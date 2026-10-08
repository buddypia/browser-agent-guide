// バックグラウンド(サービスワーカー)。拡張全体の司令塔。
// - 記憶済みURL/ルールに応じてタブ単位でページ有効化
// - ページ有効化時にコンテンツスクリプトへ動詞レシピを適用
// - サイドパネルからのチャットを受けて、文脈収集 → AI呼び出し → 動詞実行 を行う

import { getSettings as readSettingsRaw, saveSettings as saveSettingsRaw, isAutoSyncReady } from '../lib/storage.js';
import { findMatchingRules } from '../lib/site-matcher.js';
import { callAI, callAIChoice } from '../lib/ai-client.js';
import { buildSystemPrompt } from '../lib/prompt.js';
import { slugFromCapture } from '../lib/slug.js';
import { mergeRecipeActions } from '../lib/recipe-merge.js';
import {
  WORKFLOW_KEY,
  RUN_KEY,
  crossPageWorkflowForPrompt,
  normalizeWorkflow,
  normalizeRun,
  actionableSteps,
  AUTORUN_ALLOWED_VERBS,
  nextPendingStep,
  isStructuredStep,
  stepMatchesUrl,
  isLiteralPattern,
  urlMatchesPattern,
  applyVars,
  stepVariables,
  resolveStepVars,
  pickCandidate,
  buildChoiceMessages,
  formatStepTitle,
} from '../lib/workflow.js';
import { resolveLocale, normalizeLocale, DEFAULT_LOCALE } from '../sidepanel/i18n.js';

// ---- 設定ブロブのメモリキャッシュ ----
// 1メッセージ処理で getSettings が複数回(例: handleMessage 冒頭の ensureI18n と
// getActiveTabState)呼ばれても、chrome.storage.local 読込＋ディープマージを1回に抑える。
// 自身の保存(saveSettings)と外部変更(options/sidepanel の storage.onChanged)で失効させる。
// 重要: 戻り値は共有参照のため「読み取り専用」として扱う。変更時は新オブジェクトを作って
// saveSettings に渡すこと(in-place 変更すると保存前 throw でキャッシュが storage と乖離する)。
let settingsCache = null;
async function getSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = await readSettingsRaw();
  return settingsCache;
}
async function saveSettings(next) {
  settingsCache = null; // 書込前に失効させ、以後の読込が新値を取り直すようにする
  await saveSettingsRaw(next);
}

// ---- i18n: ロケール辞書(sidepanel/locales)を拡張オリジンで読み、同期 t() で解決する ----
// SW はオーケストレータとして唯一ロケール辞書を読み、content/offscreen/ai-client のエラーや
// memo.md・学習ルール名をユーザー言語で返す。content script へは GET_I18N で辞書そのものを渡す
// (非モジュールIIFE & ページ由来 fetch の WAR 制約を避けるため)。
let i18nMessages = {};
let i18nFallback = {};
let i18nLocale = DEFAULT_LOCALE;
let i18nLoadedFor = null;

async function loadLocaleJson(locale) {
  try {
    const res = await fetch(chrome.runtime.getURL(`sidepanel/locales/${normalizeLocale(locale)}.json`));
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

// 設定の言語(auto/en/ko/ja/zh)を解決し、必要時だけ辞書を読み直す。
async function ensureI18n() {
  const settings = await getSettings();
  const locale = resolveLocale(settings.ui?.language);
  if (i18nLoadedFor === locale) return;
  i18nMessages = await loadLocaleJson(locale);
  i18nFallback = locale === DEFAULT_LOCALE ? i18nMessages : await loadLocaleJson(DEFAULT_LOCALE);
  i18nLocale = locale;
  i18nLoadedFor = locale;
}

function t(key, vars) {
  const tpl = i18nMessages[key] ?? i18nFallback[key] ?? key;
  return String(tpl).replace(/\{(\w+)\}/g, (m, name) =>
    vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  );
}

// 設定が変わったら(options/sidepanel など他コンテキストの書込含む)、設定キャッシュを
// 失効させ、言語が変わっていれば次回 ensureI18n で辞書を読み直させる。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aiAdvisorSettings) {
    settingsCache = null;
    i18nLoadedFor = null;
    connectDaemonWebSocket().catch(() => {});
  }
});

const MEMORY_VERBS = new Set([
  'addNote',
  'markElement',
  'addCueButton',
  'injectHtml',
  'injectCss',
  'injectScript',
  'outlineElement',
  'injectButton',
  'injectPanel',
]);
// @term: recipe  (用語定義: glossary/extension/recipe.md。options.js の SAFE_RECIPE_VERBS と同期必須)
const RECIPE_VERBS = new Set(['injectHtml', 'injectCss', 'injectScript', 'outlineElement', 'injectButton', 'injectPanel']);
// @endterm: recipe
const REMEMBER_SCOPES = new Set(['page', 'domain', 'all']);
const AUTO_SYNC_DEFAULT_DEBOUNCE_MS = 1800;
const AUTO_SYNC_MIN_DEBOUNCE_MS = 750;
const AUTO_SYNC_MAX_DEBOUNCE_MS = 10000;
const autoSyncTimers = new Map();
const autoSyncInFlight = new Set();

// 拡張アイコンのクリックでサイドパネルを開く。
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---- タブのURL変化を監視してサイドパネルの有効化＋ページ有効化を行う ----
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // フルロード完了のみを拾う。SPA の同一ドキュメント遷移(pushState/hashchange)では
  // onUpdated も info.url 付きで発火しうるが、それは content の SPA_NAVIGATED が担当する。
  // ここで info.url まで拾うと、同じ遷移で syncTab→ACTIVATE が二重に走り、同一レシピが二重適用される。
  if (info.status === 'complete') {
    syncTab(tabId, tab?.url).catch(() => {});
    syncTabAutoRun(tabId, tab?.url);
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncTab(tabId, tab.url);
  } catch {
    /* タブ取得失敗は無視 */
  }
});

/**
 * 指定タブのURL判定を行い、記憶済みルールがあればページ有効化(注釈+レシピ適用)を行う。
 * サイドパネル自体はどのサイトでも開ける(設定変更でロックアウトしないため)。
 * 「記憶済みURL」かどうかはレシピ自動適用とバナー表示に反映される。
 */
async function syncTab(tabId, url) {
  if (!url || !/^https?:/.test(url)) return;
  const settings = await getSettings();
  const rules = findMatchingRules(url, settings.sites);
  if (rules.length === 0) return;
  // 一致したルールに紐づくレシピを集約してページへ適用する。
  const recipes = [];
  for (const rule of rules) {
    const list = settings.recipes?.[rule.id];
    if (Array.isArray(list)) recipes.push(...list.filter((action) => RECIPE_VERBS.has(action?.verb)));
  }
  await sendToContent(tabId, { type: 'ACTIVATE', recipes }).catch(() => {});
}

/**
 * タブのURL判定後に、自動実行セッションが有効ならこのページの記録手順を実行する。
 * syncTab(=ナビゲーション/SPA遷移)から呼ばれる。失敗してもナビゲーション処理を壊さない。
 */
async function syncTabAutoRun(tabId, url) {
  if (tabId == null || !url || !/^https?:/.test(url)) return;
  try {
    await maybeAutoRunWorkflow(tabId);
  } catch (e) {
    console.warn('[autorun] skipped:', e?.message || e);
  }
}

// ---- サイドパネル / options からのメッセージ処理 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // 非同期応答
});

async function handleMessage(msg, sender) {
  await ensureI18n(); // 以降の t() がユーザー言語で解決できるよう、辞書を確実に読み込む
  switch (msg?.type) {
    case 'GET_I18N':
      // content script へロケール辞書を渡す(content は import 不可のため SW が供給する)。
      return { locale: i18nLocale, messages: i18nMessages, fallback: i18nFallback };
    case 'GET_ACTIVE_TAB_STATE':
      return getActiveTabState();
    case 'CHAT':
      return runChat(msg);
    case 'REMEMBER_PAGE':
      return rememberPageRule({ url: msg.url, title: msg.title, source: msg.source });
    case 'SET_REMEMBER_SCOPE':
      return setRememberScope(msg.scope);
    case 'RUN_VERB':
      return runSingleVerb(msg);
    case 'COLLECT_CONTEXT':
      return collectContext(msg.tabId);
    case 'SPA_NAVIGATED':
      // content から SPA内部遷移(URL変化)の通知。新URLにマッチするレシピを再適用する。
      syncTabAutoRun(sender?.tab?.id, msg.url);
      return syncTab(sender?.tab?.id, msg.url);
    case 'START_WORKFLOW_AUTORUN':
      return startWorkflowAutoRun(msg.tabId, msg.vars);
    case 'STOP_WORKFLOW_AUTORUN':
      return stopWorkflowAutoRun();
    case 'APPROVE_WORKFLOW_STEP':
      return approveWorkflowStep(msg.tabId);
    case 'DRY_RUN_WORKFLOW':
      return dryRunWorkflow(msg.tabId, msg.vars);
    case 'TEST_WORKFLOW_STEP':
      return testWorkflowStep(msg.tabId, msg.stepId, msg.vars);
    case 'START_PICKER':
      return ensureContentAndSend(msg.tabId, { type: 'START_PICKER' });
    case 'STOP_PICKER':
      return ensureContentAndSend(msg.tabId, { type: 'STOP_PICKER' });
    case 'START_DRAWING':
      return ensureContentAndSend(msg.tabId, { type: 'START_DRAWING' });
    case 'STOP_DRAWING':
      return ensureContentAndSend(msg.tabId, { type: 'STOP_DRAWING' });
    case 'LIST_ANNOTATIONS':
      return ensureContentAndSend(msg.tabId, { type: 'LIST_ANNOTATIONS' });
    case 'EDIT_ANNOTATION':
      return ensureContentAndSend(msg.tabId, { type: 'EDIT_ANNOTATION', id: msg.id });
    case 'REMOVE_ANNOTATION':
      return ensureContentAndSend(msg.tabId, { type: 'REMOVE_ANNOTATION', id: msg.id });
    case 'EXPORT_CONTEXT':
      return ensureContentAndSend(msg.tabId, { type: 'EXPORT_CONTEXT' });
    case 'DOWNLOAD_CHAT':
      return downloadChatHistory({ markdown: msg.markdown, filename: msg.filename });
    case 'CAPTURE_PAGE_FEEDBACK':
      return capturePageFeedback({ tabId: msg.tabId });
    case 'PAGE_FEEDBACK_CHANGED':
      return scheduleAutoPageFeedback({
        tabId: sender?.tab?.id,
        sendCount: msg.sendCount,
      });
    case 'EXECUTE_USER_SCRIPT':
      return executeUserScript({ id: msg.id, code: msg.code, sender });
    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    default:
      throw new Error(`未知のメッセージ種別: ${msg?.type}`);
  }
}

async function executeUserScript({ id, code, sender }) {
  const tabId = sender?.tab?.id;
  if (tabId == null) {
    throw new Error(t('sw.err.execTabMissing'));
  }
  if (!chrome.userScripts?.execute) {
    throw new Error(t('sw.err.userScriptsApi'));
  }

  try {
    await chrome.userScripts.getScripts();
  } catch (err) {
    throw new Error(t('sw.err.allowUserScripts', { message: String(err?.message || err) }));
  }

  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  const marker = `${id || 'js'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const markerAttr = 'data-bag-user-script-executed';
  const sourceUrl = `bag-${String(id || 'script').replace(/[^\w.-]+/g, '_')}.user.js`;
  const wrappedCode = `(async () => {
try {
${String(code || '')}
} finally {
  try { document.documentElement.setAttribute(${JSON.stringify(markerAttr)}, ${JSON.stringify(marker)}); } catch (_) {}
}
})()
//# sourceURL=${sourceUrl}`;

  let injections;
  try {
    injections = await chrome.userScripts.execute({
      target: { tabId, frameIds: [frameId] },
      js: [{ code: wrappedCode }],
      injectImmediately: true,
      world: 'USER_SCRIPT',
    });
  } catch (err) {
    throw new Error(t('sw.err.execFailed', { message: String(err?.message || err) }));
  }

  const result = injections?.[0] || {};
  if (result.error) {
    throw new Error(t('sw.err.execError', { message: result.error }));
  }
  return {
    world: 'USER_SCRIPT',
    frameId: result.frameId ?? frameId,
    documentId: result.documentId || '',
    marker,
    result: result.result ?? null,
  };
}

/** アクティブタブの状態(URL/一致状況)を返す。 */
async function getActiveTabState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { tabId: null, matched: false };
  const settings = await getSettings();
  const rules = findMatchingRules(tab.url || '', settings.sites);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    tabIndex: tab.index,
    tabActive: Boolean(tab.active),
    url: tab.url,
    title: tab.title,
    matched: rules.length > 0,
    ruleIds: rules.map((r) => r.id),
    remembered: rules.some((r) => r.learned),
    hasApiKey: Boolean(settings.ai.apiKey),
    provider: settings.ai.provider,
    rememberScope: normalizeRememberScope(settings.memory?.defaultScope),
  };
}

/** コンテンツスクリプトからページ文脈(動詞カタログ・affordance等)を収集する。 */
async function collectContext(tabId) {
  return ensureContentAndSend(tabId, { type: 'COLLECT_CONTEXT' });
}

/** チャット本処理: 文脈収集 → AI(構造化出力) → 動詞実行 → 結果返却。 */
async function runChat({ tabId, text, history, rememberScope }) {
  const settings = await getSettings();
  if (!settings.ai.apiKey) {
    throw new Error(t('sw.err.apiKeyMissing'));
  }
  const scope = normalizeRememberScope(rememberScope || settings.memory?.defaultScope);
  const context = await collectContext(tabId);
  const verbNames = (context.verbs || []).map((v) => v.name);

  // ページ跨ぎワークフロー(記録した手順)を読み、プロンプトに「URL順の操作手順」として同梱する。
  // 現在ページの注釈だけでは別ページの手順が見えないため、ここで storage から直接読む。
  context.crossPageWorkflow = await loadCrossPageWorkflow();

  const system = buildSystemPrompt({ context });
  const messages = [
    { role: 'system', content: system },
    ...normalizeHistory(history),
    { role: 'user', content: text },
  ];

  const { reply, actions } = await callAI({ ai: settings.ai, messages, verbNames, t });

  let results = [];
  if (actions.length) {
    const res = await ensureContentAndSend(tabId, { type: 'RUN_ACTIONS', actions, source: 'chat' });
    results = res?.results || [];
  }
  const remembered = await rememberSuccessfulChanges({
    context,
    actions,
    results,
    source: 'chat',
    scope,
  });
  return { reply, actions, results, remembered };
}

/** 記録済みページ跨ぎワークフローを読み、プロンプト用の {count,steps[]} か null を返す。 */
async function loadCrossPageWorkflow() {
  try {
    const all = await chrome.storage.local.get(WORKFLOW_KEY);
    return crossPageWorkflowForPrompt(all[WORKFLOW_KEY]);
  } catch {
    return null;
  }
}

// ---- ワークフロー自動実行(セッション) ----
// 記録した手順を「1手ずつ」決定的に実行する。
//   - 構造化手順(観察記録): content の RUN_STEP で要素解決→操作→事後確認。AI は呼ばない。
//     候補選択が要る手順は lib/workflow.js の pickCandidate(純関数)で選び、ルールで決まらない時/
//     choice.by==='ai' の時だけ AI に「候補キーの enum から1つ」を選ばせる(閉じた選択)。
//   - 旧来手順(メモだけ): 従来どおり AI がメモ文を verbs 化して実行する(後方互換)。
//   - ページ合わせ: 手順の URL パターンに一致するまで待つ(クリックによる遷移)。一致しない時に
//     SW が開いてよいのは、可変セグメントの無い固定ページ or 最初の手順の記録URLだけ。
//   - 承認ゲート/確定系ラベルは held で停止し、人間の「承認して続行」で1手だけ通す。
// @term: workflow-step  (用語定義: glossary/extension/workflow-step.md。この領域を変えたら last_verified を更新)
const autoRunInFlight = new Set(); // 実行中タブ(同一タブ多重起動の防止)
const WF_NAV_WAIT_MS = 10000; // クリック後に次ページ(URL一致)を待つ上限
const WF_LOAD_WAIT_MS = 20000; // SW 主導の遷移で読込完了を待つ上限
const WF_STEP_TIMEOUT_MS = 6000; // 対象の出現待ち(content 側)
const WF_DRY_TIMEOUT_MS = 1500; // 試走は前手順の結果を待てないので短く

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readWorkflow() {
  try {
    const all = await chrome.storage.local.get(WORKFLOW_KEY);
    return normalizeWorkflow(all[WORKFLOW_KEY]);
  } catch {
    return normalizeWorkflow(null);
  }
}
async function readWorkflowRun() {
  try {
    const all = await chrome.storage.local.get(RUN_KEY);
    return normalizeRun(all[RUN_KEY]);
  } catch {
    return normalizeRun(null);
  }
}
async function writeWorkflowRun(run) {
  const next = normalizeRun(run);
  await chrome.storage.local.set({ [RUN_KEY]: next });
  return next;
}
// 実行中に AI が補った解決結果を、その手順の「学習候補」として残す(採用は人間がサイドパネルで決める)。
async function setStepSuggestion(stepId, suggestion) {
  try {
    const all = await chrome.storage.local.get(WORKFLOW_KEY);
    const raw = all[WORKFLOW_KEY] || {};
    const steps = Array.isArray(raw.steps) ? raw.steps : [];
    const i = steps.findIndex((s) => s && s.id === stepId);
    if (i < 0) return;
    steps[i] = { ...steps[i], suggestion: { ...suggestion, at: new Date().toISOString() } };
    await chrome.storage.local.set({ [WORKFLOW_KEY]: { ...raw, steps } });
  } catch {
    /* 学習候補の保存失敗は実行結果に影響させない */
  }
}
function notifyAutoRun(payload) {
  // サイドパネル等へブロードキャスト(未起動なら無視)。SW自身には届かない。
  try {
    chrome.runtime.sendMessage({ type: 'WORKFLOW_AUTORUN_EVENT', ...payload }, () => void chrome.runtime.lastError);
  } catch {
    /* 受信側不在は無視 */
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

// タブが条件を満たすまで待つ。時間切れなら最後に観測したタブ(または null)を返す。
async function waitForTab(tabId, pred, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const tab = await getTab(tabId);
    if (!tab) return null;
    if (pred(tab)) return tab;
    if (Date.now() >= end) return tab;
    await sleep(200);
  }
}

/** 自動実行セッションを開始する(opt-in)。変数が足りない/AIキーが要るのに無い場合は開始しない。 */
async function startWorkflowAutoRun(tabId, vars) {
  const workflow = await readWorkflow();
  const steps = actionableSteps(workflow);
  if (!steps.length) {
    notifyAutoRun({ phase: 'empty', text: t('sw.autorun.empty') });
    return { active: false, reason: 'empty' };
  }
  const given = vars && typeof vars === 'object' ? vars : {};
  const missing = stepVariables(steps).filter((name) => !String(given[name] ?? '').length);
  if (missing.length) {
    notifyAutoRun({ phase: 'error', text: t('sw.wf.missingVars', { names: missing.join(', ') }) });
    return { active: false, reason: 'vars', missing };
  }
  const settings = await getSettings();
  // 構造化手順だけなら AI キー無しでも走る(決定的)。メモだけの旧来手順を含む場合のみキー必須。
  if (steps.some((s) => !isStructuredStep(s)) && !settings.ai.apiKey) {
    notifyAutoRun({ phase: 'error', text: t('sw.err.apiKeyMissing') });
    return { active: false, reason: 'no-key' };
  }
  // 所有タブ(tabId)を記録し、他タブの遷移で同一セッションが乗っ取られないようにする。
  await writeWorkflowRun({
    active: true,
    doneStepIds: [],
    tabId,
    navCount: 0,
    vars: given,
    startedAt: new Date().toISOString(),
  });
  notifyAutoRun({ phase: 'start', text: t('sw.autorun.started', { count: steps.length }) });
  maybeAutoRunWorkflow(tabId).catch((e) => console.warn('[autorun]', e?.message || e));
  return { active: true };
}

/** 自動実行セッションを停止する。 */
async function stopWorkflowAutoRun() {
  const run = await readWorkflowRun();
  await writeWorkflowRun({ ...run, active: false, doneStepIds: [], heldStepId: '', approvedStepId: '' });
  notifyAutoRun({ phase: 'stopped', text: t('sw.autorun.stopped') });
  return { active: false };
}

/** 承認ゲートで止まった手順を人間が承認 → その1手だけゲートを通して再開する。 */
async function approveWorkflowStep(tabId) {
  const run = await readWorkflowRun();
  if (!run.heldStepId) return { active: run.active, reason: 'nothing-held' };
  await writeWorkflowRun({ ...run, active: true, approvedStepId: run.heldStepId, heldStepId: '', tabId: run.tabId ?? tabId });
  notifyAutoRun({ phase: 'start', text: t('sw.wf.approved') });
  maybeAutoRunWorkflow(run.tabId ?? tabId).catch((e) => console.warn('[autorun]', e?.message || e));
  return { active: true };
}

/** セッション中なら、所有タブで次の手順から1手ずつ実行する(ページ読込完了/SPA遷移/開始/承認から呼ばれる)。 */
async function maybeAutoRunWorkflow(tabId) {
  if (tabId == null || autoRunInFlight.has(tabId)) return;
  const run = await readWorkflowRun();
  if (!run.active) return;
  // セッション所有タブ以外の遷移では動かさない(別タブの乗っ取り/二重実行を防ぐ)。
  if (run.tabId != null && run.tabId !== tabId) return;
  autoRunInFlight.add(tabId);
  try {
    await driveWorkflow(tabId);
  } catch (e) {
    const latest = await readWorkflowRun();
    await writeWorkflowRun({ ...latest, active: false });
    notifyAutoRun({ phase: 'failed', text: t('sw.wf.failed', { n: '?', error: String(e?.message || e) }) });
  } finally {
    autoRunInFlight.delete(tabId);
  }
}

// 手順のページに今いない時、SW が開いてよい URL(無ければ null = 遷移は手順側のクリックに任せる)。
function navigationTargetFor(step, run) {
  if (!step.url) return null;
  if (!step.urlPattern) return step.url; // 旧来手順は従来どおり記録URLへ遷移
  if (isLiteralPattern(step.urlPattern)) return step.url; // 可変セグメントの無い固定ページ
  return run.doneStepIds.length === 0 ? step.url : null; // 最初の手順だけは記録した開始ページを開く
}

async function driveWorkflow(tabId) {
  const settings = await getSettings();
  let lastMayNavigate = false; // 直前の手順がクリック(=遷移しうる)か
  let navigatedFor = ''; // この駆動で既に遷移を試みた手順(同じ手順で2度遷移しない=ループ防止)
  for (let guard = 0; guard < 1000; guard++) {
    const workflow = await readWorkflow();
    let run = await readWorkflowRun();
    if (!run.active || (run.tabId != null && run.tabId !== tabId)) return;
    const all = actionableSteps(workflow);
    const step = nextPendingStep(workflow, run);
    if (!step) {
      await writeWorkflowRun({ ...run, active: false });
      notifyAutoRun({ phase: 'done', text: t('sw.autorun.complete') });
      return;
    }
    const n = all.findIndex((s) => s.id === step.id) + 1;
    const stop = async (phase, text, extra = {}) => {
      const latest = await readWorkflowRun();
      await writeWorkflowRun({ ...latest, active: false, ...extra });
      notifyAutoRun({ phase, text, stepId: step.id });
    };

    // 1) ページ合わせ
    let tab = await getTab(tabId);
    if (!tab) return stop('failed', t('sw.wf.tabGone'));
    if (!stepMatchesUrl(step, tab.url) && lastMayNavigate) {
      tab = await waitForTab(tabId, (tb) => stepMatchesUrl(step, tb.url), WF_NAV_WAIT_MS);
      if (!tab) return stop('failed', t('sw.wf.tabGone'));
    }
    if (!stepMatchesUrl(step, tab.url)) {
      const navUrl = navigationTargetFor(step, run);
      const navCap = all.length * 2 + 5;
      if (!navUrl || navigatedFor === step.id || run.navCount > navCap) {
        return stop('mismatch', t('sw.wf.mismatch', { n, url: step.urlPattern || step.url }));
      }
      navigatedFor = step.id;
      run = await writeWorkflowRun({ ...run, navCount: run.navCount + 1 });
      notifyAutoRun({ phase: 'navigate', text: t('sw.autorun.navigate', { url: navUrl }) });
      try {
        await chrome.tabs.update(tabId, { url: navUrl });
      } catch {
        return stop('mismatch', t('sw.wf.mismatch', { n, url: navUrl }));
      }
      // tabs.update 直後は旧URLのまま complete のことがあるので、URL一致 + 完了の両方を待つ。
      tab = await waitForTab(tabId, (tb) => tb.status === 'complete' && stepMatchesUrl(step, tb.url), WF_LOAD_WAIT_MS);
      if (!tab || !stepMatchesUrl(step, tab.url)) {
        return stop('mismatch', t('sw.wf.mismatch', { n, url: step.urlPattern || navUrl }));
      }
    }
    tab = (await waitForTab(tabId, (tb) => tb.status === 'complete', WF_LOAD_WAIT_MS)) || tab;

    // 2) 実行
    const structured = isStructuredStep(step);
    const outcome = structured
      ? await runStructuredStep(tabId, step, run, settings, { title: tab.title, url: tab.url })
      : await runLegacyStep(tabId, tab.url, step, run, settings);
    if (outcome.status === 'held') {
      return stop('held', t('sw.wf.held', { n, label: outcome.label || step.target || '' }), {
        heldStepId: step.id,
        approvedStepId: '',
      });
    }
    if (outcome.status !== 'ok') {
      return stop('failed', t('sw.wf.failed', { n, error: outcome.error || t('sw.autorun.failed') }));
    }

    // 3) URL 確認(タブの URL で検証。SPA でもフル遷移でも同じ)
    if (structured && step.check.type === 'url' && step.check.value) {
      const pattern = applyVars(step.check.value, run.vars);
      const tb = await waitForTab(tabId, (x) => urlMatchesPattern(x.url, pattern), WF_NAV_WAIT_MS);
      if (!tb || !urlMatchesPattern(tb.url, pattern)) {
        return stop('failed', t('sw.wf.failed', { n, error: t('sw.wf.checkUrl', { url: pattern }) }));
      }
    }

    // 4) 前進(途中で停止されていたら記録しない)
    const latest = await readWorkflowRun();
    if (!latest.active) return;
    await writeWorkflowRun({
      ...latest,
      doneStepIds: Array.from(new Set([...latest.doneStepIds, step.id])),
      approvedStepId: latest.approvedStepId === step.id ? '' : latest.approvedStepId,
      heldStepId: '',
    });
    const what = formatStepTitle(step, t);
    const via = outcome.via === 'ai' ? ` ${t('sw.wf.viaAi', { text: outcome.chosenText || outcome.label || '', reason: outcome.aiReason || '' })}` : '';
    notifyAutoRun({ phase: 'step', stepId: step.id, text: `${t('sw.wf.stepDone', { n, total: all.length, text: what })}${via}` });
    lastMayNavigate = structured ? step.action.verb === 'click' : true;
  }
}

// AI に候補キーを1つ選ばせる(閉じた選択)。キー未設定なら選べない(none)。
async function chooseCandidateWithAI({ settings, step, candidates, reason, url, title }) {
  if (!settings.ai.apiKey) return { choice: 'none', reason: t('sw.wf.noKeyForChoice') };
  const messages = buildChoiceMessages({ step, candidates, reason, url, title });
  return callAIChoice({ ai: settings.ai, messages, keys: candidates.map((c) => c.key), t });
}

/**
 * 構造化手順を1つ実行する(dryRun なら対象を示すだけ)。
 * @returns {{status:'ok'|'held'|'failed'|'needs-ai'|'missing', label?, chosenText?, via?, aiReason?, error?}}
 */
async function runStructuredStep(tabId, rawStep, run, settings, { title = '', url = '', dryRun = false, allowAI = true, suggest = true } = {}) {
  const step = resolveStepVars(rawStep, run.vars);
  const options = {
    allowIrreversibleClicks: Boolean(settings.workflow?.allowIrreversibleClicks),
    approved: run.approvedStepId === rawStep.id,
    dryRun,
    timeoutMs: dryRun ? WF_DRY_TIMEOUT_MS : WF_STEP_TIMEOUT_MS,
  };
  const send = (extra = {}) => ensureContentAndSend(tabId, { type: 'RUN_STEP', step, options: { ...options, ...extra } });
  let res = await send();
  let via = 'rule';
  let aiReason = '';
  let suggestion = null;
  for (let attempt = 0; attempt < 3 && ['choose', 'missing', 'stale'].includes(res?.status); attempt++) {
    if (res.status === 'stale') {
      res = await send(); // 候補が再描画で無効になった → 列挙し直す
      continue;
    }
    let key = null;
    if (res.status === 'choose') {
      const pick = pickCandidate(res.candidates, step.choice);
      if (pick.status === 'ok') {
        key = res.candidates[pick.index].key;
      } else {
        if (!allowAI) return { status: 'needs-ai', error: t(`sw.wf.pick.${pick.status}`) };
        const pool = pick.status === 'ambiguous' ? pick.indices.map((i) => res.candidates[i]) : res.candidates;
        const r = await chooseCandidateWithAI({ settings, step, candidates: pool, reason: pick.status, url, title });
        if (r.choice === 'none') return { status: 'failed', error: `${t(`sw.wf.pick.${pick.status}`)} ${r.reason}`.trim() };
        key = r.choice;
        via = 'ai';
        aiReason = r.reason;
        // ルールで決まらず AI が補った → 「次回からこの項目に固定」を学習候補にする(choice.by==='ai' は毎回AIが本来の設計)。
        if (step.choice?.by !== 'ai') suggestion = { kind: 'choice' };
      }
    } else {
      // missing: 記録した要素が見つからない → 同じ役割の候補から AI が選ぶ。
      if (!allowAI) return { status: 'missing', error: t('sw.wf.pick.missing') };
      const r = await chooseCandidateWithAI({ settings, step, candidates: res.candidates, reason: 'missing', url, title });
      if (r.choice === 'none') return { status: 'failed', error: `${t('sw.wf.pick.missing')} ${r.reason}`.trim() };
      key = r.choice;
      via = 'ai';
      aiReason = r.reason;
      suggestion = { kind: 'anchor' };
    }
    res = await send({ choiceKey: key, token: res.token });
  }
  if (!res || !res.status) return { status: 'failed', error: t('sw.autorun.failed') };
  if (res.status === 'ok' && suggestion && suggest && !dryRun) {
    await setStepSuggestion(rawStep.id, {
      kind: suggestion.kind,
      anchor: suggestion.kind === 'anchor' ? res.anchor || null : null,
      label: suggestion.kind === 'choice' ? res.chosenText || res.label || '' : res.label || '',
      reason: aiReason,
    });
  }
  return { ...res, via, aiReason };
}

/** 旧来手順(メモだけ)を1つ、従来どおり AI に verbs 化させて実行する。 */
async function runLegacyStep(tabId, url, step, run, settings) {
  if (!settings.ai.apiKey) return { status: 'failed', error: t('sw.err.apiKeyMissing') };
  const outcome = await autoRunExecuteSteps(tabId, url, [step], settings, {
    allowIrreversibleClicks: run.approvedStepId === step.id ? true : undefined,
  });
  if (outcome.held) return { status: 'held', label: outcome.heldLabel };
  if (!outcome.ranOk) return { status: 'failed', error: t('sw.autorun.failed') };
  return { status: 'ok', label: step.target || step.text, via: 'ai' };
}

/** このページの構造化手順を「操作せずに」解決だけして、何が選ばれるかを返す(AI は呼ばない)。 */
async function dryRunWorkflow(tabId, vars) {
  const settings = await getSettings();
  const workflow = await readWorkflow();
  const tab = await getTab(tabId);
  if (!tab) throw new Error(t('sw.wf.tabGone'));
  const run = normalizeRun({ vars });
  const results = [];
  for (const step of actionableSteps(workflow)) {
    if (!stepMatchesUrl(step, tab.url)) {
      results.push({ id: step.id, status: 'other-page' });
      continue;
    }
    if (!isStructuredStep(step)) {
      results.push({ id: step.id, status: 'legacy' });
      continue;
    }
    const r = await runStructuredStep(tabId, step, run, settings, { dryRun: true, allowAI: false, title: tab.title, url: tab.url });
    const status = ['ok', 'needs-ai', 'missing'].includes(r.status) ? r.status : 'failed';
    results.push({ id: step.id, status, label: r.label || '', chosenText: r.chosenText || '', error: r.error || '' });
    await sleep(500); // 光らせた枠が順に見えるように
  }
  return { results };
}

/** 1手順だけを試す(「文脈で選ぶ」条件の確認用。AI 判断も実際に行うが、操作はしない)。 */
async function testWorkflowStep(tabId, stepId, vars) {
  const settings = await getSettings();
  const workflow = await readWorkflow();
  const step = workflow.steps.find((s) => s.id === stepId);
  if (!step || !isStructuredStep(step)) throw new Error(t('sw.wf.notStructured'));
  const tab = await getTab(tabId);
  if (!tab) throw new Error(t('sw.wf.tabGone'));
  if (!stepMatchesUrl(step, tab.url)) return { status: 'other-page' };
  const r = await runStructuredStep(tabId, step, normalizeRun({ vars }), settings, {
    dryRun: true,
    suggest: false,
    title: tab.title,
    url: tab.url,
  });
  return { status: r.status, label: r.label || '', chosenText: r.chosenText || '', via: r.via || '', aiReason: r.aiReason || '', error: r.error || '' };
}
// @endterm: workflow-step

/**
 * 指定手順群の本文をAIへ渡し、autorun ソースでこのページを実行する(遷移はSWが担当)。
 * 安全のため、AIに提示する動詞を allow-list に絞る(navigateTo/submitForm/inject* 等は提示すらしない)。
 */
async function autoRunExecuteSteps(tabId, url, steps, settings, overrides = {}) {
  const context = await collectContext(tabId);
  context.crossPageWorkflow = await loadCrossPageWorkflow();
  const allowIrreversibleClicks =
    overrides.allowIrreversibleClicks ?? Boolean(settings.workflow?.allowIrreversibleClicks);
  // deny-by-default: スキーマに乗せる動詞を安全集合へ絞る(構造的にナビ/送信/注入を不可能にする)。
  const verbNames = (context.verbs || []).map((v) => v.name).filter((n) => AUTORUN_ALLOWED_VERBS.includes(n));
  // autorun モード: プロンプトの「別URLへは navigateTo で進め」案内を出さない(allow-list で除外済みのため
  // 矛盾指示になり、AIが手詰まりで空応答→failed停止を誘発していた)。遷移は SW が決定論的に行う。
  const system = buildSystemPrompt({ context, autorun: true, allowIrreversibleAutorun: allowIrreversibleClicks });
  // 本文の無いお描き/対象だけの手順も拾えるよう、対象(target)も指示文に含める。
  const memo = steps.map((s, i) => `${i + 1}. ${s.target ? `「${s.target}」を: ` : ''}${s.text || ''}`).join('\n');
  const instruction =
    `次の「記録ワークフロー」の手順を、いまのページで実行してください:\n${memo}\n\n` +
    `重要:\n` +
    (allowIrreversibleClicks
      ? `- 記録済み手順に含まれるクリックは、最終確定/購入/削除に見える場合でも実行してください(ユーザーが設定で許可済み)。\n`
      : `- 購入・送信・削除・注文の「最終確定」ボタンは押さないでください(人間が確定します)。\n`) +
    `- ページ送り/次へ/続行など「別ページへ移動するためのボタン」は押さないでください(遷移はこちらで行います)。\n` +
    `- このページで実行すべき操作が無ければ actions は空でかまいません(失敗ではありません)。`;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: instruction },
  ];
  const { reply, actions } = await callAI({ ai: settings.ai, messages, verbNames, t });
  let results = [];
  if (actions.length) {
    const res = await ensureContentAndSend(tabId, {
      type: 'RUN_ACTIONS',
      actions,
      source: 'autorun',
      options: { allowIrreversibleClicks },
    });
    results = res?.results || [];
  }
  const held = results.find((r) => r && r.held);
  const anyOk = results.some((r) => r && r.ok);
  const hardFail = results.some((r) => r && r.ok === false && !r.held);
  // 前進条件: 保留が無く、(1つ以上成功 もしくは そもそも実行すべきアクションが無かった)。
  // 「このページに打つ手が無い(空応答/noopのみ)」は失敗ではなく前進扱いにし、SWが次ページへ進める。
  // 実行を試みて全部失敗した(hardFail)時だけ failed 停止して取りこぼしを知らせる。
  const ranOk = !held && (anyOk || (!actions.length && !hardFail));
  return { reply, results, held: Boolean(held), heldLabel: held?.label || '', ranOk };
}

/** サイドパネルのツールバー等から単一動詞を直接実行する。 */
async function runSingleVerb({ tabId, verb, args, rememberScope }) {
  const res = await ensureContentAndSend(tabId, {
    type: 'RUN_ACTIONS',
    actions: [{ verb, args: args || {}, reason: 'manual' }],
    source: 'manual',
  });
  const result = res?.results?.[0];
  if (result?.ok && MEMORY_VERBS.has(verb)) {
    const context = await collectContext(tabId).catch(() => ({}));
    await rememberSuccessfulChanges({
      context,
      actions: [{ verb, args: args || {}, reason: 'manual' }],
      results: [result],
      source: 'manual',
      scope: normalizeRememberScope(rememberScope),
    });
  }
  return result;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20) // 直近のみ送信
    .map((m) => ({ role: m.role, content: m.content }));
}

async function setRememberScope(scope) {
  const settings = await getSettings();
  const nextScope = normalizeRememberScope(scope);
  await saveSettings({
    ...settings,
    memory: {
      ...(settings.memory || {}),
      defaultScope: nextScope,
    },
  });
  return { scope: nextScope };
}

function normalizeRememberScope(scope) {
  return REMEMBER_SCOPES.has(scope) ? scope : 'page';
}

async function rememberSuccessfulChanges({ context, actions, results, source, scope = 'page' }) {
  const successful = (actions || []).filter((action, index) => results?.[index]?.ok && MEMORY_VERBS.has(action.verb));
  if (!successful.length) return { remembered: false };
  return rememberPageRule({
    url: context?.url,
    title: context?.title,
    source,
    scope,
    actions: successful.filter((action) => RECIPE_VERBS.has(action.verb)),
  });
}

async function rememberPageRule({ url, title, source = 'chat', scope = 'page', actions = [] }) {
  const target = ruleTargetForScope(url, scope);
  if (!target) return { remembered: false };

  const settings = await getSettings();
  const sites = Array.isArray(settings.sites) ? [...settings.sites] : [];
  const recipes = settings.recipes && typeof settings.recipes === 'object' ? { ...settings.recipes } : {};
  const now = new Date().toISOString();
  let rule = sites.find((r) => sameRuleTarget(r, target));

  if (!rule) {
    rule = {
      id: learnedRuleId(target),
      label: ruleLabel(title, target),
      matchType: target.matchType,
      pattern: target.pattern,
      enabled: true,
      learned: true,
      source,
      createdAt: now,
      updatedAt: now,
    };
    sites.push(rule);
  } else {
    // getSettings() の戻り値(= settingsCache 共有参照)を in-place 変更しない。
    // クローンして sites[idx] に差し替えることで、保存(saveSettings は書込前に
    // cache を null 化)までの間に例外が出ても、キャッシュが storage と乖離しない。
    const idx = sites.indexOf(rule);
    rule = {
      ...rule,
      enabled: true,
      learned: rule.learned !== false,
      source: rule.source || source,
      updatedAt: now,
      label: rule.label || ruleLabel(title, target),
    };
    sites[idx] = rule;
  }

  const currentRecipe = Array.isArray(recipes[rule.id]) ? [...recipes[rule.id]] : [];
  const mergedRecipe = mergeRecipeActions(currentRecipe, actions, RECIPE_VERBS);
  recipes[rule.id] = mergedRecipe;

  await saveSettings({
    ...settings,
    sites,
    recipes,
  });

  return {
    remembered: true,
    ruleId: rule.id,
    matchType: rule.matchType,
    pattern: rule.pattern,
    scope: normalizeRememberScope(scope),
    addedRecipeCount: mergedRecipe.length - currentRecipe.length,
    recipeCount: mergedRecipe.length,
  };
}

function ruleTargetForScope(url, scope) {
  const rememberScope = normalizeRememberScope(scope);
  if (rememberScope === 'all') return { matchType: 'all', pattern: '*' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return null;
  if (rememberScope === 'domain') return { matchType: 'domain', pattern: parsed.hostname.toLowerCase() };
  return { matchType: 'page', pattern: parsed.origin + parsed.pathname };
}

function sameRuleTarget(rule, target) {
  if (!rule || !target || rule.matchType !== target.matchType) return false;
  if (target.matchType === 'all') return true;
  if (target.matchType === 'page') return pagePattern(rule.pattern) === target.pattern;
  return String(rule.pattern || '').trim().toLowerCase() === String(target.pattern || '').trim().toLowerCase();
}

function learnedRuleId(target) {
  const key = `${target.matchType}:${target.pattern}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `learned-${target.matchType}-${hash.toString(36)}`;
}

function pagePattern(url) {
  if (!url || !/^https?:/i.test(String(url))) return '';
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '';
  }
}

function ruleLabel(title, target) {
  if (target?.matchType === 'all') return t('sw.rule.allSites');
  if (target?.matchType === 'domain') return t('sw.rule.domain', { pattern: target.pattern });
  const cleanTitle = String(title || '').trim();
  if (cleanTitle) return cleanTitle.slice(0, 80);
  try {
    const url = new URL(target?.pattern || '');
    return `${url.hostname}${url.pathname}`;
  } catch {
    return target?.pattern || t('sw.rule.fallback');
  }
}

// ---- コンテンツスクリプトとの通信(未注入時は注入を試みる) ----
async function sendToContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function ensureContentAndSend(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 未注入の可能性 → 動的注入してから再送する。
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content-script.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css'],
      });
    } catch (e) {
      throw new Error(t('sw.err.contentInjectFailed', { message: String(e?.message || e) }));
    }
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// ===========================================================================
// ページフィードバック（vision ブリッジ）Phase 0 / MVP
// お描き注釈をスクリーンショットへ burn-in し、Downloads/ai-inbox/<slug>/ へ保存する。
//   流れ: content(PREPARE_CAPTURE) → captureVisibleTab → content(FINISH_CAPTURE)
//        → offscreen(合成) → chrome.downloads(shot.png/raw.png/annotation.json/memo.md)
// ===========================================================================

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const INBOX_ROOT = 'ai-inbox';
let creatingOffscreen = null;

async function scheduleAutoPageFeedback({ tabId, sendCount } = {}) {
  if (tabId == null) return { scheduled: false, reason: 'no-tab' };
  if (Number(sendCount || 0) <= 0) {
    clearAutoSyncTimer(tabId);
    return { scheduled: false, reason: 'empty' };
  }

  const settings = await getSettings();
  if (!isAutoSyncReady(settings)) {
    clearAutoSyncTimer(tabId);
    return { scheduled: false, reason: 'disabled' };
  }

  const delayMs = clampAutoSyncDebounce(settings.pageFeedback?.autoSyncDebounceMs);
  setAutoSyncTimer(tabId, delayMs);
  return { scheduled: true, delayMs };
}

function setAutoSyncTimer(tabId, delayMs) {
  clearAutoSyncTimer(tabId);
  const timer = setTimeout(() => {
    autoSyncTimers.delete(tabId);
    runAutoPageFeedback(tabId).catch((e) => {
      console.warn('[bag] page feedback auto sync failed:', e?.message || e);
    });
  }, delayMs);
  autoSyncTimers.set(tabId, timer);
}

function clearAutoSyncTimer(tabId) {
  const timer = autoSyncTimers.get(tabId);
  if (timer) clearTimeout(timer);
  autoSyncTimers.delete(tabId);
}

function clampAutoSyncDebounce(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return AUTO_SYNC_DEFAULT_DEBOUNCE_MS;
  return Math.min(AUTO_SYNC_MAX_DEBOUNCE_MS, Math.max(AUTO_SYNC_MIN_DEBOUNCE_MS, Math.round(n)));
}

async function runAutoPageFeedback(tabId) {
  if (autoSyncInFlight.has(tabId)) {
    setAutoSyncTimer(tabId, AUTO_SYNC_DEFAULT_DEBOUNCE_MS);
    return;
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }

  autoSyncInFlight.add(tabId);
  try {
    // 送信対象を先に見て、お描き(図形)が無い＝メモのみなら text-only 同期にする。
    // スクリーンショット不要なのでタブが非アクティブでも送れる（「メモを残しただけでは
    // 届かない」問題の恒久解消経路）。お描きを含む時だけ画像 burn-in が必要になる。
    const data = await ensureContentAndSend(tabId, { type: 'COLLECT_PAGE_FEEDBACK' }).catch(() => null);
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) return;
    const hasDrawing = items.some((it) => Array.isArray(it.shapesFrac) && it.shapesFrac.length > 0);
    if (!hasDrawing) {
      await pushTextOnlyPageFeedback({ tabId, tab, data });
      return;
    }
    // captureVisibleTab captures the active tab in a window, so skip if the annotated tab is no longer active.
    if (!tab?.active) return;
    await capturePageFeedback({ tabId, autoSync: true });
  } finally {
    autoSyncInFlight.delete(tabId);
  }
}

// メモのみ(お描きなし)の text-only 送信。画像を撮らず annotation.json/memo.md 相当だけを
// daemon へ push する。daemon 未到達時は throw（自動送信は勝手なダウンロード保存をしない
// という方針）。呼び出し元は自動送信経路のみ。
async function pushTextOnlyPageFeedback({ tabId, tab, data }) {
  const settings = await getSettings();
  const daemon = settings.daemon || {};
  if (!isAutoSyncReady(settings)) {
    return { transport: 'skipped', reason: 'auto-sync-disabled' };
  }
  const tabMeta = buildTabMetadata(tab || (await chrome.tabs.get(tabId)));
  const capturedAt = new Date().toISOString();
  const annotation = buildAnnotationJson({ data, composite: null, capturedAt, tab: tabMeta });
  const memo = buildMemoMarkdown({ data, composite: null, capturedAt, tab: tabMeta });
  const knownDownloadsDir = await getKnownDownloadsDir();
  const ack = await pushToDaemon({
    url: daemon.url,
    token: daemon.token,
    payload: {
      type: 'page_feedback',
      capturedAt,
      url: data.url,
      title: data.title,
      tab: tabMeta,
      dpr: data.dpr,
      viewport: data.viewport,
      downloadsDir: (daemon.saveDir || '').trim() || knownDownloadsDir || undefined,
      // image なし = text-only。daemon 側は annotation.json だけの entry として保存し、
      // MCP context ツールがそのまま返す（image ツールは「画像なし」を案内する）。
      annotation,
      memo,
    },
  });
  return { transport: 'daemon', textOnly: true, dir: ack.dir, id: ack.id, items: data.items.length };
}

async function capturePageFeedback({ tabId, autoSync = false }) {
  if (tabId == null) throw new Error(t('errors.targetTabMissing'));
  const settings = await getSettings();
  const daemon = settings.daemon || {};
  if (autoSync && !isAutoSyncReady(settings)) {
    return { transport: 'skipped', reason: 'auto-sync-disabled' };
  }
  const tab = await chrome.tabs.get(tabId);
  const tabMeta = buildTabMetadata(tab);
  if (!tab?.active) {
    if (autoSync) return { transport: 'skipped', reason: 'tab-not-active' };
    throw new Error(t('sw.err.captureTabNotActive'));
  }

  // 1) 注釈を px へ解決し、自前UIを隠す。
  const data = await ensureContentAndSend(tabId, { type: 'PREPARE_CAPTURE' });
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    await ensureContentAndSend(tabId, { type: 'FINISH_CAPTURE' }).catch(() => {});
    throw new Error(t('sw.err.captureNoDrawing'));
  }

  // 2) 可視タブを撮る（自前UIは隠れている）。必ず FINISH_CAPTURE で復元する。
  let screenshotDataUrl;
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    await ensureContentAndSend(tabId, { type: 'FINISH_CAPTURE' }).catch(() => {});
  }
  if (!screenshotDataUrl) throw new Error(t('sw.err.screenshotFailed'));

  // 3) offscreen で注釈を burn-in。
  await ensureOffscreen();
  const res = await sendToOffscreen({
    target: 'offscreen',
    type: 'COMPOSITE_PAGE_FEEDBACK',
    payload: { screenshotDataUrl, data },
  });
  if (!res?.ok) throw new Error(res?.error ? t(res.error) : t('sw.err.compositeFailed'));
  const composite = res.result;

  // 4) 保存。デーモン有効時は WebSocket push、未到達時は chrome.downloads にフォールバック。
  const capturedAt = new Date().toISOString();
  const annotation = buildAnnotationJson({ data, composite, capturedAt, tab: tabMeta });
  const memo = buildMemoMarkdown({ data, composite, capturedAt, tab: tabMeta });
  const common = {
    items: data.items.length,
    drawn: composite.drawn,
    width: composite.width,
    height: composite.height,
    downscaled: composite.downscaled,
  };

  // 過去のダウンロード保存で学習した「ブラウザの実ダウンロード先」。あればデーモンへ伝え、
  // デーモンが既定 inbox をブラウザの実態(移動済み/Edge/Brave 等)へ合わせられるようにする。
  // 注意: これは下の chrome.downloads フォールバックが一度でも走って初めて学習される
  // (chrome.downloads には「既定保存先を取得する」APIが無いため)。デーモン常用ユーザーでは
  // null のままで送らないが、その場合はデーモン自身の OS 検出が保存先を決めるので実害はない
  // (デーモン経路はデーモンが保存先を所有し、MCP もそこを読むため経路が一貫する)。
  const knownDownloadsDir = await getKnownDownloadsDir();
  let daemonError = null;
  if (daemon.enabled && daemon.url && daemon.token) {
    try {
      const ack = await pushToDaemon({
        url: daemon.url,
        token: daemon.token,
        payload: {
          type: 'page_feedback',
          capturedAt,
          url: data.url,
          title: data.title,
          tab: tabMeta,
          dpr: data.dpr,
          viewport: data.viewport,
          downloadsDir: (daemon.saveDir || '').trim() || knownDownloadsDir || undefined,
          // inline = MCP 専用のコンパクト変種（WebP/JPEG, ~12KB）。Claude Code の出力トークン
          // 上限対策で daemon の {type:'image'} に使う。shot/raw はフル解像度 PNG のまま温存。
          image: {
            shot: composite.dataUrl,
            raw: screenshotDataUrl,
            ...(composite.inlineDataUrl ? { inline: composite.inlineDataUrl, inlineMime: composite.inlineMime } : {}),
          },
          annotation,
          memo,
        },
      });
      // ack.shotUrl はパス非依存の取得先（token-less）。サイドパネルが表示する（取得時に ?token= を付与）。
      return { transport: 'daemon', dir: ack.dir, file: `${ack.dir}/shot.png`, id: ack.id, imageUrl: ack.shotUrl || null, ...common };
    } catch (e) {
      daemonError = String(e?.message || e); // フォールバックして下の downloads へ
      if (autoSync) throw new Error(daemonError);
    }
  }

  if (autoSync) {
    throw new Error(t('sw.err.daemonUnreachable'));
  }

  // chrome.downloads フォールバック（Phase 0 と同じ）。
  const slug = slugFromCapture({ capturedAt, url: data.url, title: data.title });
  const dir = `${INBOX_ROOT}/${slug}`;
  const [shotId] = await Promise.all([
    saveDownload(`${dir}/shot.png`, composite.dataUrl),
    saveDownload(`${dir}/raw.png`, screenshotDataUrl),
    saveDownload(`${dir}/annotation.json`, textToDataUrl(JSON.stringify(annotation, null, 2), 'application/json')),
    saveDownload(`${dir}/memo.md`, textToDataUrl(memo, 'text/markdown')),
  ]);

  // 実際にどこへ書かれたか(絶対パス)を取得して表に出す。ダウンロード先はブラウザ設定依存で、
  // ~/Downloads とは限らない(移動済み/Edge/Brave/「毎回確認」)。取得できたら downloadsDir を学習保存する。
  let absDir = null;
  let absFile = null;
  try {
    absFile = await resolveDownloadAbsolutePath(shotId);
    if (absFile) {
      absDir = stripLastSegment(absFile); // .../ai-inbox/<slug>
      const downloadsDir = downloadsRootFromAbsShot(absFile);
      if (downloadsDir) await chrome.storage.local.set({ [DOWNLOADS_DIR_KEY]: downloadsDir });
    }
  } catch {
    /* 取得失敗時は相対パス表示にフォールバック */
  }

  return { transport: 'downloads', dir, absDir, file: `${dir}/shot.png`, absFile, daemonError, ...common };
}

const DOWNLOADS_DIR_KEY = 'bagDownloadsDir';

// 学習済みの「ブラウザの実ダウンロード先」を返す（無ければ null）。
async function getKnownDownloadsDir() {
  try {
    const r = await chrome.storage.local.get(DOWNLOADS_DIR_KEY);
    return r[DOWNLOADS_DIR_KEY] || null;
  } catch {
    return null;
  }
}

// download id の保存完了を待ち、確定した絶対パス(DownloadItem.filename)を返す。
// download() 解決直後は filename が暫定のことがあるため onChanged(state=complete) を主に使う。
// 返り値は表示専用(取れなければ相対パス表示にフォールバック)なので、保存が滞っても UI を
// 長く待たせないよう短めのタイムアウトにする(data: URL の保存は通常 1 秒未満で完了する)。
function resolveDownloadAbsolutePath(downloadId, timeoutMs = 2000) {
  if (downloadId == null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch {
        /* listener 解除失敗は無視 */
      }
      clearTimeout(timer);
      resolve(val || null);
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete' || delta.filename?.current) {
        chrome.downloads
          .search({ id: downloadId })
          .then((items) => finish(items?.[0]?.filename || delta.filename?.current))
          .catch(() => finish(delta.filename?.current));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // data: URL は即時完了しがちなので、既に完了済みのケースを即 search で拾う。
    chrome.downloads
      .search({ id: downloadId })
      .then((items) => {
        if (items?.[0]?.state === 'complete' && items[0].filename) finish(items[0].filename);
      })
      .catch(() => {});
    const timer = setTimeout(() => {
      chrome.downloads
        .search({ id: downloadId })
        .then((items) => finish(items?.[0]?.filename))
        .catch(() => finish(null));
    }, timeoutMs);
  });
}

// 絶対パスから末尾セグメント(ファイル名)を除いてディレクトリを返す（/ と \ の両対応）。
function stripLastSegment(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

// .../<INBOX_ROOT>/<slug>/shot.png から INBOX_ROOT の親(=ブラウザのダウンロードルート)を取り出す。
// needle は INBOX_ROOT から導出する(保存パス組み立てと同じ定数で同期させる)。
function downloadsRootFromAbsShot(absShot) {
  const needle = `/${INBOX_ROOT}/`;
  const i = absShot.replace(/\\/g, '/').lastIndexOf(needle);
  return i > 0 ? absShot.slice(0, i) : null;
}

// 拡張 → デーモンへ WebSocket で1件 push し、ack を待つ。
// 認証はクエリ ?token=（ブラウザ WebSocket はカスタムヘッダ不可のため）。
function pushToDaemon({ url, token, payload, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    } catch (e) {
      reject(new Error(t('sw.err.wsInvalidUrl', { message: String(e?.message || e) })));
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* 既に閉じている */
      }
      reject(new Error(t('sw.err.daemonTimeout')));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      let m = null;
      try {
        m = JSON.parse(ev.data);
      } catch {
        /* パース不能 */
      }
      try {
        ws.close();
      } catch {
        /* noop */
      }
      if (m?.type === 'ack') resolve(m);
      else reject(new Error(m?.error || t('sw.err.daemonNoAck')));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(t('sw.err.daemonUnreachable')));
    };
  });
}

// ---- offscreen document の確保（単一しか作れない制約をガード） ----
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'スクリーンショットへの注釈 burn-in（Canvas 2D 合成）',
      })
      .catch((e) => {
        // 競合で既に作成済みなら無視。それ以外は再送出。
        if (!/single offscreen|already|Only a single/i.test(String(e?.message || e))) throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// offscreen へ送る。作成直後のリスナ未登録レースに 1 回だけリトライする。
async function sendToOffscreen(message, retried = false) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    if (!retried && /Receiving end does not exist/i.test(String(e?.message || e))) {
      await new Promise((r) => setTimeout(r, 120));
      await ensureOffscreen();
      return sendToOffscreen(message, true);
    }
    throw e;
  }
}

async function saveDownload(filename, url) {
  return chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
}

// サイドパネルからのチャット履歴ダウンロード委譲。特権 API(chrome.downloads)は
// SW 側でのみ実行する(AGENTS.md の設計境界)。saveAs:true で保存先を確認させる。
async function downloadChatHistory({ markdown, filename }) {
  const url = textToDataUrl(String(markdown ?? ''), 'text/markdown');
  const safeName = typeof filename === 'string' && filename ? filename : 'chat.md';
  const downloadId = await chrome.downloads.download({ url, filename: safeName, saveAs: true });
  return { downloadId };
}

// UTF-8 を安全に base64 data URL 化する（日本語メモ対応）。
function textToDataUrl(text, mime) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};charset=utf-8;base64,${btoa(bin)}`;
}

function buildTabMetadata(tab) {
  return {
    tabId: Number.isInteger(tab?.id) ? tab.id : null,
    windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
    index: Number.isInteger(tab?.index) ? tab.index : null,
    active: Boolean(tab?.active),
  };
}

function buildAnnotationJson({ data, composite, capturedAt, tab }) {
  return {
    // v1: 注釈要素の outerHTML / a11y を items に追加（画像なしで HTML 要素を CLI へ渡すため）。v0 も読める。
    schema: 'bag.page-feedback/v1',
    url: data.url,
    title: data.title,
    capturedAt,
    tab,
    dpr: data.dpr,
    viewport: data.viewport,
    // composite なし = text-only(メモのみ同期)。画像ファイルが存在しないので image: null。
    image: composite
      ? {
          file: 'shot.png',
          raw: 'raw.png',
          width: composite.width,
          height: composite.height,
          downscaled: composite.downscaled,
          outputScale: composite.outputScale,
          // MCP inline 専用コンパクト変種のメタ（skim 用。daemon は実ファイル/RAM を直接見るので非 load-bearing）。
          ...(composite.inlineDataUrl
            ? {
                inline: true,
                inlineMime: composite.inlineMime,
                inlineWidth: composite.inlineWidth,
                inlineHeight: composite.inlineHeight,
                inlineBytes: composite.inlineByteLength,
              }
            : {}),
        }
      : null,
    items: (data.items || []).map((it, i) => ({
      n: i + 1,
      id: it.id,
      color: it.color,
      note: it.note,
      intent: it.intent,
      shapeText: it.shapeText,
      anchorLabel: it.anchorLabel,
      selector: it.selector,
      dataAgentId: it.dataAgentId,
      testid: it.testid,
      dataAsin: it.dataAsin,
      href: it.href,
      tag: it.tag,
      role: it.role,
      html: it.html || null,
      a11y: it.a11y || null,
      targetCandidates: it.targetCandidates,
      resolved: it.resolved,
      inViewport: it.inViewport,
      bboxPx: it.bboxPx,
      shapesFrac: it.shapesFrac,
    })),
  };
}

function buildMemoMarkdown({ data, composite, capturedAt, tab }) {
  const lines = [];
  lines.push(t('memo.title'));
  lines.push('');
  lines.push(t('memo.intro'));
  lines.push(t('memo.claudeCode'));
  lines.push(t('memo.codex'));
  lines.push(t('memo.antigravity'));
  lines.push('');
  lines.push(t('memo.urlLine', { url: data.url }));
  lines.push(t('memo.titleLine', { title: data.title }));
  lines.push(t('memo.capturedAt', { at: capturedAt }));
  if (tab) {
    lines.push(
      t('memo.tabLine', {
        tabId: tab.tabId ?? 'unknown',
        windowId: tab.windowId ?? 'unknown',
        index: tab.index == null ? 'unknown' : tab.index + 1,
        active: tab.active ? t('memo.tabActiveYes') : t('memo.tabActiveNo'),
      })
    );
  }
  if (composite) {
    lines.push(
      t('memo.imageLine', {
        width: composite.width,
        height: composite.height,
        dpr: data.dpr,
        downscaled: composite.downscaled ? t('memo.downscaledYes') : t('memo.downscaledNo'),
      })
    );
    lines.push(t('memo.rawImage'));
  } else {
    // text-only(メモのみ同期): スクリーンショットは存在しない。
    lines.push(t('memo.textOnlyLine'));
  }
  lines.push('');
  lines.push(t('memo.instructions'));
  (data.items || []).forEach((it, i) => {
    const n = i + 1;
    const body = (it.note || '').trim() || it.shapeText || t('memo.noMemo');
    const intent = (it.intent || '').trim();
    const where = it.anchorLabel ? t('memo.targetLabel', { label: it.anchorLabel }) : t('memo.targetUnknown');
    const targetBits = [it.dataAsin ? `asin:${it.dataAsin}` : '', it.href ? it.href : ''].filter(Boolean);
    const flags = [];
    if (!it.resolved) flags.push(t('memo.flagUnresolved'));
    else if (!it.inViewport) flags.push(t('memo.flagOffscreen'));
    const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
    const purpose = intent ? t('memo.purposeSuffix', { intent }) : '';
    const targetInfo = targetBits.length ? ` (${targetBits.join(' / ')})` : '';
    lines.push(`${n}. ${body}${purpose} — ${where}${targetInfo}${it.selector ? ` \`${it.selector}\`` : ''}${flagStr}`);
  });
  lines.push('');
  // 旧形式の図形説明はお描き(composite あり)の時だけ意味を持つ（メモのみでは shapeText が全て空）。
  if (composite) {
    lines.push(t('memo.legacyHeading'));
    lines.push(t('memo.legacyNote'));
    (data.items || []).forEach((it, i) => {
      lines.push(`- ${i + 1}: ${it.shapeText}`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

// ---- WebSocket Bidirectional Relay to Daemon ----
let daemonWs = null;
let reconnectTimeout = null;

async function findMatchingTab({ tabId, windowId, urlContains, titleContains }) {
  let tabs = await chrome.tabs.query({});
  if (tabId != null) {
    tabs = tabs.filter(t => t.id === tabId);
  }
  if (windowId != null) {
    tabs = tabs.filter(t => t.windowId === windowId);
  }
  if (urlContains) {
    const lowerUrl = urlContains.toLowerCase();
    tabs = tabs.filter(t => t.url && t.url.toLowerCase().includes(lowerUrl));
  }
  if (titleContains) {
    const lowerTitle = titleContains.toLowerCase();
    tabs = tabs.filter(t => t.title && t.title.toLowerCase().includes(lowerTitle));
  }
  if (tabs.length === 0) return null;
  tabs.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return 0;
  });
  return tabs[0].id;
}

async function connectDaemonWebSocket() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (daemonWs) {
    try {
      daemonWs.onclose = null;
      daemonWs.onerror = null;
      daemonWs.close();
    } catch (e) {}
    daemonWs = null;
  }

  const settings = await getSettings();
  const daemon = settings.daemon || {};
  if (!daemon.enabled || !daemon.url || !daemon.token) {
    return;
  }

  const wsUrl = `${daemon.url}?token=${encodeURIComponent(daemon.token)}`;
  try {
    const ws = new WebSocket(wsUrl);
    daemonWs = ws;

    ws.onopen = () => {
      console.log('[bag] daemon WS connected');
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (msg?.type === 'run_actions') {
        const { requestId, tabId, windowId, urlContains, titleContains, actions, source } = msg;
        try {
          const targetTabId = await findMatchingTab({ tabId, windowId, urlContains, titleContains });
          if (!targetTabId) {
            throw new Error('No matching tab found for the specified filters.');
          }
          const res = await ensureContentAndSend(targetTabId, {
            type: 'RUN_ACTIONS',
            actions,
            source: source || 'execute_actions'
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'run_actions_result',
              requestId,
              ok: true,
              results: res?.results || []
            }));
          }
        } catch (err) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'run_actions_result',
              requestId,
              ok: false,
              error: err.message
            }));
          }
        }
      }
    };

    ws.onclose = () => {
      console.log('[bag] daemon WS closed');
      if (daemonWs === ws) {
        daemonWs = null;
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.warn('[bag] daemon WS error:', err);
    };
  } catch (e) {
    console.warn('[bag] failed to initiate daemon WS:', e);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) return;
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectDaemonWebSocket().catch(() => {});
  }, 5000);
}

// Initial connection on startup/load
connectDaemonWebSocket().catch(() => {});
