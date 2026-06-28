#!/usr/bin/env node
// 「コードを直したら関連ドキュメント(用語)を更新する」を機械的に強制する核。依存ゼロ。
//
// 仕組み: 変更されたコードの行範囲が、ある用語の `@term:` ガード範囲に重なったら、
//   その用語エントリの `last_verified` が *同じ変更の中で前進している* ことを要求する。
//   前進していなければ「コードを変えたのに用語を再検証していない」とみなして exit 1。
//   → ドキュメントの陳腐化(drift)を「検出可能 + 重要箇所は強制」する。
//
// 使い方:
//   node scripts/glossary/check-staleness.mjs --staged          # pre-commit(index vs HEAD)
//   node scripts/glossary/check-staleness.mjs --working         # ローカル確認(worktree vs HEAD)
//   node scripts/glossary/check-staleness.mjs --base origin/main # PR/CI(HEAD vs merge-base)
//   既定は --base origin/main(無ければ main)。

import { parseFrontmatter } from './lib/frontmatter.mjs';
import { parseMarkers, termsTouchedByRanges } from './lib/markers.mjs';
import { MARKER_ROOTS } from './lib/code.mjs';
import { loadEntries, indexById } from './lib/entries.mjs';
import { createGitContext } from './lib/git.mjs';

const ROOT = process.cwd();

function parseArgs(argv) {
  let mode = 'base';
  let ref = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') mode = 'staged';
    else if (a === '--working') mode = 'working';
    else if (a === '--base') { mode = 'base'; ref = argv[++i] || null; }
  }
  return { mode, ref };
}

function isCodeFile(path) {
  if (!/\.(js|mjs)$/.test(path)) return false;
  return MARKER_ROOTS.some((r) => path === r || path.startsWith(`${r}/`));
}

function lastVerifiedOf(content) {
  if (content == null) return null;
  try {
    return parseFrontmatter(content).data.last_verified ?? null;
  } catch {
    return null;
  }
}

function main() {
  const { mode, ref: refArg } = parseArgs(process.argv.slice(2));
  let ref = refArg;
  if (mode === 'base' && !ref) ref = 'origin/main'; // 既定の base(無ければ git.mjs が ref をそのまま使う)
  const ctx = createGitContext(mode, ref, ROOT);

  let byId;
  try {
    byId = indexById(loadEntries(ROOT));
  } catch (e) {
    console.error(`✗ 用語集の読み込みに失敗(先に validate を通してください): ${e.message}`);
    process.exit(1);
  }

  const changed = ctx.changedFiles();
  const codeChanged = changed.filter(isCodeFile);

  // 変更コード → 触れられた用語 id(+ どのファイルで触れたか)
  const touchedByTerm = new Map(); // id -> Set(path)
  for (const path of codeChanged) {
    const content = ctx.newContent(path);
    if (content == null) continue; // 削除など
    const { markers } = parseMarkers(content);
    if (!markers.length) continue;
    const ranges = ctx.newRanges(path);
    if (!ranges.length) continue;
    for (const id of termsTouchedByRanges(markers, ranges)) {
      if (!touchedByTerm.has(id)) touchedByTerm.set(id, new Set());
      touchedByTerm.get(id).add(path);
    }
  }

  const errors = [];
  for (const [id, paths] of [...touchedByTerm].sort()) {
    const entry = byId.get(id);
    if (!entry) {
      errors.push(`✗ @term: "${id}" が変更されましたが、対応する用語エントリがありません(${[...paths].join(', ')})`);
      continue;
    }
    const baseVerified = lastVerifiedOf(ctx.baseContent(entry.relPath));
    const newVerified = lastVerifiedOf(ctx.newContent(entry.relPath));
    if (newVerified == null) {
      errors.push(`✗ ${entry.relPath}: last_verified を読めません`);
      continue;
    }
    // base に存在しない(=この変更で新規追加された)用語は OK。
    if (baseVerified == null) continue;
    if (String(newVerified) <= String(baseVerified)) {
      errors.push(
        `✗ 用語 "${id}" のガード範囲(${[...paths].join(', ')})が変更されましたが、` +
        `${entry.relPath} の last_verified が更新されていません(現在 ${newVerified})。\n` +
        `   → 内容を確認し  node scripts/glossary/touch.mjs ${id}  で last_verified を今日に更新してください。`
      );
    }
  }

  if (errors.length) {
    console.error(`用語 staleness チェック [${ctx.label}]:`);
    for (const e of errors) console.error(e);
    console.error(`\n${errors.length} 件: コード変更に対して用語の再検証が必要です。`);
    process.exit(1);
  }
  const n = touchedByTerm.size;
  console.log(`用語 staleness チェック OK [${ctx.label}](変更コード ${codeChanged.length} 件、関係用語 ${n} 件は再検証済み)`);
}

main();
