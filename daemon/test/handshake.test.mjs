// クロスプラットフォーム Downloads 検出と、拡張→デーモンの downloadsDir ハンドシェイクの検証。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { WebSocket } from 'ws';
import { createHttpServer } from '../src/http.js';
import { attachWebSocketServer } from '../src/ws.js';
import { resolveDownloadsDir, defaultInboxDir, inboxFromDownloadsDir } from '../src/inbox.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'hs-token';

test('resolveDownloadsDir は絶対パスを返し、defaultInboxDir は ai-inbox 配下', () => {
  const d = resolveDownloadsDir();
  assert.equal(typeof d, 'string');
  assert.ok(isAbsolute(d), '絶対パス');
  assert.ok(d.length > 0);
  const inbox = defaultInboxDir();
  assert.ok(inbox.endsWith(join('', 'ai-inbox')) || inbox.endsWith('ai-inbox'), 'ai-inbox 末尾');
  assert.ok(inbox.startsWith(d), 'Downloads 配下');
});

test('inboxFromDownloadsDir: ホーム配下のみ採用、範囲外/相対/不正は null', () => {
  const home = homedir();
  // 正常: ホーム配下の Downloads → <dir>/ai-inbox
  assert.equal(inboxFromDownloadsDir(join(home, 'Downloads')), join(home, 'Downloads', 'ai-inbox'));
  assert.equal(inboxFromDownloadsDir(join(home, 'Moved', 'DL')), join(home, 'Moved', 'DL', 'ai-inbox'));
  // 範囲外: システムディレクトリや他ユーザー領域は拒否（トークン漏洩時の書き込み範囲を絞る）。
  assert.equal(inboxFromDownloadsDir('/etc'), null);
  assert.equal(inboxFromDownloadsDir('/tmp/../etc'), null); // 正規化しても /etc
  assert.equal(inboxFromDownloadsDir(`${home}Evil/x`), null); // prefix 混同を防ぐ
  // 不正入力。
  assert.equal(inboxFromDownloadsDir('relative/path'), null);
  assert.equal(inboxFromDownloadsDir(''), null);
  assert.equal(inboxFromDownloadsDir(null), null);
  assert.equal(inboxFromDownloadsDir(123), null);
  // home 上書きで範囲を狭められる（テスト用途）。
  assert.equal(inboxFromDownloadsDir('/sandbox/dl', { home: '/sandbox' }), join('/sandbox', 'dl', 'ai-inbox'));
  assert.equal(inboxFromDownloadsDir('/other/dl', { home: '/sandbox' }), null);
});

// 可変 inbox ホルダ + onHello 採用を index.js と同じ形で再現し、ハンドシェイクで書き込み先が切り替わるか。
let httpServer;
let baseDir;
let wsUrl;
const inboxState = { dir: '', pinned: false };

before(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'vf-hs-'));
  inboxState.dir = join(baseDir, 'initial', 'ai-inbox');
  // index.js の adoptDownloadsDir と同じ実体(inboxFromDownloadsDir)を使う。
  // テストの保存先は tmpdir 配下なので home を baseDir に上書きして採用範囲を合わせる。
  const adopt = (downloadsDir) => {
    if (inboxState.pinned) return false;
    const candidate = inboxFromDownloadsDir(downloadsDir, { home: baseDir });
    if (!candidate || candidate === inboxState.dir) return false;
    mkdirSync(candidate, { recursive: true });
    inboxState.dir = candidate;
    return true;
  };
  httpServer = createHttpServer({ inboxDir: () => inboxState.dir });
  attachWebSocketServer(httpServer, { inboxDir: () => inboxState.dir, token: TOKEN, onHello: adopt });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();
  wsUrl = `ws://127.0.0.1:${port}/ws?token=${TOKEN}`;
});

after(async () => {
  await new Promise((r) => httpServer.close(r));
  rmSync(baseDir, { recursive: true, force: true });
});

function sendOnce(message) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout'));
    }, 4000);
    ws.on('open', () => ws.send(JSON.stringify(message)));
    ws.on('message', (d) => {
      clearTimeout(t);
      ws.close();
      resolve(JSON.parse(d.toString()));
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

test('downloadsDir ハンドシェイクで書き込み先 inbox が切り替わる', async () => {
  const reported = join(baseDir, 'custom-downloads'); // ブラウザの実ダウンロード先（想定）
  const ack = await sendOnce({
    type: 'page_feedback',
    capturedAt: '2026-06-18T01:02:03.004Z',
    url: 'https://example.com/x',
    title: 'X',
    downloadsDir: reported,
    image: { shot: PNG_B64 },
  });
  assert.equal(ack.type, 'ack');
  // 採用後の inbox（reported/ai-inbox）配下に書かれている。
  assert.ok(ack.dir.startsWith(join(reported, 'ai-inbox')), `採用先に書かれる: ${ack.dir}`);
  assert.ok(existsSync(join(ack.dir, 'shot.png')));
  assert.equal(inboxState.dir, join(reported, 'ai-inbox'), 'inbox 状態が更新される');
});
