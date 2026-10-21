import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CI_JOBS, ciState, decide, mergedPr, parseReview, prTitle } from '../scripts/auto-ship.mjs';

const ok = { verdict: 'approve', scope: 'small', summary: '', issues: [] };

test('small approved change auto-merges', () => {
  assert.deepEqual(decide({ files: ['lib/storage.js', 'test/x.test.mjs'], lines: 40, review: ok }), []);
});

test('size thresholds send to human', () => {
  assert.equal(decide({ files: Array.from({ length: 16 }, (_, i) => `lib/f${i}.js`), lines: 10, review: ok }).length, 1);
  assert.equal(decide({ files: ['lib/a.js'], lines: 401, review: ok }).length, 1);
  assert.deepEqual(decide({ files: Array.from({ length: 15 }, (_, i) => `lib/f${i}.js`), lines: 400, review: ok }), []);
});

test('protected paths send to human', () => {
  for (const f of ['.claude/hooks/x.mjs', '.codex/hooks.json', '.agents/hooks.json', '.github/workflows/a.yml', 'scripts/agent-worktree-guard/guard.py', 'scripts/auto-ship.mjs', 'test/auto-ship.test.mjs', 'manifest.json', 'Makefile']) {
    assert.match(decide({ files: [f], lines: 1, review: ok }).join(), /protected paths/, f);
  }
  assert.deepEqual(decide({ files: ['.agents/skills/bag-memo/SKILL.md'], lines: 1, review: ok }), []);
  // A Harness-Entry trailer skips the experience library on the agent's own word, so a person confirms it.
  assert.match(decide({ files: ['.agents/skills/bag-memo/SKILL.md'], lines: 1, review: ok, optOuts: ['.agents/skills/bag-memo/SKILL.md'] }).join(), /Harness-Entry trailer/);
  // No origin/main means the ledger gate never ran; that must not read as a pass.
  assert.match(decide({ files: ['a.js'], lines: 1, review: ok, optOuts: null }).join(), /ledger gate could not run/);
});

test('review verdict and scope gate the merge', () => {
  assert.equal(decide({ files: ['a.js'], lines: 1, review: { ...ok, verdict: 'request_changes' } }).length, 1);
  assert.equal(decide({ files: ['a.js'], lines: 1, review: { ...ok, scope: 'large' } }).length, 1);
});

test('unparseable or missing review fails closed', () => {
  for (const out of ['', 'not json', '{"result":"x"}', JSON.stringify({ structured_output: { verdict: 'approve' } })]) {
    assert.notDeepEqual(decide({ files: ['a.js'], lines: 1, review: parseReview(out) }), [], out);
  }
  assert.deepEqual(parseReview(JSON.stringify({ structured_output: ok })), ok);
});

test('PR title is the oldest commit subject, not the branch name', () => {
  assert.equal(prTitle('- Fix follow-up\n- Add the feature', 'feat/x'), 'Add the feature');
  assert.equal(prTitle('- Only commit', 'feat/x'), 'Only commit');
  assert.equal(prTitle('', 'feat/x'), 'feat/x');
});

test('a merged PR counts only when its head is exactly this HEAD', () => {
  const prs = [{ number: 7, headRefOid: 'aaa' }, { number: 9, headRefOid: 'bbb' }];
  assert.equal(mergedPr(prs, 'bbb').number, 9);
  // New commits after the merge are new work, not a merged worktree to clean up.
  assert.equal(mergedPr(prs, 'ccc'), null);
  assert.equal(mergedPr([], 'aaa'), null);
  assert.equal(mergedPr(undefined, 'aaa'), null);
});

test('CI gate passes only when every required job finished green on the commit', () => {
  const done = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
  assert.equal(ciState([done('fast'), done('daemon'), done('e2e')]), 'pass');
  // A docs-only PR skips the e2e steps; the job itself still succeeds.
  assert.equal(ciState([done('fast'), done('daemon'), done('e2e', 'skipped')]), 'pass');
  // Right after a push no runs are registered yet, and a job can lag behind the others.
  assert.equal(ciState([]), 'pending');
  assert.equal(ciState([done('fast'), done('daemon')]), 'pending');
  assert.equal(ciState([done('fast'), done('daemon'), { name: 'e2e', status: 'in_progress', conclusion: null }]), 'pending');
  // One red job fails at once, without waiting for the rest.
  assert.equal(ciState([done('fast', 'failure'), { name: 'e2e', status: 'queued', conclusion: null }]), 'fail');
  assert.equal(ciState([done('fast'), done('daemon'), done('e2e', 'cancelled')]), 'fail');
  // Unrelated check runs neither satisfy nor block the gate.
  assert.equal(ciState([done('fast'), done('daemon'), done('e2e'), done('other', 'failure')]), 'pass');
  assert.equal(ciState(null), 'pending');
});

test('every job make ship waits for exists in the CI workflow', () => {
  // A renamed job would never report, and make ship would wait out its timeout before failing.
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const job of CI_JOBS) assert.match(yml, new RegExp(`^  ${job}:$`, 'm'), job);
});
