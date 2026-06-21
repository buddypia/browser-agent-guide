// commit-guard 의 per-guard contract test.
//
// Why: commit-guard 는 이때까지 단위 테스트가 없었다. dead-trigger lint(check-hook-refs)는
//   "import/path 가 살아있는가"만 검사하고, regex-trigger-liveness("정규 명령이 여전히
//   deny/passthrough 되는가")는 의도적으로 다루지 않는다. 본 contract test 가 그 공백을 메운다.
//   특히 PR #25(.tmp/create-pr-active carve-out 제거) 후 deny 경로가 보존됐음을 고정한다.
//
// hook 의 bottom main() 은 `!globalThis.__HOOK_ORCHESTRATOR__` 가드라 import 시 stdin 을
// 읽는다 → import 전에 플래그를 세워 부작용 없는 import 를 보장(R-CM-006).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__HOOK_ORCHESTRATOR__ = true;
const { isGitCommit, isGitAmend, isGitBranchCreate, decide } = await import(
  '../../../hooks/commit-guard.mjs'
);

test('isGitCommit: 실제 commit 만 true (dry-run/anchor/word-boundary 제외)', () => {
  for (const cmd of ['git commit', 'git commit -m "x"', 'git  commit -am x', 'GIT COMMIT -m y']) {
    assert.equal(isGitCommit(cmd), true, `commit: ${cmd}`);
  }
  for (const cmd of ['git commit --dry-run', 'echo git commit', 'git committed', '']) {
    assert.equal(isGitCommit(cmd), false, `not commit: ${cmd}`);
  }
});

test('isGitAmend: --amend 만 true', () => {
  assert.equal(isGitAmend('git commit --amend'), true);
  assert.equal(isGitAmend('git commit -m x --amend'), true);
  assert.equal(isGitAmend('git commit -m x'), false);
  assert.equal(isGitAmend('git commit'), false);
});

test('isGitBranchCreate: 생성만 true, 조회/삭제/전환은 false', () => {
  for (const cmd of ['git checkout -b foo', 'git checkout -B foo', 'git switch -c foo', 'git switch --create foo', 'git branch foo']) {
    assert.equal(isGitBranchCreate(cmd), true, `create: ${cmd}`);
  }
  for (const cmd of ['git checkout main', 'git switch main', 'git branch -d foo', 'git branch --list', 'git branch', 'git branch -a']) {
    assert.equal(isGitBranchCreate(cmd), false, `not create: ${cmd}`);
  }
});

test('decide contract: amend 는 worktree 안에서도 항상 deny', () => {
  assert.deepEqual(decide({ command: 'git commit --amend', branch: 'feature/x', isWorktree: true }), {
    action: 'deny',
    kind: 'amend',
  });
});

test('decide contract: worktree 안에서는 commit/branch create 가 passthrough', () => {
  assert.deepEqual(decide({ command: 'git commit -m x', branch: 'feature/x', isWorktree: true }), { action: 'passthrough' });
  assert.deepEqual(decide({ command: 'git checkout -b new', branch: 'feature/x', isWorktree: true }), { action: 'passthrough' });
});

test('decide contract: non-worktree 에서 branch create 는 deny', () => {
  assert.deepEqual(decide({ command: 'git checkout -b new', branch: 'main', isWorktree: false }), {
    action: 'deny',
    kind: 'branch_create',
  });
});

test('decide contract: main 직접 commit 은 deny, 다른 브랜치 commit 은 passthrough', () => {
  assert.deepEqual(decide({ command: 'git commit -m x', branch: 'main', isWorktree: false }), {
    action: 'deny',
    kind: 'main_commit',
  });
  assert.deepEqual(decide({ command: 'git commit -m x', branch: 'feature/x', isWorktree: false }), { action: 'passthrough' });
});

test('decide contract: main 에서도 dry-run commit 은 passthrough', () => {
  assert.deepEqual(decide({ command: 'git commit --dry-run', branch: 'main', isWorktree: false }), { action: 'passthrough' });
});

test('PR #25 regression: create-pr-active carve-out 은 제거됨 — extra 필드는 deny 를 우회하지 못한다', () => {
  // 과거엔 isCreatePrActive=true 가 passthrough 를 강제했다. 이제 decide 는 isWorktree 만 본다.
  assert.deepEqual(decide({ command: 'git commit -m x', branch: 'main', isWorktree: false, isCreatePrActive: true }), {
    action: 'deny',
    kind: 'main_commit',
  });
});
