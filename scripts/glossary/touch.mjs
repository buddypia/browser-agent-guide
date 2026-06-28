#!/usr/bin/env node
// 用語の last_verified を今日(ローカル日付)へ更新する補助。依存ゼロ。
// 使い方: node scripts/glossary/touch.mjs <id> [<id> ...]   /   --all
// staleness チェックで「再検証が必要」と言われた用語の last_verified を素早く前進させる。

import { readFileSync, writeFileSync } from 'node:fs';
import { loadEntries, indexById } from './lib/entries.mjs';

const ROOT = process.cwd();

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function bump(entry, date) {
  const text = readFileSync(entry.path, 'utf8');
  if (!/^last_verified:\s*.*$/m.test(text)) {
    throw new Error(`${entry.relPath}: last_verified 行が見つかりません`);
  }
  const next = text.replace(/^last_verified:\s*.*$/m, `last_verified: ${date}`);
  if (next === text) return false;
  writeFileSync(entry.path, next);
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const byId = indexById(loadEntries(ROOT));
  const date = today();
  let ids = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--all')) ids = [...byId.keys()];
  if (!ids.length) {
    console.error('使い方: node scripts/glossary/touch.mjs <id> [<id> ...]  |  --all');
    process.exit(2);
  }
  let n = 0;
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) { console.error(`✗ 用語 "${id}" がありません`); process.exitCode = 1; continue; }
    if (bump(entry, date)) { console.log(`✓ ${entry.relPath}: last_verified = ${date}`); n++; }
    else console.log(`- ${entry.relPath}: 既に ${date}`);
  }
  console.log(`\n${n} 件の last_verified を ${date} に更新しました。`);
}

main();
