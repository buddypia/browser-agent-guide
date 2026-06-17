// バックグラウンド(サービスワーカー)。拡張全体の司令塔。
// - 記憶済みURL/ルールに応じてタブ単位でページ有効化
// - ページ有効化時にコンテンツスクリプトへ動詞レシピを適用
// - サイドパネルからのチャットを受けて、文脈収集 → AI呼び出し → 動詞実行 を行う

import { getSettings, saveSettings } from '../lib/storage.js';
import { findMatchingRules } from '../lib/site-matcher.js';
import { callAI } from '../lib/ai-client.js';
import { buildSystemPrompt } from '../lib/prompt.js';

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

// 拡張アイコンのクリックでサイドパネルを開く。
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---- タブのURL変化を監視してサイドパネルの有効化＋ページ有効化を行う ----
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) {
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
  switch (msg?.type) {
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
    throw new Error('JavaScriptを実行する対象タブを特定できませんでした。');
  }
  if (!chrome.userScripts?.execute) {
    throw new Error('JavaScript注入には Chrome 135+ と userScripts API が必要です。Chromeを更新してください。');
  }

  try {
    await chrome.userScripts.getScripts();
  } catch (err) {
    throw new Error(
      'JavaScript注入には拡張機能詳細の「Allow User Scripts」を有効にしてください。' +
        ` (${String(err?.message || err)})`
    );
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
    throw new Error(`JavaScriptを実行できませんでした: ${String(err?.message || err)}`);
  }

  const result = injections?.[0] || {};
  if (result.error) {
    throw new Error(`JavaScript実行エラー: ${result.error}`);
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
    throw new Error('APIキーが未設定です。設定画面で入力してください。');
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

  const { reply, actions } = await callAI({ ai: settings.ai, messages, verbNames });

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
  if (target?.matchType === 'all') return '全サイトのAI注入';
  if (target?.matchType === 'domain') return `${target.pattern} のAI注入`;
  const cleanTitle = String(title || '').trim();
  if (cleanTitle) return cleanTitle.slice(0, 80);
  try {
    const url = new URL(target?.pattern || '');
    return `${url.hostname}${url.pathname}`;
  } catch {
    return target?.pattern || 'AI注入';
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
      throw new Error(`このページにはコンテンツスクリプトを注入できません(${String(e?.message || e)})。`);
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

async function captureVisualFeedback({ tabId }) {
  if (tabId == null) throw new Error('対象タブを特定できませんでした。');
  const tab = await chrome.tabs.get(tabId);

  // 1) 注釈を px へ解決し、自前UIを隠す。
  const data = await ensureContentAndSend(tabId, { type: 'PREPARE_CAPTURE' });
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    await ensureContentAndSend(tabId, { type: 'FINISH_CAPTURE' }).catch(() => {});
    throw new Error('お描きがありません。「お描き」で図形を描いてメモを書いてから送ってください。');
  }

  // 2) 可視タブを撮る（自前UIは隠れている）。必ず FINISH_CAPTURE で復元する。
  let screenshotDataUrl;
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    await ensureContentAndSend(tabId, { type: 'FINISH_CAPTURE' }).catch(() => {});
  }
  if (!screenshotDataUrl) throw new Error('スクリーンショットを取得できませんでした。');

  // 3) offscreen で注釈を burn-in。
  await ensureOffscreen();
  const res = await sendToOffscreen({
    target: 'offscreen',
    type: 'COMPOSITE_VISUAL_FEEDBACK',
    payload: { screenshotDataUrl, data },
  });
  if (!res?.ok) throw new Error(res?.error || '画像合成に失敗しました。');
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

  const settings = await getSettings();
  const daemon = settings.daemon || {};
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
          image: { shot: composite.dataUrl, raw: screenshotDataUrl },
          annotation,
          memo,
        },
      });
      return { transport: 'daemon', dir: ack.dir, file: `${ack.dir}/shot.png`, id: ack.id, ...common };
    } catch (e) {
      daemonError = String(e?.message || e); // フォールバックして下の downloads へ
    }
  }

  // chrome.downloads フォールバック（Phase 0 と同じ）。
  const slug = slugFromIso(capturedAt);
  const dir = `${INBOX_ROOT}/${slug}`;
  await Promise.all([
    saveDownload(`${dir}/shot.png`, composite.dataUrl),
    saveDownload(`${dir}/raw.png`, screenshotDataUrl),
    saveDownload(`${dir}/annotation.json`, textToDataUrl(JSON.stringify(annotation, null, 2), 'application/json')),
    saveDownload(`${dir}/memo.md`, textToDataUrl(memo, 'text/markdown')),
  ]);

  return { transport: 'downloads', dir, file: `${dir}/shot.png`, daemonError, ...common };
}

// 拡張 → デーモンへ WebSocket で1件 push し、ack を待つ。
// 認証はクエリ ?token=（ブラウザ WebSocket はカスタムヘッダ不可のため）。
function pushToDaemon({ url, token, payload, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    } catch (e) {
      reject(new Error(`WebSocket URL が不正です: ${String(e?.message || e)}`));
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* 既に閉じている */
      }
      reject(new Error('デーモン応答タイムアウト'));
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
      else reject(new Error(m?.error || 'デーモンが ack を返しませんでした'));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('デーモンに接続できません（未起動 / URL違い / トークン不一致）'));
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

// ISO8601 → ファイル名に使える slug（コロン/ドットを除去）。
function slugFromIso(iso) {
  return iso.replace(/[:.]/g, '-').replace(/[^0-9A-Za-z-]/g, '');
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
      testid: it.testid,
      resolved: it.resolved,
      inViewport: it.inViewport,
      bboxPx: it.bboxPx,
      shapesFrac: it.shapesFrac,
    })),
  };
}

function buildMemoMarkdown({ data, composite, capturedAt }) {
  const lines = [];
  lines.push('# 視覚フィードバック (Browser Agent Guide)');
  lines.push('');
  lines.push('> このフォルダの **shot.png を画像として** AI に見せてください（テキスト座標ではなく絵を直接 vision する）。');
  lines.push('> - Claude Code: `shot.png` のパスを会話に貼る / ドラッグ / Ctrl+V');
  lines.push('> - Codex CLI: `codex --image ./shot.png "..."`（または `view_image`）');
  lines.push('> - Antigravity(IDE): 画像をエディタへドラッグ / 貼り付け');
  lines.push('');
  lines.push(`- URL: ${data.url}`);
  lines.push(`- タイトル: ${data.title}`);
  lines.push(`- 取得日時: ${capturedAt}`);
  lines.push(
    `- 画像: shot.png (${composite.width}x${composite.height}px, dpr ${data.dpr}, downscaled: ${composite.downscaled ? 'はい' : 'いいえ'})`
  );
  lines.push('- 元画像(注釈なし): raw.png');
  lines.push('');
  lines.push('## 指示一覧');
  (data.items || []).forEach((it, i) => {
    const n = i + 1;
    const body = (it.note || '').trim() || it.shapeText || '(メモなし)';
    const intent = (it.intent || '').trim();
    const where = it.anchorLabel ? `対象「${it.anchorLabel}」` : '(対象不明)';
    const flags = [];
    if (!it.resolved) flags.push('対象未解決');
    else if (!it.inViewport) flags.push('画面外');
    const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
    lines.push(`${n}. ${body}${intent ? `（目的: ${intent}）` : ''} — ${where}${it.selector ? ` \`${it.selector}\`` : ''}${flagStr}`);
  });
  lines.push('');
  lines.push('## (旧式) 図形の言葉での説明');
  lines.push('> 画像が見られない場合のテキスト fallback。');
  (data.items || []).forEach((it, i) => {
    lines.push(`- ${i + 1}: ${it.shapeText}`);
  });
  lines.push('');
  return lines.join('\n');
}
