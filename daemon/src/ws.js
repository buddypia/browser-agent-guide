// 拡張からの WebSocket push 受信。同一 http サーバの 'upgrade' に同居（同一ポート, path=/ws）。
// 接続時にクエリ ?token=... を定数時間比較で検証し、不一致は 401 で拒否（CVE-2025-52882 対策）。
import { WebSocketServer } from 'ws';
import { writeEntry } from './writer.js';
import { tokenEquals } from './token.js';

const MAX_PAYLOAD = 64 * 1024 * 1024; // 合成PNG(base64) + raw を許容

export function attachWebSocketServer(httpServer, { inboxDir, token, path = '/ws', onSaved } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    const provided = url.searchParams.get('token') || '';
    if (!tokenEquals(provided, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid json' }));
        return;
      }
      if (msg?.type !== 'visual_feedback') {
        ws.send(JSON.stringify({ type: 'error', error: `unknown type: ${msg?.type}` }));
        return;
      }
      try {
        const { id, dir, files } = writeEntry(inboxDir, msg);
        onSaved?.({ id, dir, files });
        ws.send(JSON.stringify({ type: 'ack', id, dir, files }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: String(e?.message || e) }));
      }
    });
  });

  return wss;
}
