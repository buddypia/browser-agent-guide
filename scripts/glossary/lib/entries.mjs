// glossary/ 配下の用語エントリ(*.md)を走査して読み込むユーティリティ。依存ゼロ。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';

export const GLOSSARY_DIR = 'glossary';

// glossary/ 配下の用語ファイル(*.md)。先頭が '_' のファイル(_schema.md 等)と
// 自動生成物(TRACEABILITY.md)・README は用語エントリではないので除外する。
function isEntryFile(name) {
  if (!name.endsWith('.md')) return false;
  if (name.startsWith('_')) return false;
  if (name === 'README.md' || name === 'TRACEABILITY.md') return false;
  return true;
}

export function listEntryFiles(root = process.cwd()) {
  const base = join(root, GLOSSARY_DIR);
  const out = [];
  function walk(dir) {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (isEntryFile(name)) out.push(p);
    }
  }
  walk(base);
  return out.sort();
}

// 全エントリを読み込んで {id, path, relPath, data, body} の配列で返す。
// パースエラーは file を添えて再 throw する(どのエントリが壊れているか分かるように)。
export function loadEntries(root = process.cwd()) {
  const files = listEntryFiles(root);
  const entries = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = parseFrontmatter(text);
    } catch (e) {
      throw new Error(`${relative(root, file)}: ${e.message}`);
    }
    entries.push({
      id: parsed.data.id,
      path: file,
      relPath: relative(root, file),
      data: parsed.data,
      body: parsed.body,
    });
  }
  return entries;
}

// id -> entry の索引を作る。重複 id があれば throw(用語集の不変条件)。
export function indexById(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.id == null || e.id === '') {
      throw new Error(`${e.relPath}: 'id' が空です`);
    }
    if (map.has(e.id)) {
      throw new Error(`id 重複: "${e.id}" (${map.get(e.id).relPath} と ${e.relPath})`);
    }
    map.set(e.id, e);
  }
  return map;
}
