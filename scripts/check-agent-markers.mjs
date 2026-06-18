#!/usr/bin/env node
// @agent: マーカー規約 lint（docs/agent-markers.md の正典を機械的に検証する）。
//   - 形式: ^@agent:[a-z0-9][a-z0-9./-]*$
//   - ページ(=ファイル)内で値が一意
// 対象: リポジトリ内の *.html（node_modules / .git / .claude などは除外）。
// 違反があれば exit 1（npm run check のゲートに組み込む想定）。依存ゼロ・Node 組み込みのみ。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.claude', 'daemon']);
const PATTERN = /^@agent:[a-z0-9][a-z0-9./-]*$/;
const ATTR = /data-agent-id="([^"]*)"/g;

function walkHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkHtml(p, out);
    else if (extname(p) === '.html') out.push(p);
  }
  return out;
}

let errors = 0;
let total = 0;
let files = 0;

for (const file of walkHtml(ROOT)) {
  const text = readFileSync(file, 'utf8');
  const seen = new Set();
  let m;
  let hadMarker = false;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(text)) !== null) {
    const val = m[1];
    if (!val.startsWith('@agent:')) continue; // data-agent-id は @agent: 値のみ規約対象
    hadMarker = true;
    total++;
    const rel = relative(ROOT, file);
    if (!PATTERN.test(val)) {
      console.error(`✗ ${rel}: 形式違反 "${val}"  (規約 ^@agent:[a-z0-9][a-z0-9./-]*$)`);
      errors++;
    }
    if (seen.has(val)) {
      console.error(`✗ ${rel}: 重複 "${val}"  (同一ページ内で一意であること)`);
      errors++;
    } else {
      seen.add(val);
    }
  }
  if (hadMarker) files++;
}

if (errors) {
  console.error(`\n@agent マーカー lint: ${errors} 件の違反（${files} ファイル / ${total} マーカーを検査）`);
  process.exit(1);
}
console.log(`@agent マーカー lint OK（${files} ファイル / ${total} マーカー、形式・ページ内一意ともに問題なし）`);
