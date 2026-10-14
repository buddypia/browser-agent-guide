// DNS rebinding 対策: Host/Origin が loopback 以外のリクエストは /mcp を含む全ルートで 403。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpServer, isAllowedRequest } from '../src/http.js';

test('isAllowedRequest: loopback の Host だけを通し、Origin は loopback か無しだけを通す', () => {
  for (const host of ['127.0.0.1:8765', 'localhost:8765', '[::1]:8765', 'LOCALHOST']) assert.equal(isAllowedRequest({ host }), true, host);
  for (const host of ['evil.example:8765', '', '127.0.0.1.evil.example']) assert.equal(isAllowedRequest({ host }), false, host);
  assert.equal(isAllowedRequest({ host: '127.0.0.1:8765', origin: 'http://localhost:3000' }), true);
  assert.equal(isAllowedRequest({ host: '127.0.0.1:8765', origin: 'https://evil.example' }), false);
  assert.equal(isAllowedRequest({ host: '127.0.0.1:8765', origin: 'null' }), false);
  // --host で明示した名前は許可。0.0.0.0 は外部公開を選んだとみなし Host を問わない(Origin は引き続き検証)。
  assert.equal(isAllowedRequest({ host: 'mybox.lan:8765' }, 'mybox.lan'), true);
  assert.equal(isAllowedRequest({ host: '192.168.1.5:8765' }, '0.0.0.0'), true);
  assert.equal(isAllowedRequest({ host: '192.168.1.5:8765', origin: 'https://evil.example' }, '0.0.0.0'), false);
});

function request(port, { path = '/healthz', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('rebinding されたページ(Host=攻撃者ドメイン)からの /mcp・/healthz は 403、loopback は通る', async () => {
  const server = createHttpServer({ inboxDir: '/nonexistent', executeActions: async () => ({ ok: true, results: [] }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const mcp = {
      path: '/mcp',
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    };
    const json = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    assert.equal(await request(port, { ...mcp, headers: { ...json, host: `evil.example:${port}`, origin: `http://evil.example:${port}` } }), 403);
    assert.equal(await request(port, { headers: { host: `evil.example:${port}` } }), 403);
    assert.equal(await request(port, { headers: { origin: 'https://evil.example' } }), 403);
    assert.equal(await request(port, {}), 200);
    assert.equal(await request(port, { ...mcp, headers: json }), 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
