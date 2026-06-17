// WebSocket push の統合テスト: 拡張役の ws クライアントから visual_feedback を送り、
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
import { writeEntry } from '../src/writer.js';

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'test-secret-token';

let httpServer;
let inboxDir;
let wsUrl;

before(async () => {
  inboxDir = mkdtempSync(join(tmpdir(), 'vf-ws-'));
  httpServer = createHttpServer({ inboxDir });
  attachWebSocketServer(httpServer, { inboxDir, token: TOKEN });
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
    type: 'visual_feedback',
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

test('トークン不一致は接続拒否（401）', async () => {
  await assert.rejects(
    () => sendOnce(`${wsUrl}?token=WRONG`, { type: 'visual_feedback', image: { shot: PNG_B64 } }),
    /401|unexpected server response|socket hang up|ECONNRESET/i
  );
});

test('トークン無しも拒否', async () => {
  await assert.rejects(() => sendOnce(wsUrl, { type: 'visual_feedback', image: { shot: PNG_B64 } }));
});

test('image.shot 無しは error 応答（ファイルは作らない）', async () => {
  const before = listEntries(inboxDir, 50).length;
  const res = await sendOnce(`${wsUrl}?token=${TOKEN}`, { type: 'visual_feedback', annotation: {} });
  assert.equal(res.type, 'error');
  assert.equal(listEntries(inboxDir, 50).length, before, 'エントリは増えない');
});

test('writeEntry: slug 衝突時は -2 で別ディレクトリ', () => {
  const a = writeEntry(inboxDir, { capturedAt: '2026-06-18T09:09:09.000Z', image: { shot: PNG_B64 } });
  const b = writeEntry(inboxDir, { capturedAt: '2026-06-18T09:09:09.000Z', image: { shot: PNG_B64 } });
  assert.notEqual(a.id, b.id);
  assert.ok(b.id.endsWith('-2'));
});
