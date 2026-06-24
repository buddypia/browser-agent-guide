import { getSettings, patchSettings } from '../lib/storage.js';
import { WORKFLOW_KEY, normalizeWorkflow } from '../lib/workflow.js';
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
  btnWorkflow: document.getElementById('btn-workflow'),
  workflowCountBadge: document.getElementById('workflow-count-badge'),
  workflowPanel: document.getElementById('workflow-panel'),
  workflowHint: document.getElementById('workflow-hint'),
  workflowSteps: document.getElementById('workflow-steps'),
  workflowName: document.getElementById('workflow-name'),
  btnWorkflowSave: document.getElementById('btn-workflow-save'),
  btnWorkflowClear: document.getElementById('btn-workflow-clear'),
  workflowSaved: document.getElementById('workflow-saved'),
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
  workflow: { recording: false, steps: [], saved: [] },
  busy: false,
  // メモ(picker)/描画(drawing)モードがページ側で有効か。両モードは content 側で
  // 排他なので 1 フラグで扱い、サイドパネルにフォーカスがある状態の ESC を拾うために使う。
  pickerActive: false,
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
  renderWorkflow(state.workflow);
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
    // 別タブ切替・ページ遷移などで再取得が走る時点で、ページ側の picker/draw は
    // 無効化されている。古い true が残って ESC が空振りの停止を送らないようリセットする。
    state.pickerActive = false;
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

function hideBanner() {
  els.banner.hidden = true;
  els.banner.innerHTML = '';
  els.banner.classList.remove('ok');
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

// 開いた直後の履歴表示を SW 往復(コールドスタート)から外すため、パネル自身で
// アクティブタブURLを解決して当該ページのチャット履歴を先読みする。pageKey を
// 同期的に確定してから読込むので、後続の refreshState(SW由来の同一URL)は
// pageKey 一致で履歴ロードをスキップし二重描画にならない。
async function primeChatHistory() {
  try {
    const tabs = await chrome.tabs?.query?.({ active: true, currentWindow: true });
    const url = tabs?.[0]?.url || '';
    const nextPageKey = pageKeyForUrl(url);
    if (nextPageKey && nextPageKey !== state.pageKey) {
      state.pageKey = nextPageKey;
      state.url = url;
      await loadChatHistory();
    }
  } catch {
    /* タブ取得不可時は refreshState 側の履歴ロードに委ねる */
  }
}

async function persistChatHistory(messages = state.history, page = state) {
  const pageKey = page.pageKey || '';
  if (!pageKey) return;
  const all = await getLocal(CHAT_HISTORY_KEY, {});
  const now = new Date().toISOString();
  const next = all && typeof all === 'object' && !Array.isArray(all) ? { ...all } : {};
  const normalized = normalizeMessages(messages);
  if (!normalized.length) {
    delete next[pageKey];
    await setLocal(CHAT_HISTORY_KEY, next);
    return;
  }
  next[pageKey] = {
    url: page.url || '',
    title: page.title || '',
    updatedAt: now,
    messages: normalized,
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
  if (!state.history.length) {
    // 空状態: 同一言語のリッチな空ヒントが既に描画済みなら作り直さない。
    // init の即時描画 → 履歴ロード(空)で同じ空状態が二度描かれるときの
    // 無駄なDOM破棄/再生成とチラつきを防ぐ(言語切替時は locale 不一致で作り直す)。
    const existing = els.messages.querySelector('.empty-hint[data-ready="1"]');
    if (existing && existing.dataset.locale === state.language) return;
    els.messages.innerHTML = '';
    renderEmptyHint();
    return;
  }
  els.messages.innerHTML = '';
  state.history.forEach((msg, index) => addMessage(msg.role, msg.content, { messageIndex: index }));
  scrollToBottom();
}

function renderEmptyHint() {
  const hint = document.createElement('div');
  hint.className = 'empty-hint';
  hint.id = 'empty-hint';
  // 再構築スキップ判定用: JS生成のリッチヒントである印と、その描画言語。
  hint.dataset.ready = '1';
  hint.dataset.locale = state.language;

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
  // 「メモから始める」は composer ではなくメモボタンへ誘導する。
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
function addMessage(role, content, options = {}) {
  document.getElementById('empty-hint')?.remove();
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const head = document.createElement('div');
  head.className = 'msg-head';
  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  roleEl.textContent = roleLabel(role);
  head.appendChild(roleEl);
  wrap.appendChild(head);
  setMessageDeleteButton(wrap, options.messageIndex);

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

function setMessageDeleteButton(wrap, messageIndex) {
  const head = wrap?.querySelector('.msg-head');
  if (!head || !Number.isInteger(messageIndex) || messageIndex < 0) return;
  head.querySelector('.msg-delete')?.remove();
  head.appendChild(buildMessageDeleteButton(messageIndex));
}

function buildMessageDeleteButton(messageIndex) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-delete';
  btn.title = t('chat.deleteTurnTitle');
  btn.setAttribute('aria-label', t('chat.deleteTurnAria'));
  btn.disabled = state.busy;
  btn.innerHTML = `
    <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
      <path d="M10 11v5M14 11v5" />
    </svg>`;
  btn.addEventListener('click', () => deleteChatTurn(messageIndex));
  return btn;
}

function chatTurnRange(messageIndex) {
  const msg = state.history[messageIndex];
  if (!msg) return null;
  if (msg.role === 'user' && state.history[messageIndex + 1]?.role === 'assistant') {
    return [messageIndex, messageIndex + 2];
  }
  if (msg.role === 'assistant' && state.history[messageIndex - 1]?.role === 'user') {
    return [messageIndex - 1, messageIndex + 1];
  }
  return [messageIndex, messageIndex + 1];
}

async function deleteChatTurn(messageIndex) {
  if (state.busy) return;
  const range = chatTurnRange(messageIndex);
  if (!range) return;
  if (!confirm(t('confirm.deleteChatTurn'))) return;
  const [start, end] = range;
  state.history = normalizeMessages([...state.history.slice(0, start), ...state.history.slice(end)]);
  await persistChatHistory();
  renderChatHistory();
  els.input.focus();
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
  const userWrap = addMessage('user', cleanText);
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
      setMessageDeleteButton(userWrap, nextHistory.length - 2);
      setMessageDeleteButton(wrap, nextHistory.length - 1);
      if (actions?.length) refreshState();
    }
    await persistChatHistory(nextHistory, submitPage);
  } catch (e) {
    typing.remove();
    const nextHistory = normalizeMessages([...previousHistory, userMessage]);
    if (state.pageKey === submitPage.pageKey) {
      addMessage('error', e.message);
      state.history = nextHistory;
      setMessageDeleteButton(userWrap, nextHistory.length - 1);
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
  els.btnClearChat.disabled = b;
  document.querySelectorAll('.msg-delete').forEach((btn) => {
    btn.disabled = b;
  });
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

// メモ(picker)/描画(drawing)モード中の ESC で終了する。これらはサイドパネルの
// ボタンから開始するため、フォーカスがサイドパネル(別ドキュメント)に残り、ページ側の
// keydown ハンドラに ESC が届かない。フォーカスが実際に居るこのドキュメントで拾い、
// 配線済みの STOP_PICKER/STOP_DRAWING を送って確実に終了させる(content 側は冪等)。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !state.pickerActive) return;
  state.pickerActive = false;
  send({ type: 'STOP_PICKER', tabId: state.tabId }).catch(() => {});
  send({ type: 'STOP_DRAWING', tabId: state.tabId }).catch(() => {});
  hideBanner();
});

els.languageSelect.addEventListener('change', (e) => {
  changeLanguage(e.target.value);
});

// 「メモを残す」: ページ上で要素をクリックしてメモを残すモードを開始。
els.btnPick.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  try {
    await send({ type: 'START_PICKER', tabId: state.tabId });
    state.pickerActive = true;
    showBanner(escapeHtml(t('picker.started')), true);
  } catch (e) {
    addMessage('error', t('errors.pickerStartFailed', { message: e.message }));
  }
});

// 「描いて伝える」: ページ上で円/四角/矢印/ペンを使って対象を示す描画モードを開始。
els.btnDraw.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  try {
    await send({ type: 'START_DRAWING', tabId: state.tabId });
    state.pickerActive = true;
    showBanner(escapeHtml(t('drawing.started')), true);
  } catch (e) {
    addMessage('error', t('errors.drawingStartFailed', { message: e.message }));
  }
});

// 「画像でAIへ」: 手がかりをスクリーンショットに焼き込み(burn-in)、画像ファイルとして
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
      const daemonLines = [t('capture.sentDaemon'), '', t('capture.savePath', { path: dir })];
      // パス非依存の取得先 URL（daemon ack 由来）。inbox とブラウザの DL 先がズレても id だけで PNG を取れる。
      if (res.imageUrl) daemonLines.push(t('capture.imageUrl', { url: res.imageUrl }));
      daemonLines.push(meta, '', t('capture.daemonCliHint'), t('capture.daemonScopeHint'));
      addMessage('assistant', daemonLines.join('\n'));
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

// 「AI用にコピー」: 別のAIチャットに貼れる決定的なページ説明を生成してコピー。
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

// ---- 保存済み手がかりの一覧 ----
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
  // ページ手がかりを画像化するCTA。forAI OFF の描画だけなら capture 側も空なので出さない。
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

// ---- ページ跨ぎワークフロー(記録した手順) ----
// 記録ON中に各ページで残したメモを URL ごと時系列(=URL順)で貯め、チャットで AI に一括で渡す。
// content/SW と同じ chrome.storage.local キー(WORKFLOW_KEY)を直接読み書きする。
async function readWorkflow() {
  try {
    const all = await chrome.storage.local.get(WORKFLOW_KEY);
    return normalizeWorkflow(all[WORKFLOW_KEY]);
  } catch {
    return normalizeWorkflow(null);
  }
}

async function mutateWorkflow(mutator) {
  const wf = await readWorkflow();
  const next = mutator(wf) || wf;
  await chrome.storage.local.set({ [WORKFLOW_KEY]: next });
  return next;
}

async function refreshWorkflow() {
  renderWorkflow(await readWorkflow());
}

function shortUrl(u) {
  try {
    const url = new URL(u);
    const p = url.pathname.length > 24 ? url.pathname.slice(0, 23) + '…' : url.pathname;
    return url.host + (p === '/' ? '' : p);
  } catch {
    return u || '';
  }
}

function renderWorkflow(wf) {
  state.workflow = wf = normalizeWorkflow(wf);
  const stepCount = wf.steps.length;

  if (els.btnWorkflow) els.btnWorkflow.setAttribute('aria-pressed', wf.recording ? 'true' : 'false');
  if (els.workflowCountBadge) {
    els.workflowCountBadge.hidden = stepCount === 0;
    els.workflowCountBadge.textContent = stepCount ? String(stepCount) : '';
  }

  if (els.workflowPanel) els.workflowPanel.hidden = !(wf.recording || stepCount > 0 || wf.saved.length > 0);
  if (els.workflowHint) els.workflowHint.hidden = !wf.recording;
  if (els.btnWorkflowSave) els.btnWorkflowSave.disabled = stepCount === 0;
  if (els.btnWorkflowClear) els.btnWorkflowClear.hidden = stepCount === 0;

  if (els.workflowSteps) {
    els.workflowSteps.innerHTML = '';
    wf.steps.forEach((s, i) => els.workflowSteps.appendChild(renderWorkflowStep(s, i + 1)));
  }
  renderSavedWorkflows(wf.saved);
}

function renderWorkflowStep(s, num) {
  const row = document.createElement('div');
  row.className = 'workflow-step';

  const n = document.createElement('span');
  n.className = 'wf-num';
  n.textContent = String(num);

  const body = document.createElement('div');
  body.className = 'wf-body';
  const text = document.createElement('div');
  text.className = 'wf-text';
  text.textContent = s.text || s.target || t('workflow.emptyStep');
  const url = document.createElement('div');
  url.className = 'wf-url';
  url.textContent = shortUrl(s.url);
  url.title = s.url || '';
  body.appendChild(text);
  body.appendChild(url);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'wf-del';
  del.textContent = '×';
  del.title = t('workflow.removeStep');
  del.setAttribute('aria-label', t('workflow.removeStep'));
  del.addEventListener('click', () => removeWorkflowStep(s.id));

  row.appendChild(n);
  row.appendChild(body);
  row.appendChild(del);
  return row;
}

function renderSavedWorkflows(saved) {
  if (!els.workflowSaved) return;
  els.workflowSaved.innerHTML = '';
  if (!saved.length) return;
  const title = document.createElement('div');
  title.className = 'anno-support-title';
  title.textContent = t('workflow.savedTitle');
  els.workflowSaved.appendChild(title);
  saved.forEach((w) => {
    const row = document.createElement('div');
    row.className = 'workflow-saved-item';
    const name = document.createElement('span');
    name.className = 'wf-name';
    name.textContent = `${w.name || t('workflow.untitled')} (${w.steps.length})`;
    name.title = name.textContent;
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'wf-saved-load';
    load.textContent = t('workflow.load');
    load.addEventListener('click', () => loadSavedWorkflow(w.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'wf-saved-del';
    del.textContent = '×';
    del.title = t('workflow.deleteSaved');
    del.setAttribute('aria-label', `${t('workflow.deleteSaved')}: ${w.name || t('workflow.untitled')}`);
    del.addEventListener('click', () => deleteSavedWorkflow(w.id));
    row.appendChild(name);
    row.appendChild(load);
    row.appendChild(del);
    els.workflowSaved.appendChild(row);
  });
}

async function toggleWorkflowRecording() {
  const wf = await mutateWorkflow((w) => {
    w.recording = !w.recording;
    return w;
  });
  renderWorkflow(wf);
  if (wf.recording) showBanner(escapeHtml(t('workflow.recordingBanner')), true);
  else hideBanner();
}

async function clearWorkflowSteps() {
  if (!state.workflow.steps.length) return;
  if (!confirm(t('workflow.clearConfirm'))) return;
  renderWorkflow(
    await mutateWorkflow((w) => {
      w.steps = [];
      return w;
    })
  );
}

async function removeWorkflowStep(stepId) {
  renderWorkflow(
    await mutateWorkflow((w) => {
      w.steps = w.steps.filter((s) => s.id !== stepId);
      return w;
    })
  );
}

async function saveCurrentWorkflow() {
  const current = await readWorkflow();
  if (!current.steps.length) return;
  const name = (els.workflowName?.value || '').trim() || t('workflow.untitled');
  const entry = {
    id: `wf-${Date.now()}`,
    name,
    createdAt: new Date().toISOString(),
    steps: current.steps.map((s) => ({ ...s })),
  };
  const wf = await mutateWorkflow((w) => {
    w.saved = [entry, ...w.saved].slice(0, 30);
    return w;
  });
  if (els.workflowName) els.workflowName.value = '';
  renderWorkflow(wf);
  addMessage('assistant', t('workflow.savedMsg', { name: entry.name, count: entry.steps.length }));
}

async function loadSavedWorkflow(id) {
  const wf = await mutateWorkflow((w) => {
    const found = w.saved.find((x) => x.id === id);
    if (found) w.steps = found.steps.map((s) => ({ ...s }));
    return w;
  });
  renderWorkflow(wf);
  addMessage('assistant', t('workflow.loadedMsg'));
}

async function deleteSavedWorkflow(id) {
  renderWorkflow(
    await mutateWorkflow((w) => {
      w.saved = w.saved.filter((x) => x.id !== id);
      return w;
    })
  );
}

if (els.btnWorkflow) els.btnWorkflow.addEventListener('click', () => toggleWorkflowRecording().catch(() => {}));
if (els.btnWorkflowSave) els.btnWorkflowSave.addEventListener('click', () => saveCurrentWorkflow().catch(() => {}));
if (els.btnWorkflowClear) els.btnWorkflowClear.addEventListener('click', () => clearWorkflowSteps().catch(() => {}));

// 注釈は content 側で保存されるため、storage変化を監視して一覧を更新する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.aiAdvisorAnnotations) refreshAnnotations();
  if (changes[WORKFLOW_KEY]) refreshWorkflow();
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
  // ローカライズ済みの空ヒントを即描画し、入力も即フォーカスして、開いた瞬間に
  // 使える状態にする。バナー/履歴/注釈は SW 往復(MV3 のコールドスタートを含む)を
  // 待たずに後追いで埋めるため、ここでは await しない。
  renderChatHistory();
  syncHistoryButton();
  els.input.focus();
  loadPromptHistory();
  primeChatHistory();
  refreshWorkflow();
  refreshState();
}

init();
