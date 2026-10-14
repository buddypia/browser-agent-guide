// worktree-new の依存導入(Step 4b)の contract test。
//
// Why: 新しい worktree には node_modules が無く、`npm run check` が「パッケージが無い」で落ちて
//   AI が自分の変更の不具合と誤認した(2026-10-13)。wt.new が依存の無い npm プロジェクトにだけ
//   `npm ci` を流し、失敗は warning に留める(worktree 作成自体は成功させる)ことを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { npmProjectsMissingDeps } from '../../worktree-new.mjs';

const WT = '/repo/.worktrees/feature/x';

function fs(files) {
  const set = new Set(files.map((f) => join(WT, f)));
  return {
    existsFn: (p) => set.has(p),
    readdirFn: () => ['daemon', 'lib', 'node_modules', '.claude'],
  };
}

test('root と直下の子のうち package-lock.json があり node_modules が無いものだけを返す', () => {
  const dirs = npmProjectsMissingDeps(WT, fs(['package-lock.json', 'daemon/package-lock.json']));
  assert.deepEqual(dirs, [WT, join(WT, 'daemon')]);
});

test('node_modules があるプロジェクトは入れ直さない(冪等)', () => {
  const dirs = npmProjectsMissingDeps(WT, fs(['package-lock.json', 'node_modules', 'daemon/package-lock.json']));
  assert.deepEqual(dirs, [join(WT, 'daemon')]);
});

test('lockfile の無いディレクトリ・node_modules・dot ディレクトリは対象外', () => {
  const dirs = npmProjectsMissingDeps(WT, fs(['lib/x.js', 'node_modules/package-lock.json', '.claude/package-lock.json']));
  assert.deepEqual(dirs, []);
});

test('子ディレクトリを読めなくても root は判定する', () => {
  const dirs = npmProjectsMissingDeps(WT, {
    existsFn: (p) => p === join(WT, 'package-lock.json'),
    readdirFn: () => {
      throw new Error('EACCES');
    },
  });
  assert.deepEqual(dirs, [WT]);
});
