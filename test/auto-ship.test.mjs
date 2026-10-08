import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, parseReview } from '../scripts/auto-ship.mjs';

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
  for (const f of ['.claude/hooks/x.mjs', '.codex/hooks.json', '.agents/hooks.json', '.github/workflows/a.yml', 'scripts/agent-worktree-guard/guard.py', 'scripts/auto-ship.mjs', 'manifest.json', 'Makefile']) {
    assert.match(decide({ files: [f], lines: 1, review: ok }).join(), /protected paths/, f);
  }
  assert.deepEqual(decide({ files: ['.agents/skills/bag-memo/SKILL.md'], lines: 1, review: ok }), []);
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
