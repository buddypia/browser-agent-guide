// プロダクトコードを走査して `@term:` マーカーを集める。依存ゼロ。
// マーカーが置かれるのは製品コードのみ。ツール自身(scripts/glossary, test)や docs は
// 走査対象から外す(それらは `@term:` という *文字列* を正当に含むため誤検出を避ける)。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { parseMarkers } from './markers.mjs';

// 製品コードのルート(ここだけを走査する)。
export const MARKER_ROOTS = [
  'content', 'background', 'sidepanel', 'options', 'offscreen', 'lib', 'daemon/src',
];
const CODE_EXT = new Set(['.js', '.mjs']);

function walk(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (CODE_EXT.has(extname(p))) out.push(p);
  }
  return out;
}

// 返り値: [{ relPath, markers, errors }]
export function scanCodeMarkers(root = process.cwd()) {
  const results = [];
  for (const r of MARKER_ROOTS) {
    for (const file of walk(join(root, r))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('@term:')) continue;
      const { markers, errors } = parseMarkers(text);
      results.push({ relPath: relative(root, file), markers, errors });
    }
  }
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
