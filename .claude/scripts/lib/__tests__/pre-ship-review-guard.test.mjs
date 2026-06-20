import { test } from 'node:test';
import assert from 'node:assert/strict';

// The hook module's bottom main() is guarded by `!globalThis.__HOOK_ORCHESTRATOR__`
// and would read stdin on import. Set the flag BEFORE the dynamic import so importing
// for unit tests never blocks on stdin (R-CM-006: a hook import must have no side effects).
globalThis.__HOOK_ORCHESTRATOR__ = true;
const { isShipCommand, inferBranchFromCwd, run } = await import(
  '../../../hooks/pre-ship-review-guard.mjs'
);

test('SHIP_PATTERN gates `gh pr merge` only — the irreversible main merge', () => {
  for (const cmd of [
    'gh pr merge 17 --squash',
    'gh pr merge',
    'gh   pr   merge 5 --squash --delete-branch',
    'cd /x/.worktrees/fix/foo && gh pr merge 9',
  ]) {
    assert.equal(isShipCommand(cmd), true, `should gate: ${cmd}`);
  }
});

test('read-only / reversible gh pr subcommands are NOT gated (no false-block)', () => {
  for (const cmd of [
    'gh pr view 17',
    'gh pr list',
    'gh pr checks',
    'gh pr diff 17',
    'gh pr create --title x --body y', // reversible (PR can be closed) → out of scope
    'gh pr edit 17 --add-label foo',
    'gh pr comment 17 --body hi',
    'gh pr ready 17',
  ]) {
    assert.equal(isShipCommand(cmd), false, `should NOT gate: ${cmd}`);
  }
});

test('quoted / echoed "gh pr merge" is data, not an invocation (anchor blocks false-positive)', () => {
  assert.equal(isShipCommand('echo "gh pr merge"'), false);
  assert.equal(isShipCommand('grep -n "gh pr merge" file'), false);
});

test('inferBranchFromCwd resolves branch from the worktree cwd (gh has no --worktree arg)', () => {
  assert.equal(inferBranchFromCwd('/abs/.worktrees/fix/foo'), 'fix/foo');
  assert.equal(inferBranchFromCwd('/abs/.worktrees/fix/foo/daemon/src'), 'fix/foo'); // deep cwd
  assert.equal(inferBranchFromCwd('/abs/repo-main'), null); // outside a worktree → staged marker
  assert.equal(inferBranchFromCwd(undefined), null);
});

test('run() DENIES `gh pr merge` when no fresh pre-ship marker exists', async () => {
  const res = await run({
    tool_name: 'Bash',
    tool_input: { command: 'gh pr merge 17 --squash' },
    cwd: '/tmp/bag-nonexistent/.worktrees/fix/foo',
  });
  assert.equal(res?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('run() passes through read-only `gh pr view` (never blocks legitimate inspection)', async () => {
  const res = await run({
    tool_name: 'Bash',
    tool_input: { command: 'gh pr view 17' },
    cwd: '/tmp/bag-nonexistent/.worktrees/fix/foo',
  });
  assert.notEqual(res?.hookSpecificOutput?.permissionDecision, 'deny');
});

test('run() passes through non-Bash tools', async () => {
  const res = await run({ tool_name: 'Read', tool_input: {} });
  assert.notEqual(res?.hookSpecificOutput?.permissionDecision, 'deny');
});
