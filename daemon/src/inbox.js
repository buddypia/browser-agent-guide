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
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export const SHOT = 'shot.png';
export const RAW = 'raw.png';
export const ANNOTATION = 'annotation.json';
export const MEMO = 'memo.md';

// MVP は chrome.downloads で ~/Downloads/ai-inbox/ に保存するため、これを既定にする。
export function defaultInboxDir() {
  return join(homedir(), 'Downloads', 'ai-inbox');
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
