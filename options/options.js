// 設定ページ。AI接続・サイトルール・レシピを編集して保存する。
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/storage.js';
import { createI18n, resolveLocale, normalizeLocale, languageName } from '../sidepanel/i18n.js';

const $ = (id) => document.getElementById(id);
const SAFE_RECIPE_VERBS = new Set(['injectHtml', 'injectCss', 'injectScript', 'outlineElement', 'injectButton', 'injectPanel']);
const REMEMBER_SCOPES = new Set(['page', 'domain', 'all']);

let settings = structuredClone(DEFAULT_SETTINGS);

// ---- i18n（サイドパネルと同じ辞書を直接 import。options は ES module なので import 可能） ----
let i18n = null;
const t = (key, vars) => i18n?.t(key, vars) ?? key;

// data-i18n* 属性を持つ要素へ翻訳を適用する（sidepanel.js と同じ規約 + data-i18n-html）。
function applyI18n() {
  if (!i18n) return;
  document.documentElement.lang = i18n.locale;
  document.title = t('opt.docTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  // 信頼できる静的文言のみ。<code> 等のインラインマークアップを含むヒントで使う。
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
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

// ---- 初期化 ----
async function init() {
  settings = await getSettings();
  i18n = await createI18n(resolveLocale(settings.ui?.language));
  $('ui-language').value = normalizeRememberLanguage(settings.ui?.language);
  applyI18n();
  fillAiForm();
  fillMemoryForm();
  fillDaemonForm();
  renderRules();
  renderRecipeSites();
  toggleProviderFields();
  bindEvents();
}

// UI言語セレクタの値（保存値そのまま。未設定/不正は 'auto'）。
function normalizeRememberLanguage(language) {
  return ['auto', 'en', 'ko', 'ja', 'zh'].includes(language) ? language : 'auto';
}

// 言語セレクタ変更: 設定へ保存し、辞書を切り替えて画面を即再描画する。
async function changeLanguage(nextLanguage) {
  const language = normalizeRememberLanguage(nextLanguage);
  settings.ui = { ...(settings.ui || {}), language };
  await saveSettings(settings);
  await i18n.setLocale(resolveLocale(language));
  applyI18n();
  // 動的に生成される一覧/ステータスも翻訳し直す。
  renderRules();
  renderRecipeSites();
  setStatus('ai-status', t('language.changed', { language: languageName(i18n.locale) }), true);
}

// ---- 視覚フィードバック デーモン ----
function fillDaemonForm() {
  const d = settings.daemon || {};
  $('daemon-enabled').checked = Boolean(d.enabled);
  $('vf-auto-sync').checked = Boolean(settings.visualFeedback?.autoSync);
  $('daemon-url').value = d.url || DEFAULT_SETTINGS.daemon.url;
  $('daemon-token').value = d.token || '';
  $('daemon-save-dir').value = d.saveDir || '';
}

async function saveDaemon() {
  settings.daemon = {
    ...(settings.daemon || {}),
    enabled: $('daemon-enabled').checked,
    url: $('daemon-url').value.trim() || DEFAULT_SETTINGS.daemon.url,
    token: $('daemon-token').value.trim(),
    saveDir: $('daemon-save-dir').value.trim(),
  };
  settings.visualFeedback = {
    ...(settings.visualFeedback || {}),
    autoSync: $('vf-auto-sync').checked,
  };
  await saveSettings(settings);
  setStatus('daemon-status', t('opt.status.saved'), true);
}

// デーモンへ WebSocket 接続できるか（認証含む）を確認する。送信はしない。
function testDaemon() {
  const url = $('daemon-url').value.trim();
  const token = $('daemon-token').value.trim();
  if (!url) {
    setStatus('daemon-status', t('opt.daemon.enterUrl'), false);
    return;
  }
  setStatus('daemon-status', t('opt.daemon.connecting'), true);
  let ws;
  try {
    ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
  } catch (e) {
    setStatus('daemon-status', t('opt.daemon.invalidUrl', { message: e.message }), false);
    return;
  }
  const timer = setTimeout(() => {
    try {
      ws.close();
    } catch {
      /* 既に閉じている */
    }
    setStatus('daemon-status', t('opt.daemon.timeout'), false);
  }, 4000);
  ws.onopen = () => {
    clearTimeout(timer);
    setStatus('daemon-status', t('opt.daemon.testOk'), true);
    ws.close();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    setStatus('daemon-status', t('opt.daemon.testFailed'), false);
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
  setStatus('ai-status', t('opt.status.saved'), true);
}

async function saveMemory() {
  settings.memory = {
    ...(settings.memory || {}),
    defaultScope: normalizeRememberScope($('default-scope').value),
  };
  await saveSettings(settings);
  setStatus('memory-status', t('opt.status.saved'), true);
}

// ---- サイトルール ----
function renderRules() {
  const body = $('rules-body');
  body.innerHTML = '';
  if (!settings.sites.length) {
    body.innerHTML = `<tr><td colspan="5" class="hint">${escapeHtmlText(t('opt.rules.empty'))}</td></tr>`;
  }
  settings.sites.forEach((rule) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" ${rule.enabled ? 'checked' : ''} data-act="toggle" /></td>
      <td><input type="text" value="${escapeAttr(rule.label || '')}" data-act="label" /></td>
      <td>
        <select data-act="type">
          <option value="page" ${rule.matchType === 'page' ? 'selected' : ''}>${escapeHtmlText(t('opt.match.page'))}</option>
          <option value="domain" ${rule.matchType === 'domain' ? 'selected' : ''}>${escapeHtmlText(t('opt.match.domain'))}</option>
          <option value="all" ${rule.matchType === 'all' ? 'selected' : ''}>${escapeHtmlText(t('opt.match.all'))}</option>
          <option value="prefix" ${rule.matchType === 'prefix' ? 'selected' : ''}>${escapeHtmlText(t('opt.match.prefix'))}</option>
          <option value="regex" ${rule.matchType === 'regex' ? 'selected' : ''}>${escapeHtmlText(t('opt.match.regex'))}</option>
        </select>
      </td>
      <td><input type="text" class="pattern" value="${escapeAttr(rule.pattern || '')}" data-act="pattern" /></td>
      <td><button class="danger" data-act="del">${escapeHtmlText(t('opt.common.delete'))}</button></td>`;
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
    alert(t('opt.rules.enterPattern'));
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
    sel.innerHTML = `<option value="">${escapeHtmlText(t('opt.recipe.autoAddOption'))}</option>`;
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
    if (!Array.isArray(parsed)) throw new Error(t('opt.recipe.errArray'));
    for (const a of parsed) {
      if (!a || typeof a.verb !== 'string') throw new Error(t('opt.recipe.errShape'));
      if (!SAFE_RECIPE_VERBS.has(a.verb)) {
        throw new Error(t('opt.recipe.errVerb', { verbs: Array.from(SAFE_RECIPE_VERBS).join(', '), verb: a.verb }));
      }
    }
  } catch (e) {
    setStatus('recipe-status', t('opt.recipe.errJson', { message: e.message }), false);
    return;
  }
  settings.recipes[id] = parsed;
  await saveSettings(settings);
  setStatus('recipe-status', t('opt.status.saved'), true);
}

function insertTemplate() {
  const tpl = [
    {
      verb: 'injectHtml',
      args: { id: 'saved-note', html: '<p>このページの補足です。</p>' },
      // when: 条件を満たすときだけ実行する。selectorAbsent は既に挿入済みなら再注入しない
      //       (SPA内部遷移での再適用時の重複防止)。
      when: { selectorAbsent: '[data-bag-injected="saved-note"]' },
      reason: '保存済みHTMLを再表示',
    },
    {
      verb: 'injectCss',
      args: { id: 'saved-style', css: '[data-bag-injected="saved-note"] { outline: 2px solid #0f766e; padding: 8px; }' },
      reason: '保存済みCSSを再適用',
    },
    {
      verb: 'outlineElement',
      args: { selector: '#async-result', color: '#0f766e' },
      // waitFor: 非同期で後から現れる要素を待ってから実行する(遅延ロード/SPA対応)。
      //          selector が timeoutMs(ミリ秒)以内に出現しなければ失敗扱いになる。
      waitFor: { selector: '#async-result', timeoutMs: 5000 },
      reason: '遅延表示される結果が出てから枠線で強調する',
    },
    {
      verb: 'injectPanel',
      args: { title: '注文画面の補足', html: '<p>この画面の使い方…</p>', id: 'orders-help' },
      // urlContains: SPAでURLの一部が一致する画面でだけ表示する(例: ハッシュルート #/orders)。
      when: { urlContains: '#/orders' },
      reason: '注文画面のときだけ補足パネルを出す',
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
      ui: { ...DEFAULT_SETTINGS.ui, ...(data.ui || {}) },
      daemon: { ...DEFAULT_SETTINGS.daemon, ...(data.daemon || {}) },
      visualFeedback: { ...DEFAULT_SETTINGS.visualFeedback, ...(data.visualFeedback || {}) },
    };
      await saveSettings(settings);
      // インポートした言語設定を反映する。
      $('ui-language').value = normalizeRememberLanguage(settings.ui?.language);
      await i18n.setLocale(resolveLocale(settings.ui?.language));
      applyI18n();
      fillAiForm();
      fillMemoryForm();
      fillDaemonForm();
      renderRules();
      renderRecipeSites();
      toggleProviderFields();
      setStatus('ai-status', t('opt.status.imported'), true);
    } catch (e) {
      alert(t('opt.status.importFailed', { message: e.message }));
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
function escapeHtmlText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function matchTypeLabel(type) {
  return {
    page: t('opt.match.page'),
    domain: t('opt.match.domain'),
    all: t('opt.match.all'),
    prefix: t('opt.match.prefix'),
    regex: t('opt.match.regex'),
  }[type] || type;
}
function normalizeRememberScope(scope) {
  return REMEMBER_SCOPES.has(scope) ? scope : 'page';
}

// ---- イベント結線 ----
function bindEvents() {
  $('ui-language').addEventListener('change', (e) => changeLanguage(e.target.value));
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
