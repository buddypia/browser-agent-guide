// inbox スキャナ + MCP content ビルダー。
// ブラウザ拡張（MVP）が保存した視覚フィードバックを読み、AI コーディング CLI へ
// 「image(PNG) + ファイルパス」の両方で返すための土台。DOM/ネットワークに依存しない純粋寄りモジュール。
//
// inbox レイアウト（拡張 §4.3 と同一）:
//   <inboxDir>/<slug>/shot.png        # 注釈 burn-in 済み（vision 1次）
//                     raw.png         # 元スクショ（任意）
//                     annotation.json # 座標/selector/intent
//                     memo.md         # 人間可読

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

export const SHOT = 'shot.png';
export const RAW = 'raw.png';
export const ANNOTATION = 'annotation.json';
export const MEMO = 'memo.md';

// Windows の「Downloads」既知フォルダー GUID（移動済み時はレジストリにこの名前で絶対パスが入る）。
const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';

// Windows: レジストリから実 Downloads パスを読む（移動/OneDrive バックアップ対応）。無ければ null。
// 'Shell Folders'(REG_SZ=解決済み) を優先し、'User Shell Folders'(REG_EXPAND_SZ=%VAR% 入り) を後段に。
function downloadsFromWindowsRegistry() {
  for (const key of ['Shell Folders', 'User Shell Folders']) {
    try {
      const out = execFileSync(
        'reg',
        ['query', `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\${key}`, '/v', DOWNLOADS_GUID],
        { encoding: 'utf8', timeout: 2000, windowsHide: true }
      );
      // REG_SZ は解決済みなので %VAR% 展開しない（パスに literal '%' があっても壊さない）。
      // REG_EXPAND_SZ のみ %VAR% を展開し、未解決の %...% が残れば不採用にする。
      const m = out.match(/(REG_(?:EXPAND_)?SZ)\s+(.+?)\s*$/m);
      if (m) {
        if (m[1] === 'REG_EXPAND_SZ') {
          const expanded = m[2].replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
          if (expanded && !expanded.includes('%')) return expanded;
        } else {
          const val = m[2].trim();
          if (val) return val;
        }
      }
    } catch {
      /* 値が無い(クリーンインストール既定)/reg 不在 → 次のキーやフォールバックへ */
    }
  }
  return null;
}

// Linux: XDG から実 Downloads パスを得る。無ければ null。
function downloadsFromXdg() {
  // 1) xdg-user-dir DOWNLOAD（引数はハードコード必須。内部で eval されるため外部入力厳禁）。
  try {
    const out = execFileSync('xdg-user-dir', ['DOWNLOAD'], { encoding: 'utf8', timeout: 2000 })
      .trim()
      .replace(/\/+$/, '');
    if (out && out !== homedir()) return out;
  } catch {
    /* 未インストール(headless 等) → user-dirs.dirs を直接読む */
  }
  // 2) ${XDG_CONFIG_HOME:-~/.config}/user-dirs.dirs を直接パース（$HOME 展開のみ）。
  try {
    const cfg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const text = readFileSync(join(cfg, 'user-dirs.dirs'), 'utf8');
    const m = text.match(/^\s*XDG_DOWNLOAD_DIR="?(.+?)"?\s*$/m);
    if (m) {
      // 末尾スラッシュを除いてから homedir 等価判定（"$HOME/" を Downloads と誤認しない）。
      const v = m[1].replace(/^\$\{?HOME\}?/, homedir()).replace(/\/+$/, '');
      if (v && v !== homedir()) return v;
    }
  } catch {
    /* 無ければ OS 既定へフォールバック */
  }
  return null;
}

// OS のダウンロードフォルダーを解決する。検出失敗時は <homedir>/Downloads。
// 注意: chrome.downloads の実保存先は「ブラウザ設定」依存で、OS の Downloads と必ずしも一致しない
// （ユーザーが変更/Edge・Brave 等）。その差は拡張からの downloadsDir ハンドシェイクで埋める。
export function resolveDownloadsDir() {
  let detected = null;
  try {
    if (platform() === 'win32') detected = downloadsFromWindowsRegistry();
    else if (platform() === 'linux') detected = downloadsFromXdg();
    // darwin: ~/Downloads（ディスク上の実名は常に英語 'Downloads'。ローカライズは表示のみ）。
  } catch {
    detected = null;
  }
  return detected || join(homedir(), 'Downloads');
}

// 既定 inbox は <検出した Downloads>/ai-inbox（拡張のフォールバック保存先に合わせる）。
export function defaultInboxDir() {
  return join(resolveDownloadsDir(), 'ai-inbox');
}

// 拡張が報告した downloadsDir から「採用してよい inbox」を計算する。採用不可なら null。
// 安全境界: 採用先はユーザーのホーム配下に限定する（WS トークンが漏れても書き込み範囲を絞る）。
// ホーム外に Downloads を置くケース（例: Windows で D:\Downloads）は --inbox / BAG_VF_INBOX の明示指定を使う。
export function inboxFromDownloadsDir(downloadsDir, { home = homedir() } = {}) {
  if (!downloadsDir || typeof downloadsDir !== 'string' || !isAbsolute(downloadsDir)) return null;
  const candidate = resolve(join(downloadsDir, 'ai-inbox'));
  const root = resolve(home);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

export function resolveInboxDir(p) {
  if (!p) return defaultInboxDir();
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// inbox 配下の <slug>/（shot.png を持つもの）を新しい順に列挙する。done/ は除外。
export function listEntries(inboxDir, limit = 20) {
  if (!inboxDir || !existsSync(inboxDir)) return [];
  let dirents;
  try {
    dirents = readdirSync(inboxDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name === 'done') continue;
    const dir = join(inboxDir, d.name);
    const shot = join(dir, SHOT);
    if (!existsSync(shot)) continue;
    let mtime = 0;
    try {
      mtime = statSync(shot).mtimeMs;
    } catch {
      /* stat 失敗は 0 のまま */
    }
    entries.push({ id: d.name, dir, shot, mtime });
  }
  entries.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? 1 : -1));
  return entries.slice(0, Math.max(1, limit));
}

export function findEntry(inboxDir, id, scan = 500) {
  return listEntries(inboxDir, scan).find((e) => e.id === id) || null;
}

// annotation の url/title が部分一致するか（複数プロジェクトが1つの inbox に積まれる時の絞り込み）。
// urlContains/titleContains は大文字小文字を無視する部分一致。未指定の条件は素通し。
export function matchesFilter(annotation, { urlContains, titleContains } = {}) {
  if (urlContains) {
    const u = String(annotation?.url || '').toLowerCase();
    if (!u.includes(String(urlContains).toLowerCase())) return false;
  }
  if (titleContains) {
    const t = String(annotation?.title || '').toLowerCase();
    if (!t.includes(String(titleContains).toLowerCase())) return false;
  }
  return true;
}

// 新しい順スキャン + url/title フィルタ。each entry に {url,title} メタを付けて返す。
export function queryEntries(inboxDir, { urlContains, titleContains, limit = 20, scan = 500 } = {}) {
  const out = [];
  for (const e of listEntries(inboxDir, scan)) {
    const annotation = readAnnotation(e.dir);
    if (!matchesFilter(annotation, { urlContains, titleContains })) continue;
    out.push({ ...e, url: annotation?.url || '', title: annotation?.title || '' });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

export function readAnnotation(dir) {
  const p = join(dir, ANNOTATION);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// MCP tool 用の content[] を組み立てる。image を見られない CLI でも text の file_path で
// vision できるよう、必ず image と file_path の両方を返す（handoff §3.2 = fallback 内蔵）。
export function buildEntryContent(entry, { includeImage = true } = {}) {
  const annotation = readAnnotation(entry.dir);
  const content = [];
  if (includeImage) {
    const data = readFileSync(entry.shot).toString('base64');
    content.push({ type: 'image', data, mimeType: 'image/png' });
  }
  content.push({ type: 'text', text: buildEntryText(entry, annotation) });
  return content;
}

// image と並走させるテキスト。先頭に絶対パス、続いて指示一覧（selector/intent）。
export function buildEntryText(entry, annotation) {
  const lines = [];
  lines.push(`file_path: ${entry.shot}`);
  if (annotation?.url) lines.push(`url: ${annotation.url}`);
  if (annotation?.title) lines.push(`title: ${annotation.title}`);
  if (annotation?.capturedAt) lines.push(`captured_at: ${annotation.capturedAt}`);
  const items = Array.isArray(annotation?.items) ? annotation.items : [];
  if (items.length) {
    lines.push('annotations:');
    for (const it of items) {
      const n = it.n != null ? it.n : '?';
      const memo = String(it.note || '').trim() || it.shapeText || '(メモなし)';
      const intent = String(it.intent || '').trim();
      const where = it.anchorLabel ? ` target="${it.anchorLabel}"` : '';
      const sel = it.selector ? ` selector="${it.selector}"` : '';
      const off = it.inViewport === false ? ' (画面外)' : '';
      lines.push(`  ${n}. ${memo}${intent ? ` / intent: ${intent}` : ''}${where}${sel}${off}`);
    }
  }
  lines.push('');
  lines.push(
    '上の image を vision で解釈してください（テキスト座標ではなく絵そのものを見る）。' +
      'image を読めない場合は file_path の PNG を開いてください。各注釈は画像中の丸数字①②…と対応します。'
  );
  return lines.join('\n');
}
