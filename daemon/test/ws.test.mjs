// WebSocket push の統合テスト: 拡張役の ws クライアントから page_feedback を送り、
// inbox にファイルが書かれて ack が返ること、トークン不一致は拒否されることを検証する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws.js';
import { listEntries } from '../src/inbox.js';
import { writeEntry, decodeBase64, inlineFilename } from '../src/writer.js';

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'test-secret-token';

function fakeWebp(sizeBytes = 64) {
  const pad = Buffer.alloc(Math.max(0, sizeBytes - 12), 0x20);
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), pad]);
}

let httpServer;
let inboxDir;
let wsUrl;
let wss;

before(async () => {
  inboxDir = mkdtempSync(join(tmpdir(), 'vf-ws-'));
  httpServer = createHttpServer({ inboxDir });
  wss = attachWebSocketServer(httpServer, { inboxDir, token: TOKEN });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  await new Promise((r) => httpServer.close(r));
  rmSync(inboxDir, { recursive: true, force: true });
});

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

test('正しいトークンで push → ack + inbox にファイル', async () => {
  const ack = await sendOnce(`${wsUrl}?token=${TOKEN}`, {
    type: 'page_feedback',
    capturedAt: '2026-06-18T01:02:03.004Z',
    url: 'https://example.com/x',
    title: 'X',
    image: { shot: PNG_B64, raw: PNG_B64 },
    annotation: { url: 'https://example.com/x', items: [{ n: 1, note: 'a' }] },
    memo: '# memo\n',
  });
  assert.equal(ack.type, 'ack');
  assert.ok(ack.id, 'slug id が返る');
  assert.deepEqual(ack.files.sort(), ['annotation.json', 'memo.md', 'raw.png', 'shot.png']);
  const entries = listEntries(inboxDir, 10);
  assert.ok(entries.some((e) => e.id === ack.id), 'listEntries で見える');
  assert.ok(existsSync(join(ack.dir, 'shot.png')));
  const ann = JSON.parse(readFileSync(join(ack.dir, 'annotation.json'), 'utf8'));
  assert.equal(ann.url, 'https://example.com/x');
});

test('後方互換: 旧 type "visual_feedback" も受理する', async () => {
  const ack = await sendOnce(`${wsUrl}?token=${TOKEN}`, {
    type: 'visual_feedback',
    capturedAt: '2026-06-18T05:06:07.008Z',
    url: 'https://legacy.example.com/y',
    title: 'Y',
    image: { shot: PNG_B64 },
    annotation: { url: 'https://legacy.example.com/y', items: [{ n: 1, note: 'legacy' }] },
  });
  assert.equal(ack.type, 'ack');
  assert.ok(ack.id, '旧 type でも slug id が返る');
});

test('トークン不一致は接続拒否（401）', async () => {
  await assert.rejects(
    () => sendOnce(`${wsUrl}?token=WRONG`, { type: 'page_feedback', image: { shot: PNG_B64 } }),
    /401|unexpected server response|socket hang up|ECONNRESET/i
  );
});

test('トークン無しも拒否', async () => {
  await assert.rejects(() => sendOnce(wsUrl, { type: 'page_feedback', image: { shot: PNG_B64 } }));
});

test('image.shot 無しは error 応答（ファイルは作らない）', async () => {
  const before = listEntries(inboxDir, 50).length;
  const res = await sendOnce(`${wsUrl}?token=${TOKEN}`, { type: 'page_feedback', annotation: {} });
  assert.equal(res.type, 'error');
  assert.equal(listEntries(inboxDir, 50).length, before, 'エントリは増えない');
});

test('writeEntry: slug 衝突時は -2 で別ディレクトリ', () => {
  const a = writeEntry(inboxDir, { capturedAt: '2026-06-18T09:09:09.000Z', image: { shot: PNG_B64 } });
  const b = writeEntry(inboxDir, { capturedAt: '2026-06-18T09:09:09.000Z', image: { shot: PNG_B64 } });
  assert.notEqual(a.id, b.id);
  assert.ok(b.id.endsWith('-2'));
});

test('writeEntry: image.inline(webp) を shot.inline.webp として永続し files に含む', () => {
  const w = writeEntry(inboxDir, {
    capturedAt: '2026-06-18T09:11:00.000Z',
    image: { shot: PNG_B64, inline: `data:image/webp;base64,${fakeWebp().toString('base64')}`, inlineMime: 'image/webp' },
  });
  assert.ok(w.files.includes('shot.inline.webp'), 'inline 変種を files に載せる');
  assert.ok(existsSync(join(w.dir, 'shot.inline.webp')), 'shot.inline.webp を永続する');
  // inline 無しは何も書かない（後方互換）。
  const noInline = writeEntry(inboxDir, { capturedAt: '2026-06-18T09:12:00.000Z', image: { shot: PNG_B64 } });
  assert.ok(!noInline.files.some((f) => f.startsWith('shot.inline')), 'inline 無しは inline ファイルを作らない');
});

test('bridgeStatus: 未接続→接続(push前)→push後→切断 の状態遷移を追跡する', async () => {
  // 既存の before フックの共有サーバーは前段テストの push で汚れているため、独立サーバーで検証する。
  const dir = mkdtempSync(join(tmpdir(), 'vf-ws-bridge-'));
  const server = createHttpServer({ inboxDir: dir });
  const localWss = attachWebSocketServer(server, { inboxDir: dir, token: TOKEN });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/ws`;

  try {
    const initial = localWss.getBridgeStatus();
    assert.deepEqual(initial, { connected: false, everConnected: false, lastConnectedAt: null, lastPushAt: null });

    const ws = new WebSocket(`${url}?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const connectedBeforePush = localWss.getBridgeStatus();
    assert.equal(connectedBeforePush.connected, true);
    assert.equal(connectedBeforePush.everConnected, true);
    assert.ok(connectedBeforePush.lastConnectedAt);
    assert.equal(connectedBeforePush.lastPushAt, null, 'push 前は lastPushAt が入らない');

    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 4000);
      ws.once('message', (d) => {
        clearTimeout(timer);
        resolve(JSON.parse(d.toString()));
      });
      ws.send(
        JSON.stringify({
          type: 'page_feedback',
          capturedAt: '2026-06-18T01:02:03.004Z',
          url: 'https://example.com/bridge',
          image: { shot: PNG_B64 },
          annotation: {},
        })
      );
    });
    assert.equal(ack.type, 'ack');

    const afterPush = localWss.getBridgeStatus();
    assert.ok(afterPush.lastPushAt, 'push 後は lastPushAt が入る');

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const afterClose = localWss.getBridgeStatus();
    assert.equal(afterClose.connected, false, '切断後は connected=false');
    assert.equal(afterClose.everConnected, true, 'everConnected は切断後も保持される');
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decodeBase64: png/webp/jpeg data URL と生 base64 を扱う / inlineFilename マッピング', () => {
  const raw = Buffer.from([1, 2, 3]);
  const b64 = raw.toString('base64');
  assert.deepEqual([...decodeBase64(b64)], [1, 2, 3], '生 base64');
  assert.deepEqual([...decodeBase64(`data:image/png;base64,${b64}`)], [1, 2, 3], 'png data URL');
  assert.deepEqual([...decodeBase64(`data:image/webp;base64,${b64}`)], [1, 2, 3], 'webp data URL');
  assert.deepEqual([...decodeBase64(`data:image/jpeg;base64,${b64}`)], [1, 2, 3], 'jpeg data URL');
  assert.equal(decodeBase64(null), null);
  assert.equal(inlineFilename('image/webp'), 'shot.inline.webp');
  assert.equal(inlineFilename('image/jpeg'), 'shot.inline.jpg');
  assert.equal(inlineFilename('image/png'), null, '未対応 mime は null（書かない）');
});
