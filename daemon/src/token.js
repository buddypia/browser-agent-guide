// 共有トークンの生成・永続・検証。
// 拡張↔デーモンの WebSocket 認証用（CVE-2025-52882: localhost WS は悪性 Web ページが
// 接続しうるため、秘密トークンで拡張だけを許可する）。トークンは out-of-band で
// （起動時 stderr に表示 → ユーザーが拡張オプションに貼る）渡す。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export function tokenPath() {
  return join(homedir(), '.bag-pf', 'token');
}

function readTokenFile(p) {
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

// 優先順: 明示指定 > 環境変数(新 BAG_PF_) > 永続ファイル(新) > 新規生成(0600で保存)。
export function loadOrCreateToken(explicit) {
  if (explicit) return String(explicit);
  if (process.env.BAG_PF_TOKEN) return process.env.BAG_PF_TOKEN;
  const p = tokenPath();
  const current = readTokenFile(p);
  if (current) return current;
  const token = randomBytes(24).toString('base64url');
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, token, { mode: 0o600 });
    chmodSync(p, 0o600);
  } catch {
    /* 保存失敗でもプロセス内では使える */
  }
  return token;
}

// 長さリークを避けつつ定数時間比較する。
export function tokenEquals(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length === 0 || bb.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
