import { getSettings, patchSettings, isAutoSyncReady } from '../lib/storage.js';
import { WORKFLOW_KEY, RUN_KEY, normalizeWorkflow, normalizeRun, stepVariables, formatStepTitle } from '../lib/workflow.js';
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
  targetTab: document.getElementById('target-tab'),
  targetTabTitle: document.getElementById('target-tab-title'),
  targetTabMeta: document.getElementById('target-tab-meta'),
  btnCopyTabId: document.getElementById('btn-copy-tab-id'),
  targetTabIdValue: document.getElementById('target-tab-id-value'),
  workspaceTabs: document.getElementById('workspace-tabs'),
  btnWorkspaceMemo: document.getElementById('btn-workspace-memo'),
  btnWorkspaceWorkflow: document.getElementById('btn-workspace-workflow'),
  memoWorkspace: document.getElementById('memo-workspace'),
  workflowWorkspace: document.getElementById('workflow-workspace'),
  memoWorkspaceCount: document.getElementById('memo-workspace-count'),
  workflowWorkspaceCount: document.getElementById('workflow-workspace-count'),
  annoPanel: document.getElementById('anno-panel'),
  annoList: document.getElementById('anno-list'),
  annoFoot: document.getElementById('anno-foot'),
  btnCapture: document.getElementById('btn-capture'),
  captureLabel: document.getElementById('capture-label'),
  captureCount: document.getElementById('capture-count'),
  annoAutoSyncHint: document.getElementById('anno-autosync-hint'),
  btnAnnoRefresh: document.getElementById('btn-anno-refresh'),
  memoCountBadge: document.getElementById('memo-count-badge'),
  promptHistoryPanel: document.getElementById('prompt-history-panel'),
  promptHistoryList: document.getElementById('prompt-history-list'),
  btnHistoryClear: document.getElementById('btn-history-clear'),
  btnClearChat: document.getElementById('btn-clear-chat'),
  btnDownloadChat: document.getElementById('btn-download-chat'),
  btnWorkflow: document.getElementById('btn-workflow'),
  workflowCountBadge: document.getElementById('workflow-count-badge'),
  workflowPanel: document.getElementById('workflow-panel'),
  workflowHint: document.getElementById('workflow-hint'),
  workflowSteps: document.getElementById('workflow-steps'),
  workflowName: document.getElementById('workflow-name'),
  btnWorkflowSave: document.getElementById('btn-workflow-save'),
  btnWorkflowClear: document.getElementById('btn-workflow-clear'),
  workflowSaved: document.getElementById('workflow-saved'),
  btnWorkflowAutorun: document.getElementById('btn-workflow-autorun'),
  workflowAutorunState: document.getElementById('workflow-autorun-state'),
  btnWorkflowDryRun: document.getElementById('btn-workflow-dryrun'),
  workflowVars: document.getElementById('workflow-vars'),
  workflowVarsFields: document.getElementById('workflow-vars-fields'),
  workflowHeld: document.getElementById('workflow-held'),
  workflowHeldText: document.getElementById('workflow-held-text'),
  btnWorkflowApprove: document.getElementById('btn-workflow-approve'),
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
  windowId: null,
  tabIndex: null,
  tabActive: false,
  url: '',
  title: '',
  pageKey: '',
  workspace: 'memo',
  language: DEFAULT_LOCALE,
  history: [],
  promptHistory: [],
  promptCursor: null,
  rememberScope: 'page',
  activeTabState: null,
  annotations: [],
  workflow: { recording: false, steps: [], saved: [] },
  workflowRun: { active: false, doneStepIds: [], heldStepId: '' },
  // 決定的ワークフローの編集/試走 UI 用(サイドパネルのセッション内だけ保持)
  workflowVars: {},
  openSteps: new Set(),
  dryResults: {},
  testResults: {},
  busy: false,
  copiedTabId: null,
  // メモ(picker)/描画(drawing)モードがページ側で有効か。両モードは content 側で
  // 排他なので 1 フラグで扱い、サイドパネルにフォーカスがある状態の ESC を拾うために使う。
  pickerActive: false,
  // daemon 有効(enabled+url+token)か。メモのみを残した時に「自動送信されます」補助表示を
  // 出すかの判定に使う。init と設定変更購読(handleSettingsChanged)で更新する。
  daemonReady: false,
};

let copyTabIdResetTimer = null;

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

const WORKSPACES = ['memo', 'workflow'];

function applyWorkspaceVisibility() {
  const memoActive = state.workspace === 'memo';
  const workflowActive = state.workspace === 'workflow';
  const hasWorkflow = Boolean(
    state.workflow?.recording ||
      state.workflow?.steps?.length ||
      state.workflow?.saved?.length
  );

  if (els.btnWorkspaceMemo) {
    els.btnWorkspaceMemo.setAttribute('aria-selected', String(memoActive));
    els.btnWorkspaceMemo.tabIndex = memoActive ? 0 : -1;
  }
  if (els.btnWorkspaceWorkflow) {
    els.btnWorkspaceWorkflow.setAttribute('aria-selected', String(workflowActive));
    els.btnWorkspaceWorkflow.tabIndex = workflowActive ? 0 : -1;
  }
  if (els.memoWorkspace) els.memoWorkspace.hidden = !memoActive;
  if (els.workflowWorkspace) els.workflowWorkspace.hidden = !workflowActive;
  if (els.annoPanel) els.annoPanel.hidden = !memoActive || !state.annotations.length;
  if (els.workflowPanel) els.workflowPanel.hidden = !workflowActive || !hasWorkflow;
}

function setWorkspace(workspace, { focus = false } = {}) {
  const next = WORKSPACES.includes(workspace) ? workspace : 'memo';
  state.workspace = next;
  applyWorkspaceVisibility();
  if (focus) {
    const button = next === 'workflow' ? els.btnWorkspaceWorkflow : els.btnWorkspaceMemo;
    button?.focus();
  }
}

function handleWorkspaceKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' || event.key === 'ArrowLeft' ? 'memo' : 'workflow';
  setWorkspace(next, { focus: true });
}

function rerenderLocalizedContent() {
  applyI18n();
  renderChatHistory();
  renderPromptHistory();
  renderAnnotationList(state.annotations);
  renderWorkflow(state.workflow);
  renderWorkflowRun(state.workflowRun);
  if (state.activeTabState) renderBanner(state.activeTabState);
  renderTargetTab(state.activeTabState);
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
  state.daemonReady = isAutoSyncReady(settings);
  const nextLanguage = resolveLocale(settings?.ui?.language);
  if (nextLanguage !== state.language) {
    await i18n.setLocale(nextLanguage);
    state.language = i18n.locale;
    rerenderLocalizedContent();
  }
  // daemon 有効/無効の切替でフッタの自動送信表示を追従させる（言語不変でも再描画）。
  updateMemoCountBadge(state.annotations);
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
    state.windowId = s.windowId ?? null;
    state.tabIndex = s.tabIndex ?? null;
    state.tabActive = Boolean(s.tabActive);
    state.url = s.url || '';
    state.title = s.title || '';
    state.rememberScope = normalizeRememberScope(s.rememberScope);
    els.rememberScope.value = state.rememberScope;
    const nextPageKey = pageKeyForUrl(state.url);
    if (nextPageKey !== state.pageKey) {
      state.pageKey = nextPageKey;
      await loadChatHistory();
    }
    renderTargetTab(s);
    renderBanner(s);
    refreshAnnotations();
  } catch (e) {
    showBanner(escapeHtml(t('errors.stateFetchFailed', { message: e.message })), false);
  }
}

function renderTargetTab(s = {}) {
  const tabId = s?.tabId ?? state.tabId;
  const windowId = s?.windowId ?? state.windowId;
  const tabIndex = s?.tabIndex ?? state.tabIndex;
  const title = s?.title || state.title || t('targetTab.unknownTitle');
  const url = s?.url || state.url || '';
  const tabIdText = tabId == null ? '—' : String(tabId);
  const copyTitle =
    tabId == null ? t('targetTab.copyUnavailable') : t('targetTab.copyTitle', { tabId: tabIdText });
  els.targetTabIdValue.textContent = tabIdText;
  els.btnCopyTabId.disabled = tabId == null;
  els.btnCopyTabId.title = copyTitle;
  els.btnCopyTabId.setAttribute('aria-label', copyTitle);
  if (state.copiedTabId !== tabIdText) els.btnCopyTabId.classList.remove('copied');
  els.targetTabTitle.textContent = title;
  els.targetTabTitle.title = url || title;
  els.targetTabMeta.textContent = t('targetTab.meta', {
    windowId: windowId ?? 'unknown',
    index: tabIndex == null ? 'unknown' : tabIndex + 1,
  });
  els.targetTabMeta.title = url || '';
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error(t('errors.clipboardUnavailable'));
}

function markTabIdCopied(tabId) {
  state.copiedTabId = String(tabId);
  els.btnCopyTabId.classList.add('copied');
  clearTimeout(copyTabIdResetTimer);
  copyTabIdResetTimer = setTimeout(() => {
    if (state.copiedTabId === String(tabId)) state.copiedTabId = null;
    els.btnCopyTabId.classList.remove('copied');
  }, 1400);
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
  updateDownloadAvailability();
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

  const headActions = document.createElement('div');
  headActions.className = 'msg-head-actions';
  head.appendChild(headActions);

  wrap.appendChild(head);
  setMessageCopyButton(wrap, content);
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
  const actions = wrap?.querySelector('.msg-head-actions');
  if (!actions || !Number.isInteger(messageIndex) || messageIndex < 0) return;
  actions.querySelector('.msg-delete')?.remove();
  actions.appendChild(buildMessageDeleteButton(messageIndex));
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

function setMessageCopyButton(wrap, content) {
  const actions = wrap?.querySelector('.msg-head-actions');
  if (!actions) return;
  actions.querySelector('.msg-copy')?.remove();
  actions.appendChild(buildMessageCopyButton(content));
}

function buildMessageCopyButton(content) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-copy';
  btn.title = t('chat.copyMessageTitle');
  btn.setAttribute('aria-label', t('chat.copyMessageAria'));
  btn.disabled = state.busy;
  btn.innerHTML = `
    <svg class="action-icon copy-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
    <svg class="action-icon copied-icon" viewBox="0 0 24 24" aria-hidden="true" style="display:none; stroke:var(--ok)">
      <polyline points="20 6 9 17 4 12" />
    </svg>`;
  btn.addEventListener('click', async () => {
    try {
      await copyTextToClipboard(content);
      const copyIcon = btn.querySelector('.copy-icon');
      const copiedIcon = btn.querySelector('.copied-icon');
      if (copyIcon && copiedIcon) {
        copyIcon.style.display = 'none';
        copiedIcon.style.display = 'inline-block';
        setTimeout(() => {
          copyIcon.style.display = 'inline-block';
          copiedIcon.style.display = 'none';
        }, 1500);
      }
    } catch (e) {
      console.error('Failed to copy message:', e);
    }
  });
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
  updateDownloadAvailability();
  document.querySelectorAll('.msg-delete').forEach((btn) => {
    btn.disabled = b;
  });
  document.querySelectorAll('.msg-copy').forEach((btn) => {
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
els.btnWorkspaceMemo?.addEventListener('click', () => setWorkspace('memo'));
els.btnWorkspaceWorkflow?.addEventListener('click', () => setWorkspace('workflow'));
els.workspaceTabs?.addEventListener('keydown', handleWorkspaceKeydown);

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

els.btnCopyTabId.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  if (state.tabId == null) {
    showBanner(escapeHtml(t('errors.targetTabMissing')), false);
    return;
  }
  const tabId = String(state.tabId);
  try {
    await copyTextToClipboard(tabId);
    markTabIdCopied(tabId);
    showBanner(escapeHtml(t('targetTab.copied', { tabId })), true);
  } catch (e) {
    showBanner(escapeHtml(t('errors.tabIdCopyFailed', { message: e.message })), false);
  }
});

// 「メモを残す」: ページ上で要素をクリックしてメモを残すモードを開始。
els.btnPick.addEventListener('click', async () => {
  setWorkspace('memo');
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
  setWorkspace('memo');
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
  setWorkspace('memo');
  if (state.tabId == null) await refreshState();
  if (els.btnCapture.disabled) return;
  els.btnCapture.disabled = true;
  showBanner(escapeHtml(t('capture.processing')), true);
  try {
    const res = await send({ type: 'CAPTURE_PAGE_FEEDBACK', tabId: state.tabId });
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
  setWorkspace('memo');
  if (state.tabId == null) await refreshState();
  try {
    const res = await send({ type: 'EXPORT_CONTEXT', tabId: state.tabId });
    const text = res?.text || '';
    await copyTextToClipboard(text);
    addMessage('assistant', t('context.copied', { text }));
  } catch (e) {
    addMessage('error', t('errors.contextCopyFailed', { message: e.message }));
  }
});

els.btnAffordances.addEventListener('click', async () => {
  setWorkspace('memo');
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

// ⋯ メニュー: 頻度の低い設定と破壊的操作(全削除)を常設ボタンから一段奥へ退避する。
const btnMore = document.getElementById('btn-more');
const moreMenu = document.getElementById('more-menu');
function setMoreMenu(open) {
  moreMenu.hidden = !open;
  btnMore.setAttribute('aria-expanded', String(open));
}
btnMore.addEventListener('click', () => setMoreMenu(moreMenu.hidden));
moreMenu.addEventListener('click', (e) => {
  if (e.target.closest('button')) setMoreMenu(false);
});
document.addEventListener('click', (e) => {
  if (!moreMenu.hidden && !moreMenu.contains(e.target) && !btnMore.contains(e.target)) setMoreMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !moreMenu.hidden) {
    setMoreMenu(false);
    btnMore.focus();
  }
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
els.btnDownloadChat.addEventListener('click', () => {
  downloadChat();
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

async function downloadChat() {
  // \u7a7a\u5c65\u6b74/\u9001\u4fe1\u4e2d\u306f\u30dc\u30bf\u30f3\u3092 disabled \u5316\u3057\u3066\u5230\u9054\u3055\u305b\u306a\u3044(updateDownloadAvailability)\u3002
  // \u3053\u3053\u3078\u6765\u305f\u5834\u5408\u306f\u7121\u5bb3\u306b\u63e1\u308a\u3064\u3076\u3059 \u2014 \u30e2\u30fc\u30c0\u30eb(alert)\u306f\u4ed6\u306e\u60c5\u5831\u901a\u77e5\u3068\u4e0d\u6574\u5408\u306a\u305f\u3081\u4f7f\u308f\u306a\u3044\u3002
  if (state.busy || !state.history?.length) return;
  try {
    const mdText = formatChatHistoryToMarkdown();
    const filename = buildChatDownloadFilename();

    if (chrome?.runtime?.id) {
      // \u7279\u6a29 API(chrome.downloads)\u306f service worker \u5074\u3067\u5b9f\u884c\u3059\u308b(AGENTS.md \u306e\u8a2d\u8a08\u5883\u754c)\u3002
      await send({ type: 'DOWNLOAD_CHAT', markdown: mdText, filename });
    } else {
      // \u62e1\u5f35\u5916(dev/test)\u3067\u306f\u30a2\u30f3\u30ab\u30fc\u3067\u30d5\u30a9\u30fc\u30eb\u30d0\u30c3\u30af\u3059\u308b\u3002
      const dataUrl = textToDataUrl(mdText, 'text/markdown');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } catch (e) {
    addMessage('error', t('errors.downloadFailed', { message: e.message }));
  }
}

// \u65e5\u4ed8\u3068\u30da\u30fc\u30b8\u30bf\u30a4\u30c8\u30eb\u304b\u3089\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9\u30d5\u30a1\u30a4\u30eb\u540d\u3092\u7d44\u307f\u7acb\u3066\u308b\u3002
function buildChatDownloadFilename() {
  const sanitize = (s) => s.replace(/[^a-zA-Z0-9_\u4e00-\u9faf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7a3-]/g, '_').substring(0, 30);
  const dateStr = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
  const pageTitle = sanitize(state.title || 'chat');
  return `chat_${pageTitle}_${dateStr}.md`;
}

// \u30c0\u30a6\u30f3\u30ed\u30fc\u30c9\u30dc\u30bf\u30f3\u306e\u6d3b\u6027\u72b6\u614b\u3092\u5c65\u6b74/busy \u306b\u8ffd\u5f93\u3055\u305b\u308b(\u7a7a\u5c65\u6b74\u3067\u306f\u62bc\u305b\u306a\u3044)\u3002
function updateDownloadAvailability() {
  if (els.btnDownloadChat) els.btnDownloadChat.disabled = state.busy || !state.history?.length;
}

function formatChatHistoryToMarkdown() {
  if (!state.history || state.history.length === 0) return '';
  let md = `# Chat History - ${state.title || 'Browser Agent'}\n`;
  md += `URL: ${state.url || 'Unknown'}\n`;
  md += `Date: ${new Date().toLocaleString()}\n\n`;

  state.history.forEach((msg) => {
    const roleName = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'AI' : 'Error';
    md += `## ${roleName}\n\n${msg.content}\n\n`;
    if (msg.actions && msg.actions.length > 0) {
      md += `### Executed Actions\n\n`;
      msg.actions.forEach((act, idx) => {
        const res = msg.results?.[idx];
        const status = res ? (res.ok ? '✓ OK' : `✗ Fail: ${res.error}`) : 'Not Run';
        md += `- **${act.verb}** (${status}): ${act.reason || ''}\n`;
      });
      md += `\n`;
    }
  });
  return md;
}

function textToDataUrl(text, mime) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};charset=utf-8;base64,${btoa(bin)}`;
}

// ---- 保存済み手がかりの一覧 ----
// SW が記録する「AIへ届いたメモの内容署名」。トレイの未送信/送信済み表示に使う。
const SENT_MEMOS_KEY = 'aiAdvisorSentMemos';
let sentMemos = {};
async function loadSentMemos() {
  try {
    sentMemos = (await chrome.storage.local.get(SENT_MEMOS_KEY))[SENT_MEMOS_KEY] || {};
  } catch {
    sentMemos = {};
  }
}

// 届いた内容と今の内容が同じなら送信済み。編集して中身が変われば未送信に戻る。
function sentStateChip(a) {
  const sent = Boolean(a.sig) && Boolean(sentMemos[a.sig]);
  const chip = document.createElement('span');
  chip.className = `anno-sent ${sent ? 'sent' : 'pending'}`;
  chip.textContent = sent ? t('annotations.sentState.sent') : t('annotations.sentState.pending');
  return chip;
}

async function refreshAnnotations() {
  if (state.tabId == null) return;
  try {
    const [res] = await Promise.all([send({ type: 'LIST_ANNOTATIONS', tabId: state.tabId }), loadSentMemos()]);
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
  if (els.memoWorkspaceCount) {
    els.memoWorkspaceCount.hidden = list.length === 0;
    els.memoWorkspaceCount.textContent = list.length ? String(list.length) : '';
  }
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
  // 画像でAIへ送る対象 = forAI ON のお描き + forAI ON かつ本文ありメモ。
  // content の collectPageFeedbackData / sendCount と同じ述語（kind + 本文あり + forAI!==false）に揃え、
  // メモだけのページでも送信できるようにする（メモは forAI 未設定=ON 扱い）。
  const noteSendCount = list.filter(
    (a) => a.kind === 'note' && String(a.note || '').trim() && a.forAI !== false
  ).length;
  const totalSend = sendCount + noteSendCount;
  const hasDrawing = sendCount > 0;
  const noteOnly = !hasDrawing && noteSendCount > 0;
  // 送信フッタ: 送る対象（お描き or メモ）が無ければ出さない。
  if (els.annoFoot) els.annoFoot.hidden = totalSend === 0;
  if (els.captureCount) els.captureCount.textContent = totalSend > 0 ? String(totalSend) : '';
  // ラベルを文脈適応。お描きがある時は画像へ焼き込んで送るが、メモのみは画像を撮らないので
  // 「画像で」の語を外す（annotations.capture=画像でAIへ送る / captureNoteOnly=AIへ送る）。
  if (els.captureLabel) {
    els.captureLabel.textContent = hasDrawing ? t('annotations.capture') : t('annotations.captureNoteOnly');
  }
  // daemon 有効 & メモのみ = 残すだけで自動送信される。手動ボタンは「今すぐ送る」用に残しつつ、
  // 自動送信される旨を補助表示する（daemon 無効時やお描きがある時は出さない）。
  if (els.annoAutoSyncHint) {
    els.annoAutoSyncHint.hidden = !(noteOnly && state.daemonReady);
  }
}

function renderAnnotationList(list) {
  state.annotations = Array.isArray(list) ? list : [];
  els.annoList.innerHTML = '';
  updateMemoCountBadge(state.annotations);
  if (!state.annotations.length) {
    applyWorkspaceVisibility();
    return;
  }
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
  applyWorkspaceVisibility();
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
  // 送信対象なら「未送信/送信済み」がそのまま送信対象であることも示すので、ON フラグの代わりに出す。
  let flag;
  if (a.forAI === false) {
    flag = document.createElement('span');
    flag.className = 'anno-flag off';
    flag.textContent = t('annotations.forAIOff');
  } else {
    flag = sentStateChip(a);
  }
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
  if (a.kind === 'note' && String(a.note || '').trim() && a.forAI !== false) body.appendChild(sentStateChip(a));
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

async function readWorkflowRun() {
  try {
    const all = await chrome.storage.local.get(RUN_KEY);
    return normalizeRun(all[RUN_KEY]);
  } catch {
    return normalizeRun(null);
  }
}

async function refreshWorkflowRun() {
  renderWorkflowRun(await readWorkflowRun());
}

// 自動実行ボタンの状態(開始/停止)を反映する。手順0件のときは押せない。
function renderWorkflowRun(run) {
  state.workflowRun = run = normalizeRun(run);
  const btn = els.btnWorkflowAutorun;
  if (!btn) return;
  const stepCount = (state.workflow?.steps || []).length;
  btn.setAttribute('aria-pressed', run.active ? 'true' : 'false');
  btn.textContent = run.active ? t('workflow.autorunStop') : t('workflow.autorun');
  btn.disabled = !run.active && stepCount === 0;
  if (els.workflowAutorunState) {
    const total = (state.workflow?.steps || []).length;
    els.workflowAutorunState.textContent = run.active
      ? t('workflow.autorunProgress', { done: run.doneStepIds.length, total })
      : '';
  }
  // 承認ゲートで止まっている時だけ「承認して続行」を出す。
  const held = !run.active && run.heldStepId ? (state.workflow?.steps || []).find((s) => s.id === run.heldStepId) : null;
  if (els.workflowHeld) els.workflowHeld.hidden = !held;
  if (held && els.workflowHeldText) els.workflowHeldText.textContent = t('workflow.heldText', { text: stepTitle(held) });
  if (els.btnWorkflowDryRun) els.btnWorkflowDryRun.disabled = run.active || !(state.workflow?.steps || []).length;
  // 実行状況(完了/保留)を手順の行にも反映する。
  if (els.workflowSteps && state.workflow?.steps?.length) {
    els.workflowSteps.querySelectorAll('.workflow-step').forEach((row, i) => {
      const id = row.dataset.stepId;
      const done = run.doneStepIds.includes(id);
      row.classList.toggle('is-done', done);
      row.classList.toggle('is-held', run.heldStepId === id);
      const num = row.querySelector('.wf-num');
      if (num) num.textContent = done ? '✓' : String(i + 1);
    });
  }
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

  if (els.workflowWorkspaceCount) {
    els.workflowWorkspaceCount.hidden = stepCount === 0;
    els.workflowWorkspaceCount.textContent = stepCount ? String(stepCount) : '';
  }

  if (els.btnWorkflow) els.btnWorkflow.setAttribute('aria-pressed', wf.recording ? 'true' : 'false');
  if (els.workflowCountBadge) {
    els.workflowCountBadge.hidden = stepCount === 0;
    els.workflowCountBadge.textContent = stepCount ? String(stepCount) : '';
  }

  if (els.workflowHint) els.workflowHint.hidden = !wf.recording;
  if (els.btnWorkflowSave) els.btnWorkflowSave.disabled = stepCount === 0;
  if (els.btnWorkflowClear) els.btnWorkflowClear.hidden = stepCount === 0;

  if (els.workflowSteps) {
    els.workflowSteps.innerHTML = '';
    wf.steps.forEach((s, i) => els.workflowSteps.appendChild(renderWorkflowStep(s, i + 1)));
  }
  renderSavedWorkflows(wf.saved);
  renderWorkflowVars(wf);
  applyWorkspaceVisibility();
  // 手順数が変わると自動実行ボタンの可否も変わるので追従させる。
  renderWorkflowRun(state.workflowRun);
}

// 手順の一行タイトル(lib の formatStepTitle をこのパネルの言語で使う)。
function stepTitle(s) {
  return formatStepTitle(s, t);
}

function createEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function badge(text, tone) {
  return createEl('span', `wf-badge${tone ? ` wf-badge--${tone}` : ''}`, text);
}

// 手順を部分更新して保存する(サイドパネルの編集 UI 用)。
async function updateWorkflowStep(stepId, patch) {
  renderWorkflow(
    await mutateWorkflow((w) => {
      w.steps = w.steps.map((s) => (s.id === stepId ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s));
      return w;
    })
  );
}

function renderWorkflowStep(s, num) {
  const run = state.workflowRun;
  const structured = Boolean(s.action?.verb);
  const row = createEl('div', 'workflow-step');
  row.dataset.stepId = s.id;
  if (run.doneStepIds.includes(s.id)) row.classList.add('is-done');
  if (run.heldStepId === s.id) row.classList.add('is-held');
  if (s.needsReview) row.classList.add('needs-review');

  const n = createEl('span', 'wf-num', run.doneStepIds.includes(s.id) ? '✓' : String(num));
  const body = createEl('div', 'wf-body');
  body.appendChild(createEl('div', 'wf-text', stepTitle(s)));
  if (structured && s.text) body.appendChild(createEl('div', 'wf-note', s.text));

  const meta = createEl('div', 'wf-meta');
  const url = createEl('span', 'wf-url', shortUrl(s.urlPattern || s.url));
  url.title = s.urlPattern || s.url || '';
  meta.appendChild(url);
  if (!structured) meta.appendChild(badge(t('wf.badge.legacy'), 'ai'));
  if (s.choice?.by === 'ai') meta.appendChild(badge(t('wf.badge.aiChoice'), 'ai'));
  if (s.gate) meta.appendChild(badge(t('wf.badge.gate'), 'gate'));
  if (s.check?.type && s.check.type !== 'none') meta.appendChild(badge(t(`wf.badge.check.${s.check.type}`)));
  body.appendChild(meta);

  const dry = state.dryResults[s.id];
  if (dry && dry.status !== 'other-page') {
    const tone = dry.status === 'ok' ? 'ok' : dry.status === 'legacy' ? 'ai' : 'warn';
    const line = createEl('div', `wf-dry wf-dry--${tone}`, t(`wf.dry.${dry.status}`, { text: dry.chosenText || dry.label || '', error: dry.error || '' }));
    body.appendChild(line);
  }

  if (s.needsReview) body.appendChild(renderReviewPrompt(s));
  if (s.suggestion) body.appendChild(renderSuggestion(s));
  if (structured) body.appendChild(renderStepEditor(s));

  const del = createEl('button', 'wf-del', '×');
  del.type = 'button';
  del.title = t('workflow.removeStep');
  del.setAttribute('aria-label', t('workflow.removeStep'));
  del.addEventListener('click', () => removeWorkflowStep(s.id));

  row.appendChild(n);
  row.appendChild(body);
  row.appendChild(del);
  return row;
}

// リストから選んだ手順は「どう選ぶか」を人が決めるまで目立たせる。
function renderReviewPrompt(s) {
  const box = createEl('div', 'wf-review');
  box.appendChild(createEl('span', '', s.action?.value === '{password}' ? t('wf.review.password') : t('wf.review.pick')));
  const okBtn = createEl('button', 'wf-mini', t('wf.review.keep'));
  okBtn.type = 'button';
  okBtn.addEventListener('click', () => updateWorkflowStep(s.id, { needsReview: false }));
  box.appendChild(okBtn);
  return box;
}

// 実行中に AI が補った解決を「次回から固定する？」と提案する(採用は人間が決める)。
function renderSuggestion(s) {
  const sg = s.suggestion;
  const box = createEl('div', 'wf-suggest');
  const text = sg.kind === 'anchor' ? t('wf.suggest.anchor', { label: sg.label }) : t('wf.suggest.choice', { label: sg.label });
  box.appendChild(createEl('span', 'wf-suggest-text', sg.reason ? `${text} (${sg.reason})` : text));
  const adopt = createEl('button', 'wf-mini', t('wf.suggest.adopt'));
  adopt.type = 'button';
  adopt.addEventListener('click', () =>
    updateWorkflowStep(s.id, (cur) =>
      cur.suggestion?.kind === 'anchor' && cur.suggestion.anchor
        ? { locator: { ...cur.locator, anchor: cur.suggestion.anchor }, suggestion: null }
        : { choice: { by: 'text', value: cur.suggestion?.label || '' }, suggestion: null, needsReview: false }
    )
  );
  const dismiss = createEl('button', 'wf-mini wf-mini--ghost', t('wf.suggest.dismiss'));
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => updateWorkflowStep(s.id, { suggestion: null }));
  box.appendChild(adopt);
  box.appendChild(dismiss);
  return box;
}

const CHOICE_ORDER = ['text', 'index', 'first', 'last', 'min', 'max', 'ai'];
const CHECK_ORDER = ['none', 'url', 'text', 'appears'];

function labeled(labelText, control) {
  const wrap = createEl('label', 'wf-field');
  wrap.appendChild(createEl('span', 'wf-field-label', labelText));
  wrap.appendChild(control);
  return wrap;
}

function renderStepEditor(s) {
  const details = createEl('details', 'wf-edit');
  details.open = state.openSteps.has(s.id) || Boolean(s.needsReview);
  details.addEventListener('toggle', () => {
    if (details.open) state.openSteps.add(s.id);
    else state.openSteps.delete(s.id);
  });
  details.appendChild(createEl('summary', 'wf-edit-summary', t('wf.edit.summary')));
  const form = createEl('div', 'wf-edit-body');

  // 選び方(リストの項目 / セレクトの選択肢)
  if (s.locator?.kind === 'pick' || s.action.verb === 'select') {
    const choice = s.choice || { by: 'text', value: s.action.value || '' };
    const sel = createEl('select', 'wf-input');
    CHOICE_ORDER.forEach((by) => {
      const o = createEl('option', '', t(`wf.rule.${by}`));
      o.value = by;
      sel.appendChild(o);
    });
    sel.value = choice.by;
    const valueInput = createEl('input', 'wf-input');
    valueInput.type = 'text';
    valueInput.value = choice.value;
    valueInput.placeholder = t(`wf.rule.${choice.by}.placeholder`);
    valueInput.hidden = ['first', 'last', 'min', 'max'].includes(choice.by);
    sel.addEventListener('change', () => {
      const by = sel.value;
      const value = by === 'index' && !/^\d+$/.test(valueInput.value) ? '1' : valueInput.value;
      updateWorkflowStep(s.id, { choice: { by, value }, needsReview: false });
    });
    valueInput.addEventListener('change', () =>
      updateWorkflowStep(s.id, { choice: { by: sel.value, value: valueInput.value }, needsReview: false })
    );
    form.appendChild(labeled(t('wf.edit.choice'), sel));
    form.appendChild(valueInput);
    form.appendChild(createEl('p', 'wf-hint', t(`wf.rule.${choice.by}.hint`)));

    const testRow = createEl('div', 'wf-test-row');
    const testBtn = createEl('button', 'wf-mini', t('wf.edit.test'));
    testBtn.type = 'button';
    const result = createEl('span', 'wf-test-result');
    const prev = state.testResults[s.id];
    if (prev) result.textContent = prev;
    testBtn.addEventListener('click', () => testWorkflowStepNow(s.id, result, testBtn));
    testRow.appendChild(testBtn);
    testRow.appendChild(result);
    form.appendChild(testRow);
  }

  // 入力値({名前} で実行時に入力)
  if (s.action.verb === 'fill') {
    const input = createEl('input', 'wf-input');
    input.type = 'text';
    input.value = s.action.value;
    input.addEventListener('change', () =>
      updateWorkflowStep(s.id, (cur) => ({ action: { ...cur.action, value: input.value }, needsReview: false }))
    );
    form.appendChild(labeled(t('wf.edit.value'), input));
    form.appendChild(createEl('p', 'wf-hint', t('wf.edit.valueHint')));
  }

  // 確認(この手順の後に満たされるべき状態)
  const checkSel = createEl('select', 'wf-input');
  CHECK_ORDER.forEach((type) => {
    const o = createEl('option', '', t(`wf.check.${type}`));
    o.value = type;
    checkSel.appendChild(o);
  });
  checkSel.value = s.check?.type || 'none';
  const checkVal = createEl('input', 'wf-input');
  checkVal.type = 'text';
  checkVal.value = s.check?.value || '';
  checkVal.placeholder = t(`wf.check.${checkSel.value}.placeholder`);
  checkVal.hidden = checkSel.value === 'none';
  const saveCheck = () => updateWorkflowStep(s.id, { check: { type: checkSel.value, value: checkVal.value } });
  checkSel.addEventListener('change', saveCheck);
  checkVal.addEventListener('change', saveCheck);
  form.appendChild(labeled(t('wf.edit.check'), checkSel));
  form.appendChild(checkVal);

  // 承認ゲート(クリックのみ)
  if (s.action.verb === 'click') {
    const gate = createEl('input');
    gate.type = 'checkbox';
    gate.checked = Boolean(s.gate);
    gate.addEventListener('change', () => updateWorkflowStep(s.id, { gate: gate.checked }));
    const wrap = createEl('label', 'wf-check');
    wrap.appendChild(gate);
    wrap.appendChild(createEl('span', '', t('wf.edit.gate')));
    form.appendChild(wrap);
  }

  // メモ(人間/AI への補足。決定的実行には使わない)
  const note = createEl('input', 'wf-input');
  note.type = 'text';
  note.value = s.text || '';
  note.placeholder = t('wf.edit.notePlaceholder');
  note.addEventListener('change', () => updateWorkflowStep(s.id, { text: note.value }));
  form.appendChild(labeled(t('wf.edit.note'), note));

  details.appendChild(form);
  return details;
}

// 実行時に入力する変数({名前})の入力欄。値はこのサイドパネルのセッション中だけ保持する。
function renderWorkflowVars(wf) {
  if (!els.workflowVars || !els.workflowVarsFields) return;
  const names = stepVariables(wf.steps);
  els.workflowVars.hidden = names.length === 0;
  els.workflowVarsFields.innerHTML = '';
  names.forEach((name) => {
    const input = createEl('input', 'wf-input');
    input.type = /pass|パスワード/i.test(name) ? 'password' : 'text';
    input.value = state.workflowVars[name] ?? '';
    input.autocomplete = 'off';
    input.addEventListener('input', () => {
      state.workflowVars[name] = input.value;
    });
    els.workflowVarsFields.appendChild(labeled(`{${name}}`, input));
  });
}

async function testWorkflowStepNow(stepId, resultEl, button) {
  if (state.tabId == null) await refreshState();
  button.disabled = true;
  resultEl.textContent = t('wf.edit.testing');
  try {
    const r = await send({ type: 'TEST_WORKFLOW_STEP', tabId: state.tabId, stepId, vars: state.workflowVars });
    const text =
      r.status === 'ok'
        ? t(r.via === 'ai' ? 'wf.test.okAi' : 'wf.test.ok', { text: r.chosenText || r.label, reason: r.aiReason })
        : r.status === 'other-page'
          ? t('wf.test.otherPage')
          : t('wf.test.fail', { error: r.error || r.status });
    state.testResults[stepId] = text;
    resultEl.textContent = text;
  } catch (e) {
    resultEl.textContent = t('wf.test.fail', { error: e.message });
  } finally {
    button.disabled = false;
  }
}

async function dryRunWorkflowNow() {
  if (state.tabId == null) await refreshState();
  if (state.tabId == null) return;
  if (els.btnWorkflowDryRun) els.btnWorkflowDryRun.disabled = true;
  try {
    const { results } = await send({ type: 'DRY_RUN_WORKFLOW', tabId: state.tabId, vars: state.workflowVars });
    state.dryResults = Object.fromEntries(results.map((r) => [r.id, r]));
    renderWorkflow(state.workflow);
    const here = results.filter((r) => r.status !== 'other-page');
    const ok = here.filter((r) => r.status === 'ok').length;
    addMessage('assistant', here.length ? t('wf.dry.summary', { ok, total: here.length }) : t('wf.dry.none'));
  } catch (e) {
    addMessage('assistant', t('wf.test.fail', { error: e.message }));
  } finally {
    if (els.btnWorkflowDryRun) els.btnWorkflowDryRun.disabled = false;
  }
}

async function approveWorkflowStepNow() {
  if (state.tabId == null) await refreshState();
  await send({ type: 'APPROVE_WORKFLOW_STEP', tabId: state.tabId });
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

// 自動実行(セッション)の開始/停止。SW が遷移ごとに各ページの手順を実行する。
async function toggleWorkflowAutoRun() {
  if (state.tabId == null) await refreshState();
  const run = await readWorkflowRun();
  if (run.active) {
    await send({ type: 'STOP_WORKFLOW_AUTORUN' });
    return;
  }
  if (!(state.workflow?.steps || []).length) return;
  // 対象タブが解決できないと SW がどのタブで実行すべきか分からないので開始しない。
  if (state.tabId == null) {
    showBanner(escapeHtml(t('errors.stateFetchFailed', { message: 'tab' })), false);
    return;
  }
  if (!confirm(t('workflow.autorunConfirm'))) return;
  state.dryResults = {};
  showBanner(escapeHtml(t('workflow.autorunStartBanner')), true);
  await send({ type: 'START_WORKFLOW_AUTORUN', tabId: state.tabId, vars: state.workflowVars });
}

if (els.btnWorkflow) els.btnWorkflow.addEventListener('click', () => {
  setWorkspace('workflow');
  toggleWorkflowRecording().catch(() => {});
});
if (els.btnWorkflowSave) els.btnWorkflowSave.addEventListener('click', () => saveCurrentWorkflow().catch(() => {}));
if (els.btnWorkflowClear) els.btnWorkflowClear.addEventListener('click', () => clearWorkflowSteps().catch(() => {}));
if (els.btnWorkflowAutorun) els.btnWorkflowAutorun.addEventListener('click', () => toggleWorkflowAutoRun().catch(() => {}));
if (els.btnWorkflowDryRun) els.btnWorkflowDryRun.addEventListener('click', () => dryRunWorkflowNow().catch(() => {}));
if (els.btnWorkflowApprove) els.btnWorkflowApprove.addEventListener('click', () => approveWorkflowStepNow().catch(() => {}));

// SW からの自動実行イベント(各手順の結果・保留・完了)をチャットに表示する。
// onMessage が無い環境(テストスタブ等)では何もしない。
chrome.runtime.onMessage?.addListener?.((msg) => {
  if (msg?.type === 'WORKFLOW_AUTORUN_EVENT' && msg.text) {
    addMessage('assistant', msg.text);
  }
  if (msg?.type === 'PAGE_FEEDBACK_CHANGED' && msg.reason === 'resolution_change') {
    refreshAnnotations();
  }
});

// 注釈は content 側で保存されるため、storage変化を監視して一覧を更新する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.aiAdvisorAnnotations) refreshAnnotations();
  if (changes[SENT_MEMOS_KEY]) {
    sentMemos = changes[SENT_MEMOS_KEY].newValue || {};
    renderAnnotationList(state.annotations);
  }
  if (changes[WORKFLOW_KEY]) refreshWorkflow();
  if (changes[RUN_KEY]) refreshWorkflowRun();
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
  state.daemonReady = isAutoSyncReady(settings);
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
  refreshWorkflowRun();
  refreshState();
}

init();
