// Streamable HTTP の Node http 配線（stateless）。
// POST /mcp ごとに McpServer + StreamableHTTPServerTransport を新規生成して 1 リクエストを処理する。
// stateless（sessionIdGenerator: undefined）なので 3 つの CLI が同一エンドポイントへ同時接続できる。
// テストから差し込めるよう http.Server を返す（listen は呼び出し側）。

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';

const MAX_BODY = 8 * 1024 * 1024; // 8MB（tools/call の要求は小さい）

// inboxDir は文字列でも「現在の inbox を返す関数」でも良い（実行時に inbox を差し替えられるように）。
export function createHttpServer({ inboxDir, path = '/mcp' } = {}) {
  const currentInbox = () => (typeof inboxDir === 'function' ? inboxDir() : inboxDir);
  return http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, inboxDir: currentInbox() }));
      return;
    }
    if (url !== path) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(jsonRpcError(-32700, 'Parse error'));
      return;
    }
    const server = createMcpServer(currentInbox());
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(jsonRpcError(-32603, String(e?.message || e)));
    }
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return resolve(undefined);
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function jsonRpcError(code, message) {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
}
