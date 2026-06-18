import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function installChromeMock(page) {
  await page.addInitScript(() => {
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
        case 'RUN_VERB':
          if (message.verb === 'listAffordances') return { ok: true, result: { affordances: [] } };
          return { ok: true, result: {} };
        case 'CHAT':
          return {
            reply: 'Checked the goal, context, and result.',
            actions: [],
            results: [],
          };
        case 'SET_REMEMBER_SCOPE':
        case 'OPEN_OPTIONS':
        case 'START_PICKER':
        case 'EXPORT_CONTEXT':
          return {};
        default:
          return {};
      }
    }

    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
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

async function expectNoAxeViolations(page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

test.describe('UI quality gates', () => {
  test.beforeAll(async () => {
    server = await startStaticServer();
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test.beforeEach(async ({ page }) => installChromeMock(page));

  test('side panel exposes frequent actions and passes axe', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    await expect(page.getByRole('heading', { name: 'Page Operation Rails' })).toBeVisible();
    await expect(page.getByLabel('Language')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add context' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy context' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show clues' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open prompt history' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Instruction for AI' })).toBeVisible();

    await page.getByRole('button', { name: 'Open prompt history' }).click();
    await expect(page.locator('#prompt-history-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open prompt history' })).toHaveAttribute('aria-expanded', 'true');

    await expectNoAxeViolations(page);
  });

  test('side panel changes language from the top control', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    const language = page.getByLabel('Language');
    await expect(language).toBeVisible();
    await expect(language).toHaveValue('en');
    await expect(language.locator('option')).toHaveCount(4);
    await expect(language.locator('option')).toHaveText(['EN', 'KO', 'JA', 'ZH']);

    await language.selectOption('ja');
    await expect(page.getByRole('heading', { name: 'ページ操作のレール' })).toBeVisible();
    await expect(page.getByRole('button', { name: '補足を付ける' })).toBeVisible();

    await page.getByLabel('言語').selectOption('ko');
    await expect(page.getByRole('heading', { name: '페이지 작업 레일' })).toBeVisible();
    await expect(page.getByRole('button', { name: '맥락 추가' })).toBeVisible();

    await page.getByLabel('언어').selectOption('zh');
    await expect(page.getByRole('heading', { name: '页面操作轨道' })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加上下文' })).toBeVisible();

    await page.getByLabel('语言').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Page Operation Rails' })).toBeVisible();
  });

  test('side panel can send a mocked prompt', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await page.getByRole('textbox', { name: 'Instruction for AI' }).fill('Check the main CTA on this page');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('#messages').getByText('Check the main CTA on this page')).toBeVisible();
    await expect(page.locator('#messages').getByText('Checked the goal, context, and result.')).toBeVisible();
  });

  test('options page passes axe on the default settings state', async ({ page }) => {
    await page.goto(pageUrl('options/options.html'));

    await expect(page.getByRole('heading', { name: 'Browser Agent Guide 設定' })).toBeVisible();
    await expect(page.getByLabel('プロバイダ')).toBeVisible();
    await expect(page.locator('.anthropic-field').first()).toBeHidden();
    await expect(page.getByRole('button', { name: '保存' }).first()).toBeVisible();

    await expectNoAxeViolations(page);
  });
});
