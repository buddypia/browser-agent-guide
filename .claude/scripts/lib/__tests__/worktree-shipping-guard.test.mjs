// worktree-shipping-guard の Stop メッセージ contract test。
//
// Why: このガードはテストが無く、PLAN.md 前提の指示(廃止済みゲート)や、既定経路(make ship)と食い違う
//   手動 merge の案内、`cd` + 相対パスの例を出し続けていた。案内が既定の出荷経路と一致することを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__HOOK_ORCHESTRATOR__ = true;
const { buildBlockMessage } = await import('../../../hooks/worktree-shipping-guard.mjs');

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
