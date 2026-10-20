// harness2 由来のハーネス検証(scripts/check-harness.mjs)、同期ペア検査(scripts/check-sync-pairs.mjs)、
// それを編集直後に回す PostToolUse フック(.claude/hooks/post-edit-invariants.mjs)のテスト。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALWAYS_ON_MAX, validateHarness } from '../scripts/check-harness.mjs';
import { checkSyncPairs } from '../scripts/check-sync-pairs.mjs';

globalThis.__HOOK_ORCHESTRATOR__ = true;
const { run } = await import('../.claude/hooks/post-edit-invariants.mjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'harness-'));
  made.push(root);
  mkdirSync(join(root, '.git'));
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const TRIGGER = '- When demo work, read .agents/skills/demo/SKILL.md and follow it.\n';
const SKILL = '---\nname: demo\ndescription: Demo skill.\n---\n\nRun `bash ${CLAUDE_SKILL_DIR}/scripts/go.sh` first.\n';
const codexHooks = (event, hook) => JSON.stringify({ hooks: { [event]: [{ matcher: 'Edit', hooks: [hook] }] } });
const BASE = {
  'AGENTS.md': `## Skills\n${TRIGGER}\nMake sure to read it.\n\n\`\`\`bash\nnpm run check\nmake q.check\n\`\`\`\n`,
  'CLAUDE.md': '@AGENTS.md\n',
  'package.json': JSON.stringify({ scripts: { check: 'true' } }),
  Makefile: 'q.check:\n\t@true\n',
  '.agents/skills/demo/SKILL.md': SKILL,
  '.agents/skills/demo/scripts/go.sh': 'echo ok\n',
  '.codex/hooks.json': codexHooks('PostToolUse', { type: 'command', command: 'node "$(git rev-parse --show-toplevel)/.claude/hooks/a.mjs"' }),
  '.claude/hooks/a.mjs': '',
  'scripts/check-harness.mjs': '',
};
const errorsFor = (overrides) => validateHarness(makeRepo({ ...BASE, ...overrides })).errors;
const hasError = (errors, needle) => assert.ok(errors.some((e) => e.includes(needle)), `expected "${needle}" in:\n${errors.join('\n')}`);

describe('check-harness', () => {
  test('this repository passes', () => {
    const { errors, alwaysOnChars } = validateHarness(ROOT);
    assert.deepEqual(errors, []);
    assert.ok(alwaysOnChars <= ALWAYS_ON_MAX);
  });

  test('a minimal valid harness passes (prose "make sure" is not a make target)', () => {
    assert.deepEqual(errorsFor({}), []);
  });

  test('the CLI still fails when run through a symlinked path', () => {
    const copy = (rel) => readFileSync(join(ROOT, rel));
    const root = makeRepo({ ...BASE, 'AGENTS.md': '', 'scripts/check-harness.mjs': copy('scripts/check-harness.mjs'), 'scripts/harness-library.mjs': copy('scripts/harness-library.mjs') });
    const link = join(mkdtempSync(join(tmpdir(), 'harness-link-')), 'repo');
    made.push(dirname(link));
    symlinkSync(root, link);
    const r = spawnSync(process.execPath, [join(link, 'scripts/check-harness.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /missing or empty/);
  });

  test('AGENTS.md: cap, empty, Jinja, CLAUDE.md import', () => {
    hasError(errorsFor({ 'AGENTS.md': TRIGGER + 'x'.repeat(ALWAYS_ON_MAX) }), 'over the 8000 cap');
    hasError(errorsFor({ 'AGENTS.md': '' }), 'missing or empty');
    hasError(errorsFor({ 'AGENTS.md': `${TRIGGER}{{ name }}` }), 'Jinja');
    hasError(errorsFor({ 'CLAUDE.md': '@AGENTS.md\nAlso do this.\n' }), 'CLAUDE.md must stay');
  });

  test('skills: trigger line, frontmatter, allowed-tools, SKILL.md presence', () => {
    hasError(errorsFor({ 'AGENTS.md': 'No skills here.\n' }), 'skill "demo" is never named');
    hasError(errorsFor({ '.agents/skills/demo/SKILL.md': SKILL.replace('name: demo', 'name: other') }), '`name: other` overrides');
    hasError(errorsFor({ '.agents/skills/demo/SKILL.md': SKILL.replace('description: Demo skill.\n', '') }), 'needs a `description:`');
    hasError(errorsFor({ '.agents/skills/demo/SKILL.md': SKILL.replace('Demo skill.', 'Demo: skill.') }), 'plain YAML value');
    assert.deepEqual(errorsFor({ '.agents/skills/demo/SKILL.md': SKILL.replace('Demo skill.', '"Demo: skill."') }), []);
    const tools = errorsFor({ '.agents/skills/demo/SKILL.md': SKILL.replace('---\n\n', 'allowed-tools: Read Edit Bash(bash *) Bash(rg *)\n---\n\n') });
    hasError(tools, 'pre-approves `Edit`');
    hasError(tools, 'pre-approves `Bash(bash *)`');
    assert.ok(!tools.some((e) => e.includes('Bash(rg *)')));
    hasError(errorsFor({ '.agents/skills/empty/notes.md': 'x' }), 'has no SKILL.md');
    hasError(errorsFor({ 'AGENTS.md': `${TRIGGER}- When y, read .agents/skills/ghost/SKILL.md and follow it.\n` }), '.agents/skills/ghost/SKILL.md, which does not exist');
  });

  test('named scripts, npm scripts and make targets must exist', () => {
    hasError(errorsFor({ '.agents/skills/demo/scripts/go.sh': null }), 'invokes `.agents/skills/demo/scripts/go.sh`');
    hasError(errorsFor({ 'AGENTS.md': `${TRIGGER}Run \`npm run nope\`.\n` }), '`npm run nope`');
    hasError(errorsFor({ 'AGENTS.md': `${TRIGGER}Run \`make -C <wt> nope\`.\n` }), '`make nope`');
    hasError(errorsFor({ 'AGENTS.md': `${TRIGGER}Run \`node scripts/missing.mjs\`.\n` }), 'invokes `scripts/missing.mjs`');
  });

  test('hook files: Codex schema and command targets', () => {
    hasError(errorsFor({ '.codex/hooks.json': codexHooks('AfterTool', { type: 'command', command: 'true' }) }), 'unknown event "AfterTool"');
    hasError(errorsFor({ '.codex/hooks.json': codexHooks('PostToolUse', { type: 'prompt', prompt: 'x' }) }), 'must be "command"');
    hasError(errorsFor({ '.codex/hooks.json': '{"hooks": {}}' }), 'needs a top-level');
    hasError(errorsFor({ '.codex/hooks.json': '{' }), 'not valid JSON');
    hasError(errorsFor({ '.claude/hooks/a.mjs': null }), 'runs `.claude/hooks/a.mjs` but that file does not exist');
  });
});

describe('check-sync-pairs', () => {
  const recipe = (verbs) => `const SAFE_RECIPE_VERBS = new Set([${verbs.map((v) => `'${v}'`).join(', ')}]);\n`;
  const sw = (verbs) => `const RECIPE_VERBS = new Set([${verbs.map((v) => `'${v}'`).join(', ')}]);\n`;
  const pairs = (o = {}) =>
    makeRepo({
      'lib/slug.js': 'export const a = 1;\n',
      'daemon/src/slug.js': 'export const a = 1;\n',
      'options/options.js': recipe(['injectHtml', 'injectCss']),
      'background/service-worker.js': sw(['injectCss', 'injectHtml']),
      'content/content-script.js': "  const AGENT_ALLOWED_VERBS = new Set([\n    'readText', 'noop',\n  ]);\n",
      'daemon/src/server.js': "export const EXECUTE_ACTIONS_VERBS = [\n  'readText', 'noop',\n];\n",
      ...o,
    });

  test('this repository passes', () => assert.deepEqual(checkSyncPairs(ROOT), []));

  test('order-insensitive recipe lists pass; drift is reported per pair', () => {
    assert.deepEqual(checkSyncPairs(pairs()), []);
    hasError(checkSyncPairs(pairs({ 'daemon/src/slug.js': 'export const a = 2;\n' })), 'byte-identical');
    hasError(checkSyncPairs(pairs({ 'background/service-worker.js': sw(['injectHtml', 'injectCss', 'setStyle']) })), 'only in RECIPE_VERBS: [setStyle]');
    hasError(checkSyncPairs(pairs({ 'daemon/src/server.js': "export const EXECUTE_ACTIONS_VERBS = ['noop', 'readText'];\n" })), 'different order');
  });

  test('touched limits the check to pairs containing the edited file', () => {
    const root = pairs({ 'daemon/src/slug.js': 'drift\n' });
    assert.equal(checkSyncPairs(root, { touched: ['lib/slug.js'] }).length, 1);
    assert.deepEqual(checkSyncPairs(root, { touched: ['lib/prompt.js'] }), []);
  });
});

describe('post-edit-invariants hook', () => {
  const edit = (root, rel) => ({ tool_name: 'Edit', tool_input: { file_path: join(root, rel) }, cwd: root });

  test('blocks with the harness reason after an AGENTS.md edit breaks the cap', async () => {
    const root = makeRepo({ ...BASE, 'AGENTS.md': TRIGGER + 'x'.repeat(ALWAYS_ON_MAX) });
    const out = await run(edit(root, 'AGENTS.md'));
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /over the 8000 cap/);
    assert.match(out.reason, /harness-rules\/SKILL\.md/);
  });

  test('passes through unrelated edits and checkouts of other projects', async () => {
    const root = makeRepo({ ...BASE, 'AGENTS.md': TRIGGER + 'x'.repeat(ALWAYS_ON_MAX), 'src/a.js': '' });
    assert.deepEqual(await run(edit(root, 'src/a.js')), {});
    const other = makeRepo({ ...BASE, 'AGENTS.md': '', 'scripts/check-harness.mjs': null });
    assert.deepEqual(await run(edit(other, 'AGENTS.md')), {});
    assert.deepEqual(await run({ tool_name: 'Read', tool_input: { file_path: join(root, 'AGENTS.md') } }), {});
  });

  test('reports a broken import in an edited hook (hooks fail OPEN on one)', async () => {
    const root = makeRepo({ ...BASE, '.claude/hooks/broken.mjs': "import x from './nope.mjs';\n" });
    const out = await run(edit(root, '.claude/hooks/broken.mjs'));
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /unresolved import '\.\/nope\.mjs'/);
  });

  test('reads Codex apply_patch targets and reports a sync-pair drift', async () => {
    const root = makeRepo({ ...BASE, 'lib/slug.js': 'a\n', 'daemon/src/slug.js': 'b\n' });
    const out = await run({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: lib/slug.js\n@@\n-a\n+a\n*** End Patch\n' }, cwd: root });
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /lib\/slug\.js ⇔ daemon\/src\/slug\.js: must stay byte-identical/);
  });
});
