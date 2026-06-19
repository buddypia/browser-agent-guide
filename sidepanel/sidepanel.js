import { getSettings, patchSettings } from '../lib/storage.js';
import { createI18n, DEFAULT_LOCALE, LANGUAGE_OPTIONS, languageName, localeToIntl, normalizeLocale, resolveLocale } from './i18n.js';

// サイドパネルのチャットUI。background経由でAI呼び出しと動詞実行を行う。

const els = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  composer: document.getElementById('composer'),
  banner: document.getElementById('status-banner'),
  btnPick: document.getElementById('btn-pick'),
  btnDraw: document.getElementById('btn-draw'),
  btnContext: document.getElementById('btn-context'),
  btnAffordances: document.getElementById('btn-affordances'),
  btnHistory: document.getElementById('btn-history'),
  btnSettings: document.getElementById('btn-settings'),
  languageSelect: document.getElementById('language-select'),
  rememberScope: document.getElementById('remember-scope'),
  annoPanel: document.getElementById('anno-panel'),
  annoList: document.getElementById('anno-list'),
  annoFoot: document.getElementById('anno-foot'),
  btnCapture: document.getElementById('btn-capture'),
  captureCount: document.getElementById('capture-count'),
  btnAnnoRefresh: document.getElementById('btn-anno-refresh'),
  memoCountBadge: document.getElementById('memo-count-badge'),
  promptHistoryPanel: document.getElementById('prompt-history-panel'),
  promptHistoryList: document.getElementById('prompt-history-list'),
  btnHistoryClear: document.getElementById('btn-history-clear'),
  btnClearChat: document.getElementById('btn-clear-chat'),
};

const CHAT_HISTORY_KEY = 'aiAdvisorChatHistoryByPage';
const PROMPT_HISTORY_KEY = 'aiAdvisorPromptHistory';
const MAX_CHAT_PAGES = 25;
const MAX_CHAT_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 8000;
const MAX_PROMPT_HISTORY = 50;
const MAX_PROMPT_CHARS = 4000;
const REMEMBER_SCOPES = new Set(['page', 'domain', 'all']);

let i18n = null;
let suppressNextSettingsRefresh = false;

let state = {
  tabId: null,
  url: '',
  title: '',
  pageKey: '',
  language: DEFAULT_LOCALE,
  history: [],
  promptHistory: [],
  promptCursor: null,
  rememberScope: 'page',
  activeTabState: null,
  annotations: [],
  busy: false,
};

function t(key, values) {
  return i18n?.t(key, values) ?? key;
}

function renderLanguageOptions() {
  els.languageSelect.innerHTML = '';
  LANGUAGE_OPTIONS.forEach((language) => {
    const opt = document.createElement('option');
    opt.value = language.value;
    // 国旗で表示(Windows は国旗フォント非搭載のため文字ペアにフォールバック)。
    opt.textContent = language.flag;
    opt.title = language.label;
    opt.setAttribute('aria-label', language.label);
    els.languageSelect.appendChild(opt);
  });
  els.languageSelect.value = state.language;
}

function applyI18n() {
  document.documentElement.lang = state.language;
  document.title = t('document.title');
  els.languageSelect.value = state.language;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  });
}

function rerenderLocalizedContent() {
  applyI18n();
  renderChatHistory();
  renderPromptHistory();
  renderAnnotationList(state.annotations);
  if (state.activeTabState) renderBanner(state.activeTabState);
  syncHistoryButton();
}

async function changeLanguage(nextLanguage) {
  const previous = state.language;
  const language = normalizeLocale(nextLanguage);
  if (language === previous) return;

  els.languageSelect.disabled = true;
  try {
    await i18n.setLocale(language);
    state.language = i18n.locale;
    suppressNextSettingsRefresh = true;
    await patchSettings({ ui: { language: state.language } });
    rerenderLocalizedContent();
    showBanner(escapeHtml(t('language.changed', { language: languageName(state.language) })), true);
  } catch (e) {
    suppressNextSettingsRefresh = false;
    await i18n.setLocale(previous);
    state.language = previous;
    els.languageSelect.value = previous;
    showBanner(escapeHtml(t('errors.languageChangeFailed', { message: e.message })), false);
  } finally {
    els.languageSelect.disabled = false;
  }
}

async function handleSettingsChanged(settings) {
  if (!i18n) return;
  const nextLanguage = resolveLocale(settings?.ui?.language);
  if (nextLanguage !== state.language) {
    await i18n.setLocale(nextLanguage);
    state.language = i18n.locale;
    rerenderLocalizedContent();
  }
  await refreshState();
}

// background へメッセージ送信(エラーはthrow)。
function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || t('errors.unknown')));
      resolve(res.result);
    });
  });
}

async function getLocal(key, fallback) {
  try {
    const raw = await chrome.storage.local.get(key);
    return raw[key] ?? fallback;
  } catch {
    return fallback;
  }
}

async function setLocal(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

async function refreshState() {
  try {
    const s = await send({ type: 'GET_ACTIVE_TAB_STATE' });
    state.activeTabState = s;
    state.tabId = s.tabId;
    state.url = s.url || '';
    state.title = s.title || '';
    state.rememberScope = normalizeRememberScope(s.rememberScope);
    els.rememberScope.value = state.rememberScope;
    const nextPageKey = pageKeyForUrl(state.url);
    if (nextPageKey !== state.pageKey) {
      state.pageKey = nextPageKey;
      await loadChatHistory();
    }
    renderBanner(s);
    refreshAnnotations();
  } catch (e) {
    showBanner(escapeHtml(t('errors.stateFetchFailed', { message: e.message })), false);
  }
}

function normalizeRememberScope(scope) {
  return REMEMBER_SCOPES.has(scope) ? scope : 'page';
}

function renderBanner(s) {
  if (!s.hasApiKey) {
    showBanner(`${escapeHtml(t('banner.apiKeyMissing'))} <a id="open-opt">${escapeHtml(t('common.openSettings'))}</a>`, false);
  } else if (!s.matched) {
    showBanner(escapeHtml(t('banner.pageNotRemembered')), false);
  } else {
    const label = s.remembered ? t('banner.rememberedPage') : t('banner.targetRule');
    showBanner(escapeHtml(t('banner.connected', { label, provider: s.provider })), true);
  }
  const link = document.getElementById('open-opt');
  if (link) link.onclick = () => send({ type: 'OPEN_OPTIONS' });
}

function showBanner(html, ok) {
  els.banner.hidden = false;
  els.banner.innerHTML = html;
  els.banner.classList.toggle('ok', !!ok);
}

// ---- 履歴の保存・復元 ----
function pageKeyForUrl(url) {
  if (!url || !/^https?:/i.test(String(url))) return '';
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '';
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }))
    .slice(-MAX_CHAT_MESSAGES);
}

function normalizePromptHistory(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return { text: entry, createdAt: '' };
      if (entry && typeof entry.text === 'string') {
        return { text: entry.text, createdAt: entry.createdAt || '' };
      }
      return null;
    })
    .filter((entry) => entry && entry.text.trim())
    .map((entry) => ({
      text: entry.text.trim().slice(0, MAX_PROMPT_CHARS),
      createdAt: entry.createdAt,
    }))
    .slice(0, MAX_PROMPT_HISTORY);
}

async function loadChatHistory() {
  if (!state.pageKey) {
    state.history = [];
    renderChatHistory();
    return;
  }
  const all = await getLocal(CHAT_HISTORY_KEY, {});
  state.history = normalizeMessages(all?.[state.pageKey]?.messages || []);
  renderChatHistory();
}

async function persistChatHistory(messages = state.history, page = state) {
  const pageKey = page.pageKey || '';
  if (!pageKey) return;
  const all = await getLocal(CHAT_HISTORY_KEY, {});
  const now = new Date().toISOString();
  const next = all && typeof all === 'object' && !Array.isArray(all) ? { ...all } : {};
  next[pageKey] = {
    url: page.url || '',
    title: page.title || '',
    updatedAt: now,
    messages: normalizeMessages(messages),
  };

  const pruned = Object.fromEntries(
    Object.entries(next)
      .sort(([, a], [, b]) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
      .slice(0, MAX_CHAT_PAGES)
  );
  await setLocal(CHAT_HISTORY_KEY, pruned);
}

async function loadPromptHistory() {
  state.promptHistory = normalizePromptHistory(await getLocal(PROMPT_HISTORY_KEY, []));
  renderPromptHistory();
}

async function rememberPrompt(text) {
  const clean = text.trim().slice(0, MAX_PROMPT_CHARS);
  if (!clean) return;
  const next = [
    { text: clean, createdAt: new Date().toISOString() },
    ...state.promptHistory.filter((entry) => entry.text !== clean),
  ].slice(0, MAX_PROMPT_HISTORY);
  state.promptHistory = next;
  state.promptCursor = null;
  await setLocal(PROMPT_HISTORY_KEY, next);
  renderPromptHistory();
}

async function clearPromptHistory() {
  state.promptHistory = [];
  state.promptCursor = null;
  try {
    await chrome.storage.local.remove(PROMPT_HISTORY_KEY);
  } catch {
    /* 履歴の表示だけは即時に空へ戻す */
  }
  renderPromptHistory();
  els.input.focus();
}

function renderChatHistory() {
  els.messages.innerHTML = '';
  if (!state.history.length) renderEmptyHint();
  state.history.forEach((msg) => addMessage(msg.role, msg.content));
  scrollToBottom();
}

function renderEmptyHint() {
  const hint = document.createElement('div');
  hint.className = 'empty-hint';
  hint.id = 'empty-hint';

  const title = document.createElement('h1');
  title.textContent = t('empty.title');

  const description = document.createElement('p');
  description.className = 'empty-desc';
  description.textContent = t('empty.description');

  // タップで composer を埋めるサンプル指示チップ(既存の usePrompt を再利用)。
  const chips = document.createElement('div');
  chips.className = 'starter-chips';
  ['empty.chipShorten', 'empty.chipEmphasize'].forEach((key) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'starter-chip';
    chip.textContent = t(key);
    chip.addEventListener('click', () => usePrompt(t(key)));
    chips.appendChild(chip);
  });
  // 「まず目印を付ける」は composer ではなく Mark 行(補足を付ける)へ誘導する。
  const markChip = document.createElement('button');
  markChip.type = 'button';
  markChip.className = 'starter-chip meta';
  markChip.textContent = t('empty.chipMark');
  markChip.addEventListener('click', () => els.btnPick.focus());
  chips.appendChild(markChip);

  const pointer = document.createElement('p');
  pointer.className = 'start-pointer';
  pointer.textContent = t('empty.startPointer');

  // 3手順レールはコンパクトな副次ヒントへ降格(目的・手がかり・検証)。
  const rail = document.createElement('p');
  rail.className = 'rail-mini';
  rail.setAttribute('aria-label', t('empty.railsLabel'));
  rail.textContent = [t('empty.goalLabel'), t('empty.contextLabel'), t('empty.verifyLabel')].join(' · ');

  hint.append(title, description, chips, pointer, rail);
  els.messages.appendChild(hint);
}

function renderPromptHistory() {
  els.promptHistoryList.innerHTML = '';
  if (!state.promptHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('history.empty');
    els.promptHistoryList.appendChild(empty);
    return;
  }

  state.promptHistory.forEach((entry) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-item';
    const text = document.createElement('span');
    text.className = 'history-text';
    text.textContent = entry.text;
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent = formatHistoryDate(entry.createdAt);
    row.append(text, meta);
    row.addEventListener('click', () => usePrompt(entry.text));
    els.promptHistoryList.appendChild(row);
  });
}

function syncHistoryButton() {
  const open = !els.promptHistoryPanel.hidden;
  els.btnHistory.classList.toggle('is-active', open);
  els.btnHistory.setAttribute('aria-expanded', String(open));
}

function formatHistoryDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(localeToIntl(state.language), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function usePrompt(text) {
  els.input.value = text;
  els.input.focus();
  els.input.setSelectionRange(text.length, text.length);
}

function movePromptCursor(direction) {
  if (!state.promptHistory.length) return;
  if (state.promptCursor == null) {
    state.promptCursor = direction > 0 ? 0 : state.promptHistory.length - 1;
  } else {
    state.promptCursor += direction;
  }

  if (state.promptCursor < 0) {
    state.promptCursor = null;
    usePrompt('');
    return;
  }
  if (state.promptCursor >= state.promptHistory.length) {
    state.promptCursor = state.promptHistory.length - 1;
  }
  usePrompt(state.promptHistory[state.promptCursor].text);
}

// ---- メッセージ描画 ----
function addMessage(role, content) {
  document.getElementById('empty-hint')?.remove();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="role">${escapeHtml(roleLabel(role))}</div>`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function roleLabel(role) {
  if (role === 'user') return t('roles.user');
  if (role === 'assistant') return t('roles.assistant');
  return t('roles.error');
}

function renderActions(parent, actions, results) {
  if (!actions?.length) return;
  const box = document.createElement('div');
  box.className = 'actions';
  actions.forEach((a, i) => {
    const r = results?.[i];
    const ok = r?.ok;
    const div = document.createElement('div');
    div.className = `action ${ok === true ? 'ok' : ok === false ? 'fail' : ''}`;
    const detail = r
      ? ok
        ? formatResult(r.result)
        : t('actionsResult.failed', { message: r.error })
      : t('actionsResult.notRun');
    div.innerHTML = `<span class="verb">${escapeHtml(a.verb)}</span> <span class="muted">${escapeHtml(a.reason || '')}</span>
      <div class="detail">${escapeHtml(detail)}</div>`;
    box.appendChild(div);
  });
  parent.appendChild(box);
  scrollToBottom();
}

function formatResult(result) {
  if (result == null) return t('result.ok');
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<div class="typing"><span class="spinner"></span>${escapeHtml(t('chat.typing'))}</div>`;
  els.messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 送信処理 ----
async function handleSubmit(text) {
  const cleanText = text.trim();
  if (!cleanText || state.busy) return;
  if (state.tabId == null) await refreshState();
  if (state.tabId == null) {
    addMessage('error', t('errors.targetTabMissing'));
    return;
  }
  setBusy(true);
  await rememberPrompt(cleanText);
  const previousHistory = normalizeMessages(state.history);
  const userMessage = { role: 'user', content: cleanText };
  const submitPage = { pageKey: state.pageKey, url: state.url, title: state.title };
  addMessage('user', cleanText);
  const typing = addTyping();

  try {
    const { reply, actions, results } = await send({
      type: 'CHAT',
      tabId: state.tabId,
      text: cleanText,
      history: previousHistory,
      rememberScope: state.rememberScope,
    });
    typing.remove();
    const nextHistory = normalizeMessages([...previousHistory, userMessage, { role: 'assistant', content: reply || '' }]);
    if (state.pageKey === submitPage.pageKey) {
      const wrap = addMessage('assistant', reply || t('chat.noReply'));
      renderActions(wrap, actions, results);
      state.history = nextHistory;
      if (actions?.length) refreshState();
    }
    await persistChatHistory(nextHistory, submitPage);
  } catch (e) {
    typing.remove();
    const nextHistory = normalizeMessages([...previousHistory, userMessage]);
    if (state.pageKey === submitPage.pageKey) {
      addMessage('error', e.message);
      state.history = nextHistory;
    }
    await persistChatHistory(nextHistory, submitPage);
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  state.busy = b;
  els.send.disabled = b;
  els.input.disabled = b;
  if (!b) els.input.focus();
}

// ---- ツールバー: 単一動詞の直接実行 ----
async function runVerb(verb, args) {
  if (state.tabId == null) await refreshState();
  try {
    const result = await send({ type: 'RUN_VERB', tabId: state.tabId, verb, args, rememberScope: state.rememberScope });
    return result;
  } catch (e) {
    addMessage('error', t('errors.runVerbFailed', { verb, message: e.message }));
    return null;
  }
}

// ---- イベント ----
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value;
  els.input.value = '';
  handleSubmit(text);
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
    return;
  }

  const atStart = els.input.selectionStart === 0 && els.input.selectionEnd === 0;
  const atEnd = els.input.selectionStart === els.input.value.length && els.input.selectionEnd === els.input.value.length;
  if (e.key === 'ArrowUp' && atStart && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    movePromptCursor(1);
  } else if (e.key === 'ArrowDown' && atEnd && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    movePromptCursor(-1);
  }
});

els.languageSelect.addEventListener('change', (e) => {
  changeLanguage(e.target.value);
});

// 「補足を付ける」: ページ上で要素をクリックして補足を付ける注釈モードを開始。
els.btnPick.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  try {
    await send({ type: 'START_PICKER', tabId: state.tabId });
    showBanner(escapeHtml(t('picker.started')), true);
  } catch (e) {
    addMessage('error', t('errors.pickerStartFailed', { message: e.message }));
  }
});

// 「お描き」: ページ上で円/四角/矢印/ペンを使って印を描くお描きモードを開始。
els.btnDraw.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  try {
    await send({ type: 'START_DRAWING', tabId: state.tabId });
    showBanner(escapeHtml(t('drawing.started')), true);
  } catch (e) {
    addMessage('error', t('errors.drawingStartFailed', { message: e.message }));
  }
});

// 「画像でAIへ」: お描きをスクリーンショットに焼き込み(burn-in)、画像ファイルとして
// ダウンロード保存する。AIにはその shot.png を vision で見せる(テキスト変換ではなく絵を見る)。
els.btnCapture.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  if (els.btnCapture.disabled) return;
  els.btnCapture.disabled = true;
  showBanner(escapeHtml(t('capture.processing')), true);
  try {
    const res = await send({ type: 'CAPTURE_VISUAL_FEEDBACK', tabId: state.tabId });
    const dir = res?.dir || '';
    const meta = t('capture.meta', {
      width: res.width,
      height: res.height,
      downscaled: res.downscaled ? t('capture.downscaled') : '',
      drawn: res.drawn,
      items: res.items,
    });
    if (res.transport === 'daemon') {
      addMessage(
        'assistant',
        [
          t('capture.sentDaemon'),
          '',
          t('capture.savePath', { path: dir }),
          meta,
          '',
          t('capture.daemonCliHint'),
          t('capture.daemonScopeHint'),
        ].join('\n')
      );
      showBanner(escapeHtml(t('capture.daemonSentBanner')), true);
    } else {
      const note = res.daemonError ? t('capture.fallbackNote', { message: res.daemonError }) : '';
      addMessage(
        'assistant',
        [
          t('capture.savedDownload'),
          '',
          // 実際の保存先(絶対パス)が取れていればそれを表示。ダウンロード先はブラウザ設定依存で
          // ~/Downloads とは限らない(移動済み/Edge/Brave 等)ため、取れた絶対パスを優先する。
          t('capture.savePath', { path: res.absDir || `Downloads/${dir}` }),
          meta,
          '',
          t('capture.imageInstruction'),
          t('capture.memoInstruction') + note,
        ].join('\n')
      );
      showBanner(escapeHtml(t('capture.savedBanner')), true);
    }
  } catch (e) {
    addMessage('error', t('errors.captureFailed', { message: e.message }));
    showBanner(escapeHtml(t('errors.captureFailed', { message: e.message })), false);
  } finally {
    els.btnCapture.disabled = false;
  }
});

// 「文脈をコピー」: 別のAIチャットに貼れる決定的なページ説明を生成してコピー。
els.btnContext.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  try {
    const res = await send({ type: 'EXPORT_CONTEXT', tabId: state.tabId });
    const text = res?.text || '';
    await navigator.clipboard.writeText(text);
    addMessage('assistant', t('context.copied', { text }));
  } catch (e) {
    addMessage('error', t('errors.contextCopyFailed', { message: e.message }));
  }
});

els.btnAffordances.addEventListener('click', async () => {
  const r = await runVerb('listAffordances', {});
  if (r?.ok) {
    const list = r.result?.affordances || [];
    const text = list.length
      ? list.map((a) => `[${a.aiId}] <${a.role}> ${a.label}`).join('\n')
      : t('context.noAffordances');
    addMessage('assistant', text);
  }
});

els.btnSettings.addEventListener('click', () => {
  send({ type: 'OPEN_OPTIONS' });
});

els.rememberScope.addEventListener('change', async (e) => {
  const prev = state.rememberScope;
  const scope = normalizeRememberScope(e.target.value);
  state.rememberScope = scope;
  try {
    await send({ type: 'SET_REMEMBER_SCOPE', scope });
    showBanner(escapeHtml(t('memory.scopeSaved', { scope: rememberScopeLabel(scope) })), true);
  } catch (err) {
    addMessage('error', t('errors.scopeChangeFailed', { message: err.message }));
    state.rememberScope = prev;
    els.rememberScope.value = state.rememberScope;
  }
});

els.btnAnnoRefresh.addEventListener('click', refreshAnnotations);
els.btnHistory.addEventListener('click', () => {
  els.promptHistoryPanel.hidden = !els.promptHistoryPanel.hidden;
  if (!els.promptHistoryPanel.hidden) renderPromptHistory();
  syncHistoryButton();
});
els.btnHistoryClear.addEventListener('click', clearPromptHistory);
els.btnClearChat.addEventListener('click', () => {
  clearChat();
});

async function clearChat() {
  if (state.busy) return;
  if (!confirm(t('confirm.clearChat'))) return;
  state.history = [];
  await persistChatHistory();
  renderChatHistory();
  els.input.value = '';
  els.input.focus();
}

// ---- 保存済み補足の一覧 ----
async function refreshAnnotations() {
  if (state.tabId == null) return;
  try {
    const res = await send({ type: 'LIST_ANNOTATIONS', tabId: state.tabId });
    renderAnnotationList(res?.annotations || []);
  } catch {
    renderAnnotationList([]);
  }
}

function kindLabel(kind) {
  return t(`annotations.kind.${kind}`) === `annotations.kind.${kind}` ? t('annotations.kind.fallback') : t(`annotations.kind.${kind}`);
}

function rememberScopeLabel(scope) {
  return {
    page: t('memory.pageFull'),
    domain: t('memory.domainFull'),
    all: t('memory.allFull'),
  }[scope] || t('memory.pageFull');
}

function updateMemoCountBadge(list) {
  const drawings = list.filter((a) => a.kind === 'drawing');
  const count = drawings.length;
  const sendCount = drawings.filter((a) => a.forAI !== false).length;
  if (els.memoCountBadge) {
    if (count > 0) {
      els.memoCountBadge.hidden = false;
      els.memoCountBadge.textContent = String(count);
      els.memoCountBadge.title = t('annotations.memoCountTitle', { count, send: sendCount });
    } else {
      els.memoCountBadge.hidden = true;
      els.memoCountBadge.textContent = '';
      els.memoCountBadge.removeAttribute('title');
    }
  }
  // 「AI送信トレイ」を画像化するCTA。forAI OFF のお描きだけなら capture 側も空なので出さない。
  if (els.annoFoot) els.annoFoot.hidden = sendCount === 0;
  if (els.captureCount) els.captureCount.textContent = sendCount > 0 ? String(sendCount) : '';
}

function renderAnnotationList(list) {
  state.annotations = Array.isArray(list) ? list : [];
  els.annoList.innerHTML = '';
  updateMemoCountBadge(state.annotations);
  if (!state.annotations.length) {
    els.annoPanel.hidden = true;
    return;
  }
  els.annoPanel.hidden = false;
  const drawings = state.annotations.filter((a) => a.kind === 'drawing');
  if (drawings.length) renderSendTray(drawings);

  const supporting = state.annotations.filter((a) => a.kind !== 'drawing');
  if (supporting.length) {
    const group = document.createElement('div');
    group.className = 'anno-support';
    const title = document.createElement('div');
    title.className = 'anno-support-title';
    title.textContent = t('annotations.otherNotes');
    group.appendChild(title);
    supporting.forEach((a) => group.appendChild(renderSupportAnnotationItem(a)));
    els.annoList.appendChild(group);
  }
}

function renderSendTray(drawings) {
  const sendCount = drawings.filter((a) => a.forAI !== false).length;
  const savedOnly = drawings.length - sendCount;
  const unresolved = drawings.filter((a) => !a.resolved).length;

  const summary = document.createElement('div');
  summary.className = 'anno-tray-summary';
  summary.append(
    buildTrayMetric(sendCount, t('annotations.sendCount'), 'send'),
    buildTrayMetric(savedOnly, t('annotations.savedOnlyCount'), 'saved'),
    buildTrayMetric(unresolved, t('annotations.needsCheckCount'), unresolved ? 'warn' : '')
  );
  els.annoList.appendChild(summary);

  if (!sendCount) {
    const empty = document.createElement('div');
    empty.className = 'anno-tray-empty';
    empty.textContent = t('annotations.trayEmpty');
    els.annoList.appendChild(empty);
  }

  drawings.forEach((a, index) => {
    els.annoList.appendChild(renderDrawingTrayItem(a, index + 1));
  });
}

function buildTrayMetric(value, label, tone) {
  const cell = document.createElement('div');
  cell.className = `anno-tray-metric ${tone || ''}`.trim();
  const num = document.createElement('b');
  num.textContent = String(value);
  const text = document.createElement('span');
  text.textContent = label;
  cell.append(num, text);
  return cell;
}

function renderDrawingTrayItem(a, index) {
  const row = document.createElement('div');
  row.className = `anno-tray-item${a.resolved ? '' : ' unresolved'}${a.forAI === false ? ' off' : ''}`;
  row.appendChild(renderDrawingPreview(a, index));

  const body = document.createElement('div');
  body.className = 'anno-tray-body';

  const head = document.createElement('div');
  head.className = 'anno-tray-title-row';
  const num = document.createElement('span');
  num.className = 'anno-tray-num';
  num.textContent = String(index);
  const title = document.createElement('span');
  title.className = 'anno-tray-title';
  title.textContent = a.note || a.shapeText || t('annotations.kind.drawing');
  const flag = document.createElement('span');
  flag.className = `anno-flag ${a.forAI === false ? 'off' : 'on'}`;
  flag.textContent = a.forAI === false ? t('annotations.forAIOff') : t('annotations.forAIOn');
  head.append(num, title, flag);

  const sub = document.createElement('div');
  sub.className = 'anno-sub';
  sub.textContent = a.intent || a.shapeText || t('annotations.visualIncluded');

  const meta = document.createElement('div');
  meta.className = 'anno-tray-meta';
  const target = document.createElement('span');
  target.textContent = a.target ? t('annotations.target', { target: a.target }) : t('annotations.targetUnknown');
  meta.appendChild(target);
  if (!a.resolved) {
    const warn = document.createElement('span');
    warn.className = 'anno-warn';
    warn.textContent = t('annotations.unresolved');
    meta.appendChild(warn);
  }
  if (a.forAI === false) {
    const off = document.createElement('span');
    off.textContent = t('annotations.visualExcluded');
    meta.appendChild(off);
  }

  if (!a.resolved) {
    const hint = document.createElement('div');
    hint.className = 'anno-tray-hint';
    hint.textContent = t('annotations.unresolvedHint');
    body.append(head, sub, meta, hint, buildAnnotationActions(a, true));
  } else {
    body.append(head, sub, meta, buildAnnotationActions(a, true));
  }
  row.appendChild(body);
  return row;
}

function renderSupportAnnotationItem(a) {
  const row = document.createElement('div');
  row.className = 'anno-item' + (a.resolved ? '' : ' unresolved');
  const kind = document.createElement('span');
  kind.className = 'anno-kind';
  kind.textContent = kindLabel(a.kind);

  const body = document.createElement('span');
  body.className = 'anno-body';
  const title = document.createElement('span');
  title.className = 'anno-title';
  title.textContent = annotationTitle(a);
  body.appendChild(title);
  const sub = annotationSub(a);
  if (sub) {
    const subEl = document.createElement('span');
    subEl.className = 'anno-sub';
    subEl.textContent = sub;
    body.appendChild(subEl);
  }
  if (a.target) {
    const target = document.createElement('span');
    target.className = 'anno-target';
    target.textContent = t('annotations.target', { target: a.target });
    body.appendChild(target);
  }
  if (!a.resolved) {
    const warn = document.createElement('span');
    warn.className = 'anno-warn';
    warn.textContent = t('annotations.unresolved');
    body.appendChild(warn);
  }

  row.append(kind, body, buildAnnotationActions(a, false));
  return row;
}

function annotationTitle(a) {
  if (a.kind === 'note') return a.note || t('annotations.noTitle');
  if (a.kind === 'marker') return a.name || t('annotations.noTitle');
  if (a.kind === 'drawing') return a.note || a.shapeText || t('annotations.kind.drawing');
  return a.label || t('annotations.noTitle');
}

function annotationSub(a) {
  if (a.kind === 'drawing') return a.intent || a.shapeText || '';
  return a.intent || (a.kind === 'note' ? '' : a.note) || '';
}

function buildAnnotationActions(a, onPageLabel) {
  const actions = document.createElement('span');
  actions.className = 'anno-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.dataset.act = 'edit';
  edit.title = t('annotations.edit');
  edit.textContent = onPageLabel ? t('annotations.openOnPage') : t('annotations.edit');
  edit.addEventListener('click', async () => {
    await send({ type: 'EDIT_ANNOTATION', tabId: state.tabId, id: a.id });
  });
  const del = document.createElement('button');
  del.type = 'button';
  del.dataset.act = 'del';
  del.title = t('annotations.delete');
  del.textContent = t('annotations.delete');
  del.addEventListener('click', async () => {
    await send({ type: 'REMOVE_ANNOTATION', tabId: state.tabId, id: a.id });
    refreshAnnotations();
  });
  actions.append(edit, del);
  return actions;
}

function renderDrawingPreview(a, index) {
  const wrap = document.createElement('div');
  wrap.className = 'anno-preview';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 72');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('annotations.trayPreviewLabel', { n: index }));
  svg.appendChild(svgNode('rect', { x: 1, y: 1, width: 118, height: 70, rx: 7, class: 'anno-preview-bg' }));
  svg.appendChild(svgNode('rect', { x: 11, y: 12, width: 68, height: 8, rx: 3, class: 'anno-preview-line strong' }));
  svg.appendChild(svgNode('rect', { x: 11, y: 27, width: 94, height: 6, rx: 3, class: 'anno-preview-line' }));
  svg.appendChild(svgNode('rect', { x: 11, y: 40, width: 58, height: 6, rx: 3, class: 'anno-preview-line' }));

  const shapes = a.shapePreview?.shapes || [];
  if (shapes.length) {
    shapes.forEach((shape) => drawPreviewShape(svg, shape, a.shapePreview?.color));
  } else {
    drawPreviewShape(svg, { type: 'rect', x: 0.16, y: 0.26, w: 0.5, h: 0.42, color: a.shapePreview?.color }, a.shapePreview?.color);
  }

  const badge = svgNode('g', { class: 'anno-preview-badge' });
  badge.appendChild(svgNode('circle', { cx: 104, cy: 17, r: 10 }));
  const text = svgNode('text', { x: 104, y: 21, 'text-anchor': 'middle' });
  text.textContent = String(index);
  badge.appendChild(text);
  svg.appendChild(badge);
  wrap.appendChild(svg);
  return wrap;
}

function drawPreviewShape(svg, shape, fallbackColor) {
  const color = safePreviewColor(shape.color || fallbackColor);
  const attrs = {
    fill: 'none',
    stroke: color,
    'stroke-width': 3,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  const px = (x) => 10 + Number(x || 0) * 100;
  const py = (y) => 10 + Number(y || 0) * 52;
  if (shape.type === 'rect') {
    svg.appendChild(svgNode('rect', { ...attrs, x: px(shape.x), y: py(shape.y), width: Number(shape.w || 0) * 100, height: Number(shape.h || 0) * 52, rx: 4 }));
  } else if (shape.type === 'ellipse') {
    svg.appendChild(svgNode('ellipse', { ...attrs, cx: px(shape.cx), cy: py(shape.cy), rx: Math.abs(Number(shape.rx || 0) * 100), ry: Math.abs(Number(shape.ry || 0) * 52) }));
  } else if (shape.type === 'arrow') {
    svg.appendChild(svgNode('polyline', { ...attrs, points: previewArrowPoints(px(shape.x1), py(shape.y1), px(shape.x2), py(shape.y2)) }));
  } else {
    const pts = (shape.pts || []).map(([x, y]) => `${px(x)},${py(y)}`).join(' ');
    svg.appendChild(svgNode('polyline', { ...attrs, points: pts }));
  }
}

function svgNode(name, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}

function safePreviewColor(color) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(color || '')) ? color : '#ef4444';
}

function previewArrowPoints(x1, y1, x2, y2) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.min(10, Math.max(6, Math.hypot(x2 - x1, y2 - y1) * 0.22));
  const spread = 0.48;
  const hx1 = x2 - len * Math.cos(ang - spread);
  const hy1 = y2 - len * Math.sin(ang - spread);
  const hx2 = x2 - len * Math.cos(ang + spread);
  const hy2 = y2 - len * Math.sin(ang + spread);
  return `${x1},${y1} ${x2},${y2} ${hx1},${hy1} ${x2},${y2} ${hx2},${hy2}`;
}

// 注釈は content 側で保存されるため、storage変化を監視して一覧を更新する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.aiAdvisorAnnotations) refreshAnnotations();
  if (changes.aiAdvisorSettings) {
    if (suppressNextSettingsRefresh) {
      suppressNextSettingsRefresh = false;
    } else {
      handleSettingsChanged(changes.aiAdvisorSettings.newValue).catch((e) => {
        showBanner(escapeHtml(t('errors.stateFetchFailed', { message: e.message })), false);
      });
    }
  }
  if (changes[PROMPT_HISTORY_KEY]) {
    state.promptHistory = normalizePromptHistory(changes[PROMPT_HISTORY_KEY].newValue || []);
    renderPromptHistory();
  }
});

// アクティブタブの変化に追従して対象タブIDとバナーを更新する。
chrome.tabs.onActivated.addListener(() => refreshState());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === 'complete' || info.url) refreshState();
});

// 初期化
async function init() {
  const settings = await getSettings().catch(() => ({ ui: { language: '' } }));
  i18n = await createI18n(resolveLocale(settings.ui?.language));
  state.language = i18n.locale;
  renderLanguageOptions();
  applyI18n();
  await Promise.all([loadPromptHistory(), refreshState()]);
  syncHistoryButton();
  els.input.focus();
}

init();
