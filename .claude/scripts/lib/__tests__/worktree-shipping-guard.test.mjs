// worktree-shipping-guard の Stop メッセージ contract test。
//
// Why: このガードはテストが無く、PLAN.md 前提の指示(廃止済みゲート)や、既定経路(make ship)と食い違う
//   手動 merge の案内、`cd` + 相対パスの例を出し続けていた。案内が既定の出荷経路と一致することを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.__HOOK_ORCHESTRATOR__ = true;
const { buildBlockMessage, evaluate } = await import('../../../hooks/worktree-shipping-guard.mjs');

test('Stop メッセージ: commit 済みは make ship、未 commit は git -C で commit を案内し、PLAN.md に触れない', () => {
  const root = '/repo';
  const msg = buildBlockMessage(root, [
    { path: '/repo/.worktrees/fix/a', branch: 'fix/a', commits: 2, uncommitted: 0, commit_required: false },
    { path: '/repo/.worktrees/fix/b', branch: 'fix/b', commits: 0, uncommitted: 3, commit_required: true },
  ]);
  assert.match(msg, /make -C "\.worktrees\/fix\/a" ship/);
  assert.match(msg, /git -C "\.worktrees\/fix\/b" commit/);
  assert.doesNotMatch(msg, /PLAN\.md/);
  assert.doesNotMatch(msg, /^\s*cd /m);
  assert.doesNotMatch(msg, /make -C "\.worktrees\/fix\/b" ship/); // 未 commit の worktree は ship させない
});

test('evaluate: 依存注入なしの本番経路で例外を出さず、未マージの worktree を候補にする', () => {
  // hook は例外を catch して passthrough する(fail-open)ため、関数の削除漏れは Stop ガードを黙って無効にする。
  const repo = mkdtempSync(join(tmpdir(), 'shipping-guard-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('worktree', 'add', '-q', '-b', 'fix/x', join(repo, '.worktrees', 'fix', 'x'));
    const wt = join(repo, '.worktrees', 'fix', 'x');
    writeFileSync(join(wt, 'a.txt'), 'x');
    execFileSync('git', ['-C', wt, 'add', 'a.txt']);
    execFileSync('git', ['-C', wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work']);
    const r = evaluate(repo);
    assert.equal(typeof r.block, 'boolean');
    const all = [...r.candidates, ...(r.not_owned || []), ...(r.skipped_attempt || [])];
    assert.ok(all.some((c) => c.branch === 'fix/x'), JSON.stringify(r));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
