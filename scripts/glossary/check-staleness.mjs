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

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { parseMarkers, termsTouchedByRanges } from './lib/markers.mjs';
import { MARKER_ROOTS } from './lib/code.mjs';
import { loadEntries, indexById } from './lib/entries.mjs';
import { createGitContext } from './lib/git.mjs';

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

function bodyOf(content) {
  try {
    return parseFrontmatter(content).body;
  } catch {
    return content;
  }
}

// iso 日付がいま(どのタイムゾーンでも)「今日」でありうるか。touch はローカル日付、CI は UTC で動くので
// 日付の正午 UTC から ±36h を今日とみなす。テストは GLOSSARY_TODAY=YYYY-MM-DD で固定する。
function isToday(iso, env = process.env) {
  const fixed = env.GLOSSARY_TODAY;
  const now = fixed ? Date.parse(`${fixed}T12:00:00Z`) : Date.now();
  const d = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(d) && Math.abs(now - d) <= 36 * 3600 * 1000;
}

export function checkStaleness({ cwd = process.cwd(), argv = [], env = process.env } = {}) {
  const { mode, ref: refArg } = parseArgs(argv);
  let ref = refArg;
  if (mode === 'base' && !ref) ref = 'origin/main'; // 既定の base(無ければ git.mjs が ref をそのまま使う)
  const ctx = createGitContext(mode, ref, cwd);

  const changed = ctx.changedFiles();
  const codeChanged = changed.filter(isCodeFile);

  // Fast-path: 変更コードが無ければ用語集のロード自体をスキップする。
  if (codeChanged.length === 0) {
    return {
      code: 0,
      out: `用語 staleness チェック OK [${ctx.label}](変更コード 0 件、関係用語 0 件は再検証済み)\n`,
    };
  }

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

  if (touchedByTerm.size === 0) {
    return {
      code: 0,
      out: `用語 staleness チェック OK [${ctx.label}](変更コード ${codeChanged.length} 件、関係用語 0 件は再検証済み)\n`,
    };
  }

  let byId;
  try {
    byId = indexById(loadEntries(cwd));
  } catch (e) {
    return {
      code: 1,
      out: `✗ 用語集の読み込みに失敗(先に validate を通してください): ${e.message}\n`,
    };
  }

  const errors = [];
  for (const [id, paths] of [...touchedByTerm].sort()) {
    const entry = byId.get(id);
    if (!entry) {
      errors.push(`✗ @term: "${id}" が変更されましたが、対応する用語エントリがありません(${[...paths].join(', ')})`);
      continue;
    }
    const baseEntry = ctx.baseContent(entry.relPath);
    const newEntry = ctx.newContent(entry.relPath);
    const baseVerified = lastVerifiedOf(baseEntry);
    const newVerified = lastVerifiedOf(newEntry);
    if (newVerified == null) {
      errors.push(`✗ ${entry.relPath}: last_verified を読めません`);
      continue;
    }
    // base に存在しない(=この変更で新規追加された)用語は OK。
    if (baseVerified == null) continue;
    // 日付は1日単位なので、base が今日の日付だと2度目の変更では前進させられない(touch しても差分が出ず、
    // ゲートを通す手段が無くなる)。その時に限り、同じ変更で本文を書き直したことを再検証とみなす。
    // 古い日付のままの本文修正は通さない(前進させれば済むので、例外にすると抜け穴になる)。
    const advanced = String(newVerified) > String(baseVerified);
    const sameDayRevised =
      String(newVerified) === String(baseVerified) &&
      isToday(String(newVerified), env) &&
      bodyOf(newEntry) !== bodyOf(baseEntry);
    if (!advanced && !sameDayRevised) {
      errors.push(
        `✗ 用語 "${id}" のガード範囲(${[...paths].join(', ')})が変更されましたが、` +
        `${entry.relPath} の last_verified が更新されていません(現在 ${newVerified})。\n` +
        `   → 内容を確認し  node scripts/glossary/touch.mjs ${id}  で last_verified を今日に更新してください(base が既に今日の日付なら、本文を実装に合わせて直せば通ります)。`
      );
    }
  }

  if (errors.length) {
    const lines = [
      `用語 staleness チェック [${ctx.label}]:`,
      ...errors,
      `\n${errors.length} 件: コード変更に対して用語の再検証が必要です。`,
    ];
    return { code: 1, out: `${lines.join('\n')}\n` };
  }
  const n = touchedByTerm.size;
  return {
    code: 0,
    out: `用語 staleness チェック OK [${ctx.label}](変更コード ${codeChanged.length} 件、関係用語 ${n} 件は再検証済み)\n`,
  };
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const { code, out } = checkStaleness({ cwd: process.cwd(), argv: process.argv.slice(2), env: process.env });
  if (code !== 0) {
    process.stderr.write(out);
    process.exit(code);
  }
  process.stdout.write(out);
}
