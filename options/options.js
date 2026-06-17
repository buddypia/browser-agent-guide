// 設定ページ。AI接続・サイトルール・レシピを編集して保存する。
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);
const SAFE_RECIPE_VERBS = new Set(['injectHtml', 'injectCss', 'injectScript', 'outlineElement', 'injectButton', 'injectPanel']);
const REMEMBER_SCOPES = new Set(['page', 'domain', 'all']);

let settings = structuredClone(DEFAULT_SETTINGS);

// ---- 初期化 ----
async function init() {
  settings = await getSettings();
  fillAiForm();
  fillMemoryForm();
  fillDaemonForm();
  renderRules();
  renderRecipeSites();
  toggleProviderFields();
  bindEvents();
}

// ---- 視覚フィードバック デーモン ----
function fillDaemonForm() {
  const d = settings.daemon || {};
  $('daemon-enabled').checked = Boolean(d.enabled);
  $('daemon-url').value = d.url || DEFAULT_SETTINGS.daemon.url;
  $('daemon-token').value = d.token || '';
}

async function saveDaemon() {
  settings.daemon = {
    ...(settings.daemon || {}),
    enabled: $('daemon-enabled').checked,
    url: $('daemon-url').value.trim() || DEFAULT_SETTINGS.daemon.url,
    token: $('daemon-token').value.trim(),
  };
  await saveSettings(settings);
  setStatus('daemon-status', '保存しました', true);
}

// デーモンへ WebSocket 接続できるか（認証含む）を確認する。送信はしない。
function testDaemon() {
  const url = $('daemon-url').value.trim();
  const token = $('daemon-token').value.trim();
  if (!url) {
    setStatus('daemon-status', 'URL を入力してください', false);
    return;
  }
  setStatus('daemon-status', '接続中…', true);
  let ws;
  try {
    ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
  } catch (e) {
    setStatus('daemon-status', `URL が不正です: ${e.message}`, false);
    return;
  }
  const timer = setTimeout(() => {
    try {
      ws.close();
    } catch {
      /* 既に閉じている */
    }
    setStatus('daemon-status', 'タイムアウト（デーモン未起動かURL違い）', false);
  }, 4000);
  ws.onopen = () => {
    clearTimeout(timer);
    setStatus('daemon-status', '接続OK（認証成功）', true);
    ws.close();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    setStatus('daemon-status', '接続失敗（未起動 / URL違い / トークン不一致）', false);
  };
}

function fillMemoryForm() {
  $('default-scope').value = normalizeRememberScope(settings.memory?.defaultScope);
}

// ---- AI設定 ----
function fillAiForm() {
  $('provider').value = settings.ai.provider;
  $('apiKey').value = settings.ai.apiKey;
  $('baseUrl').value = settings.ai.baseUrl;
  $('model').value = settings.ai.model;
  $('anthropicModel').value = settings.ai.anthropicModel;
  $('geminiModel').value = settings.ai.geminiModel;
  $('temperature').value = settings.ai.temperature;
}

function toggleProviderFields() {
  const p = $('provider').value;
  document.querySelectorAll('.oai-field').forEach((el) => (el.style.display = p === 'openai' || p === 'custom' ? '' : 'none'));
  document.querySelectorAll('.anthropic-field').forEach((el) => (el.style.display = p === 'anthropic' ? '' : 'none'));
  document.querySelectorAll('.gemini-field').forEach((el) => (el.style.display = p === 'gemini' ? '' : 'none'));
}

async function saveAi() {
  settings.ai = {
    ...settings.ai,
    provider: $('provider').value,
    apiKey: $('apiKey').value.trim(),
    baseUrl: $('baseUrl').value.trim() || DEFAULT_SETTINGS.ai.baseUrl,
    model: $('model').value.trim() || DEFAULT_SETTINGS.ai.model,
    anthropicModel: $('anthropicModel').value.trim() || DEFAULT_SETTINGS.ai.anthropicModel,
    geminiModel: $('geminiModel').value.trim() || DEFAULT_SETTINGS.ai.geminiModel,
    temperature: Number($('temperature').value) || 0,
  };
  await saveSettings(settings);
  setStatus('ai-status', '保存しました', true);
}

async function saveMemory() {
  settings.memory = {
    ...(settings.memory || {}),
    defaultScope: normalizeRememberScope($('default-scope').value),
  };
  await saveSettings(settings);
  setStatus('memory-status', '保存しました', true);
}

// ---- サイトルール ----
function renderRules() {
  const body = $('rules-body');
  body.innerHTML = '';
  if (!settings.sites.length) {
    body.innerHTML = '<tr><td colspan="5" class="hint">まだ記憶したURLはありません。補足やチャットで変更すると自動で追加されます。</td></tr>';
  }
  settings.sites.forEach((rule) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" ${rule.enabled ? 'checked' : ''} data-act="toggle" /></td>
      <td><input type="text" value="${escapeAttr(rule.label || '')}" data-act="label" /></td>
      <td>
        <select data-act="type">
          <option value="page" ${rule.matchType === 'page' ? 'selected' : ''}>ページURL</option>
          <option value="domain" ${rule.matchType === 'domain' ? 'selected' : ''}>ドメイン</option>
          <option value="all" ${rule.matchType === 'all' ? 'selected' : ''}>すべて</option>
          <option value="prefix" ${rule.matchType === 'prefix' ? 'selected' : ''}>前方一致</option>
          <option value="regex" ${rule.matchType === 'regex' ? 'selected' : ''}>正規表現</option>
        </select>
      </td>
      <td><input type="text" class="pattern" value="${escapeAttr(rule.pattern || '')}" data-act="pattern" /></td>
      <td><button class="danger" data-act="del">削除</button></td>`;
    bindRuleRow(tr, rule);
    body.appendChild(tr);
  });
}

function bindRuleRow(tr, rule) {
  tr.querySelector('[data-act="toggle"]').addEventListener('change', (e) => {
    rule.enabled = e.target.checked;
    persistSites();
  });
  tr.querySelector('[data-act="label"]').addEventListener('change', (e) => {
    rule.label = e.target.value;
    persistSites();
  });
  tr.querySelector('[data-act="type"]').addEventListener('change', (e) => {
    rule.matchType = e.target.value;
    persistSites();
  });
  tr.querySelector('[data-act="pattern"]').addEventListener('change', (e) => {
    rule.pattern = e.target.value;
    persistSites();
  });
  tr.querySelector('[data-act="del"]').addEventListener('click', () => {
    settings.sites = settings.sites.filter((r) => r.id !== rule.id);
    delete settings.recipes[rule.id];
    persistSites();
    renderRules();
    renderRecipeSites();
  });
}

function addRule() {
  const matchType = $('new-type').value;
  const pattern = matchType === 'all' ? '*' : $('new-pattern').value.trim();
  if (!pattern) {
    alert('パターンを入力してください。');
    return;
  }
  settings.sites.push({
    id: crypto.randomUUID(),
    label: $('new-label').value.trim(),
    matchType,
    pattern,
    enabled: true,
  });
  $('new-label').value = '';
  $('new-pattern').value = '';
  persistSites();
  renderRules();
  renderRecipeSites();
}

async function persistSites() {
  await saveSettings(settings);
}

// ---- レシピ ----
function renderRecipeSites() {
  const sel = $('recipe-site');
  const prev = sel.value;
  sel.innerHTML = '';
  if (!settings.sites.length) {
    sel.innerHTML = '<option value="">(補足やチャット変更で自動追加)</option>';
    $('recipe-json').value = '';
    return;
  }
  settings.sites.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.label || r.pattern} (${matchTypeLabel(r.matchType)})`;
    sel.appendChild(opt);
  });
  sel.value = settings.sites.some((r) => r.id === prev) ? prev : settings.sites[0].id;
  loadRecipeJson();
}

function loadRecipeJson() {
  const id = $('recipe-site').value;
  const list = settings.recipes[id] || [];
  $('recipe-json').value = JSON.stringify(list, null, 2);
}

async function saveRecipe() {
  const id = $('recipe-site').value;
  if (!id) return;
  let parsed;
  try {
    parsed = JSON.parse($('recipe-json').value || '[]');
    if (!Array.isArray(parsed)) throw new Error('配列である必要があります。');
    for (const a of parsed) {
      if (!a || typeof a.verb !== 'string') throw new Error('各要素は {verb, args} 形式です。');
      if (!SAFE_RECIPE_VERBS.has(a.verb)) {
        throw new Error(`レシピで使える動詞は ${Array.from(SAFE_RECIPE_VERBS).join(', ')} のみです: ${a.verb}`);
      }
    }
  } catch (e) {
    setStatus('recipe-status', `JSONエラー: ${e.message}`, false);
    return;
  }
  settings.recipes[id] = parsed;
  await saveSettings(settings);
  setStatus('recipe-status', '保存しました', true);
}

function insertTemplate() {
  const tpl = [
    {
      verb: 'injectHtml',
      args: { id: 'saved-note', html: '<p>このページの補足です。</p>' },
      reason: '保存済みHTMLを再表示',
    },
    {
      verb: 'injectCss',
      args: { id: 'saved-style', css: '[data-bag-injected="saved-note"] { outline: 2px solid #0f766e; padding: 8px; }' },
      reason: '保存済みCSSを再適用',
    },
  ];
  $('recipe-json').value = JSON.stringify(tpl, null, 2);
}

// ---- バックアップ ----
function exportSettings() {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'browser-agent-guide-settings.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importSettings(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
    settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      ai: { ...DEFAULT_SETTINGS.ai, ...(data.ai || {}) },
      memory: { ...DEFAULT_SETTINGS.memory, ...(data.memory || {}) },
      daemon: { ...DEFAULT_SETTINGS.daemon, ...(data.daemon || {}) },
    };
      await saveSettings(settings);
      fillAiForm();
      fillMemoryForm();
      fillDaemonForm();
      renderRules();
      renderRecipeSites();
      toggleProviderFields();
      setStatus('ai-status', 'インポートしました', true);
    } catch (e) {
      alert(`インポート失敗: ${e.message}`);
    }
  };
  reader.readAsText(file);
}

// ---- 補助 ----
function setStatus(id, msg, ok) {
  const el = $(id);
  el.textContent = msg;
  el.className = `status ${ok ? 'ok' : 'err'}`;
  if (msg) setTimeout(() => (el.textContent = ''), 3000);
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}
function matchTypeLabel(type) {
  return { page: 'ページURL', domain: 'ドメイン', all: 'すべて', prefix: '前方一致', regex: '正規表現' }[type] || type;
}
function normalizeRememberScope(scope) {
  return REMEMBER_SCOPES.has(scope) ? scope : 'page';
}

// ---- イベント結線 ----
function bindEvents() {
  $('provider').addEventListener('change', toggleProviderFields);
  $('save-ai').addEventListener('click', saveAi);
  $('save-memory').addEventListener('click', saveMemory);
  $('save-daemon').addEventListener('click', saveDaemon);
  $('test-daemon').addEventListener('click', testDaemon);
  $('add-rule').addEventListener('click', addRule);
  $('recipe-site').addEventListener('change', loadRecipeJson);
  $('save-recipe').addEventListener('click', saveRecipe);
  $('recipe-template').addEventListener('click', insertTemplate);
  $('export').addEventListener('click', exportSettings);
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importSettings(e.target.files[0]);
  });
}

init();
