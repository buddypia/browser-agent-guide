import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkBaseFreshness } from '../../mark-pre-ship-confirmed.mjs';

// Ship-time base-freshness gate (docs/retros/retro-2026-06-30-worktree-base-remote-divergence-recurrence.md).
// Reproduces the PR #67 incident's exact preconditions: a worktree branched from an OLD
// origin/main, upstream advances and touches a file the branch ALSO independently touches.
// checkBaseFreshness must warn (stderr) listing the overlapping path, without ever blocking
// (it has no exit code / no return-value failure — it is advisory only).

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(tmp) {
  const originDir = join(tmp, 'origin.git');
  git(['init', '--bare', '--initial-branch=main', originDir], tmp);

  const seed = join(tmp, 'seed');
  git(['clone', originDir, seed], tmp);
  git(['config', 'user.email', 'test@example.com'], seed);
  git(['config', 'user.name', 'Test User'], seed);
  writeFileSync(join(seed, 'FOO.txt'), 'orig\n');
  git(['add', 'FOO.txt'], seed);
  git(['commit', '-m', 'initial'], seed);
  git(['push', 'origin', 'main'], seed);

  const mainRoot = join(tmp, 'main');
  git(['clone', originDir, mainRoot], tmp);
  git(['config', 'user.email', 'test@example.com'], mainRoot);
  git(['config', 'user.name', 'Test User'], mainRoot);

  return { originDir, seed, mainRoot };
}

function withCapturedStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test('checkBaseFreshness warns when branch and upstream touched the same file since merge-base', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mpsc-'));
  try {
    const { seed, mainRoot } = makeRepo(tmp);

    // Branch a worktree from the current origin/main, then touch FOO.txt on the branch.
    git(['worktree', 'add', '.worktrees/fix/foo', '-b', 'fix/foo', 'origin/main'], mainRoot);
    const wt = join(mainRoot, '.worktrees', 'fix', 'foo');
    git(['config', 'user.email', 'test@example.com'], wt);
    git(['config', 'user.name', 'Test User'], wt);
    writeFileSync(join(wt, 'FOO.txt'), 'branch change\n');
    git(['add', 'FOO.txt'], wt);
    git(['commit', '-m', 'branch touches FOO'], wt);

    // Upstream advances independently and ALSO touches FOO.txt (the incident's exact shape).
    writeFileSync(join(seed, 'FOO.txt'), 'upstream change\n');
    git(['add', 'FOO.txt'], seed);
    git(['commit', '-m', 'upstream touches FOO'], seed);
    git(['push', 'origin', 'main'], seed);

    const stderr = withCapturedStderr(() => {
      const result = checkBaseFreshness(mainRoot, 'fix/foo', false);
      assert.equal(result.warned, true);
      assert.deepEqual(result.overlap, ['FOO.txt']);
    });
    assert.match(stderr, /base freshness/);
    assert.match(stderr, /FOO\.txt/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkBaseFreshness stays silent when the branch is current with origin/main (0 false positives)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mpsc-'));
  try {
    const { mainRoot } = makeRepo(tmp);

    git(['worktree', 'add', '.worktrees/fix/bar', '-b', 'fix/bar', 'origin/main'], mainRoot);
    const wt = join(mainRoot, '.worktrees', 'fix', 'bar');
    git(['config', 'user.email', 'test@example.com'], wt);
    git(['config', 'user.name', 'Test User'], wt);
    writeFileSync(join(wt, 'BAR.txt'), 'unrelated new file\n');
    git(['add', 'BAR.txt'], wt);
    git(['commit', '-m', 'branch adds BAR (no upstream drift)'], wt);

    const stderr = withCapturedStderr(() => {
      const result = checkBaseFreshness(mainRoot, 'fix/bar', false);
      assert.equal(result.warned, false);
    });
    assert.equal(stderr, '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkBaseFreshness skips (fail-open) for staged mode / force / absent worktree', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mpsc-'));
  try {
    const { mainRoot } = makeRepo(tmp);
    assert.equal(checkBaseFreshness(mainRoot, null, false).warned, false); // staged mode
    assert.equal(checkBaseFreshness(mainRoot, 'fix/whatever', true).warned, false); // --force
    assert.equal(checkBaseFreshness(mainRoot, 'fix/never-created', false).warned, false); // no worktree
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
