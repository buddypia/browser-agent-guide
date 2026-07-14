import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import pkg from '../daemon/node_modules/ws/index.js';
const { WebSocket, WebSocketServer } = pkg;
import { createHttpServer } from '../daemon/src/http.js';
import { attachWebSocketServer } from '../daemon/src/ws.js';
import { createPageFeedbackStore } from '../daemon/src/store.js';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = 'test/fixtures/playground.html';
const TOKEN = 'stress-secret-token';
const DEBUGGER_PORT = 9899; // Using a unique port to avoid collisions

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
  const sws = context.serviceWorkers();
  if (sws.length > 0) return sws[0];
  
  // If empty, try to trigger a wake-up by creating a new page or navigating
  const page = await context.newPage();
  await page.goto('chrome://extensions/');
  await page.close();
  
  const sws2 = context.serviceWorkers();
  if (sws2.length > 0) return sws2[0];
  
  return await context.waitForEvent('serviceworker', { timeout: 10000 });
}

test.describe('Milestone 2 Stress and Boundary Verification', () => {
  let staticServer;
  let staticOrigin;
  let pageUrl;
  let userDataDir;
  let browserContext;
  let daemonServer;
  let daemonPort;
  let daemonWss;
  let daemonInboxDir;
  let entryStore;

  before(async () => {
    // 1) Start HTTP Static Server for fixture
    staticServer = await startStaticServer();
    staticOrigin = `http://127.0.0.1:${staticServer.address().port}`;
    pageUrl = `${staticOrigin}/${FIXTURE}`;

    // 2) Start test daemon server
    daemonInboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-stress-inbox-'));
    entryStore = createPageFeedbackStore({ inboxDir: daemonInboxDir, storageMode: 'memory' });
    daemonServer = createHttpServer({ inboxDir: daemonInboxDir, entryStore, token: TOKEN });
    daemonWss = attachWebSocketServer(daemonServer, { inboxDir: daemonInboxDir, entryStore, token: TOKEN });
    await new Promise((r) => daemonServer.listen(0, '127.0.0.1', r));
    daemonPort = daemonServer.address().port;

    // 3) Launch persistent Chrome context with remote debugging port DEBUGGER_PORT
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-m2-stress-'));
    browserContext = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        '--headless=new',
        `--disable-extensions-except=${projectRoot}`,
        `--load-extension=${projectRoot}`,
        `--remote-debugging-port=${DEBUGGER_PORT}`,
      ],
    });
  });

  after(async () => {
    // Cleanup Chrome
    await browserContext?.close().catch(() => {});
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

  test('1. WebSocket Relay connection, automatic reconnects, and command broadcasting', async () => {
    // Navigate first to make sure service worker has been activated
    const page = await browserContext.newPage();
    await page.goto(pageUrl);

    const sw = await getServiceWorker(browserContext);

    // Initial connection to our daemonPort
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
          },
        });
      },
      { wsUrl, token: TOKEN }
    );

    // Wait for extension connection to daemon WebSocket
    let isConnected = false;
    for (let i = 0; i < 50; i++) {
      if (daemonWss.getBridgeStatus().connected) {
        isConnected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(isConnected, 'Extension should connect to WebSocket daemon');

    // --- RECONNECT TEST ---
    console.log('Testing WebSocket Reconnection...');
    
    // Close the daemon server and terminate active WebSocket connections
    if (daemonWss) {
      for (const client of daemonWss.clients || []) {
        client.terminate();
      }
      await new Promise((r) => daemonWss.close(r));
    }
    const closedPromise = new Promise((r) => daemonServer.close(r));
    daemonServer.closeAllConnections?.();
    await closedPromise;
    
    // Check that it gets disconnected
    let isDisconnected = false;
    for (let i = 0; i < 50; i++) {
      if (!daemonWss.getBridgeStatus().connected) {
        isDisconnected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(isDisconnected, 'Extension should detect server closed and disconnect');

    // Re-create the daemon server on the same port
    console.log(`Re-spawning daemon server on port ${daemonPort}...`);
    daemonServer = createHttpServer({ inboxDir: daemonInboxDir, entryStore, token: TOKEN });
    daemonWss = attachWebSocketServer(daemonServer, { inboxDir: daemonInboxDir, entryStore, token: TOKEN });
    await new Promise((r) => daemonServer.listen(daemonPort, '127.0.0.1', r));

    // Wait for extension to automatically reconnect, keeping service worker alive
    console.log('Waiting for extension to automatically reconnect (should take ~5s)...');
    let isReconnected = false;
    for (let i = 0; i < 60; i++) {
      if (daemonWss.getBridgeStatus().connected) {
        isReconnected = true;
        break;
      }
      try {
        // Ping to wake up service worker
        await sw.evaluate(() => typeof chrome !== "undefined");
      } catch (e) {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(isReconnected, 'Extension should automatically reconnect to the re-spawned daemon');
    console.log('Reconnection successful.');

    // --- COMMAND BROADCASTING AND TIMEOUT TEST ---
    try {
      await daemonWss.executeActions({
        actions: [{ verb: 'clickElement', args: { selector: 'button' } }],
        tabId: 999999 // nonexistent
      });
      assert.fail('Should have failed because tabId 999999 does not exist');
    } catch (e) {
      assert.match(e.message, /No matching tab found/);
    }

    await page.close();
  });

  test('2. Fallback CDP Bridge CLI boundaries and corner cases', async () => {
    const cdpBridgePath = path.join(projectRoot, 'scripts/cdp-bridge.mjs');

    // Case 2a: Missing or invalid port
    console.log('Testing CDP Bridge CLI with invalid port...');
    let stdout;
    let errOccurred = false;
    try {
      stdout = execFileSync('node', [
        cdpBridgePath,
        '--port', '9999', // Port with no debugger
        '--json',
        '[]'
      ], { encoding: 'utf8' });
    } catch (err) {
      errOccurred = true;
      const response = JSON.parse(err.stdout);
      assert.equal(response.ok, false);
      assert.match(response.error, /Could not connect to Chrome debugger/);
    }
    assert.ok(errOccurred, 'CDP Bridge CLI should fail on invalid port');

    // Ensure page exists for the next tests
    const page = await browserContext.newPage();
    await page.goto(pageUrl);

    // Case 2b: Unmatched URL/title
    console.log('Testing CDP Bridge CLI with unmatched filters...');
    errOccurred = false;
    try {
      stdout = execFileSync('node', [
        cdpBridgePath,
        '--port', String(DEBUGGER_PORT),
        '--urlContains', 'nonexistent-xyz-page.html',
        '--json',
        '[]'
      ], { encoding: 'utf8' });
    } catch (err) {
      errOccurred = true;
      const response = JSON.parse(err.stdout);
      assert.equal(response.ok, false);
      assert.match(response.error, /No matching tab found/);
    }
    assert.ok(errOccurred, 'CDP Bridge CLI should fail when no tab matches filters');

    // Case 2c: Malformed actions JSON
    console.log('Testing CDP Bridge CLI with malformed actions JSON...');
    errOccurred = false;
    try {
      stdout = execFileSync('node', [
        cdpBridgePath,
        '--port', String(DEBUGGER_PORT),
        '--json',
        '{"malformed": ' // invalid json
      ], { encoding: 'utf8' });
    } catch (err) {
      errOccurred = true;
      const response = JSON.parse(err.stdout);
      assert.equal(response.ok, false);
      assert.match(response.error, /Failed to parse actions JSON/);
    }
    assert.ok(errOccurred, 'CDP Bridge CLI should fail on malformed JSON');

    await page.close();
  });

  test('3. Clipboard hook with empty values, large payload, and special characters', async () => {
    const page = await browserContext.newPage();
    await page.goto(pageUrl);

    // Get service worker after page is navigated (waking it up)
    const sw = await getServiceWorker(browserContext);

    // Helper to get clipboard signals
    const getClipboardSignals = async () => {
      const tabState = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true });
        return chrome.tabs.sendMessage(tab.id, { type: 'COLLECT_CONTEXT' });
      });
      return tabState.signals.filter((s) => s.aiId === 'clipboard');
    };

    // Case 3a: Empty value
    console.log('Testing Clipboard Hook with empty value...');
    await page.evaluate(async () => {
      await navigator.clipboard.writeText('');
    });
    let signals = await getClipboardSignals();
    let emptySignal = signals.find((s) => s.text === '');
    assert.ok(emptySignal, 'Should capture empty clipboard write');
    assert.equal(emptySignal.intent, 'clipboard-write: ');

    // Case 3b: Special characters
    console.log('Testing Clipboard Hook with special characters...');
    const specialStr = 'Hello \n World! \t "quotes" & <script>alert(1)</script> 🌟 🚀\0null\\backslashes';
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, specialStr);
    signals = await getClipboardSignals();
    let specialSignal = signals.find((s) => s.text === specialStr);
    assert.ok(specialSignal, 'Should capture special characters successfully');
    assert.equal(specialSignal.intent, 'clipboard-write: ' + specialStr);

    // Case 3c: Large payload (stress test)
    console.log('Testing Clipboard Hook with large payload...');
    const largeStr = 'A'.repeat(50000); // 50KB string
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, largeStr);
    signals = await getClipboardSignals();
    let largeSignal = signals.find((s) => s.text === largeStr);
    assert.ok(largeSignal, 'Should capture large text without issues');
    assert.equal(largeSignal.text.length, 50000);

    await page.close();
  });

  test('4. Clipboard hook spoofing protection', async () => {
    const page = await browserContext.newPage();
    await page.goto(pageUrl);

    const sw = await getServiceWorker(browserContext);

    const getClipboardSignals = async () => {
      const tabState = await sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true });
        return chrome.tabs.sendMessage(tab.id, { type: 'COLLECT_CONTEXT' });
      });
      return tabState.signals.filter((s) => s.aiId === 'clipboard');
    };

    console.log('Dispatching CustomEvents with missing/wrong nonces...');
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('BAG_CLIPBOARD_WRITE', {
        detail: { text: 'spoofed-wrong-nonce', nonce: 'fake-nonce-uuid-1234' }
      }));
      window.dispatchEvent(new CustomEvent('BAG_CLIPBOARD_WRITE', {
        detail: { text: 'spoofed-missing-nonce' }
      }));
    });

    const signals = await getClipboardSignals();
    const spoofedSignal = signals.find((s) => s.text.includes('spoofed'));
    assert.ok(!spoofedSignal, 'Spoofed clipboard writes must be successfully ignored');

    await page.close();
  });

  test('5. Multi-client connectivity and broadcast aggregation', async () => {
    const mockClient1 = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      mockClient1.once('open', resolve);
      mockClient1.once('error', reject);
    });

    const mockClient2 = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      mockClient2.once('open', resolve);
      mockClient2.once('error', reject);
    });

    const mock1MsgPromise = new Promise((r) => mockClient1.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'run_actions') r(m);
    }));
    const mock2MsgPromise = new Promise((r) => mockClient2.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'run_actions') r(m);
    }));

    const executePromise = daemonWss.executeActions({
      actions: [{ verb: 'clickElement', args: { selector: 'button' } }],
      urlContains: 'nonexistent-mock-filter-page'
    });

    const mock1Msg = await mock1MsgPromise;
    const mock2Msg = await mock2MsgPromise;
    assert.equal(mock1Msg.requestId, mock2Msg.requestId);

    mockClient1.send(JSON.stringify({
      type: 'run_actions_result',
      requestId: mock1Msg.requestId,
      ok: false,
      error: 'Mock client 1 failure'
    }));

    let isPromiseSettled = false;
    executePromise.then(
      () => { isPromiseSettled = true; },
      () => { isPromiseSettled = true; }
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(isPromiseSettled, false, 'Promise should not settle until all clients respond or one succeeds');

    mockClient2.send(JSON.stringify({
      type: 'run_actions_result',
      requestId: mock2Msg.requestId,
      ok: true,
      results: [{ ok: true, mock: true }]
    }));

    const res = await executePromise;
    assert.equal(res.ok, true, 'Overall result should be ok: true because mockClient2 succeeded');
    assert.deepEqual(res.results, [{ ok: true, mock: true }]);

    mockClient1.close();
    mockClient2.close();
  });
});
