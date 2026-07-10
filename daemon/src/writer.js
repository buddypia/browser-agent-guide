// WebSocket で受け取ったページフィードバックを inbox に書き出す。
// MVP(chrome.downloads)と同じレイアウト: <inbox>/<slug>/{shot.png,raw.png,annotation.json,memo.md}
// 原子的書き込み(tmp→rename) + 0600。slug はサーバ側で生成し、クライアントのパスは信用しない（traversal 防止）。
import { writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { slugFromCapture } from './slug.js';

// inbox 配下に未使用の <slug>/ を確保する（衝突時は -2, -3…）。
function uniqueDir(inboxDir, slug) {
  let name = slug;
  let n = 2;
  while (existsSync(join(inboxDir, name))) {
    name = `${slug}-${n}`;
    n += 1;
  }
  return { name, dir: join(inboxDir, name) };
}

function writeAtomic(dir, filename, buffer) {
  const target = join(dir, filename);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, buffer, { mode: 0o600 });
  renameSync(tmp, target);
}

export function decodeBase64(data) {
  if (!data) return null;
  // data URL（png/webp/jpeg いずれの image/* も）でも生 base64 でも受ける。
  const b64 = String(data).replace(/^data:image\/[a-z+]+;base64,/, '');
  return Buffer.from(b64, 'base64');
}

// MCP inline 用コンパクト変種のディスク上ファイル名を mimeType から決める（1 か所に集約）。
// inbox.js の readEntryInline の probe 順とこのマッピングが対になっている。未知 mime は null（書かない）。
export function inlineFilename(mime) {
  if (mime === 'image/webp') return 'shot.inline.webp';
  if (mime === 'image/jpeg') return 'shot.inline.jpg';
  return null;
}

/**
 * 受信ペイロードを inbox に保存する。
 * @param {string} inboxDir
 * @param {{capturedAt?:string,url?:string,title?:string,dpr?:number,viewport?:object,
 *          image?:{shot?:string,raw?:string}, annotation?:object, memo?:string}} payload
 * @returns {{id:string, dir:string, files:string[]}}
 */
export function writeEntry(inboxDir, payload, { now, id } = {}) {
  const shot = decodeBase64(payload?.image?.shot);
  if (!shot || !shot.length) throw new Error('image.shot (base64 PNG) が必要です。');
  const capturedAt = payload?.capturedAt || payload?.annotation?.capturedAt || now || new Date().toISOString();
  // フォルダー名は {日時}__{ホスト}__{タイトル}__{ID}。url/title はペイロード(または annotation)から取る。
  const url = payload?.url || payload?.annotation?.url || '';
  const title = payload?.title || payload?.annotation?.title || '';
  const slug = id || slugFromCapture({ capturedAt, url, title });
  if (/[\\/]/.test(slug) || slug === '.' || slug === '..') throw new Error('invalid entry id');
  mkdirSync(inboxDir, { recursive: true });
  const { name, dir } = id ? { name: slug, dir: join(inboxDir, slug) } : uniqueDir(inboxDir, slug);
  if (id && existsSync(dir)) throw new Error(`entry already exists: ${slug}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  try {
    writeAtomic(dir, 'shot.png', shot);
    files.push('shot.png');
    // MCP inline 専用のコンパクト変種（WebP/JPEG）。disk/hybrid で daemon 再起動後も
    // Claude Code に小さい inline を返せるよう shot.png の隣に永続する（フル解像度は shot.png のまま）。
    const inline = decodeBase64(payload?.image?.inline);
    const inlineName = inlineFilename(payload?.image?.inlineMime);
    if (inline && inline.length && inlineName) {
      writeAtomic(dir, inlineName, inline);
      files.push(inlineName);
    }
    const raw = decodeBase64(payload?.image?.raw);
    if (raw && raw.length) {
      writeAtomic(dir, 'raw.png', raw);
      files.push('raw.png');
    }
    if (payload?.annotation) {
      writeAtomic(dir, 'annotation.json', Buffer.from(JSON.stringify(payload.annotation, null, 2), 'utf8'));
      files.push('annotation.json');
    }
    if (payload?.memo) {
      writeAtomic(dir, 'memo.md', Buffer.from(String(payload.memo), 'utf8'));
      files.push('memo.md');
    }
  } catch (e) {
    // 途中失敗したエントリは中途半端に残さない。
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 後始末失敗は無視 */
    }
    throw e;
  }
  return { id: name, dir, files };
}
