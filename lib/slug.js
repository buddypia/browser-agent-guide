// ページフィードバックのフォルダー名(slug)を生成する共有ロジック。
// 形式: {日時}__{ホスト}__{タイトル}__{ID}
//   例: 20260618-102900__example-com__sales-dashboard-acme__1kfqbxu
//
// !!! 重要 !!!
// このファイルは拡張(lib/slug.js)とデーモン(daemon/src/slug.js)へ「同一内容」で複製されている。
// 2つは別 npm プロジェクトで共有 import ができないため、片方を直したら必ずもう片方も同じに直すこと。
// 同じ {capturedAt,url,title} から両者が同一フォルダー名を生成することを test/slug.test.mjs が保証する。
//
// 設計メモ:
// - 区切り '__' は各セグメント内に決して現れない(sanitizeToken が連続非英数を1つの '-' に畳むため)。
// - 全セグメントは [a-z0-9-] のみ → chrome.downloads / Windows / 各FS のサニタイズや予約名に安全。
// - ID は同期ハッシュ(FNV-1a)。crypto.subtle は SW で非同期のみ＝slug 生成を async 化してしまうため不可。
// - 日時はローカル時刻の固定長 YYYYMMDD-HHMMSS なので、辞書順ソート == 時系列。

// 任意文字列を [a-z0-9-] のトークンへ畳み込む。maxLen 指定時は末尾の '-' を残さず切り詰める。
export function sanitizeToken(str, maxLen) {
  let t = String(str == null ? '' : str)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (maxLen && t.length > maxLen) t = t.slice(0, maxLen).replace(/-+$/g, '');
  return t;
}

// capturedAt(ISO) → ローカル時刻の YYYYMMDD-HHMMSS。不正な入力は固定値にフォールバック。
export function stampFromIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '00000000-000000';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// URL → サイト識別子セグメント(www. 除去・ドット→ハイフン・30字上限)。解析不能なら 'site'。
export function hostSlug(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return sanitizeToken(host.replace(/^www\./, '').replace(/\./g, '-'), 30) || 'site';
}

// FNV-1a 32bit(Math.imul + UTF-8 バイト)。SW(TextEncoder) と Node(TextEncoder) でバイト一致＝決定的。
export function shortHash(input) {
  const bytes = new TextEncoder().encode(String(input == null ? '' : input));
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(-7);
}

// {日時}__{ホスト}__{タイトル}__{ID} を生成する。
export function slugFromCapture({ capturedAt, url, title } = {}) {
  return [
    stampFromIso(capturedAt),
    hostSlug(url),
    sanitizeToken(title, 24) || 'untitled',
    shortHash(`${capturedAt || ''}\n${url || ''}`),
  ].join('__');
}
