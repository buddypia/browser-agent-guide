// サイドパネルのチャットUI。background経由でAI呼び出しと動詞実行を行う。

const els = {
  messages: document.getElementById('messages'),
  emptyHint: document.getElementById('empty-hint'),
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
const EMPTY_HINT_HTML = els.emptyHint?.outerHTML || '';
const REMEMBER_SCOPES = new Set(['page', 'domain', 'all']);

let state = {
  tabId: null,
  url: '',
  title: '',
  pageKey: '',
  history: [],
  promptHistory: [],
  promptCursor: null,
  rememberScope: 'page',
  busy: false,
};

// background へメッセージ送信(エラーはthrow)。
function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || '不明なエラー'));
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
    showBanner(`状態取得に失敗: ${e.message}`, false);
  }
}

function normalizeRememberScope(scope) {
  return REMEMBER_SCOPES.has(scope) ? scope : 'page';
}

function renderBanner(s) {
  if (!s.hasApiKey) {
    showBanner('APIキーが未設定です。<a id="open-opt">設定を開く</a>', false);
  } else if (!s.matched) {
    showBanner(
      'このページはまだ記憶されていません。補足やチャットでページを変えると、このURLのルールとして自動保存されます。',
      false
    );
  } else {
    const label = s.remembered ? '記憶済みページ' : '対象ルール';
    showBanner(`${label} / ${s.provider} で接続`, true);
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
  els.messages.innerHTML = state.history.length ? '' : EMPTY_HINT_HTML;
  state.history.forEach((msg) => addMessage(msg.role, msg.content));
  scrollToBottom();
}

function renderPromptHistory() {
  els.promptHistoryList.innerHTML = '';
  if (!state.promptHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'まだ保存されたプロンプトはありません。';
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
  return new Intl.DateTimeFormat('ja-JP', {
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
  wrap.innerHTML = `<div class="role">${role === 'user' ? 'あなた' : role === 'assistant' ? 'AI' : 'エラー'}</div>`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
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
        : `失敗: ${r.error}`
      : '(未実行)';
    div.innerHTML = `<span class="verb">${escapeHtml(a.verb)}</span> <span class="muted">${escapeHtml(a.reason || '')}</span>
      <div class="detail">${escapeHtml(detail)}</div>`;
    box.appendChild(div);
  });
  parent.appendChild(box);
  scrollToBottom();
}

function formatResult(result) {
  if (result == null) return 'OK';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `<div class="typing"><span class="spinner"></span>考え中…</div>`;
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
    addMessage('error', '対象タブを特定できませんでした。');
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
      const wrap = addMessage('assistant', reply || '(応答なし)');
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
    addMessage('error', `${verb} 失敗: ${e.message}`);
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

// 「補足を付ける」: ページ上で要素をクリックして補足を付ける注釈モードを開始。
els.btnPick.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  try {
    await send({ type: 'START_PICKER', tabId: state.tabId });
    showBanner('ページ上で補足を付けたい場所をクリックしてください（Escで終了）。', true);
  } catch (e) {
    addMessage('error', `注釈モードを開始できません: ${e.message}`);
  }
});

// 「お描き」: ページ上で円/四角/矢印/ペンを使って印を描くお描きモードを開始。
els.btnDraw.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  try {
    await send({ type: 'START_DRAWING', tabId: state.tabId });
    showBanner('ページ上で図形を選んで印を描いてください（描き終えたら「完了」、Escで終了）。', true);
  } catch (e) {
    addMessage('error', `お描きを開始できません: ${e.message}`);
  }
});

// 「画像でAIへ」: お描きをスクリーンショットに焼き込み(burn-in)、画像ファイルとして
// ダウンロード保存する。AIにはその shot.png を vision で見せる(テキスト変換ではなく絵を見る)。
els.btnCapture.addEventListener('click', async () => {
  if (state.tabId == null) await refreshState();
  if (els.btnCapture.disabled) return;
  els.btnCapture.disabled = true;
  showBanner('スクリーンショットを撮って、お描きを焼き込み中…', true);
  try {
    const res = await send({ type: 'CAPTURE_VISUAL_FEEDBACK', tabId: state.tabId });
    const dir = res?.dir || '';
    const meta = `画像: shot.png (${res.width}×${res.height}px${res.downscaled ? ' / 2000pxに縮小済み' : ''}) / 注釈 ${res.drawn}/${res.items} 件`;
    if (res.transport === 'daemon') {
      addMessage(
        'assistant',
        [
          'デーモンへ送信しました（WebSocket）。',
          '',
          `保存先: ${dir}/`,
          meta,
          '',
          'CLI で「視覚フィードバックの最新を見て」と頼めば、MCP 経由で自動取得されます。',
          '複数プロジェクトが混在する場合は urlContains で今のページに絞れます。',
        ].join('\n')
      );
      showBanner('デーモンへ送信しました。', true);
    } else {
      const note = res.daemonError ? `\n（デーモン送信に失敗→ダウンロード保存にフォールバック: ${res.daemonError}）` : '';
      addMessage(
        'assistant',
        [
          '視覚フィードバックをダウンロードフォルダに保存しました。',
          '',
          `保存先: Downloads/${dir}/`,
          meta,
          '',
          'AIに見せる手順: このフォルダの shot.png を Claude Code / Codex に **画像** として渡してください。',
          '（同フォルダの memo.md に各CLIでの貼り方が書いてあります）' + note,
        ].join('\n')
      );
      showBanner('視覚フィードバックを保存しました。', true);
    }
  } catch (e) {
    addMessage('error', `視覚フィードバックの保存に失敗: ${e.message}`);
    showBanner(`保存に失敗: ${e.message}`, false);
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
    addMessage('assistant', `ページの文脈をコピーしました。別のAIチャットの先頭に貼り付けてから指示してください。\n\n${text}`);
  } catch (e) {
    addMessage('error', `文脈のコピーに失敗: ${e.message}`);
  }
});

els.btnAffordances.addEventListener('click', async () => {
  const r = await runVerb('listAffordances', {});
  if (r?.ok) {
    const list = r.result?.affordances || [];
    const text = list.length
      ? list.map((a) => `[${a.aiId}] <${a.role}> ${a.label}`).join('\n')
      : '操作可能要素は見つかりませんでした。';
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
    showBanner(`AI注入の自動保存範囲: ${rememberScopeLabel(scope)}`, true);
  } catch (err) {
    addMessage('error', `保存範囲を変更できません: ${err.message}`);
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
  if (!confirm('現在のチャット履歴をクリアして、新しいチャットを開始しますか？')) return;
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

const KIND_LABEL = { note: 'メモ', marker: '目印', button: '合図', drawing: 'お描き' };

function rememberScopeLabel(scope) {
  return { page: 'このURLだけ', domain: 'このドメイン全体', all: 'すべてのサイト' }[scope] || 'このURLだけ';
}

function updateMemoCountBadge(list) {
  const count = list.filter((a) => a.kind === 'drawing').length;
  if (els.memoCountBadge) {
    if (count > 0) {
      els.memoCountBadge.hidden = false;
      els.memoCountBadge.textContent = String(count);
      els.memoCountBadge.title = `お描きメモ ${count} 件`;
    } else {
      els.memoCountBadge.hidden = true;
      els.memoCountBadge.textContent = '';
    }
  }
  // 「お描きを画像でAIへ」はお描きが1件以上ある時だけ出す(独立機能ではなくお描きの一部)。
  if (els.annoFoot) els.annoFoot.hidden = count === 0;
  if (els.captureCount) els.captureCount.textContent = count > 0 ? String(count) : '';
}

function renderAnnotationList(list) {
  els.annoList.innerHTML = '';
  updateMemoCountBadge(list);
  if (!list.length) {
    els.annoPanel.hidden = true;
    return;
  }
  els.annoPanel.hidden = false;
  list.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'anno-item' + (a.resolved ? '' : ' unresolved');
    const title =
      a.kind === 'note'
        ? a.note
        : a.kind === 'marker'
          ? a.name
          : a.kind === 'drawing'
            ? a.note || a.shapeText || 'お描き'
            : a.label;
    const sub =
      a.kind === 'drawing'
        ? a.intent || a.shapeText || ''
        : a.intent || (a.kind === 'note' ? '' : a.note) || '';
    // お描きメモは forAI(AIに渡す)の状態を小さく表示する。
    const memoFlag =
      a.kind === 'drawing'
        ? a.forAI === false
          ? '<span class="anno-flag off">AIに渡さない</span>'
          : '<span class="anno-flag on">AIに渡す</span>'
        : '';
    row.innerHTML = `
      <span class="anno-kind">${KIND_LABEL[a.kind] || '補足'}</span>
      <span class="anno-body">
        <span class="anno-title">${escapeHtml(title || '(無題)')}</span>
        ${sub ? `<span class="anno-sub">${escapeHtml(sub)}</span>` : ''}
        ${memoFlag}
        ${a.target ? `<span class="anno-target">対象: ${escapeHtml(a.target)}</span>` : ''}
        ${a.resolved ? '' : '<span class="anno-warn">対象が見つかりません</span>'}
      </span>
      <span class="anno-actions">
        <button data-act="edit" title="編集">編集</button>
        <button data-act="del" title="削除">削除</button>
      </span>`;
    row.querySelector('[data-act="edit"]').addEventListener('click', async () => {
      await send({ type: 'EDIT_ANNOTATION', tabId: state.tabId, id: a.id });
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await send({ type: 'REMOVE_ANNOTATION', tabId: state.tabId, id: a.id });
      refreshAnnotations();
    });
    els.annoList.appendChild(row);
  });
}

// 注釈は content 側で保存されるため、storage変化を監視して一覧を更新する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aiAdvisorAnnotations) refreshAnnotations();
  if (area === 'local' && changes.aiAdvisorSettings) refreshState();
  if (area === 'local' && changes[PROMPT_HISTORY_KEY]) {
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
  await Promise.all([loadPromptHistory(), refreshState()]);
  syncHistoryButton();
  els.input.focus();
}

init();
