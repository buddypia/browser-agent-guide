#!/usr/bin/env node
// Browser Agent Guide 視覚フィードバック デーモン（Phase 1 / 消費側）。
// inbox を Streamable HTTP MCP で公開し、Claude Code / Codex / Antigravity が
// context-first で annotation メタを読み、必要時だけ image+パスを取得できるようにする。
//
// 使い方:
//   node src/index.js                       # 既定 inbox=<自動検出した Downloads>/ai-inbox, port=8765
//   node src/index.js --inbox ./.ai-inbox --port 8765   # 明示指定すると「固定」され拡張の報告で上書きされない
//   node src/index.js --storage hybrid      # 受信時はメモリ保持、image/file_path 要求時だけ inbox に保存
//   BAG_VF_INBOX=/path BAG_VF_PORT=8765 BAG_VF_STORAGE=hybrid node src/index.js
//
// 既定 inbox は OS の Downloads を自動検出する（Win=レジストリ / Linux=XDG / mac=~/Downloads）。
// さらに拡張が WS で報告する downloadsDir を採用して、ブラウザの実ダウンロード先（移動済み/Edge・Brave）に追従する。

import { mkdirSync } from 'node:fs';
import { createHttpServer } from './http.js';
import { resolveInboxDir, inboxFromDownloadsDir } from './inbox.js';
import { attachWebSocketServer } from './ws.js';
import { loadOrCreateToken, tokenPath } from './token.js';
import { createVisualFeedbackStore, normalizeStorageMode } from './store.js';

const args = parseArgs(process.argv.slice(2));
// --inbox / 環境変数による明示指定があれば「固定」し、拡張の報告では上書きしない。
const explicitInbox = args.inbox || process.env.BAG_VF_INBOX || '';
const inboxState = { dir: resolveInboxDir(explicitInbox || undefined), pinned: Boolean(explicitInbox) };
const getInbox = () => inboxState.dir;
const port = Number(args.port || process.env.BAG_VF_PORT || 8765);
const host = args.host || process.env.BAG_VF_HOST || '127.0.0.1';
const token = loadOrCreateToken(args.token);
const storageMode = normalizeStorageMode(args.storage || process.env.BAG_VF_STORAGE || 'disk');
const entryStore = createVisualFeedbackStore({ inboxDir: getInbox, storageMode });

// 拡張が報告してきた実ダウンロード先を採用する（固定時/範囲外/不正時は無視）。
// これにより、ブラウザのダウンロード先が OS 既定と違っても（移動済み/Edge・Brave）inbox が一致する。
// 採用先はホーム配下に限定する（inboxFromDownloadsDir）。範囲外は明示 --inbox/BAG_VF_INBOX を使う。
function adoptDownloadsDir(downloadsDir) {
  if (inboxState.pinned) return false;
  const candidate = inboxFromDownloadsDir(downloadsDir);
  if (!candidate || candidate === inboxState.dir) return false;
  try {
    mkdirSync(candidate, { recursive: true });
  } catch {
    return false; // 作成不可なら採用しない
  }
  inboxState.dir = candidate;
  process.stderr.write(`[bag-vf] 拡張の報告により inbox を更新: ${candidate}\n`);
  return true;
}

const server = createHttpServer({ inboxDir: getInbox, entryStore });
attachWebSocketServer(server, {
  inboxDir: getInbox,
  entryStore,
  token,
  onSaved: ({ id, storage, materialized }) =>
    process.stderr.write(`[bag-vf] saved ${id}${storage ? ` (${storage}${materialized ? ', materialized' : ''})` : ''}\n`),
  onHello: (downloadsDir) => adoptDownloadsDir(downloadsDir),
});

server.listen(port, host, () => {
  // stdout は汚さず stderr に出す（MCP の stdio とは独立だが慣習に合わせる）。
  process.stderr.write(`[bag-vf] MCP(Streamable HTTP)  http://${host}:${port}/mcp\n`);
  process.stderr.write(`[bag-vf] 拡張 push (WebSocket)  ws://${host}:${port}/ws\n`);
  process.stderr.write(`[bag-vf] inbox: ${getInbox()}${inboxState.pinned ? ' (固定)' : ' (自動検出。拡張の報告で更新される場合あり)'}\n`);
  process.stderr.write(`[bag-vf] storage: ${storageMode}${storageMode === 'hybrid' ? ' (context はメモリ、image/file_path 時だけ保存)' : ' (即時保存)'}\n`);
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
    else if (a === '--storage') out.storage = argv[(i += 1)];
  }
  return out;
}
