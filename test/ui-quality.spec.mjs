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

async function installChromeMock(page, seed = {}) {
  await page.addInitScript((seedData) => {
    const store = seedData && typeof seedData === 'object' ? JSON.parse(JSON.stringify(seedData)) : {};
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
            windowId: 2,
            tabIndex: 0,
            tabActive: true,
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
            reply: `Reply to: ${message.text}`,
            actions: [],
            results: [],
          };
        case 'CAPTURE_PAGE_FEEDBACK':
          // daemon 経路: ack 由来の token-less な画像URL（res.imageUrl）をサイドパネルが表示する。
          return {
            transport: 'daemon',
            dir: '/home/user/Downloads/ai-inbox/cap-test-slug',
            id: 'cap-test-slug',
            imageUrl: 'http://127.0.0.1:8765/shot/cap-test-slug.png',
            items: 1,
            drawn: 1,
            width: 800,
            height: 600,
            downscaled: false,
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

    let clipboardText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text) {
          clipboardText = String(text);
          window.__bagCopiedText = clipboardText;
        },
      },
    });
    window.__bagCopiedText = clipboardText;

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
        // サイドパネルは init 時に自前で active tab を解決し、SW 往復を待たずに
        // 当該ページのチャット履歴を先読みする(primeChatHistory)。
        async query() {
          return [{ id: 1, windowId: 2, index: 0, active: true, url: 'https://example.com/app', title: 'Example App' }];
        },
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
    };
  }, seed);
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

    await expect(page.getByRole('heading', { name: 'Start by typing an instruction' })).toBeVisible();
    await expect(page.getByLabel('Target tab')).toContainText('Example App');
    await expect(page.getByRole('button', { name: 'Copy tab ID 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy tab ID 1' })).toContainText('1');
    await expect(page.getByLabel('Target tab')).toContainText('Window 2 / Pos 1');
    await expect(page.getByLabel('Language')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add note' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy for AI' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'List elements' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open prompt history' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete all chat messages' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Instruction for AI' })).toBeVisible();

    await page.getByRole('button', { name: 'Open prompt history' }).click();
    await expect(page.locator('#prompt-history-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open prompt history' })).toHaveAttribute('aria-expanded', 'true');

    await expectNoAxeViolations(page);
  });

  test('side panel separates page notes from workflow actions', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    await expect(page.locator('#btn-workspace-memo')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#memo-workspace')).toBeVisible();
    await expect(page.locator('#workflow-workspace')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Add note' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record workflow' })).toBeHidden();

    await page.locator('#btn-workspace-workflow').click();

    await expect(page.locator('#btn-workspace-workflow')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#btn-workspace-memo')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#workflow-workspace')).toBeVisible();
    await expect(page.locator('#memo-workspace')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Record workflow' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add note' })).toBeHidden();

    await page.locator('#btn-workspace-workflow').press('ArrowLeft');
    await expect(page.locator('#btn-workspace-memo')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#btn-workspace-memo')).toBeFocused();
  });

  test('side panel copies the current tab ID from the target chip', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    await page.getByRole('button', { name: 'Copy tab ID 1' }).click();

    await expect(page.locator('#status-banner')).toContainText('Copied tab ID 1.');
    await expect(page.locator('#btn-copy-tab-id')).toHaveClass(/copied/);
    await expect.poll(() => page.evaluate(() => window.__bagCopiedText)).toBe('1');
  });

  test('side panel changes language from the top control', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    // ブランド名/ロゴはトップバーから削除済み(Chromeのサイドパネルヘッダーと重複するため)。
    await expect(page.locator('.brand')).toHaveCount(0);
    await expect(page.locator('.brand-name')).toHaveCount(0);

    const language = page.getByLabel('Language');
    await expect(language).toBeVisible();
    await expect(language).toHaveValue('en');
    await expect(language.locator('option')).toHaveCount(4);
    // ラベルは国旗表示(EN/KO/JA/ZH をやめた)。
    await expect(language.locator('option')).toHaveText(['🇺🇸', '🇰🇷', '🇯🇵', '🇨🇳']);

    await language.selectOption('ja');
    await expect(page.getByRole('heading', { name: 'まずは指示を入力' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'メモを残す' })).toBeVisible();

    await page.getByLabel('言語').selectOption('ko');
    await expect(page.getByRole('heading', { name: '먼저 지시를 입력하세요' })).toBeVisible();
    await expect(page.getByRole('button', { name: '메모 추가' })).toBeVisible();

    await page.getByLabel('언어').selectOption('zh');
    await expect(page.getByRole('heading', { name: '先输入指令' })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加批注' })).toBeVisible();

    await page.getByLabel('语言').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Start by typing an instruction' })).toBeVisible();
  });

  test('side panel restores per-page chat history on open via its own tab query', async ({ page }) => {
    // SW 往復(GET_ACTIVE_TAB_STATE)を待たずに、パネル自身の chrome.tabs.query で
    // 解決した URL の履歴が開いた直後に表示されること(primeChatHistory)を検証する。
    await installChromeMock(page, {
      aiAdvisorChatHistoryByPage: {
        'https://example.com/app': {
          url: 'https://example.com/app',
          title: 'Example App',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messages: [
            { role: 'user', content: 'remembered question' },
            { role: 'assistant', content: 'remembered answer' },
          ],
        },
      },
    });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    await expect(page.locator('#messages').getByText('remembered question', { exact: true })).toBeVisible();
    await expect(page.locator('#messages').getByText('remembered answer', { exact: true })).toBeVisible();
    // 履歴があるので空ヒントは出ない。
    await expect(page.locator('#messages .empty-hint')).toHaveCount(0);
  });

  test('side panel can send a mocked prompt', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await page.getByRole('textbox', { name: 'Instruction for AI' }).fill('Check the main CTA on this page');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('#messages').getByText('Check the main CTA on this page', { exact: true })).toBeVisible();
    await expect(page.locator('#messages').getByText('Reply to: Check the main CTA on this page')).toBeVisible();
  });

  test('side panel shows the daemon image URL after capture', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    // パネル JS の初期化完了を待つ（init が state を整える）。
    await expect(page.getByRole('textbox', { name: 'Instruction for AI' })).toBeVisible();

    // キャプチャCTA(#btn-capture)はトレイに項目がある時だけ可視。ここでは daemon ack→サイドパネル
    // 表示の配線だけを検証したいので、ハンドラを DOM の .click() で直接起動する（可視性に依存しない）。
    await page.evaluate(() => document.getElementById('btn-capture').click());

    // daemon 経路で res.imageUrl が来たら、パス非依存の取得先 URL を「画像URL」行として出す。
    await expect(
      page.locator('#messages').getByText('http://127.0.0.1:8765/shot/cap-test-slug.png')
    ).toBeVisible();
    // token は表示テキストに埋め込まない（取得時に付与する案内のみ）。
    await expect(page.locator('#messages').getByText('append ?token=')).toBeVisible();
  });

  test('side panel can delete one chat turn or all chat messages', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    await page.getByRole('textbox', { name: 'Instruction for AI' }).fill('First change');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#messages').getByText('Reply to: First change')).toBeVisible();

    await page.getByRole('textbox', { name: 'Instruction for AI' }).fill('Second change');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#messages').getByText('Reply to: Second change')).toBeVisible();

    await page.getByRole('button', { name: 'Delete this chat' }).first().click();
    await expect(page.locator('#messages').getByText('First change', { exact: true })).toHaveCount(0);
    await expect(page.locator('#messages').getByText('Reply to: First change')).toHaveCount(0);
    await expect(page.locator('#messages').getByText('Second change', { exact: true })).toBeVisible();
    await expect(page.locator('#messages').getByText('Reply to: Second change')).toBeVisible();

    await page.getByRole('button', { name: 'Delete all chat messages' }).click();
    await expect(page.getByRole('heading', { name: 'Start by typing an instruction' })).toBeVisible();
    await expect(page.locator('#messages').getByText('Second change', { exact: true })).toHaveCount(0);
    await expect(page.locator('#messages').getByText('Reply to: Second change')).toHaveCount(0);
  });

  test('options page passes axe on the default settings state', async ({ page }) => {
    await page.goto(pageUrl('options/options.html'));

    // 既定の言語はブラウザ UI 言語依存。テストを決定的にするため日本語へ切り替えて検証する。
    await page.locator('#ui-language').selectOption('ja');

    await expect(page.getByRole('heading', { name: 'Browser Agent Guide 設定' })).toBeVisible();
    await expect(page.getByLabel('プロバイダ')).toBeVisible();
    await expect(page.locator('.anthropic-field').first()).toBeHidden();
    await expect(page.getByRole('button', { name: '保存' }).first()).toBeVisible();

    await expectNoAxeViolations(page);
  });
});
