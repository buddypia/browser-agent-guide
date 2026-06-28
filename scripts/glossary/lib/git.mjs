// staleness チェック用の最小 git ヘルパー。依存ゼロ(child_process のみ)。
//
// 3 つの比較モードを「new 側 / base 側 / 変更行範囲」の抽象で統一する:
//   working  : new=作業ツリー        base=HEAD            (ローカルの素早い確認)
//   staged   : new=index(--cached)   base=HEAD            (pre-commit hook)
//   base:REF : new=HEAD              base=merge-base(REF) (PR/CI、REF は通常 origin/main)

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// 失敗を null で吸収する版。git の stderr(存在しない ref など)は抑制する。
function gitMaybe(args, root) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return null; }
}

// `git show <ref>:<path>` 。存在しなければ null。
function showFile(ref, path, root) {
  return gitMaybe(['show', `${ref}:${path}`], root);
}

// `@@ -a,b +c,d @@` ヘッダから new 側の変更行範囲を取り出す(--unified=0 前提)。
function parseHunks(diffText) {
  const ranges = [];
  if (!diffText) return ranges;
  for (const line of diffText.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    if (count === 0) continue; // 純粋な削除(new 側に行が無い)はガード範囲に影響しない
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

export function createGitContext(mode, ref, root = process.cwd()) {
  if (mode === 'base') {
    const mb = (gitMaybe(['merge-base', ref, 'HEAD'], root) || ref).trim();
    return {
      mode,
      label: `base:${ref} (merge-base ${mb.slice(0, 9)})`,
      changedFiles() {
        const out = gitMaybe(['diff', '--name-only', `${ref}...HEAD`], root) || '';
        return out.split(/\r?\n/).filter(Boolean);
      },
      newContent(path) { return showFile('HEAD', path, root); },
      baseContent(path) { return showFile(mb, path, root); },
      newRanges(path) {
        return parseHunks(gitMaybe(['diff', '--unified=0', `${ref}...HEAD`, '--', path], root));
      },
    };
  }
  if (mode === 'staged') {
    return {
      mode,
      label: 'staged (index vs HEAD)',
      changedFiles() {
        const out = gitMaybe(['diff', '--cached', '--name-only'], root) || '';
        return out.split(/\r?\n/).filter(Boolean);
      },
      newContent(path) { return showFile('', path, root); }, // `git show :path` = index
      baseContent(path) { return showFile('HEAD', path, root); },
      newRanges(path) {
        return parseHunks(gitMaybe(['diff', '--cached', '--unified=0', '--', path], root));
      },
    };
  }
  // working
  return {
    mode: 'working',
    label: 'working (worktree vs HEAD)',
    changedFiles() {
      const out = gitMaybe(['diff', '--name-only', 'HEAD'], root) || '';
      return out.split(/\r?\n/).filter(Boolean);
    },
    newContent(path) {
      const abs = `${root}/${path}`;
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    },
    baseContent(path) { return showFile('HEAD', path, root); },
    newRanges(path) {
      return parseHunks(gitMaybe(['diff', '--unified=0', 'HEAD', '--', path], root));
    },
  };
}
