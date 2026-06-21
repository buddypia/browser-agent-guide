import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 回帰テスト: 「補足を付ける(picker)」「お描き(drawing)」はサイドパネルのボタンから
// 開始するため、ESC 押下時もフォーカスはサイドパネル(別ドキュメント)に残る。ページ側の
// keydown ハンドラに ESC が届かないので、サイドパネル側で ESC を拾って STOP_PICKER/
// STOP_DRAWING を送ること、モード未起動時は何も送らないことを保証する。

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let server;
let origin;

function pageUrl(relativePath) {
  return `${origin}/${relativePath}`;
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function startStaticServer() {
  return new Promise((resolve, reject) => {
    const nextServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'sidepanel/sidepanel.html';
      const filePath = path.resolve(projectRoot, requested);
      if (!filePath.startsWith(projectRoot + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.readFile(filePath, (err, body) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'content-type': contentType(filePath) });
        res.end(body);
      });
    });
    nextServer.once('error', reject);
    nextServer.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
}

// ui-quality.spec.mjs の installChromeMock を土台に、送信された message.type を
// window.__sentTypes に記録する版。ESC が正しい停止メッセージを送るかを検証できる。
async function installChromeMock(page) {
  await page.addInitScript(() => {
    window.__sentTypes = [];
    const store = {};
    const storageListeners = new Set();

    function copy(value) {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function getStorageResult(keys) {
      if (keys == null) return copy(store);
      if (typeof keys === 'string') return { [keys]: copy(store[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, copy(store[key])]));
      if (typeof keys === 'object') {
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, copy(store[key] ?? fallback)]));
      }
      return {};
    }

    function emitStorageChanges(changes) {
      storageListeners.forEach((listener) => listener(changes, 'local'));
    }

    function runtimeResult(message) {
      switch (message?.type) {
        case 'GET_ACTIVE_TAB_STATE':
          return {
            tabId: 1,
            url: 'https://example.com/app',
            title: 'Example App',
            rememberScope: 'page',
            hasApiKey: true,
            matched: true,
            remembered: false,
            provider: 'mock',
          };
        case 'LIST_ANNOTATIONS':
          return { annotations: [] };
        default:
          return {};
      }
    }

    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          window.__sentTypes.push(message?.type);
          queueMicrotask(() => callback?.({ ok: true, result: runtimeResult(message) }));
        },
      },
      storage: {
        local: {
          async get(keys) {
            return getStorageResult(keys);
          },
          async set(items) {
            const changes = {};
            Object.entries(items || {}).forEach(([key, value]) => {
              changes[key] = { oldValue: copy(store[key]), newValue: copy(value) };
              store[key] = copy(value);
            });
            emitStorageChanges(changes);
          },
          async remove(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            const changes = {};
            list.forEach((key) => {
              changes[key] = { oldValue: copy(store[key]), newValue: undefined };
              delete store[key];
            });
            emitStorageChanges(changes);
          },
        },
        onChanged: {
          addListener(listener) {
            storageListeners.add(listener);
          },
          removeListener(listener) {
            storageListeners.delete(listener);
          },
        },
      },
      tabs: {
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
    };
  });
}

test.describe('picker / drawing ESC exit', () => {
  test.beforeAll(async () => {
    server = await startStaticServer();
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test.beforeEach(async ({ page }) => installChromeMock(page));

  test('ESC exits the note picker even when focus stays in the side panel', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('#status-banner')).toBeVisible();

    // フォーカスはサイドパネルに残ったまま(ページ要素はクリックしない)。ESC を押す。
    await page.keyboard.press('Escape');

    await expect.poll(() => page.evaluate(() => window.__sentTypes)).toContain('STOP_PICKER');
    await expect(page.locator('#status-banner')).toBeHidden();
  });

  test('ESC exits drawing mode even when focus stays in the side panel', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await page.getByRole('button', { name: 'Draw' }).click();
    await expect(page.locator('#status-banner')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect.poll(() => page.evaluate(() => window.__sentTypes)).toContain('STOP_DRAWING');
    await expect(page.locator('#status-banner')).toBeHidden();
  });

  test('ESC is inert when no picker/drawing mode is active', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    // 初期化(refreshState)の完了を、接続バナーの表示で待つ。
    await expect(page.locator('#status-banner')).toBeVisible();

    await page.keyboard.press('Escape');

    const types = await page.evaluate(() => window.__sentTypes);
    expect(types).not.toContain('STOP_PICKER');
    expect(types).not.toContain('STOP_DRAWING');
  });
});
