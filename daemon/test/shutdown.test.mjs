// 実バイナリの終了処理: 拡張が WS で繋がったままでも SIGTERM で終わること、
// 端末でない stderr(launchd/systemd のログ)にトークンの値を出さないこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const indexJs = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.js');
const TOKEN = 'shutdown-test-token';

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? rej(err) : res(port)));
    });
  });

test('SIGTERM: 接続中の WS があっても終了し、stderr にトークン値を出さない', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bag-pf-shutdown-'));
  const port = await freePort();
  const proc = spawn(process.execPath, [indexJs, '--port', String(port), '--token', TOKEN], {
    env: { ...process.env, HOME: home, BAG_PF_INBOX: join(home, 'inbox') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
  try {
    for (let i = 0; i < 50 && !stderr.includes('retention:'); i += 1) await new Promise((r) => setTimeout(r, 100));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    });
    const closed = new Promise((res) => ws.once('close', res));
    proc.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
    assert.equal(code, 0);
    await closed;
    assert.equal(stderr.includes(TOKEN), false);
    assert.match(stderr, /token: --token \/ BAG_PF_TOKEN の値/);
  } finally {
    proc.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  }
});
