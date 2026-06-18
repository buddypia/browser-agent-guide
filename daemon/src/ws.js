// 拡張からの WebSocket push 受信。同一 http サーバの 'upgrade' に同居（同一ポート, path=/ws）。
// 接続時にクエリ ?token=... を定数時間比較で検証し、不一致は 401 で拒否（CVE-2025-52882 対策）。
import { WebSocketServer } from 'ws';
import { writeEntry } from './writer.js';
import { tokenEquals } from './token.js';

const MAX_PAYLOAD = 64 * 1024 * 1024; // 合成PNG(base64) + raw を許容

// inboxDir は文字列でも「現在の inbox を返す関数」でも良い。
// onHello(downloadsDir) が渡されると、push 時に拡張が報告した実ダウンロード先を採用できる。
export function attachWebSocketServer(httpServer, { inboxDir, token, path = '/ws', onSaved, onHello } = {}) {
  const currentInbox = () => (typeof inboxDir === 'function' ? inboxDir() : inboxDir);
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
        // 拡張が実ダウンロード先を報告してきたら、書き込み前に inbox を合わせる（固定時は無視）。
        if (msg.downloadsDir) onHello?.(msg.downloadsDir);
        const { id, dir, files } = writeEntry(currentInbox(), msg);
        onSaved?.({ id, dir, files });
        ws.send(JSON.stringify({ type: 'ack', id, dir, files }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: String(e?.message || e) }));
      }
    });
  });

  return wss;
}
