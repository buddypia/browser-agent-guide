// バックグラウンド(サービスワーカー)。拡張全体の司令塔。
// - 記憶済みURL/ルールに応じてタブ単位でページ有効化
// - ページ有効化時にコンテンツスクリプトへ動詞レシピを適用
// - サイドパネルからのチャットを受けて、文脈収集 → AI呼び出し → 動詞実行 を行う

import { getSettings, saveSettings } from '../lib/storage.js';
import { findMatchingRules } from '../lib/site-matcher.js';
import { callAI } from '../lib/ai-client.js';
import { buildSystemPrompt } from '../lib/prompt.js';
import { slugFromCapture } from '../lib/slug.js';
import { resolveLocale, normalizeLocale, DEFAULT_LOCALE } from '../sidepanel/i18n.js';

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

// 言語設定が変わったら、次回 ensureI18n で辞書を読み直させる。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aiAdvisorSettings) i18nLoadedFor = null;
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
const RECIPE_VERBS = new Set(['injectHtml', 'injectCss', 'injectScript', 'outlineElement', 'injectButton', 'injectPanel']);
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
      return syncTab(sender?.tab?.id, msg.url);
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
    case 'CAPTURE_VISUAL_FEEDBACK':
      return captureVisualFeedback({ tabId: msg.tabId });
    case 'VISUAL_FEEDBACK_CHANGED':
      return scheduleAutoVisualFeedback({
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
    rule.enabled = true;
    rule.learned = rule.learned !== false;
    rule.source = rule.source || source;
    rule.updatedAt = now;
    if (!rule.label) rule.label = ruleLabel(title, target);
  }

  const currentRecipe = Array.isArray(recipes[rule.id]) ? [...recipes[rule.id]] : [];
  const mergedRecipe = mergeRecipeActions(currentRecipe, actions);
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

function mergeRecipeActions(existing, actions) {
  const next = [...existing];
  const seen = new Set(existing.map(recipeKey));
  for (const action of actions || []) {
    if (!action || !RECIPE_VERBS.has(action.verb)) continue;
    const recipeAction = {
      verb: action.verb,
      args: clonePlain(action.args || {}),
      reason: action.reason || 'チャットで覚えた変更',
    };
    const key = recipeKey(recipeAction);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(recipeAction);
  }
  return next;
}

function recipeKey(action) {
  return JSON.stringify({ verb: action?.verb || '', args: sortKeys(action?.args || {}) });
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      out[key] = sortKeys(value[key]);
      return out;
    }, {});
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
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
// 視覚フィードバック（vision ブリッジ）Phase 0 / MVP
// お描き注釈をスクリーンショットへ burn-in し、Downloads/ai-inbox/<slug>/ へ保存する。
//   流れ: content(PREPARE_CAPTURE) → captureVisibleTab → content(FINISH_CAPTURE)
//        → offscreen(合成) → chrome.downloads(shot.png/raw.png/annotation.json/memo.md)
// ===========================================================================

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const INBOX_ROOT = 'ai-inbox';
let creatingOffscreen = null;

async function scheduleAutoVisualFeedback({ tabId, sendCount } = {}) {
  if (tabId == null) return { scheduled: false, reason: 'no-tab' };
  if (Number(sendCount || 0) <= 0) {
    clearAutoSyncTimer(tabId);
    return { scheduled: false, reason: 'empty' };
  }

  const settings = await getSettings();
  const daemon = settings.daemon || {};
  if (!settings.visualFeedback?.autoSync || !daemon.enabled || !daemon.url || !daemon.token) {
    clearAutoSyncTimer(tabId);
    return { scheduled: false, reason: 'disabled' };
  }

  const delayMs = clampAutoSyncDebounce(settings.visualFeedback?.autoSyncDebounceMs);
  setAutoSyncTimer(tabId, delayMs);
  return { scheduled: true, delayMs };
}

function setAutoSyncTimer(tabId, delayMs) {
  clearAutoSyncTimer(tabId);
  const timer = setTimeout(() => {
    autoSyncTimers.delete(tabId);
    runAutoVisualFeedback(tabId).catch((e) => {
      console.warn('[bag] visual feedback auto sync failed:', e?.message || e);
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

async function runAutoVisualFeedback(tabId) {
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
  // captureVisibleTab captures the active tab in a window, so skip if the annotated tab is no longer active.
  if (!tab?.active) return;

  autoSyncInFlight.add(tabId);
  try {
    await captureVisualFeedback({ tabId, autoSync: true });
  } finally {
    autoSyncInFlight.delete(tabId);
  }
}

async function captureVisualFeedback({ tabId, autoSync = false }) {
  if (tabId == null) throw new Error(t('errors.targetTabMissing'));
  const settings = await getSettings();
  const daemon = settings.daemon || {};
  if (autoSync && (!settings.visualFeedback?.autoSync || !daemon.enabled || !daemon.url || !daemon.token)) {
    return { transport: 'skipped', reason: 'auto-sync-disabled' };
  }
  const tab = await chrome.tabs.get(tabId);
  if (autoSync && !tab?.active) {
    return { transport: 'skipped', reason: 'tab-not-active' };
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
    type: 'COMPOSITE_VISUAL_FEEDBACK',
    payload: { screenshotDataUrl, data },
  });
  if (!res?.ok) throw new Error(res?.error ? t(res.error) : t('sw.err.compositeFailed'));
  const composite = res.result;

  // 4) 保存。デーモン有効時は WebSocket push、未到達時は chrome.downloads にフォールバック。
  const capturedAt = new Date().toISOString();
  const annotation = buildAnnotationJson({ data, composite, capturedAt });
  const memo = buildMemoMarkdown({ data, composite, capturedAt });
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
          type: 'visual_feedback',
          capturedAt,
          url: data.url,
          title: data.title,
          dpr: data.dpr,
          viewport: data.viewport,
          downloadsDir: knownDownloadsDir || undefined,
          image: { shot: composite.dataUrl, raw: screenshotDataUrl },
          annotation,
          memo,
        },
      });
      return { transport: 'daemon', dir: ack.dir, file: `${ack.dir}/shot.png`, id: ack.id, ...common };
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

function buildAnnotationJson({ data, composite, capturedAt }) {
  return {
    schema: 'bag.visual-feedback/v0',
    url: data.url,
    title: data.title,
    capturedAt,
    dpr: data.dpr,
    viewport: data.viewport,
    image: {
      file: 'shot.png',
      raw: 'raw.png',
      width: composite.width,
      height: composite.height,
      downscaled: composite.downscaled,
      outputScale: composite.outputScale,
    },
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
      resolved: it.resolved,
      inViewport: it.inViewport,
      bboxPx: it.bboxPx,
      shapesFrac: it.shapesFrac,
    })),
  };
}

function buildMemoMarkdown({ data, composite, capturedAt }) {
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
  lines.push(
    t('memo.imageLine', {
      width: composite.width,
      height: composite.height,
      dpr: data.dpr,
      downscaled: composite.downscaled ? t('memo.downscaledYes') : t('memo.downscaledNo'),
    })
  );
  lines.push(t('memo.rawImage'));
  lines.push('');
  lines.push(t('memo.instructions'));
  (data.items || []).forEach((it, i) => {
    const n = i + 1;
    const body = (it.note || '').trim() || it.shapeText || t('memo.noMemo');
    const intent = (it.intent || '').trim();
    const where = it.anchorLabel ? t('memo.targetLabel', { label: it.anchorLabel }) : t('memo.targetUnknown');
    const flags = [];
    if (!it.resolved) flags.push(t('memo.flagUnresolved'));
    else if (!it.inViewport) flags.push(t('memo.flagOffscreen'));
    const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
    const purpose = intent ? t('memo.purposeSuffix', { intent }) : '';
    lines.push(`${n}. ${body}${purpose} — ${where}${it.selector ? ` \`${it.selector}\`` : ''}${flagStr}`);
  });
  lines.push('');
  lines.push(t('memo.legacyHeading'));
  lines.push(t('memo.legacyNote'));
  (data.items || []).forEach((it, i) => {
    lines.push(`- ${i + 1}: ${it.shapeText}`);
  });
  lines.push('');
  return lines.join('\n');
}
