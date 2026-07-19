// merge-guard 의 per-guard contract test.
//
// Why: 이 guard 에는 단위 테스트가 없었다. retro-2026-07-19 (gh pr merge --delete-branch from
//   worktree footgun) 에서 추가한 ②-deny 분기를 contract 로 고정한다 — main 이 다른 worktree 에
//   점유된 상태의 `gh pr merge --delete-branch`/`-d` 는 deny, 무플래그/git merge 는 통과.
//   순수 조합 술어(isGhPrMerge/hasDeleteBranchFlag/effectiveCwd)는 여기서, git 상태에 의존하는
//   defaultBranchHeldByAnotherWorktree/전체 deny 판정은 end-to-end (retro Step 8) 에서 검증한다.
//
// import 부작용 회피: bottom main() 가드 플래그(__HOOK_ORCHESTRATOR__)를 import 전에 세운다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__HOOK_ORCHESTRATOR__ = true;
const {
  isGhPrMerge,
  hasDeleteBranchFlag,
  effectiveCwd,
  defaultBranchHeldByAnotherWorktree,
  shouldDenyDeleteBranchFromWorktree,
  GH_PR_MERGE_WORKTREE_DENY_REASON,
} = await import('../../merge-guard.mjs');

const WT = '/Users/x/proj/.worktrees/fix/foo';
// 비-worktree 이자 비-repo → git 판정 두 신호 모두 실패 → defaultBranchHeldByAnotherWorktree=false.
const NON_REPO = '/nonexistent-not-a-repo-xyz';

test('isGhPrMerge: gh pr merge 만 매칭 (git merge 와 구별)', () => {
  assert.equal(isGhPrMerge('gh pr merge 84 --squash'), true);
  assert.equal(isGhPrMerge('gh  pr  merge 84'), true);
  assert.equal(isGhPrMerge('git merge origin/main'), false);
  assert.equal(isGhPrMerge('gh pr create'), false);
  assert.equal(isGhPrMerge(''), false);
});

test('hasDeleteBranchFlag: --delete-branch 와 짧은 별칭 -d 둘 다 매칭, --draft 오탐 없음', () => {
  assert.equal(hasDeleteBranchFlag('gh pr merge 84 --squash --delete-branch'), true);
  assert.equal(hasDeleteBranchFlag('gh pr merge 84 --squash -d'), true);
  assert.equal(hasDeleteBranchFlag('gh pr merge 84 -d --squash'), true);
  assert.equal(hasDeleteBranchFlag('gh pr merge 84 --squash'), false);
  assert.equal(hasDeleteBranchFlag('gh pr merge 84 --squash --draft'), false); // "--d..." 오탐 방지
  assert.equal(hasDeleteBranchFlag(''), false);
});

test('effectiveCwd: 선행 `cd <path> &&` 파싱, 없으면 hookData.cwd', () => {
  assert.equal(effectiveCwd(`cd ${WT} && gh pr merge 84 -d`, {}), WT);
  assert.equal(effectiveCwd(`cd '${WT}' && gh pr merge 84 -d`, {}), WT);
  assert.equal(effectiveCwd('gh pr merge 84 -d', { cwd: WT }), WT);
});

test('defaultBranchHeldByAnotherWorktree: 비-repo/판정불가 → false (fail-open, zero false-block)', () => {
  assert.equal(defaultBranchHeldByAnotherWorktree('gh pr merge 84 -d', { cwd: NON_REPO }), false);
});

test('shouldDeny: 무플래그 / gh 아님 / 비-repo 는 통과 (false) — git 상태 무관하게 결정론적', () => {
  // 무플래그면 hasDeleteBranchFlag 에서 컷 → git 조회 없이 false
  assert.equal(shouldDenyDeleteBranchFromWorktree(`cd ${WT} && gh pr merge 84 --squash`, {}), false);
  // gh pr merge 가 아니면 isGhPrMerge 에서 컷
  assert.equal(shouldDenyDeleteBranchFromWorktree(`cd ${WT} && git merge --delete-branch`, {}), false);
  // --delete-branch 있어도 비-repo cwd → defaultBranchHeldByAnotherWorktree=false → deny 안 함
  assert.equal(
    shouldDenyDeleteBranchFromWorktree('gh pr merge 84 --squash --delete-branch', { cwd: NON_REPO }),
    false,
  );
});

test('deny reason 에 핵심 키워드 포함 (AI 에게 전달되는 차단 사유)', () => {
  assert.match(GH_PR_MERGE_WORKTREE_DENY_REASON, /BLOCKED/);
  assert.match(GH_PR_MERGE_WORKTREE_DENY_REASON, /--delete-branch/);
  assert.match(GH_PR_MERGE_WORKTREE_DENY_REASON, /failed to run git/);
  assert.match(GH_PR_MERGE_WORKTREE_DENY_REASON, /gh pr view/);
});
