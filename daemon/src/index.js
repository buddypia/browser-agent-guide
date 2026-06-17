#!/usr/bin/env node
// Browser Agent Guide 視覚フィードバック デーモン（Phase 1 / 消費側）。
// inbox を Streamable HTTP MCP で公開し、Claude Code / Codex / Antigravity が
// get_latest_visual_feedback で image+パスを取得できるようにする。
//
// 使い方:
//   node src/index.js                       # 既定 inbox=~/Downloads/ai-inbox, port=8765
//   node src/index.js --inbox ./.ai-inbox --port 8765
//   BAG_VF_INBOX=/path BAG_VF_PORT=8765 node src/index.js

import { createHttpServer } from './http.js';
import { resolveInboxDir } from './inbox.js';
import { attachWebSocketServer } from './ws.js';
import { loadOrCreateToken, tokenPath } from './token.js';

const args = parseArgs(process.argv.slice(2));
const inboxDir = resolveInboxDir(args.inbox || process.env.BAG_VF_INBOX);
const port = Number(args.port || process.env.BAG_VF_PORT || 8765);
const host = args.host || process.env.BAG_VF_HOST || '127.0.0.1';
const token = loadOrCreateToken(args.token);

const server = createHttpServer({ inboxDir });
attachWebSocketServer(server, {
  inboxDir,
  token,
  onSaved: ({ id }) => process.stderr.write(`[bag-vf] saved ${id}\n`),
});

server.listen(port, host, () => {
  // stdout は汚さず stderr に出す（MCP の stdio とは独立だが慣習に合わせる）。
  process.stderr.write(`[bag-vf] MCP(Streamable HTTP)  http://${host}:${port}/mcp\n`);
  process.stderr.write(`[bag-vf] 拡張 push (WebSocket)  ws://${host}:${port}/ws\n`);
  process.stderr.write(`[bag-vf] inbox: ${inboxDir}\n`);
  process.stderr.write(`[bag-vf] token: ${token}\n`);
  process.stderr.write(`[bag-vf]   ↑ これを拡張オプションの「視覚フィードバック デーモン」に貼る (保存先: ${tokenPath()})\n`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--inbox') out.inbox = argv[(i += 1)];
    else if (a === '--port') out.port = argv[(i += 1)];
    else if (a === '--host') out.host = argv[(i += 1)];
    else if (a === '--token') out.token = argv[(i += 1)];
  }
  return out;
}
