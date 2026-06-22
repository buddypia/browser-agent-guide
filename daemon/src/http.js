// Streamable HTTP の Node http 配線（stateless）。
// POST /mcp ごとに McpServer + StreamableHTTPServerTransport を新規生成して 1 リクエストを処理する。
// stateless（sessionIdGenerator: undefined）なので 3 つの CLI が同一エンドポイントへ同時接続できる。
// テストから差し込めるよう http.Server を返す（listen は呼び出し側）。
//
// 追加: GET /shot/<id>.png と /raw/<id>.png をトークン必須で配信する（ディスクパス非依存の取得先）。
// ブラウザの DL 先と inbox がズレても、CLI/人間は id だけで PNG を取れる（file_path に依存しない）。

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { createDiskEntryStore } from './store.js';
import { readEntryImageBuffer } from './inbox.js';
import { tokenEquals } from './token.js';

const MAX_BODY = 8 * 1024 * 1024; // 8MB（tools/call の要求は小さい）

// /shot/<id>.png | /raw/<id>.png。id は slug 文字種（[a-z0-9_-]、'__' 区切り）に限定し traversal を排除する。
const IMAGE_ROUTE = /^\/(shot|raw)\/([A-Za-z0-9_-]+)\.png$/;

// inboxDir は文字列でも「現在の inbox を返す関数」でも良い（実行時に inbox を差し替えられるように）。
// entryStore を渡すと、MCP は disk 直読みではなく store 抽象を通して context/image を取得する。
// token を渡すと /shot|/raw 画像配信が有効化される（クエリ ?token= を定数時間比較）。未指定なら画像配信は 401。
export function createHttpServer({ inboxDir, entryStore, token, path = '/mcp' } = {}) {
  const currentInbox = () => (typeof inboxDir === 'function' ? inboxDir() : inboxDir);
  // 画像配信用の lookup store。entryStore が無ければ disk store を都度生成（現在の inbox を読む）。
  const lookupStore = () => entryStore || createDiskEntryStore(currentInbox());

  return http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          inboxDir: currentInbox(),
          imageRoute: token ? '/shot/<id>.png' : null,
          ...(entryStore?.info?.() || {}),
        })
      );
      return;
    }
    const imageMatch = IMAGE_ROUTE.exec(url);
    if (imageMatch) {
      serveImage(req, res, { kind: imageMatch[1], id: imageMatch[2], token, lookupStore });
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
    // この POST に使われた authority(host:port) からパス非依存の取得先 URL を組み立て、MCP テキストに併走させる。
    const shotUrlFor = makeShotUrlFor(req, token);
    const server = createMcpServer(entryStore || currentInbox(), { shotUrlFor });
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

// GET /shot|/raw/<id>.png を配信する。token 必須（loopback でも他プロセスへ捕捉内容を漏らさない）。
function serveImage(req, res, { kind, id, token, lookupStore }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  let provided = '';
  try {
    provided = new URL(req.url || '', 'http://127.0.0.1').searchParams.get('token') || '';
  } catch {
    provided = '';
  }
  if (!token || !tokenEquals(provided, token)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }
  let entry;
  try {
    entry = lookupStore().findEntry(id);
  } catch {
    entry = null;
  }
  const buf = entry ? readEntryImageBuffer(entry, kind) : null;
  if (!buf) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(buf);
}

// id から loopback HTTP 取得先 URL を作る関数を返す。token 未設定（=ルート無効）なら undefined = URL 併走なし。
// host は req.headers.host（クライアントが接続に使った authority）。同じ宛先で必ず到達できる。
// 重要: token は URL に埋め込まない。/mcp は無認証なので、書き込み権限を持つ token を読み取り専用の
// MCP レスポンスへ載せると権限昇格の経路になる。取得側は別途 ?token= を付与する（README 参照）。
function makeShotUrlFor(req, token) {
  if (!token) return undefined;
  const host = req.headers.host || '127.0.0.1';
  return (id, kind = 'shot') => `http://${host}/${kind === 'raw' ? 'raw' : 'shot'}/${encodeURIComponent(id)}.png`;
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
