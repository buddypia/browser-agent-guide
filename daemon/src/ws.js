// 拡張からの WebSocket push 受信。同一 http サーバの 'upgrade' に同居（同一ポート, path=/ws）。
// 接続時にクエリ ?token=... を定数時間比較で検証し、不一致は 401 で拒否（CVE-2025-52882 対策）。
import { WebSocketServer } from 'ws';
import { writeEntry } from './writer.js';
import { tokenEquals } from './token.js';
import { imageUrlFor } from './image-url.js';

const MAX_PAYLOAD = 64 * 1024 * 1024; // 合成PNG(base64) + raw を許容

// inboxDir は文字列でも「現在の inbox を返す関数」でも良い。
// onHello(downloadsDir) が渡されると、push 時に拡張が報告した実ダウンロード先を採用できる。
export function attachWebSocketServer(httpServer, { inboxDir, entryStore, token, path = '/ws', onSaved, onHello } = {}) {
  const currentInbox = () => (typeof inboxDir === 'function' ? inboxDir() : inboxDir);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  const pendingRequests = new Map();
  const clients = new Set();

  wss.executeActions = (params) => {
    if (clients.size === 0) {
      return Promise.reject(new Error('No extension clients connected to daemon.'));
    }
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2) + Date.now();
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Action execution timed out (30s).'));
      }, 30000);
      const pendingRequest = {
        resolve,
        reject,
        timer,
        activeClients: new Set(),
        errors: []
      };
      pendingRequests.set(requestId, pendingRequest);
      const payload = {
        type: 'run_actions',
        requestId,
        ...params,
      };
      const serialized = JSON.stringify(payload);
      for (const client of clients) {
        try {
          client.send(serialized);
          pendingRequest.activeClients.add(client);
        } catch (e) {
          // ignore
        }
      }
      if (pendingRequest.activeClients.size === 0) {
        pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(new Error('Failed to send actions to any client.'));
      }
    });
  };

  // 拡張との橋渡し状態。healthz/preflight が「daemon は起きているが拡張がまだ一度も
  // 繋がっていない」と「繋がったことはあるが今は切れている」を区別できるようにする。
  const bridgeStatus = { connected: false, everConnected: false, lastConnectedAt: null, lastPushAt: null };
  wss.getBridgeStatus = () => ({ ...bridgeStatus });

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

  wss.on('connection', (ws, req) => {
    // 接続に使われた authority(host:port)。ack に載せる取得先 URL の host に使う（=画像配信ルートと同一サーバ）。
    const host = req?.headers?.host || '';
    clients.add(ws);
    bridgeStatus.connected = true;
    bridgeStatus.everConnected = true;
    bridgeStatus.lastConnectedAt = new Date().toISOString();
    ws.on('close', () => {
      clients.delete(ws);
      bridgeStatus.connected = (clients.size > 0);
      for (const [requestId, pendingRequest] of pendingRequests.entries()) {
        if (pendingRequest.activeClients.has(ws)) {
          pendingRequest.activeClients.delete(ws);
          if (pendingRequest.activeClients.size === 0) {
            pendingRequests.delete(requestId);
            clearTimeout(pendingRequest.timer);
            const combinedError = pendingRequest.errors.length > 0
              ? pendingRequest.errors.join('; ')
              : 'Client disconnected';
            pendingRequest.reject(new Error(`Action execution failed: ${combinedError}`));
          }
        }
      }
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid json' }));
        return;
      }
      if (msg?.type === 'run_actions_result') {
        const reqId = msg.requestId;
        if (reqId && pendingRequests.has(reqId)) {
          const deferred = pendingRequests.get(reqId);
          if (deferred.activeClients.has(ws)) {
            deferred.activeClients.delete(ws);
            if (msg.ok === true) {
              pendingRequests.delete(reqId);
              clearTimeout(deferred.timer);
              deferred.resolve(msg);
            } else {
              deferred.errors.push(msg.error || 'Action execution failed');
              if (deferred.activeClients.size === 0) {
                pendingRequests.delete(reqId);
                clearTimeout(deferred.timer);
                deferred.reject(new Error(deferred.errors.join('; ')));
              }
            }
          }
        }
        return;
      }
      // 'page_feedback' を受ける。
      if (msg?.type !== 'page_feedback') {
        ws.send(JSON.stringify({ type: 'error', error: `unknown type: ${msg?.type}` }));
        return;
      }
      try {
        // 拡張が実ダウンロード先を報告してきたら、書き込み前に inbox を合わせる（固定時は無視）。
        if (msg.downloadsDir) onHello?.(msg.downloadsDir);
        const saved = entryStore?.save ? entryStore.save(msg) : { storage: 'disk', materialized: true, ...writeEntry(currentInbox(), msg) };
        bridgeStatus.lastPushAt = new Date().toISOString();
        onSaved?.(saved);
        // パス非依存の取得先 URL を ack に併走させる（拡張サイドパネルがそのまま表示できる）。
        // token は URL に埋め込まない（取得時に ?token= を付与）。raw は payload にある時だけ広告する。
        // 注: index.js では WS と画像配信ルートが同一 token を共有するので、この URL は ?token= 付与で必ず到達できる。
        const urls = token && saved?.id
          ? {
              shotUrl: imageUrlFor(host, saved.id, 'shot'),
              ...(msg.image?.raw ? { rawUrl: imageUrlFor(host, saved.id, 'raw') } : {}),
            }
          : {};
        ws.send(JSON.stringify({ type: 'ack', ...saved, ...urls }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: String(e?.message || e) }));
      }
    });
  });

  return wss;
}
