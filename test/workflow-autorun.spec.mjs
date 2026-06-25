// 自動実行(autorun)の不可逆ガード: source==='autorun' のとき、対象ラベルが「注文を確定/購入/削除」
// 等のクリックは保留(held)され実行されないこと、通常ボタンは実行されることを検証する。
// content-script.js を chrome スタブ付きで直接注入して確認する(workflow.spec.mjs と同じ手法)。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');
const jaLocaleJson = fs.readFileSync(path.join(projectRoot, 'sidepanel/locales/ja.json'), 'utf8');

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
  <button id="add" data-testid="add" style="position:fixed;left:60px;top:40px;width:200px;height:40px">カートに入れる</button>
  <button id="buy" data-testid="buy" style="position:fixed;left:60px;top:120px;width:200px;height:40px">注文を確定する</button>
  <button id="now" data-testid="now" style="position:fixed;left:60px;top:200px;width:200px;height:40px">今すぐ買う</button>
  <button id="icon" data-testid="icon" aria-label="" style="position:fixed;left:60px;top:280px;width:40px;height:40px"><svg width="20" height="20"></svg></button>
  <form id="f" style="position:fixed;left:60px;top:360px"><input name="q" value="x"><button type="submit" data-testid="submit-btn">検索</button></form>
  <output id="state" data-testid="state">idle</output>
  <script>
    document.getElementById('add').addEventListener('click', function () { document.getElementById('state').textContent = 'added'; });
    document.getElementById('buy').addEventListener('click', function () { document.getElementById('state').textContent = 'ordered'; });
    document.getElementById('now').addEventListener('click', function () { document.getElementById('state').textContent = 'bought'; });
    document.getElementById('icon').addEventListener('click', function () { document.getElementById('state').textContent = 'icon-clicked'; });
  </script>
</body></html>`;

const CHROME_STUB = `
  window.__bagListener = null; window.__store = {};
  window.__bagI18n = ${jaLocaleJson};
  const __c = (v) => (v === undefined ? undefined : structuredClone(v));
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'GET_I18N') {
          const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
          if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r);
        }
        if (typeof cb === 'function') { cb({ ok: true }); return; } return Promise.resolve({ ok: true });
      },
      get lastError() { return null; },
    },
    storage: {
      local: {
        get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: __c(window.__store[k]) } : __c(window.__store)),
        set: (o) => { for (const [k, v] of Object.entries(o)) window.__store[k] = __c(v); return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
  };
`;

const send = (page, m) => page.evaluate((msg) => new Promise((r) => window.__bagListener(msg, {}, r)), m);
const run = (page, verb, args, source) =>
  send(page, { type: 'RUN_ACTIONS', actions: [{ verb, args }], source }).then((o) => o.results[0]);

test.describe('自動実行の不可逆ガード', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(PAGE_HTML);
    await page.addScriptTag({ content: CHROME_STUB });
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });
  });

  test('autorun: 通常ボタン(カートに入れる)は実行される', async ({ page }) => {
    const r = await run(page, 'clickAffordance', { selector: '#add' }, 'autorun');
    expect(r.ok).toBe(true);
    expect(await page.getByTestId('state').innerText()).toBe('added');
  });

  test('autorun: 「注文を確定する」は保留(held)され実行されない', async ({ page }) => {
    const r = await run(page, 'clickAffordance', { selector: '#buy' }, 'autorun');
    expect(r.ok).toBe(false);
    expect(r.held).toBe(true);
    expect(r.label).toContain('確定');
    expect(await page.getByTestId('state').innerText()).toBe('idle'); // 押されていない
  });

  test('chat: 同じ確定ボタンは保留されない(ガードは autorun 限定)', async ({ page }) => {
    const r = await run(page, 'clickAffordance', { selector: '#buy' }, 'chat');
    expect(r.ok).toBe(true);
    expect(r.held).toBeFalsy();
    expect(await page.getByTestId('state').innerText()).toBe('ordered');
  });

  test('autorun: 破壊的動詞(removeElement)はブロックされる', async ({ page }) => {
    const r = await run(page, 'removeElement', { selector: '#add' }, 'autorun');
    expect(r.ok).toBe(false);
    await expect(page.locator('#add')).toHaveCount(1); // 消えていない
  });

  test('autorun: 「今すぐ買う」も保留される(キーワード拡充)', async ({ page }) => {
    const r = await run(page, 'clickAffordance', { selector: '#now' }, 'autorun');
    expect(r.ok).toBe(false);
    expect(r.held).toBe(true);
    expect(await page.getByTestId('state').innerText()).toBe('idle');
  });

  test('autorun: 名前の取れないアイコンのみボタンは fail-safe で保留', async ({ page }) => {
    const r = await run(page, 'clickAffordance', { selector: '#icon' }, 'autorun');
    expect(r.ok).toBe(false);
    expect(r.held).toBe(true);
    expect(await page.getByTestId('state').innerText()).toBe('idle');
  });

  test('autorun: allow-list 外の navigateTo / submitForm は拒否(提示も実行もしない)', async ({ page }) => {
    const nav = await run(page, 'navigateTo', { url: 'https://example.com/' }, 'autorun');
    expect(nav.ok).toBe(false);
    expect(nav.held).toBeFalsy(); // held ではなく deny-by-default の拒否
    const sub = await run(page, 'submitForm', { selector: '#f' }, 'autorun');
    expect(sub.ok).toBe(false);
    // フォーム送信されていない(stateは idle のまま)
    expect(await page.getByTestId('state').innerText()).toBe('idle');
  });
});
