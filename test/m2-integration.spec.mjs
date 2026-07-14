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
    daemonServer = createHttpServer({ inboxDir: daemonInboxDir, entryStore, token: TOKEN });
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

  test('c. Permanent Clipboard Hook intercepts page clipboard-write and records to signalLog', async () => {
    const page = await context.newPage();
    await page.goto(pageUrl);

    // Evaluate copy action in the page context (MAIN world) to trigger clipboard hook
    await page.evaluate(async () => {
      // Navigator clipboard writeText in the MAIN world context
      await navigator.clipboard.writeText('copied-by-hook-test-content');
    });

    // Send a message from Playwright to content script of active tab to retrieve signals (signalLog)
    const sw = await getServiceWorker(context);
    const tabState = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true });
      return chrome.tabs.sendMessage(tab.id, { type: 'COLLECT_CONTEXT' });
    });

    const clipboardSignal = tabState.signals.find(s => s.aiId === 'clipboard');
    expect(clipboardSignal).toBeDefined();
    expect(clipboardSignal.text).toBe('copied-by-hook-test-content');
    expect(clipboardSignal.intent).toBe('clipboard-write: copied-by-hook-test-content');

    await page.close();
  });
});
