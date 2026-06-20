import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectProblems } from '../../check-hook-refs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .claude/scripts/lib/__tests__
const REPO_ROOT = resolve(HERE, '../../../..'); // repo root

test('POSITIVE: the real .claude hooks + scripts tree has 0 dangling references (no false positives)', () => {
  const problems = collectProblems(
    [join(REPO_ROOT, '.claude/hooks'), join(REPO_ROOT, '.claude/scripts')],
    REPO_ROOT,
  );
  assert.deepEqual(problems, [], `expected no dangling refs, got:\n${problems.join('\n')}`);
});

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'bag-hookrefs-'));
  try {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('NEGATIVE: catches an unresolved import AND a dangling .claude path literal', () => {
  withFixture((root) => {
    writeFileSync(
      join(root, 'hooks', 'bad.mjs'),
      "import { x } from './ghost.mjs';\nconst cmd = 'node .claude/scripts/deleted-thing.mjs --foo';\n",
    );
    const problems = collectProblems([join(root, 'hooks')], root);
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.ok(problems.some((p) => p.includes("unresolved import './ghost.mjs'")));
    assert.ok(problems.some((p) => p.includes('dangling .claude path literal') && p.includes('deleted-thing.mjs')));
  });
});

test('POSITIVE: a resolvable relative import is not flagged', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'hooks', 'real.mjs'), 'export const y = 1;\n');
    writeFileSync(join(root, 'hooks', 'good.mjs'), "import { y } from './real.mjs';\n");
    const problems = collectProblems([join(root, 'hooks')], root);
    assert.deepEqual(problems, []);
  });
});

test('NO FALSE POSITIVE: commented-out imports / block comments are ignored', () => {
  withFixture((root) => {
    writeFileSync(
      join(root, 'hooks', 'commented.mjs'),
      "// import { z } from './ghost-commented.mjs';\n/* import './block-ghost.mjs'; */\nexport const a = 1;\n",
    );
    const problems = collectProblems([join(root, 'hooks')], root);
    assert.deepEqual(problems, []);
  });
});

test('multi-line import specifiers are parsed (newline-spanning import head)', () => {
  withFixture((root) => {
    writeFileSync(join(root, 'hooks', 'dep.mjs'), 'export const a = 1;\nexport const b = 2;\n');
    writeFileSync(
      join(root, 'hooks', 'multiline.mjs'),
      'import {\n  a,\n  b,\n} from "./dep.mjs";\n',
    );
    writeFileSync(
      join(root, 'hooks', 'multiline-bad.mjs'),
      'import {\n  a,\n  b,\n} from "./nope.mjs";\n',
    );
    const problems = collectProblems([join(root, 'hooks')], root);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.ok(problems[0].includes("unresolved import './nope.mjs'"));
  });
});
