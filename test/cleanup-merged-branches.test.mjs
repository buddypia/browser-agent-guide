import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBranchMerged } from '../scripts/cleanup-merged-branches.mjs';

test('fast-forward ancestor branch is judged merged', () => {
  const res = judgeBranchMerged({
    isAncestor: true,
    mainTree: 'tree-sha-1',
    mergedTree: 'tree-sha-2',
    branchHeadSha: 'head-sha-1',
    prList: [],
  });
  assert.equal(res.merged, true);
  assert.match(res.reason, /fast-forward/);
});

test('tree-identical squash-merged branch is judged merged', () => {
  const res = judgeBranchMerged({
    isAncestor: false,
    mainTree: 'tree-sha-1',
    mergedTree: 'tree-sha-1',
    branchHeadSha: 'head-sha-1',
    prList: [],
  });
  assert.equal(res.merged, true);
  assert.match(res.reason, /tree-identical/);
});

test('PR merged at exact matching HEAD commit is judged merged', () => {
  const res = judgeBranchMerged({
    isAncestor: false,
    mainTree: 'tree-sha-1',
    mergedTree: 'tree-sha-2',
    branchHeadSha: 'commit-abc-1234',
    prList: [{ number: 98, state: 'MERGED', headRefOid: 'commit-abc-1234' }],
  });
  assert.equal(res.merged, true);
  assert.match(res.reason, /PR #98 was merged/);
});

test('PR merged at older commit with unmerged local HEAD is kept safe', () => {
  const res = judgeBranchMerged({
    isAncestor: false,
    mainTree: 'tree-sha-1',
    mergedTree: 'tree-sha-2',
    branchHeadSha: 'commit-def-newer',
    prList: [{ number: 98, state: 'MERGED', headRefOid: 'commit-abc-older' }],
  });
  assert.equal(res.merged, false);
});

test('open or closed PR is not judged merged', () => {
  const res = judgeBranchMerged({
    isAncestor: false,
    mainTree: 'tree-sha-1',
    mergedTree: 'tree-sha-2',
    branchHeadSha: 'commit-xyz',
    prList: [
      { number: 99, state: 'OPEN', headRefOid: 'commit-xyz' },
      { number: 100, state: 'CLOSED', headRefOid: 'commit-xyz' },
    ],
  });
  assert.equal(res.merged, false);
});
