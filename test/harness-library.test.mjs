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
import { checkLedgerGate, INDEX, readEntries, renderIndex, TRAILER, validateEntry, validateLibrary } from '../scripts/harness-library.mjs';

// 呼び出し側の GIT_DIR / GIT_WORK_TREE(worktree-init が CLI 設定へ注入する)が残ると、一時リポジトリ向けの
// git commit が本物の worktree に作用する。子プロセスへ継がせない。
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[k];

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
    hasError(checkLedgerGate({ changed: ['AGENTS.md', 'lib/a.js'], entries: [] }), 'AGENTS.md');
    assert.deepEqual(checkLedgerGate({ changed: ['AGENTS.md'], entries: entry('AGENTS.md') }), []);
    assert.deepEqual(checkLedgerGate({ changed: ['lib/a.js', 'docs/x.md'], entries: [] }), []);
  });

  test('a directory component covers what is under it, but not a whole top-level tree', () => {
    const skill = '.agents/skills/testing/SKILL.md';
    assert.deepEqual(checkLedgerGate({ changed: [skill], entries: entry('.agents/skills/testing/') }), []);
    hasError(checkLedgerGate({ changed: [skill], entries: entry('.agents/') }), skill);
    hasError(checkLedgerGate({ changed: [skill], entries: entry('.agents/skills/test') }), skill);
  });

  test('scripts that hook files run are on the gate, wherever they live', () => {
    const hookTargets = new Set(['.claude/scripts/merge-guard.mjs']);
    hasError(checkLedgerGate({ changed: ['.claude/scripts/merge-guard.mjs'], entries: [], hookTargets }), 'merge-guard.mjs');
    assert.deepEqual(checkLedgerGate({ changed: ['.claude/scripts/lib/utils.mjs'], entries: [], hookTargets }), []);
  });

  test('an open verdict on a changed component must be settled or cited', () => {
    const old = { name: '2026-01-01-old.md', src: ENTRY.replace('verdict**: helped', 'verdict**: pending') };
    const own = entry('AGENTS.md');
    hasError(checkLedgerGate({ changed: ['AGENTS.md'], entries: own, library: [old, ...own] }), '2026-01-01-old.md has open verdicts');
    const citing = [{ name: NAME, src: own[0].src.replace('The step ran', 'Follows 2026-01-01-old; the step ran') }];
    assert.deepEqual(checkLedgerGate({ changed: ['AGENTS.md'], entries: citing, library: [old, ...citing] }), []);
    assert.deepEqual(checkLedgerGate({ changed: ['AGENTS.md'], entries: [...own, old], library: [old, ...own] }), []);
    const settled = { ...old, src: ENTRY };
    assert.deepEqual(checkLedgerGate({ changed: ['AGENTS.md'], entries: own, library: [settled, ...own] }), []);
  });

  test('exempt paths are skipped; the checker and merge gate are on the gate', () => {
    assert.deepEqual(checkLedgerGate({ changed: ['AGENTS.md'], entries: [], exempt: new Set(['AGENTS.md']) }), []);
    hasError(checkLedgerGate({ changed: ['AGENTS.md', 'scripts/check-harness.mjs'], entries: [], exempt: new Set(['AGENTS.md']) }), 'scripts/check-harness.mjs');
    hasError(checkLedgerGate({ changed: ['scripts/auto-ship.mjs'], entries: [] }), 'scripts/auto-ship.mjs');
  });

  test('the trailer needs a reason', () => {
    assert.ok(TRAILER.test('Fix typo\n\nHarness-Entry: none — typo\n'));
    assert.ok(!TRAILER.test('Harness-Entry: none\n'));
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
    mkdirSync(join(root, '.claude/scripts'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node .claude/scripts/guard.mjs' }] }] } }));
    writeFileSync(join(root, '.claude/scripts/guard.mjs'), '');
    hasError(ledgerGate(root), '.claude/scripts/guard.mjs');
    rmSync(join(root, '.claude'), { recursive: true });
    rmSync(join(root, 'docs'), { recursive: true });
  });

  test('a trailer exempts only the paths its own commit changed', () => {
    const root = makeRepo({ 'AGENTS.md': 'base\n', 'CLAUDE.md': '@AGENTS.md\n' }, { git: true });
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    const commit = (msg) => git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qam', msg);
    git('init', '-q');
    git('add', '.');
    commit('base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(root, 'AGENTS.md'), 'typo fixed\n');
    commit('Fix typo\n\nHarness-Entry: none — typo');
    assert.deepEqual(ledgerGate(root), []);
    writeFileSync(join(root, 'CLAUDE.md'), '@AGENTS.md\nmore\n');
    commit('Change CLAUDE.md');
    const errs = ledgerGate(root);
    hasError(errs, 'CLAUDE.md');
    assert.ok(!errs.join('').includes('(AGENTS.md'), errs.join('\n'));
    writeFileSync(join(root, 'AGENTS.md'), 'uncommitted\n');
    hasError(ledgerGate(root), 'AGENTS.md');
    git('checkout', '--', 'AGENTS.md');
    writeFileSync(join(root, 'AGENTS.md'), 'real change\n');
    commit('Change AGENTS.md again');
    hasError(ledgerGate(root), 'AGENTS.md');
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
