import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeBranchMerged, isSafeBranchName, PROTECTED_BRANCHES, getBranchPrs } from '../scripts/cleanup-merged-branches.mjs';

test('isSafeBranchName protects primary branches and rejects dangerous tokens', () => {
  for (const b of ['main', 'master', 'HEAD', 'develop', 'release']) {
    assert.equal(isSafeBranchName(b), false, `should reject protected branch: ${b}`);
  }
  for (const b of ['-f', '--help', '-D', '--delete', '-b', 'feature/..']) {
    assert.equal(isSafeBranchName(b), false, `should reject flag or traversal: ${b}`);
  }
  for (const b of ['', ' ', '   ', null, undefined, 123]) {
    assert.equal(isSafeBranchName(b), false, `should reject invalid input: ${b}`);
  }
  assert.equal(isSafeBranchName('feature/login-fix'), true);
  assert.equal(isSafeBranchName('fix/eg2-port-38765'), true);
  assert.equal(isSafeBranchName('chore/cleanup'), true);
});

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

test('tree-identical squash-merged branch is judged merged when ancestor and PR do not match', () => {
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

test('getBranchPrs returns cached PRs on hit, and queries fallback on miss', () => {
  const cache = new Map([
    ['feature/cached', [{ number: 1, state: 'MERGED', headRefOid: 'sha1', headRefName: 'feature/cached' }]],
  ]);

  // Hit
  let fallbackCalled = false;
  const hit = getBranchPrs('feature/cached', cache, () => {
    fallbackCalled = true;
    return '[]';
  });
  assert.equal(fallbackCalled, false);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].number, 1);

  // Miss with successful fallback
  const miss = getBranchPrs('feature/miss', cache, (_cmd, args) => {
    assert.deepEqual(args.slice(0, 4), ['pr', 'list', '--head', 'feature/miss']);
    return JSON.stringify([{ number: 2, state: 'MERGED', headRefOid: 'sha2', headRefName: 'feature/miss' }]);
  });
  assert.equal(miss.length, 1);
  assert.equal(miss[0].number, 2);
  assert.equal(cache.has('feature/miss'), true, 'should cache the fallback result');
});

