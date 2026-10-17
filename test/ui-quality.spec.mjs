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
          // content script の一覧はテストごとに seed の __mockAnnotations で差し替える。
          return { annotations: copy(store.__mockAnnotations) || [] };
        case 'SET_ANNOTATION_FOR_AI': {
          const hit = (store.__mockAnnotations || []).find((a) => a.id === message.id);
          if (hit) hit.forAI = message.on;
          return { id: message.id, forAI: message.on };
        }
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
          (window.__bagSentMessages ||= []).push(copy(message));
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

// 言語・自動保存・DL・全削除は ⋯ メニューに格納されている。
async function openMoreMenu(page) {
  const more = page.getByRole('button', { name: 'More actions' });
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
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
    await expect(page.getByRole('button', { name: 'Add note' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy for AI' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'List elements' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open prompt history' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete all chat messages' })).toBeHidden();
    await openMoreMenu(page);
    await expect(page.getByLabel('Language')).toBeVisible();
    await expect(page.getByLabel('Auto-save')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete all chat messages' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download chat history' })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#more-menu')).toBeHidden();
    await expect(page.getByRole('button', { name: 'More actions' })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Instruction for AI' })).toBeVisible();

    await page.getByRole('button', { name: 'Open prompt history' }).click();
    await expect(page.locator('#prompt-history-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open prompt history' })).toHaveAttribute('aria-expanded', 'true');

    await expectNoAxeViolations(page);
  });

  test('side panel keeps the header compact at side-panel width (redpen theme)', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await expect(page.getByLabel('Target tab')).toContainText('Example App');

    // 会話と送信トレイに高さを返す: ヘッダー(対象タブ+タブ切替+道具)は画面の3割以内。
    const header = await page.locator('.topbar').boundingBox();
    expect(header.height).toBeLessThanOrEqual(720 * 0.3);
    // 道具は1列に収まる(折り返しで縦に積まない)。
    const tops = await page.locator('#memo-workspace .quick-action').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath('sidepanel-redpen-360.png') });

    await page.getByRole('button', { name: 'More actions' }).click();
    await page.screenshot({ path: testInfo.outputPath('sidepanel-redpen-menu-360.png') });
    await expectNoAxeViolations(page);
  });

  test('side panel tray shows which memos already reached AI', async ({ page }, testInfo) => {
    const drawing = (id, note, sig) => ({ id, kind: 'drawing', note, intent: '', shapeText: '', step: 1, forAI: true, resolved: true, target: 'Total', sig, shapePreview: null });
    await installChromeMock(page, {
      __mockAnnotations: [
        drawing('d1', 'Right-align the total', 'text-sent'),
        drawing('d2', 'Make Confirm stand out', 'text-new'),
        { id: 'n1', kind: 'note', note: 'Address field is too narrow', intent: '', step: 1, resolved: true, target: 'Address', sig: 'text-edited' },
        // 送信対象外のメモは送られないので、状態チップも出さない。
        { id: 'n2', kind: 'note', note: 'Private reminder', intent: '', step: 1, resolved: true, target: 'Name', forAI: false, sig: 'text-private' },
      ],
      // 記録は署名(ページ+id+中身)がキー。d1 は同じ内容で届いた。n1 は届いた後に編集され、署名が変わったので未送信。
      aiAdvisorSentMemos: { 'text-sent': '2026-10-09T00:00:00Z', 'text-old': '2026-10-09T00:00:00Z' },
    });
    await page.setViewportSize({ width: 360, height: 720 });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    const tray = page.locator('#anno-panel');
    await expect(tray.locator('.anno-tray-item').nth(0).locator('.anno-sent')).toHaveText('Sent to AI');
    await expect(tray.locator('.anno-tray-item').nth(1).locator('.anno-sent')).toHaveText('Not sent');
    await expect(tray.locator('.anno-item .anno-sent')).toHaveText('Not sent');

    // SW が送信を記録すると、その場で送信済みに変わる。
    await page.evaluate(() =>
      chrome.storage.local.set({ aiAdvisorSentMemos: { 'text-sent': 'x', 'text-new': 'x', 'text-edited': 'x' } })
    );
    await expect(tray.locator('.anno-sent.pending')).toHaveCount(0);
    await expect(tray.locator('.anno-sent.sent')).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath('sidepanel-tray-sent-360.png') });
    await expectNoAxeViolations(page);
  });

  test('side panel lets the user check which memos go to AI', async ({ page }, testInfo) => {
    await installChromeMock(page, {
      __mockAnnotations: [
        { id: 'd1', kind: 'drawing', note: 'Right-align the total', intent: '', shapeText: '', step: 1, forAI: true, resolved: true, target: 'Total', sig: 's1', shapePreview: null },
        { id: 'n1', kind: 'note', note: 'Address field is too narrow', intent: '', step: 1, forAI: true, resolved: true, target: 'Address', sig: 's2' },
        { id: 'n2', kind: 'note', note: 'Private reminder', intent: '', step: 2, forAI: false, resolved: true, target: 'Name', sig: 's3' },
        // AI が対応済みにしたメモ(resolve_feedback)は「AIに渡す」が外れ、対応済みと示す。
        { id: 'n3', kind: 'note', note: 'Make Save red', intent: '', step: 3, forAI: false, doneAt: '2026-10-17T01:00:00Z', resolved: true, target: 'Save', sig: 's5' },
        { id: 'd2', kind: 'drawing', note: 'Bigger logo', intent: '', shapeText: '', step: 2, forAI: false, doneAt: '2026-10-17T01:00:00Z', resolved: true, target: 'Logo', sig: 's6', shapePreview: null },
        // 目印は送信対象ではないのでチェックを出さない。
        { id: 'm1', kind: 'marker', name: 'Hero', label: '', note: '', intent: 'hero banner', resolved: true, target: 'Hero', sig: 's4' },
      ],
    });
    await page.setViewportSize({ width: 360, height: 720 });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    const tray = page.locator('#anno-panel');
    const checks = tray.getByRole('checkbox', { name: 'Send to AI' });
    await expect(checks).toHaveCount(5);
    await expect(checks.nth(0)).toBeChecked();
    await expect(checks.nth(1)).not.toBeChecked();
    await expect(checks.nth(2)).toBeChecked();
    await expect(checks.nth(3)).not.toBeChecked();
    await expect(checks.nth(4)).not.toBeChecked();
    await expect(tray.locator('.anno-done')).toHaveCount(2);
    await expect(tray.locator('.anno-done').first()).toContainText('Fixed by AI');
    await tray.locator('.anno-done').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('sidepanel-memo-done-360.png') });
    await expect(page.locator('#capture-count')).toHaveText('2');

    await checks.nth(2).uncheck();
    await expect.poll(() => page.evaluate(() => window.__bagSentMessages.filter((m) => m.type === 'SET_ANNOTATION_FOR_AI'))).toEqual([
      { type: 'SET_ANNOTATION_FOR_AI', tabId: 1, id: 'n1', on: false },
    ]);
    await expect(page.locator('#capture-count')).toHaveText('1');
    await expect(tray.getByRole('checkbox', { name: 'Send to AI' }).nth(2)).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('sidepanel-memo-checks-360.png') });
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

  test('switching saved workflows asks before discarding unsaved steps', async ({ page }) => {
    const step = (id, target) => ({
      kind: 'action', id, url: 'https://example.com/app', matchType: 'page', pattern: 'https://example.com/app', text: '',
      target, action: { verb: 'click', value: '' }, locator: { kind: 'fixed', anchor: { selector: `#${id}`, tag: 'button', role: 'button', text: target } },
    });
    await installChromeMock(page, {
      aiAdvisorWorkflow: { recording: false, steps: [step('u1', 'Unsaved')], saved: [{ id: 'wf-a', name: 'Flow A', createdAt: '', steps: [step('a1', 'Saved A')] }] },
    });
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await page.locator('#btn-workspace-workflow').click();
    const stored = () => page.evaluate(async () => (await chrome.storage.local.get('aiAdvisorWorkflow')).aiAdvisorWorkflow);
    const select = page.locator('#workflow-select');

    // 保存先の無い手順は、確認で断れば残る。
    page.once('dialog', (d) => d.dismiss());
    await select.selectOption('wf-a');
    await expect(select).toHaveValue('');
    expect((await stored()).steps.map((s) => s.id)).toEqual(['u1']);

    page.once('dialog', (d) => d.accept());
    await select.selectOption('wf-a');
    await expect.poll(async () => (await stored()).steps.map((s) => s.id)).toEqual(['a1']);

    // content script が作業中の手順だけに足した手順(メモ等)は未保存の変更。切り替えるなら確かめ、断れば残る。
    await page.evaluate(async (s) => {
      const { aiAdvisorWorkflow: wf } = await chrome.storage.local.get('aiAdvisorWorkflow');
      await chrome.storage.local.set({ aiAdvisorWorkflow: { ...wf, steps: [...wf.steps, s] } });
    }, step('m1', 'Memo'));
    page.once('dialog', (d) => d.dismiss());
    await select.selectOption('');
    await expect(select).toHaveValue('wf-a');
    expect((await stored()).steps.map((s) => s.id)).toEqual(['a1', 'm1']);
    // 保存済みの A は「更新」を押すまで変わらない。
    expect((await stored()).saved.find((w) => w.id === 'wf-a').steps.map((s) => s.id)).toEqual(['a1']);
    await page.locator('#btn-workflow-save').click();
    await expect.poll(async () => (await stored()).saved.find((w) => w.id === 'wf-a').steps.map((s) => s.id)).toEqual(['a1', 'm1']);
    // 保存後は未保存の変更が無いので、確認なしで切り替わる。
    await select.selectOption('');
    await expect.poll(async () => (await stored()).steps.length).toBe(0);
  });

  test('workflow switch controls are disabled during auto-run, and saving past the limit says why', async ({ page }) => {
    const step = (id) => ({ kind: 'action', id, url: 'https://example.com/app', matchType: 'page', pattern: 'https://example.com/app', text: '', target: id, action: { verb: 'click', value: '' } });
    const saved = Array.from({ length: 50 }, (_, i) => ({ id: `wf-${i}`, name: `Flow ${i}`, createdAt: '', steps: [step(`s${i}`)] }));
    await installChromeMock(page, {
      aiAdvisorWorkflow: { recording: false, activeId: 'wf-0', name: 'Flow 0', steps: [step('s0')], saved },
      aiAdvisorWorkflowRun: { active: true, doneStepIds: [], heldStepId: '' },
    });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await page.locator('#btn-workspace-workflow').click();
    const del = page.locator('.wf-saved-del').first();
    await expect(page.locator('#workflow-select')).toBeDisabled();
    await expect(page.locator('#btn-workflow-new')).toBeDisabled();
    await expect(del).toBeDisabled();
    await expect(page.locator('.wf-saved-load').nth(1)).toBeDisabled();

    // 停止すると戻る(選択中の行の「読み込み」だけは押せないまま)。
    await page.evaluate(() => chrome.storage.local.set({ aiAdvisorWorkflowRun: { active: false, doneStepIds: [], heldStepId: '' } }));
    await expect(page.locator('#workflow-select')).toBeEnabled();
    await expect(page.locator('#btn-workflow-new')).toBeEnabled();
    await expect(del).toBeEnabled();
    await expect(page.locator('.wf-saved-load').first()).toBeDisabled();
    await expect(page.locator('.wf-saved-load').nth(1)).toBeEnabled();

    // 上限(50件)では別名保存を断って理由を出し、どれも消さない。
    await page.locator('#btn-workflow-save-copy').click();
    await expect(page.locator('.msg.error').last()).toContainText('50');
    const stored = await page.evaluate(async () => (await chrome.storage.local.get('aiAdvisorWorkflow')).aiAdvisorWorkflow);
    expect(stored.saved.map((w) => w.id)).toEqual(saved.map((w) => w.id));
  });

  test('switching workflows while a run waits for approval abandons that run', async ({ page }) => {
    const step = { kind: 'action', id: 's1', url: 'https://example.com/app', matchType: 'page', pattern: 'https://example.com/app', text: '', target: 'Place order', action: { verb: 'click', value: '' } };
    // コピーは手順 id を共有するので、切り替え後も保留中の手順が見つかってしまう組み合わせ。
    const saved = [
      { id: 'wf-a', name: 'Flow A', createdAt: '', steps: [step] },
      { id: 'wf-b', name: 'Flow B', createdAt: '', steps: [step] },
    ];
    await installChromeMock(page, {
      aiAdvisorWorkflow: { recording: false, activeId: 'wf-a', name: 'Flow A', steps: [step], saved },
      aiAdvisorWorkflowRun: { active: false, doneStepIds: [], heldStepId: 's1', heldKind: 'gate', heldLabel: 'Place order' },
    });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await page.evaluate(() => {
      window.__sentTypes = [];
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (message, callback) => {
        window.__sentTypes.push(message?.type);
        return original(message, callback);
      };
    });
    await page.locator('#btn-workspace-workflow').click();
    await expect(page.locator('#workflow-held')).toBeVisible();

    await page.locator('#workflow-saved .workflow-saved-item').filter({ hasText: 'Flow B' }).locator('.wf-saved-load').click();
    await expect.poll(() => page.evaluate(() => window.__sentTypes)).toContain('STOP_WORKFLOW_AUTORUN');
  });

  test('side panel shows structured workflow steps at side-panel width and passes axe', async ({ page }, testInfo) => {
    const anchor = (selector, text) => ({ selector, tag: 'button', role: 'button', text });
    const base = { kind: 'action', url: 'https://example.com/app', matchType: 'page', pattern: 'https://example.com/app', text: '' };
    await installChromeMock(page, {
      aiAdvisorWorkflow: {
        recording: false,
        saved: [],
        steps: [
          {
            ...base,
            id: 's1',
            target: 'Shipping method',
            action: { verb: 'click', value: '' },
            locator: { kind: 'pick', anchor: anchor('#ship li:nth-child(3) button', 'Choose'), scope: { selector: '#ship', tag: 'ul' }, item: { tag: 'li', classes: ['opt'], role: '' }, inner: ':scope > button' },
            choice: { by: 'text', value: 'Charter ¥6,800' },
            needsReview: true,
          },
          {
            ...base,
            id: 's2',
            target: 'Quantity',
            action: { verb: 'fill', value: '{qty}' },
            locator: { kind: 'fixed', anchor: { selector: '#qty', tag: 'input' } },
            suggestion: { kind: 'anchor', anchor: { selector: '#amount', tag: 'input' }, label: 'Amount', reason: 'same field, renamed', at: '2026-10-08T00:00:00Z' },
          },
          {
            ...base,
            id: 's3',
            target: 'Place order',
            action: { verb: 'click', value: '' },
            locator: { kind: 'fixed', anchor: anchor('#confirm', 'Place order') },
            check: { type: 'url', value: 'https://example.com/orders/:id' },
            gate: true,
          },
        ],
      },
      aiAdvisorWorkflowRun: { active: false, tabId: 1, doneStepIds: ['s1', 's2'], heldStepId: 's3', vars: { qty: '5' } },
    });
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await page.locator('#btn-workspace-workflow').click();

    const panel = page.locator('#workflow-panel');
    await expect(panel).toContainText('In “Shipping method”, click the item “Charter ¥6,800”');
    await expect(panel).toContainText('Type “{qty}” into “Quantity”');
    await expect(panel).toContainText('You picked from a list. How should it be chosen next time?');
    await expect(panel).toContainText('so AI used “Amount”');
    await expect(panel).toContainText('Needs approval');
    await expect(page.locator('#workflow-vars')).toBeVisible();
    await expect(page.locator('#workflow-vars-fields input')).toHaveCount(1);
    await expect(page.locator('#workflow-held')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve and continue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dry run this page' })).toBeVisible();

    // 手順設定を開くと、選び方(閉じた選択肢)と確認・承認ゲートを編集できる。
    // 完了済みは ✓、確認待ち(リスト選択)の手順は設定が最初から開いている。
    await expect(page.locator('#workflow-steps .wf-num')).toHaveText(['✓', '✓', '3']);
    const editors = page.locator('#workflow-steps .wf-edit');
    await expect(editors.nth(0)).toHaveAttribute('open', '');
    await expect(editors.nth(0).locator('select').first()).toHaveValue('text');
    await editors.nth(2).locator('.wf-edit-summary').click();
    await expect(editors.nth(2).getByRole('checkbox', { name: 'Stop and ask me before clicking' })).toBeChecked();
    // 手順一覧をスクロールしても「承認して続行」はパネル上端に残る。
    await expect(page.getByRole('button', { name: 'Approve and continue' })).toBeInViewport();

    // サイドパネル幅で横スクロールが出ないこと。
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath('sidepanel-workflow-360.png') });
    await expectNoAxeViolations(page);
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

    await openMoreMenu(page);
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

    await openMoreMenu(page);
    await page.getByRole('button', { name: 'Delete all chat messages' }).click();
    await expect(page.getByRole('heading', { name: 'Start by typing an instruction' })).toBeVisible();
    await expect(page.locator('#messages').getByText('Second change', { exact: true })).toHaveCount(0);
    await expect(page.locator('#messages').getByText('Reply to: Second change')).toHaveCount(0);
  });

  test('side panel can copy chat messages and trigger download', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    await page.getByRole('textbox', { name: 'Instruction for AI' }).fill('First change');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#messages').getByText('Reply to: First change')).toBeVisible();

    // Check that copy message buttons exist
    await expect(page.getByRole('button', { name: 'Copy message' }).first()).toBeVisible();

    // Set up download listener
    const downloadPromise = page.waitForEvent('download');
    await openMoreMenu(page);
    await page.getByRole('button', { name: 'Download chat history' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('.md');
  });

  test('side panel disables chat download until there is history', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    await openMoreMenu(page);
    // Empty history: the download control is disabled (no modal alert path is reachable).
    const download = page.getByRole('button', { name: 'Download chat history' });
    await expect(download).toBeDisabled();

    await page.getByRole('textbox', { name: 'Instruction for AI' }).fill('First change');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#messages').getByText('Reply to: First change')).toBeVisible();

    await openMoreMenu(page);
    await expect(download).toBeEnabled();
  });

  test('side panel delegates chat download to the service worker in the extension', async ({ page }) => {
    await page.goto(pageUrl('sidepanel/sidepanel.html'));

    await page.getByRole('textbox', { name: 'Instruction for AI' }).fill('First change');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#messages').getByText('Reply to: First change')).toBeVisible();

    // Emulate a real extension page: chrome.runtime.id present → the privileged
    // chrome.downloads call is delegated to the service worker via DOWNLOAD_CHAT.
    await page.evaluate(() => {
      window.__downloadMessages = [];
      window.chrome.runtime.id = 'test-extension-id';
      const orig = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === 'DOWNLOAD_CHAT') {
          window.__downloadMessages.push(message);
          callback?.({ ok: true, result: { downloadId: 1 } });
          return;
        }
        return orig(message, callback);
      };
    });

    await openMoreMenu(page);
    await page.getByRole('button', { name: 'Download chat history' }).click();
    await page.waitForFunction(() => (window.__downloadMessages?.length || 0) > 0);
    const msg = await page.evaluate(() => window.__downloadMessages[0]);
    expect(msg.filename).toContain('.md');
    expect(msg.markdown).toContain('Reply to: First change');
  });

  test('side panel theme follows the OS until the setting pins it, and hover stays visible in dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(pageUrl('sidepanel/sidepanel.html'));
    await expect(page.getByLabel('Target tab')).toContainText('Example App');
    const body = page.locator('body');
    await expect(body).toHaveCSS('background-color', 'rgb(24, 23, 21)');

    await openMoreMenu(page);
    await page.locator('#theme-select').selectOption('light');
    await expect(body).toHaveCSS('background-color', 'rgb(245, 242, 236)');

    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('#theme-select').selectOption('dark');
    await expect(body).toHaveCSS('background-color', 'rgb(24, 23, 21)');

    // 選択していないタブの hover 地は文字色(ダークでは明るい色)から作る。墨色の固定値だと暗い地に消える。
    await page.keyboard.press('Escape');
    const tab = page.locator('.workspace-tab:not([aria-selected="true"])').first();
    await tab.hover();
    // 地は transition で変わるので落ち着くまで待つ。値は rgb()/oklab()/color(srgb) のどれでも先頭が明度に相当する。
    await expect
      .poll(async () => {
        const [first] = (await tab.evaluate((el) => getComputedStyle(el).backgroundColor)).match(/[\d.]+/g).map(Number);
        return first > 1 ? first / 255 : first;
      })
      .toBeGreaterThan(0.5);
  });

  test('options page passes axe on the default settings state', async ({ page }, testInfo) => {
    await page.goto(pageUrl('options/options.html'));

    // 既定の言語・テーマはブラウザ UI 環境依存。テストを決定的にするため日本語・ライトへ切り替えて検証する。
    await page.locator('#ui-language').selectOption('ja');
    await page.locator('#theme-select').selectOption('light');

    await expect(page.getByRole('heading', { name: 'Browser Agent Guide 設定' })).toBeVisible();
    await expect(page.getByLabel('プロバイダ')).toBeVisible();
    await expect(page.locator('.anthropic-field').first()).toBeHidden();
    await expect(page.getByRole('button', { name: '保存' }).first()).toBeVisible();
    // サイドパネルと同じ紙の地色(light)で描かれる。
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 242, 236)');
    await page.screenshot({ path: testInfo.outputPath('options-paper.png'), fullPage: true });

    await expectNoAxeViolations(page);

    // ダークテーマへの切替と axe 適合も検証する。
    await page.locator('#theme-select').selectOption('dark');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(24, 23, 21)');
    await expect(page.locator('#save-daemon')).toHaveCSS('background-color', 'rgb(240, 237, 230)');
    await expectNoAxeViolations(page);
  });

  test('options judge section shows only the chosen provider fields', async ({ page }, testInfo) => {
    await page.goto(pageUrl('options/options.html'));
    await page.locator('#ui-language').selectOption('ja');
    await page.locator('#theme-select').selectOption('light');

    // 既定(LLM)は追加の欄なし。
    await expect(page.locator('#judge-apiKey')).toBeHidden();
    await expect(page.locator('#judge-clefAccountId')).toBeHidden();

    await page.locator('#judge-provider').selectOption('jev');
    await expect(page.getByLabel('Jev APIキー')).toBeVisible();
    await expect(page.locator('#judge-clefAccountId')).toBeHidden();

    await page.locator('#judge-provider').selectOption('clef');
    await expect(page.locator('#judge-apiKey')).toBeHidden();
    await expect(page.getByLabel('Cloudflare アカウントID')).toBeVisible();
    await expect(page.getByLabel('Workers AI トークン / プロキシキー')).toBeVisible();
    await expect(page.getByLabel('Worker プロキシ URL (任意)')).toBeVisible();
    await expect(page.locator('#judge-clefModel')).toBeVisible();

    // 宛先が無いまま接続テストしても外へは送らず、入力を促す。
    await page.locator('#test-judge').click();
    await expect(page.locator('#judge-status')).toContainText('Cloudflare アカウントID');

    await page.locator('.card', { has: page.locator('#judge-provider') }).screenshot({ path: testInfo.outputPath('options-judge-clef.png') });
    await expectNoAxeViolations(page);
  });
});
