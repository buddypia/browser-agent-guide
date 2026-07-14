import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws.js';
import { createPageFeedbackStore } from '../src/store.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'stress-secret-token';

let httpServer;
let inboxDir;
let wsUrl;
let wss;
let store;

before(async () => {
  inboxDir = mkdtempSync(join(tmpdir(), 'bag-ws-stress-'));
  // Set up store in memory mode for default checks
  store = createPageFeedbackStore({ inboxDir, storageMode: 'memory', memoryLimit: 100 });
  httpServer = createHttpServer({ inboxDir, entryStore: store });
  wss = attachWebSocketServer(httpServer, { inboxDir, entryStore: store, token: TOKEN });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  await new Promise((r) => httpServer.close(r));
  try {
    store.cleanup?.();
  } catch {}
  rmSync(inboxDir, { recursive: true, force: true });
});

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function closeClients(clients) {
  await Promise.all(clients.map(ws => {
    return new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
      } else {
        ws.on('close', resolve);
        ws.close();
      }
    });
  }));
  // Wait for server-side socket event handlers to run
  await delay(100);
}

test('Multi-client load - Memory Store: 30 parallel connections pushing 5 payloads each', async () => {
  const numClients = 30;
  const pushesPerClient = 5;
  const clients = [];
  const promises = [];

  for (let i = 0; i < numClients; i++) {
    const ws = new WebSocket(`${wsUrl}?token=${TOKEN}`);
    clients.push(ws);

    const readyPromise = new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    promises.push(readyPromise);
  }

  // Wait for all clients to connect
  await Promise.all(promises);

  const pushPromises = [];
  for (let i = 0; i < numClients; i++) {
    const ws = clients[i];
    for (let j = 0; j < pushesPerClient; j++) {
      const payload = {
        type: 'page_feedback',
        capturedAt: new Date().toISOString(),
        url: `https://example.com/client-${i}/page-${j}`,
        title: `Client ${i} Page ${j}`,
        image: { shot: PNG_B64 },
        annotation: { url: `https://example.com/client-${i}/page-${j}`, items: [] },
      };
      
      const push = new Promise((resolve, reject) => {
        const handler = (data) => {
          try {
            const resp = JSON.parse(data.toString());
            if (resp.type === 'ack') {
              ws.off('message', handler);
              resolve(resp);
            } else if (resp.type === 'error') {
              ws.off('message', handler);
              reject(new Error(resp.error));
            }
          } catch (e) {
            ws.off('message', handler);
            reject(e);
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify(payload));
      });
      pushPromises.push(push);
    }
  }

  const results = await Promise.all(pushPromises);
  assert.equal(results.length, numClients * pushesPerClient);
  for (const ack of results) {
    assert.equal(ack.type, 'ack');
    assert.equal(ack.storage, 'memory');
    assert.equal(ack.materialized, false);
  }

  // Check bridge status
  const status = wss.getBridgeStatus();
  assert.equal(status.connected, true);
  assert.equal(status.everConnected, true);

  // Close all clients
  await closeClients(clients);

  const statusAfterClose = wss.getBridgeStatus();
  assert.equal(statusAfterClose.connected, false);
});

test('Multi-client load - Disk Store: 10 parallel connections pushing 5 payloads each', async () => {
  const diskDir = mkdtempSync(join(tmpdir(), 'bag-ws-stress-disk-'));
  const diskStore = createPageFeedbackStore({ inboxDir: diskDir, storageMode: 'disk' });
  const diskHttpServer = createHttpServer({ inboxDir: diskDir, entryStore: diskStore });
  const diskWss = attachWebSocketServer(diskHttpServer, { inboxDir: diskDir, entryStore: diskStore, token: TOKEN });
  await new Promise((r) => diskHttpServer.listen(0, '127.0.0.1', r));
  const { port } = diskHttpServer.address();
  const diskWsUrl = `ws://127.0.0.1:${port}/ws`;

  try {
    const numClients = 10;
    const pushesPerClient = 5;
    const clients = [];
    const connectPromises = [];

    for (let i = 0; i < numClients; i++) {
      const ws = new WebSocket(`${diskWsUrl}?token=${TOKEN}`);
      clients.push(ws);
      connectPromises.push(new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      }));
    }

    await Promise.all(connectPromises);

    const pushPromises = [];
    for (let i = 0; i < numClients; i++) {
      const ws = clients[i];
      for (let j = 0; j < pushesPerClient; j++) {
        const payload = {
          type: 'page_feedback',
          capturedAt: new Date().toISOString(),
          url: `https://example.com/disk-client-${i}/page-${j}`,
          title: `Disk Client ${i} Page ${j}`,
          image: { shot: PNG_B64 },
          annotation: { url: `https://example.com/disk-client-${i}/page-${j}`, items: [] },
        };
        
        pushPromises.push(new Promise((resolve, reject) => {
          const handler = (data) => {
            try {
              const resp = JSON.parse(data.toString());
              if (resp.type === 'ack') {
                ws.off('message', handler);
                resolve(resp);
              } else if (resp.type === 'error') {
                ws.off('message', handler);
                reject(new Error(resp.error));
              }
            } catch (e) {
              ws.off('message', handler);
              reject(e);
            }
          };
          ws.on('message', handler);
          ws.send(JSON.stringify(payload));
        }));
      }
    }

    const results = await Promise.all(pushPromises);
    assert.equal(results.length, numClients * pushesPerClient);
    for (const ack of results) {
      assert.equal(ack.type, 'ack');
      assert.equal(ack.storage, 'disk');
      assert.equal(ack.materialized, true);
    }

    await Promise.all(clients.map(ws => {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) resolve();
        else {
          ws.on('close', resolve);
          ws.close();
        }
      });
    }));
    await delay(100);
  } finally {
    await new Promise((r) => diskHttpServer.close(r));
    rmSync(diskDir, { recursive: true, force: true });
  }
});

test('Connection cycling: 100 sequential connects, disconnects, and pushes', async () => {
  const numCycles = 100;
  for (let i = 0; i < numCycles; i++) {
    const ws = new WebSocket(`${wsUrl}?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const payload = {
      type: 'page_feedback',
      capturedAt: new Date().toISOString(),
      url: `https://example.com/cycle-${i}`,
      title: `Cycle ${i}`,
      image: { shot: PNG_B64 },
      annotation: { url: `https://example.com/cycle-${i}`, items: [] },
    };

    const ack = await new Promise((resolve, reject) => {
      ws.on('message', (data) => {
        try {
          const resp = JSON.parse(data.toString());
          if (resp.type === 'ack') resolve(resp);
          else reject(new Error(resp.error));
        } catch (e) {
          reject(e);
        }
      });
      ws.send(JSON.stringify(payload));
    });

    assert.equal(ack.type, 'ack');

    await new Promise((resolve) => {
      ws.on('close', resolve);
      ws.close();
    });
  }

  await delay(150); // wait for final close handling on server side
  const finalStatus = wss.getBridgeStatus();
  assert.equal(finalStatus.connected, false);
});

test('Action execution - Broadcast, multi-client, first success resolves', async () => {
  const clients = [];
  const connectPromises = [];
  const numClients = 5;

  for (let i = 0; i < numClients; i++) {
    const ws = new WebSocket(`${wsUrl}?token=${TOKEN}`);
    clients.push(ws);
    connectPromises.push(new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    }));
  }

  await Promise.all(connectPromises);

  // Set up listeners on the clients for run_actions
  const clientActionsReceived = [];
  for (let i = 0; i < numClients; i++) {
    const ws = clients[i];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'run_actions') {
        clientActionsReceived.push({ index: i, msg });
        if (i === 2) {
          ws.send(JSON.stringify({
            type: 'run_actions_result',
            requestId: msg.requestId,
            ok: true,
            results: [{ ok: true }]
          }));
        } else if (i < 2) {
          ws.send(JSON.stringify({
            type: 'run_actions_result',
            requestId: msg.requestId,
            ok: false,
            error: `Client ${i} failed`
          }));
        }
      }
    });
  }

  const result = await wss.executeActions({
    actions: [{ verb: 'clickElement', args: { selector: 'button' } }],
    urlContains: 'example.com'
  });

  assert.equal(result.ok, true);
  assert.equal(clientActionsReceived.length, numClients, 'All clients received the broadcast actions');

  await closeClients(clients);
});

test('Action execution - Broadcast, multi-client, all fail rejects with combined errors', async () => {
  const clients = [];
  const connectPromises = [];
  const numClients = 3;

  for (let i = 0; i < numClients; i++) {
    const ws = new WebSocket(`${wsUrl}?token=${TOKEN}`);
    clients.push(ws);
    connectPromises.push(new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    }));
  }

  await Promise.all(connectPromises);

  for (let i = 0; i < numClients; i++) {
    const ws = clients[i];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'run_actions') {
        ws.send(JSON.stringify({
          type: 'run_actions_result',
          requestId: msg.requestId,
          ok: false,
          error: `Error from client ${i}`
        }));
      }
    });
  }

  const executePromise = wss.executeActions({
    actions: [{ verb: 'clickElement', args: { selector: 'button' } }]
  });

  await assert.rejects(executePromise, (err) => {
    assert.ok(err.message.includes('Error from client 0'));
    assert.ok(err.message.includes('Error from client 1'));
    assert.ok(err.message.includes('Error from client 2'));
    return true;
  });

  await closeClients(clients);
});

test('Action execution - Client disconnects during action execution', async () => {
  const clients = [];
  const connectPromises = [];
  const numClients = 3;

  for (let i = 0; i < numClients; i++) {
    const ws = new WebSocket(`${wsUrl}?token=${TOKEN}`);
    clients.push(ws);
    connectPromises.push(new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    }));
  }

  await Promise.all(connectPromises);

  for (let i = 0; i < numClients; i++) {
    const ws = clients[i];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'run_actions') {
        if (i === 0) {
          // Client 0 fails
          ws.send(JSON.stringify({
            type: 'run_actions_result',
            requestId: msg.requestId,
            ok: false,
            error: 'Client 0 failure'
          }));
        } else if (i === 1) {
          // Client 1 disconnects immediately
          ws.terminate();
        } else {
          // Client 2 disconnects after a short delay
          setTimeout(() => ws.terminate(), 50);
        }
      }
    });
  }

  const executePromise = wss.executeActions({
    actions: [{ verb: 'clickElement', args: { selector: 'button' } }]
  });

  await assert.rejects(executePromise, (err) => {
    assert.ok(err.message.includes('Action execution failed'));
    return true;
  });

  await closeClients(clients);
});
