// hybrid store の統合テスト:
// WS push 直後はメモリ保持のみ、context MCP は disk なしで読め、
// image MCP を呼んだ時だけ file_path fallback を materialize する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws.js';
import { createVisualFeedbackStore, normalizeStorageMode } from '../src/store.js';
import { listEntries } from '../src/inbox.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'hybrid-store-token';

function sendOnce(url, message) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout'));
    }, 4000);
    ws.on('open', () => ws.send(JSON.stringify(message)));
    ws.on('message', (d) => {
      clearTimeout(timer);
      ws.close();
      try {
        resolve(JSON.parse(d.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function withMcpClient(baseUrl, fn) {
  const client = new Client({ name: 'hybrid-test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('normalizeStorageMode: disk/hybrid/memory を区別し、不明は disk', () => {
  assert.equal(normalizeStorageMode(''), 'disk');
  assert.equal(normalizeStorageMode('disk'), 'disk');
  assert.equal(normalizeStorageMode('hybrid'), 'hybrid');
  assert.equal(normalizeStorageMode('memory'), 'memory');
  assert.equal(normalizeStorageMode('MEMORY'), 'memory');
  assert.equal(normalizeStorageMode('unknown'), 'disk');
});

test('hybrid store: context はメモリから返し、image 要求時だけ inbox に保存する', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-hybrid-'));
  const entryStore = createVisualFeedbackStore({ inboxDir, storageMode: 'hybrid' });
  const httpServer = createHttpServer({ inboxDir, entryStore, nowMs: Date.parse('2026-06-18T01:10:00.000Z') });
  const wss = attachWebSocketServer(httpServer, { inboxDir, entryStore, token: TOKEN });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;

  try {
    const ack = await sendOnce(`${wsUrl}?token=${TOKEN}`, {
      type: 'visual_feedback',
      capturedAt: '2026-06-18T01:02:03.004Z',
      url: 'https://hybrid.example/page',
      title: 'Hybrid Capture',
      image: { shot: PNG_B64, raw: PNG_B64 },
      annotation: {
        url: 'https://hybrid.example/page',
        title: 'Hybrid Capture',
        capturedAt: '2026-06-18T01:02:03.004Z',
        items: [{ n: 1, note: 'memory only', selector: '#target' }],
      },
      memo: '# memo\n',
    });

    assert.equal(ack.type, 'ack');
    assert.equal(ack.storage, 'memory');
    assert.equal(ack.materialized, false);
    assert.deepEqual(ack.files, []);
    assert.ok(ack.id);
    assert.equal(existsSync(join(ack.dir, 'shot.png')), false, 'WS push 直後は disk に保存しない');

    await withMcpClient(mcpUrl, async (client) => {
      const contextRes = await client.callTool({
        name: 'get_latest_visual_feedback_context',
        arguments: { urlContains: 'hybrid.example' },
      });
      assert.ok(!contextRes.content.some((c) => c.type === 'image'), 'context は image なし');
      assert.equal(contextRes.structuredContent.id, ack.id);
      assert.equal(contextRes.structuredContent.storage, 'memory');
      assert.equal(contextRes.structuredContent.materialized, false);
      assert.equal(contextRes.structuredContent.annotations[0].selector, '#target');
      assert.equal(existsSync(join(ack.dir, 'shot.png')), false, 'context 取得でも disk に保存しない');

      const imageRes = await client.callTool({
        name: 'get_latest_visual_feedback',
        arguments: {
          urlContains: 'hybrid.example',
          contextId: ack.id,
          imageReason: 'test verifies that image transport materializes the file_path fallback',
        },
      });
      const img = imageRes.content.find((c) => c.type === 'image');
      const txt = imageRes.content.find((c) => c.type === 'text');
      assert.ok(img, 'image content を返す');
      assert.equal(img.mimeType, 'image/png');
      assert.ok(txt.text.includes(`file_path: ${join(ack.dir, 'shot.png')}`));
      assert.ok(existsSync(join(ack.dir, 'shot.png')), 'image 要求時に file_path を materialize する');
      assert.ok(existsSync(join(ack.dir, 'annotation.json')), 'annotation fallback も同時に作る');
    });
  } finally {
    wss.close();
    await new Promise((r) => httpServer.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('hybrid store: 異なる host の memory push 2件で bare context が disambiguation を返す（N5）', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-hybrid-amb-'));
  const entryStore = createVisualFeedbackStore({ inboxDir, storageMode: 'hybrid' });
  const httpServer = createHttpServer({ inboxDir, entryStore, nowMs: Date.parse('2026-06-20T10:10:00.000Z') });
  const wss = attachWebSocketServer(httpServer, { inboxDir, entryStore, token: TOKEN });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  try {
    await sendOnce(`${wsUrl}?token=${TOKEN}`, {
      type: 'visual_feedback',
      capturedAt: '2026-06-20T10:00:00.000Z',
      url: 'https://amazon.co.jp/x',
      title: 'Amazon',
      image: { shot: PNG_B64 },
      annotation: { url: 'https://amazon.co.jp/x', title: 'Amazon', capturedAt: '2026-06-20T10:00:00.000Z', items: [] },
    });
    await sendOnce(`${wsUrl}?token=${TOKEN}`, {
      type: 'visual_feedback',
      capturedAt: '2026-06-20T09:58:00.000Z',
      url: 'https://example.com/y',
      title: 'MyApp',
      image: { shot: PNG_B64 },
      annotation: { url: 'https://example.com/y', title: 'MyApp', capturedAt: '2026-06-20T09:58:00.000Z', items: [] },
    });
    await withMcpClient(mcpUrl, async (client) => {
      // メモリ保持エントリでも peekDistinctRecent が capturedAt を読み、曖昧検知が働く。
      const res = await client.callTool({ name: 'get_latest_visual_feedback_context', arguments: {} });
      assert.ok(!res.content.some((c) => c.type === 'image'), '曖昧時は image を返さない');
      assert.equal(res.structuredContent.id, undefined, 'foreign id を載せない');
      assert.equal(res.structuredContent.disambiguation.distinctCount, 2, 'memory entry の capturedAt で 2 案件を検知');
    });
  } finally {
    wss.close();
    await new Promise((r) => httpServer.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('memory store (既定): inbox を作らず、image 要求時のみ OS tmp に一時 materialize する', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-memory-'));
  const entryStore = createVisualFeedbackStore({ inboxDir, storageMode: 'memory' });
  const httpServer = createHttpServer({ inboxDir, entryStore, token: TOKEN, nowMs: Date.parse('2026-06-22T01:10:00.000Z') });
  const wss = attachWebSocketServer(httpServer, { inboxDir, entryStore, token: TOKEN });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  let materializedPath = '';

  try {
    const ack = await sendOnce(`${wsUrl}?token=${TOKEN}`, {
      type: 'visual_feedback',
      capturedAt: '2026-06-22T01:02:03.004Z',
      url: 'https://memory.example/page',
      title: 'Memory Capture',
      image: { shot: PNG_B64, raw: PNG_B64 },
      annotation: {
        url: 'https://memory.example/page',
        title: 'Memory Capture',
        capturedAt: '2026-06-22T01:02:03.004Z',
        items: [{ n: 1, note: 'memory mode', selector: '#target' }],
      },
      memo: '# memo\n',
    });
    assert.equal(ack.type, 'ack');
    assert.equal(ack.storage, 'memory');
    assert.equal(ack.materialized, false);

    await withMcpClient(mcpUrl, async (client) => {
      const contextRes = await client.callTool({
        name: 'get_latest_visual_feedback_context',
        arguments: { urlContains: 'memory.example' },
      });
      assert.ok(!contextRes.content.some((c) => c.type === 'image'), 'context は image なし');
      assert.equal(contextRes.structuredContent.id, ack.id);
      assert.equal(listEntries(inboxDir, 10).length, 0, 'context 取得でも inbox を作らない');

      const imageRes = await client.callTool({
        name: 'get_latest_visual_feedback',
        arguments: {
          urlContains: 'memory.example',
          contextId: ack.id,
          imageReason: 'test verifies memory mode materializes to OS tmp, not the inbox',
        },
      });
      const img = imageRes.content.find((c) => c.type === 'image');
      const txt = imageRes.content.find((c) => c.type === 'text').text;
      assert.ok(img, 'image はメモリから返る');
      assert.equal(img.mimeType, 'image/png');
      // Codex#10334 パリティ: image 結果は structuredContent を持たない。
      assert.equal(imageRes.structuredContent, undefined, 'image 結果は structuredContent を持たない');
      // file_path は OS tmp 配下（inbox 配下ではない）に出る。
      const m = txt.match(/file_path: (.+)/);
      assert.ok(m, 'memory モードでも file_path を出す（OS tmp 上）');
      materializedPath = m[1].trim();
      assert.ok(materializedPath.startsWith(tmpdir()), 'file_path は OS tmp 配下');
      assert.ok(!materializedPath.startsWith(inboxDir), 'file_path は inbox 配下ではない');
      assert.ok(existsSync(materializedPath), 'tmp に一時 materialize されている');
      assert.equal(listEntries(inboxDir, 10).length, 0, 'image 要求でも inbox は空のまま');
    });

    // cleanup で一時 materialize 先を破棄する（プロセス終了時に index.js が呼ぶのと同じ）。
    entryStore.cleanup();
    assert.equal(existsSync(materializedPath), false, 'cleanup で OS tmp の一時ファイルを破棄する');
  } finally {
    wss.close();
    await new Promise((r) => httpServer.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
});
