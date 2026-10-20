// harness2 由来のハーネス経験ライブラリ(scripts/harness-library.mjs)と、check-harness.mjs に足した
// サブエージェント検査・ライブラリ検査・台帳ゲート(ledgerGate)のテスト。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ledgerGate, validateHarness } from '../scripts/check-harness.mjs';
import { checkLedgerGate, INDEX, readEntries, renderIndex, validateEntry, validateLibrary } from '../scripts/harness-library.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeRepo(files, { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-lib-'));
  made.push(root);
  if (!git) mkdirSync(join(root, '.git'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const NAME = '2026-10-21-demo-change.md';
const ENTRY = `# Demo change

- **date**: 2026-10-21
- **dimension**: INV
- **motivation**: PR #1 showed agents skipping the step.

## Edits

### \`AGENTS.md\`
- **change**: Added a line.
- **observed**: The step ran in the next session.
- **verdict**: helped

## Lesson

- **cue**: A step agents skip.
- **lesson**: Name it in AGENTS.md.
- **evidence**: \`AGENTS.md\` row.
- **confidence**: medium — one session.
`;
const errsOf = (src, name = NAME) => validateEntry(name, src);
const hasError = (errors, needle) => assert.ok(errors.some((e) => e.includes(needle)), `expected "${needle}" in:\n${errors.join('\n')}`);

describe('harness library entries', () => {
  test('this repository passes and INDEX.md is fresh', () => {
    assert.deepEqual(validateLibrary(ROOT), []);
    assert.ok(readEntries(ROOT).length > 0);
  });

  test('a complete entry passes, and NO_ENTRY is a valid lesson', () => {
    assert.deepEqual(errsOf(ENTRY), []);
    assert.deepEqual(errsOf(ENTRY.replace(/## Lesson[\s\S]*/, '## Lesson\n\nNO_ENTRY\n')), []);
  });

  test('missing evidence, bad verdicts and malformed fields are reported', () => {
    hasError(errsOf(ENTRY.replace(/- \*\*motivation\*\*:.*\n/, '')), 'motivation');
    hasError(errsOf(ENTRY.replace('verdict**: helped', 'verdict**: great')), 'must be one of');
    hasError(errsOf(ENTRY.replace('dimension**: INV', 'dimension**: misc')), 'dimension');
    hasError(errsOf(ENTRY, '2026-10-20-demo-change.md'), 'differs from the file name');
    hasError(errsOf(ENTRY, 'demo.md'), 'name it');
    hasError(errsOf(ENTRY.replace(/## Lesson[\s\S]*/, '')), 'needs "## Lesson"');
    hasError(errsOf(ENTRY.replace(/### `AGENTS\.md`[\s\S]*?(?=## Lesson)/, '')), 'one "### `<component path>`" block');
    hasError(errsOf(ENTRY.replace('- **observed**: The step ran in the next session.\n', '')), 'needs "- **observed**:"');
  });

  test('a lesson resting only on confounded or pending rows must be low confidence', () => {
    const guess = ENTRY.replace('verdict**: helped', 'verdict**: confounded');
    hasError(errsOf(guess), 'is a guess');
    assert.deepEqual(errsOf(guess.replace('confidence**: medium', 'confidence**: low')), []);
    hasError(errsOf(ENTRY.replace('confidence**: medium', 'confidence**: sure')), 'high, medium or low');
  });

  test('the lesson must name a harness component', () => {
    hasError(errsOf(ENTRY.replace('Name it in AGENTS.md.', 'Be thorough.')), 'must name the harness component');
  });

  test('INDEX.md must match the entries', () => {
    const entries = { [`docs/harness/entries/${NAME}`]: ENTRY };
    const fresh = makeRepo({ ...entries, [INDEX]: renderIndex([{ name: NAME, src: ENTRY }]) });
    assert.deepEqual(validateLibrary(fresh), []);
    hasError(validateLibrary(makeRepo(entries)), 'out of date');
    hasError(validateLibrary(makeRepo({ ...entries, [INDEX]: '# stale\n' })), 'out of date');
    assert.deepEqual(validateLibrary(makeRepo({})), []);
  });

  test('INDEX.md lists open verdicts', () => {
    const index = renderIndex([{ name: NAME, src: ENTRY.replace('verdict**: helped', 'verdict**: pending') }]);
    assert.match(index, /## Verdicts still open\n\n[\s\S]*`AGENTS\.md` pending/);
  });
});

describe('ledger gate', () => {
  const entry = (component) => [{ name: NAME, src: ENTRY.replace('### `AGENTS.md`', `### \`${component}\``) }];

  test('a harness change needs an entry naming each changed component', () => {
    hasError(checkLedgerGate({ changed: ['AGENTS.md', 'lib/a.js'], entries: [], messages: '' }), 'AGENTS.md');
    assert.deepEqual(checkLedgerGate({ changed: ['AGENTS.md'], entries: entry('AGENTS.md'), messages: '' }), []);
    assert.deepEqual(checkLedgerGate({ changed: ['lib/a.js', 'docs/x.md'], entries: [], messages: '' }), []);
  });

  test('a directory component covers what is under it, but not a whole top-level tree', () => {
    const skill = '.agents/skills/testing/SKILL.md';
    assert.deepEqual(checkLedgerGate({ changed: [skill], entries: entry('.agents/skills/testing/'), messages: '' }), []);
    hasError(checkLedgerGate({ changed: [skill], entries: entry('.agents/'), messages: '' }), skill);
    hasError(checkLedgerGate({ changed: [skill], entries: entry('.agents/skills/test'), messages: '' }), skill);
  });

  test('a commit trailer with a reason opts out; one without a reason does not', () => {
    assert.deepEqual(checkLedgerGate({ changed: ['AGENTS.md'], entries: [], messages: 'Fix typo\n\nHarness-Entry: none — typo\n' }), []);
    hasError(checkLedgerGate({ changed: ['AGENTS.md'], entries: [], messages: 'Harness-Entry: none\n' }), 'AGENTS.md');
  });

  test('ledgerGate diffs the branch against origin/main, including uncommitted and untracked files', () => {
    const root = makeRepo({ 'AGENTS.md': 'base\n' }, { git: true });
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base', '--allow-empty');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'agents');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.deepEqual(ledgerGate(root), []);
    writeFileSync(join(root, 'AGENTS.md'), 'changed\n');
    hasError(ledgerGate(root), 'AGENTS.md');
    mkdirSync(join(root, 'docs/harness/entries'), { recursive: true });
    writeFileSync(join(root, `docs/harness/entries/${NAME}`), ENTRY);
    assert.deepEqual(ledgerGate(root), []);
  });

  test('ledgerGate is skipped without an origin/main to diff against', () => {
    const root = makeRepo({ 'AGENTS.md': 'x\n' }, { git: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    assert.equal(ledgerGate(root), null);
  });
});

describe('subagents', () => {
  const BASE = {
    'AGENTS.md': 'Spawn the `demo-agent` subagent for big reads.\n',
    'CLAUDE.md': '@AGENTS.md\n',
    '.claude/agents/demo-agent.md': '---\nname: demo-agent\ndescription: Reads a lot, answers briefly.\n---\n\nBody.\n',
  };
  const errorsFor = (o) => validateHarness(makeRepo({ ...BASE, ...o })).errors;

  test('a named subagent with frontmatter passes', () => assert.deepEqual(errorsFor({}), []));

  test('frontmatter and a trigger are required', () => {
    hasError(errorsFor({ '.claude/agents/demo-agent.md': '---\nname: other\ndescription: x\n---\n' }), 'needs frontmatter `name: demo-agent`');
    hasError(errorsFor({ '.claude/agents/demo-agent.md': '---\nname: demo-agent\n---\n' }), 'needs a `description:`');
    hasError(errorsFor({ 'AGENTS.md': 'Nothing here.\n' }), 'subagent "demo-agent" is never named');
  });
});
