// destructive-git-guard 의 per-guard contract test.
//
// Why: 이 guard 도 단위 테스트가 없었다. PR #25 에서 create-pr-active safe-allowlist carve-out
//   을 제거했으므로, 정규 파괴 명령이 여전히 차단되고 안전 명령이 통과함을 contract 로 고정한다.
//
// import 부작용 회피: bottom main() 가드 플래그를 import 전에 세운다(R-CM-006).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__HOOK_ORCHESTRATOR__ = true;
const { checkDestructiveGit, isDirectWorktreeShippingMerge, classifyRestore } = await import(
  '../../../hooks/destructive-git-guard.mjs'
);

test('정규 파괴 명령은 모두 blocked', () => {
  for (const cmd of [
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git reset --merge',
    'git reset --keep',
    'git clean -fd',
    'git clean -fdx',
    'git clean -f',
    'git stash clear',
    'git push --force',
    'git push -f origin main',
    'git rebase main',
    'git rebase -i HEAD~3',
    'git checkout .',
    'git checkout -- src/file.js',
  ]) {
    assert.equal(checkDestructiveGit(cmd).blocked, true, `should block: ${cmd}`);
  }
});

test('안전 명령은 통과 (working tree 보존 / 조회 / 일반 commit)', () => {
  for (const cmd of [
    'git status',
    'git add .',
    'git commit -m "fix: x"',
    'git log --oneline',
    'git reset --soft HEAD~1', // HEAD만 이동
    'git reset HEAD -- src/file.js', // unstage (index만)
    'git reset', // bare = mixed, working tree 보존
    'git stash', // push 암묵
    'git stash pop',
    'git stash drop',
    'git push', // force 아님
    'git checkout main', // 브랜치 전환
    'git checkout -b feature/x', // 브랜치 생성 (파괴 아님)
    'git diff',
  ]) {
    assert.equal(checkDestructiveGit(cmd).blocked, false, `should pass: ${cmd}`);
  }
});

test('git restore: 광역은 block, 명시적 단일 파일 / --staged 는 allow', () => {
  assert.equal(classifyRestore('git restore .'), 'block');
  assert.equal(classifyRestore('git restore src/'), 'block');
  assert.equal(classifyRestore('git restore "*.js"'), 'block');
  assert.equal(classifyRestore('git restore src/file.js'), 'allow');
  assert.equal(classifyRestore('git restore --staged src/file.js'), 'allow');
  assert.equal(classifyRestore('git status'), 'none');
  // checkDestructiveGit 경유로도 광역 restore 는 blocked
  assert.equal(checkDestructiveGit('git restore .').blocked, true);
  assert.equal(checkDestructiveGit('git restore src/file.js').blocked, false);
});

test('worktree shipping FF merge: GitHub Flow 브랜치 직접 ff-merge 는 blocked', () => {
  assert.equal(isDirectWorktreeShippingMerge('git merge --ff-only feature/foo'), true);
  assert.equal(isDirectWorktreeShippingMerge('git merge --ff-only fix/bar'), true);
  const r = checkDestructiveGit('git merge --ff-only feature/foo');
  assert.equal(r.blocked, true);
  assert.equal(r.kind, 'worktree-shipping');
});

test('worktree shipping FF merge: origin/main freshness sync 는 허용', () => {
  assert.equal(isDirectWorktreeShippingMerge('git merge --ff-only origin/main'), false);
  assert.equal(checkDestructiveGit('git merge --ff-only origin/main').blocked, false);
});

test('체이닝(&&/;)으로 파괴 명령을 숨겨도 검출한다', () => {
  assert.equal(checkDestructiveGit('git status && git reset --hard').blocked, true);
  assert.equal(checkDestructiveGit('echo ok; git push --force').blocked, true);
});

test('비문자열/빈 입력은 not blocked (안전 기본값)', () => {
  assert.equal(checkDestructiveGit('').blocked, false);
  assert.equal(checkDestructiveGit(null).blocked, false);
  assert.equal(checkDestructiveGit(undefined).blocked, false);
});
