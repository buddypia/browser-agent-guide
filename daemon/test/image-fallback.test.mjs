// 画像のパス非依存・メモリ優先まわりのテスト。
// - imageUrlFor: token-less な /shot|/raw URL を1か所で組み立てる純関数
// - buildEntryText: file_path は実ファイルがある時だけ出す（未materialize は shot_url fallback を案内）
// - image MCP ツール: materialize が失敗（read-only inbox 等）してもメモリの画像 + shot_url で応答する（memory-first）
// - WS ack: パス非依存の取得先 shotUrl/rawUrl を token-less で併走させ、?token= 付与で到達できる
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
import { createPageFeedbackStore } from '../src/store.js';
import { writeEntry } from '../src/writer.js';
import { findEntry, buildEntryContent, listEntries } from '../src/inbox.js';
import { imageUrlFor } from '../src/image-url.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const WEBP_MAGIC_RIFF = [0x52, 0x49, 0x46, 0x46]; // 'RIFF'
const TOKEN = 'image-fallback-token';

// 偽 WebP（RIFF....WEBP）。daemon は中身を検証しないので mime/サイズ検証にはこれで十分。
function fakeWebpDataUrl(sizeBytes = 80) {
  const pad = Buffer.alloc(Math.max(0, sizeBytes - 12), 0x20);
  const buf = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), pad]);
  return `data:image/webp;base64,${buf.toString('base64')}`;
}

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

// ---- imageUrlFor 純関数 ----
test('imageUrlFor: token-less / kind / id encode', () => {
  assert.equal(imageUrlFor('127.0.0.1:8765', 'abc__def', 'shot'), 'http://127.0.0.1:8765/shot/abc__def.png');
  assert.equal(imageUrlFor('127.0.0.1:8765', 'abc__def', 'raw'), 'http://127.0.0.1:8765/raw/abc__def.png');
  // 既定は shot、未知 kind も shot 扱い、host 空は loopback。
  assert.equal(imageUrlFor('127.0.0.1:8765', 'x'), 'http://127.0.0.1:8765/shot/x.png');
  assert.equal(imageUrlFor('', 'x', 'shot'), 'http://127.0.0.1/shot/x.png');
  // token は決して URL に埋め込まない。
  assert.ok(!imageUrlFor('h:1', 'id', 'shot').includes('token'));
});

// ---- buildEntryText: file_path は実在時のみ、未materialize は shot_url fallback ----
test('buildEntryContent: 未materialize(memory) は file_path を出さず shot_url を案内、image はメモリから', () => {
  const shotUrlFor = (id, kind) => imageUrlFor('127.0.0.1:8765', id, kind);
  const entry = {
    id: 'mem__entry',
    dir: join(tmpdir(), 'nonexistent-bag-pf-xyz'),
    shot: join(tmpdir(), 'nonexistent-bag-pf-xyz', 'shot.png'),
    shotBuffer: Buffer.from(PNG_B64, 'base64'),
    storage: 'memory',
    materialized: false,
    annotation: { url: 'https://x', items: [{ n: 1, note: 'a', selector: '#t' }] },
  };
  const content = buildEntryContent(entry, { shotUrlFor });
  const img = content.find((c) => c.type === 'image');
  const txt = content.find((c) => c.type === 'text').text;
  assert.ok(img, 'image content はメモリ(shotBuffer)から返る');
  assert.deepEqual([...Buffer.from(img.data, 'base64').subarray(0, 8)], PNG_MAGIC);
  assert.ok(!txt.includes('file_path:'), '存在しない file_path は広告しない');
  assert.ok(txt.includes('shot_url: http://127.0.0.1:8765/shot/mem__entry.png'), 'shot_url fallback を出す');
  assert.ok(txt.includes('note: file_path は未materialize'), '未materialize の注記を出す');
});

test('buildEntryContent: disk エントリは file_path を出す', () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-imgfb-disk-'));
  try {
    const written = writeEntry(inboxDir, {
      capturedAt: '2026-06-18T01:02:03.004Z',
      url: 'https://example.com/x',
      image: { shot: PNG_B64 },
      annotation: { url: 'https://example.com/x', items: [] },
    });
    const entry = findEntry(inboxDir, written.id);
    const shotUrlFor = (id, kind) => imageUrlFor('127.0.0.1:8765', id, kind);
    const txt = buildEntryContent(entry, { shotUrlFor }).find((c) => c.type === 'text').text;
    assert.ok(txt.includes(`file_path: ${join(entry.dir, 'shot.png')}`), 'disk は file_path を出す');
    assert.ok(txt.includes('shot_url: '), 'shot_url も併走する');
    assert.ok(!txt.includes('note: file_path は未materialize'), 'disk では未materialize 注記を出さない');
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

// ---- image MCP ツール: materialize 失敗でもメモリ画像 + shot_url で応答（memory-first / best-effort） ----
test('image tool: materialize 失敗時も image を返し、disk へ書かず、file_path を出さない', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-imgfb-mem-'));
  const entryStore = createPageFeedbackStore({ inboxDir, storageMode: 'hybrid' });
  const ack = entryStore.save({
    capturedAt: '2026-06-18T03:02:03.004Z',
    url: 'https://example.com/m',
    title: 'M',
    image: { shot: PNG_B64, raw: PNG_B64 },
    annotation: { url: 'https://example.com/m', items: [{ n: 1, note: 'memory only', selector: '#t' }] },
  });
  // read-only inbox / disk full を模す: materialize が常に失敗する。
  entryStore.materialize = () => {
    throw new Error('read-only inbox (simulated)');
  };
  const httpServer = createHttpServer({ inboxDir, entryStore, token: TOKEN });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const mcpUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;
  const client = new Client({ name: 'imgfb-test-client', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    const res = await client.callTool({
      name: 'get_feedback_image',
      arguments: {
        id: ack.id,
        contextId: ack.id,
        imageReason: 'test verifies image is still returned when materialize fails (memory-first)',
      },
    });
    assert.ok(!res.isError, 'materialize 失敗でもエラーにしない');
    // Codex#10334 パリティ: memory-first / materialize 失敗の image 経路でも structuredContent を載せない
    // （載せると Codex が content[] ごと image を落とすため）。
    assert.equal(res.structuredContent, undefined, 'Codex#10334 パリティ: image 結果は structuredContent を持たない');
    const img = res.content.find((c) => c.type === 'image');
    const txt = res.content.find((c) => c.type === 'text').text;
    assert.ok(img, 'メモリの image を返す');
    assert.equal(img.mimeType, 'image/png');
    assert.ok(!txt.includes('file_path:'), 'materialize 失敗時は file_path を出さない');
    assert.ok(txt.includes(`shot_url: http://127.0.0.1:${httpServer.address().port}/shot/${ack.id}.png`), 'shot_url fallback を出す');
    assert.equal(listEntries(inboxDir, 10).length, 0, 'image 応答で disk へ materialize しない');
  } finally {
    await client.close();
    await new Promise((r) => httpServer.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

// ---- inline 変種 + materialize 失敗: メモリの webp inline を返し、Codex#10334 パリティを保つ ----
test('image tool: inline(webp) があれば materialize 失敗でも webp を返し structuredContent を載せない', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-imgfb-inline-'));
  const entryStore = createPageFeedbackStore({ inboxDir, storageMode: 'hybrid' });
  const ack = entryStore.save({
    capturedAt: '2026-06-18T04:02:03.004Z',
    url: 'https://example.com/inl',
    title: 'Inl',
    image: { shot: PNG_B64, inline: fakeWebpDataUrl(), inlineMime: 'image/webp' },
    annotation: { url: 'https://example.com/inl', items: [{ n: 1, note: 'inline', selector: '#t' }] },
  });
  entryStore.materialize = () => {
    throw new Error('read-only inbox (simulated)');
  };
  const httpServer = createHttpServer({ inboxDir, entryStore, token: TOKEN });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const mcpUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;
  const client = new Client({ name: 'imgfb-inline-client', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    const res = await client.callTool({
      name: 'get_feedback_image',
      arguments: { id: ack.id, contextId: ack.id, imageReason: 'verify inline webp survives materialize failure (memory-first)' },
    });
    assert.ok(!res.isError);
    assert.equal(res.structuredContent, undefined, 'Codex#10334 パリティ: inline 分岐でも structuredContent を持たない');
    const img = res.content.find((c) => c.type === 'image');
    assert.equal(img.mimeType, 'image/webp', 'メモリの inline(webp) を返す');
    assert.deepEqual([...Buffer.from(img.data, 'base64').subarray(0, 4)], WEBP_MAGIC_RIFF);
    const txt = res.content.find((c) => c.type === 'text').text;
    assert.ok(txt.includes(`shot_url: http://127.0.0.1:${httpServer.address().port}/shot/${ack.id}.png`), 'フル解像度の shot_url を併走');
  } finally {
    await client.close();
    await new Promise((r) => httpServer.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

// ---- WS ack: パス非依存 shotUrl/rawUrl（token-less）を併走し、?token= で到達できる ----
test('ws ack: token-less な shotUrl/rawUrl を載せ、?token= 付与で 200・無しは 401', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-imgfb-ack-'));
  const httpServer = createHttpServer({ inboxDir, token: TOKEN });
  attachWebSocketServer(httpServer, { inboxDir, token: TOKEN });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  try {
    const ack = await sendOnce(`${wsUrl}?token=${TOKEN}`, {
      type: 'page_feedback',
      capturedAt: '2026-06-18T05:02:03.004Z',
      url: 'https://example.com/ack',
      title: 'Ack',
      image: { shot: PNG_B64, raw: PNG_B64 },
      annotation: { url: 'https://example.com/ack', items: [] },
    });
    assert.equal(ack.type, 'ack');
    assert.ok(ack.shotUrl, 'ack に shotUrl が載る');
    assert.ok(ack.shotUrl.includes(`/shot/${ack.id}.png`), 'shotUrl に対象 id が入る');
    assert.ok(!ack.shotUrl.includes('token'), 'token は ack URL に埋め込まない');
    assert.ok(ack.rawUrl && ack.rawUrl.includes(`/raw/${ack.id}.png`), 'raw があるので rawUrl も載る');
    assert.ok(!ack.rawUrl.includes('token'), 'rawUrl も token-less');

    // token 無しは 401、?token= を付ければ 200 image/png（file_path 非依存で取得できる）。
    assert.equal((await fetch(ack.shotUrl)).status, 401);
    const got = await fetch(`${ack.shotUrl}?token=${TOKEN}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual([...Buffer.from(await got.arrayBuffer()).subarray(0, 8)], PNG_MAGIC);

    // raw を持たない push は rawUrl を広告しない（404 を約束しない）。
    const ack2 = await sendOnce(`${wsUrl}?token=${TOKEN}`, {
      type: 'page_feedback',
      capturedAt: '2026-06-18T05:03:03.004Z',
      url: 'https://example.com/ack2',
      image: { shot: PNG_B64 },
      annotation: { url: 'https://example.com/ack2', items: [] },
    });
    assert.ok(ack2.shotUrl, 'shot は常に載る');
    assert.equal(ack2.rawUrl, undefined, 'raw 無し push は rawUrl を載せない');
  } finally {
    await new Promise((r) => httpServer.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
});
