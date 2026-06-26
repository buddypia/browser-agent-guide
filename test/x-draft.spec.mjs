// X/Twitter draft composer support.
// The real X DOM changes often, so this spec verifies the contract we rely on:
// data-testid compose opener, contenteditable tweetTextarea, hidden media input,
// and a tweetButton that must never be clicked by draft creation.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');
const jaLocaleJson = fs.readFileSync(path.join(projectRoot, 'sidepanel/locales/ja.json'), 'utf8');

const PNG_DATA_URL =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lz8nWAAAAABJRU5ErkJggg==';

const X_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    [data-testid="SideNav_NewTweet_Button"] { display: inline-flex; margin: 32px; padding: 12px 18px; background: #111; color: white; }
    [role="dialog"] { position: fixed; left: 80px; top: 80px; width: 520px; padding: 20px; border: 1px solid #ddd; background: white; }
    [data-testid="tweetTextarea_0"] { min-height: 120px; padding: 12px; border: 1px solid #aaa; white-space: pre-wrap; }
  </style>
</head><body>
  <a href="/compose/post" role="button" data-testid="SideNav_NewTweet_Button">Post</a>
  <output data-testid="state">idle</output>
  <script>
    window.__xDraftState = { text: '', files: [], posted: false, opened: false };
    document.querySelector('[data-testid="SideNav_NewTweet_Button"]').addEventListener('click', function (e) {
      e.preventDefault();
      if (document.querySelector('[role="dialog"]')) return;
      window.__xDraftState.opened = true;
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML =
        '<div data-testid="tweetTextarea_0" role="textbox" aria-label="Post text" contenteditable="true"></div>' +
        '<input data-testid="fileInput" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>' +
        '<button data-testid="tweetButton" type="button">Post</button>';
      document.body.appendChild(dialog);
      const editor = dialog.querySelector('[data-testid="tweetTextarea_0"]');
      const file = dialog.querySelector('[data-testid="fileInput"]');
      const button = dialog.querySelector('[data-testid="tweetButton"]');
      editor.addEventListener('input', function () {
        window.__xDraftState.text = editor.innerText || editor.textContent || '';
      });
      file.addEventListener('change', function () {
        window.__xDraftState.files = Array.from(file.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size }));
      });
      button.addEventListener('click', function () {
        window.__xDraftState.posted = true;
        document.querySelector('[data-testid="state"]').textContent = 'posted';
      });
    });
  </script>
</body></html>`;

const OTHER_PAGE_HTML = '<!doctype html><html><body><main>not X</main></body></html>';

const CHROME_STUB = `
  window.__bagListener = null;
  window.__store = {};
  window.__bagI18n = ${jaLocaleJson};
  window.__runtimeMessages = [];
  const __clone = (v) => (v === undefined ? undefined : structuredClone(v));
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'GET_I18N') {
          const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
          if (typeof cb === 'function') { cb(r); return; }
          return Promise.resolve(r);
        }
        window.__runtimeMessages.push(__clone(msg));
        if (msg && msg.type === 'FETCH_IMAGE_AS_DATA_URL') {
          const r = { ok: true, result: { dataUrl: ${JSON.stringify(PNG_DATA_URL)}, filename: 'from-url.png' } };
          if (typeof cb === 'function') { cb(r); return; }
          return Promise.resolve(r);
        }
        if (typeof cb === 'function') { cb({ ok: true }); return; }
        return Promise.resolve({ ok: true });
      },
      get lastError() { return null; },
    },
    storage: {
      local: {
        get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: __clone(window.__store[k]) } : __clone(window.__store)),
        set: (obj) => { for (const [key, val] of Object.entries(obj)) window.__store[key] = __clone(val); return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
  };
`;

const send = (page, msg) => page.evaluate((m) => new Promise((r) => window.__bagListener(m, {}, r)), msg);
const run = (page, verb, args, source = 'chat') =>
  send(page, { type: 'RUN_ACTIONS', actions: [{ verb, args, reason: 'test' }], source }).then((o) => o.results[0]);

async function installContentScript(page) {
  await page.addScriptTag({ content: CHROME_STUB });
  await page.addStyleTag({ content: contentCss });
  await page.addScriptTag({ content: contentScript });
}

test.describe('X draft composer verb', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://x.com/**', (route) => route.fulfill({ contentType: 'text/html', body: X_PAGE_HTML }));
    await page.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: OTHER_PAGE_HTML }));
  });

  test('draftXPost opens the composer, fills text, attaches a Data URL image, and never posts', async ({ page }) => {
    await page.goto('https://x.com/home');
    await installContentScript(page);

    const res = await run(page, 'draftXPost', {
      text: 'ブラウザから下書きだけ作るテスト\\nPost button stays untouched.',
      imageDataUrl: PNG_DATA_URL,
      filename: 'draft.png',
    });

    expect(res.ok).toBe(true);
    expect(res.result.drafted).toBe(true);
    expect(res.result.posted).toBe(false);
    expect(res.result.image.name).toBe('draft.png');
    const state = await page.evaluate(() => window.__xDraftState);
    expect(state.opened).toBe(true);
    expect(state.text).toContain('下書きだけ作るテスト');
    expect(state.files).toHaveLength(1);
    expect(state.files[0].type).toBe('image/png');
    expect(state.posted).toBe(false);
    await expect(page.getByTestId('state')).toHaveText('idle');
  });

  test('draftXPost can fetch an image URL through the service worker bridge', async ({ page }) => {
    await page.goto('https://x.com/home');
    await installContentScript(page);

    const res = await run(page, 'draftXPost', {
      text: 'URL image draft',
      imageUrl: 'https://assets.example/generated.png',
    });

    expect(res.ok).toBe(true);
    expect(res.result.image.name).toBe('from-url.png');
    const messages = await page.evaluate(() => window.__runtimeMessages);
    expect(messages.some((m) => m.type === 'FETCH_IMAGE_AS_DATA_URL' && m.url === 'https://assets.example/generated.png')).toBe(true);
  });

  test('chat actions cannot click the X Post button after a draft is created', async ({ page }) => {
    await page.goto('https://x.com/home');
    await installContentScript(page);
    await run(page, 'draftXPost', { text: 'do not publish' });

    const blocked = await run(page, 'clickElement', { selector: '[data-testid="tweetButton"]' }, 'chat');

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('下書き');
    expect(await page.evaluate(() => window.__xDraftState.posted)).toBe(false);
    await expect(page.getByTestId('state')).toHaveText('idle');
  });

  test('draftXPost refuses to run outside X/Twitter hosts', async ({ page }) => {
    await page.goto('https://example.com/');
    await installContentScript(page);

    const res = await run(page, 'draftXPost', { text: 'wrong host' });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('x.com');
  });
});
