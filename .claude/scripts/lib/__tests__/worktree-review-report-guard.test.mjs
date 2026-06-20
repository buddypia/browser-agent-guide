/**
 * worktree-review-report-guard.test.mjs — Stop hook 판정 매트릭스 (node:test, 의존 0)
 *
 * 실행: node --test .claude/scripts/lib/__tests__/worktree-review-report-guard.test.mjs
 *
 * hook 의 bottom main 가드는 `import.meta.url === file://argv[1]` 이라 import 시 미실행 —
 * export 만 안전하게 가져온다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  classifyOwnership,
  buildBlockMessage,
  isEscapeHatchBranch,
} from '../../../hooks/worktree-review-report-guard.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PROJECT = '/repo';

const PORCELAIN = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo/.worktrees/feature/foo',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/foo',
  '',
].join('\n');

function validReport() {
  return [
    `<!-- bag-review: head=${SHA} -->`,
    '## Summary / 概要', 'a',
    '## Why / なぜ', 'a',
    '## Changed Files / 変更ファイル', 'a',
    '## How / 作業方法', 'a',
    '## Impact / 影響範囲', 'a',
    '## Trade-offs / トレードオフ', 'a',
    '## Remaining Work / 残作業', 'a',
    '## File Structure / フォルダー構造', 'a',
    '## Review Requests / レビュー依頼', 'a',
  ].join('\n');
}

function makeOpts(over = {}) {
  return {
    _safeGit: (cmd) => (cmd.startsWith('worktree list') ? PORCELAIN : null),
    _countUnmerged: () => 1,
    _countUncommitted: () => 0,
    _headSha: () => SHA,
    _readReport: () => validReport(),
    _classifyOwnership: () => 'owned',
    ...over,
  };
}

test('owned + committed + invalid(report 부재) → BLOCK 1건', () => {
  const v = evaluate(PROJECT, makeOpts({ _readReport: () => null }));
  assert.equal(v.block, true);
  assert.equal(v.candidates.length, 1);
  assert.equal(v.candidates[0].branch, 'feature/foo');
  assert.equal(v.candidates[0].present, false);
});

test('owned + committed + valid report → passthrough', () => {
  const v = evaluate(PROJECT, makeOpts());
  assert.equal(v.block, false);
  assert.equal(v.candidates.length, 0);
});

test('owned + unmerged=0 → passthrough (commit 된 작업 없음)', () => {
  const v = evaluate(PROJECT, makeOpts({ _countUnmerged: () => 0, _readReport: () => null }));
  assert.equal(v.block, false);
});

test('owned + uncommitted>0 → passthrough (먼저 commit — shipping-guard 담당)', () => {
  const v = evaluate(PROJECT, makeOpts({ _countUncommitted: () => 3, _readReport: () => null }));
  assert.equal(v.block, false);
});

test('not owned (other) → passthrough + not_owned 기록', () => {
  const v = evaluate(PROJECT, makeOpts({ _classifyOwnership: () => 'other', _readReport: () => null }));
  assert.equal(v.block, false);
  assert.equal(v.not_owned.length, 1);
  assert.equal(v.not_owned[0].ownership, 'other');
});

test('orphan → passthrough', () => {
  const v = evaluate(PROJECT, makeOpts({ _classifyOwnership: () => 'orphan', _readReport: () => null }));
  assert.equal(v.block, false);
  assert.equal(v.not_owned.length, 1);
});

test('stale report (stamp 불일치) → BLOCK + stale 플래그', () => {
  const stale = validReport().replace(SHA, 'ffffffffffffffffffffffffffffffffffffffff');
  const v = evaluate(PROJECT, makeOpts({ _readReport: () => stale }));
  assert.equal(v.block, true);
  assert.equal(v.candidates[0].stale, true);
});

test('hotfix 브랜치 worktree → escape hatch (미차단)', () => {
  const hotfixPorcelain = [
    'worktree /repo',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/hotfix-x',
    'branch refs/heads/hotfix-x',
    '',
  ].join('\n');
  const v = evaluate(
    PROJECT,
    makeOpts({ _safeGit: (cmd) => (cmd.startsWith('worktree list') ? hotfixPorcelain : null), _readReport: () => null }),
  );
  assert.equal(v.block, false);
});

test('worktree list 실패 → passthrough (fail-open)', () => {
  const v = evaluate(PROJECT, makeOpts({ _safeGit: () => null }));
  assert.equal(v.block, false);
});

test('classifyOwnership: Layer1 cwd 가 그 worktree 내부 → owned', () => {
  const own = classifyOwnership('/repo/.worktrees/feature/foo', 'feature/foo', {
    cwd: '/repo/.worktrees/feature/foo/src',
    _resolveWorktreeRoot: () => '/repo/.worktrees/feature/foo',
    _readSessionOwner: () => null,
  });
  assert.equal(own, 'owned');
});

test('classifyOwnership: Layer2 사이드카 일치 → owned, 불일치 → other, 부재 → orphan', () => {
  const base = { cwd: '/repo', _resolveWorktreeRoot: () => null, sessionId: 'S1' };
  assert.equal(classifyOwnership('/wt', 'b', { ...base, _readSessionOwner: () => 'S1' }), 'owned');
  assert.equal(classifyOwnership('/wt', 'b', { ...base, _readSessionOwner: () => 'S2' }), 'other');
  assert.equal(classifyOwnership('/wt', 'b', { ...base, _readSessionOwner: () => null }), 'orphan');
});

test('isEscapeHatchBranch: hotfix/* + hotfix-*', () => {
  assert.equal(isEscapeHatchBranch('hotfix/x'), true);
  assert.equal(isEscapeHatchBranch('hotfix-x'), true);
  assert.equal(isEscapeHatchBranch('feature/x'), false);
});

test('buildBlockMessage: 미작성 섹션 제목 포함 + throw 없음', () => {
  const msg = buildBlockMessage(PROJECT, [
    { path: '/repo/.worktrees/feature/foo', branch: 'feature/foo', unmerged: 2, present: true, missing: ['impact', 'review_requests'], stale: false, reportPath: '/repo/.worktrees/feature/foo/.tmp/worktree-feature__foo/REVIEW.md' },
  ]);
  assert.match(msg, /Impact/);
  assert.match(msg, /Review Requests/);
  assert.match(msg, /feature\/foo/);
  assert.match(msg, /mark-worktree-reviewed/);
});
