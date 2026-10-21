import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, mergedPr, parseReview, prTitle } from '../scripts/auto-ship.mjs';

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
