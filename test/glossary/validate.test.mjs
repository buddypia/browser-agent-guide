// validate.mjs の統合テスト。一時ディレクトリに良/不良の用語集を作って exit code を検証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'glossary', 'validate.mjs');

function write(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function runValidate(dir) {
  try {
    const out = execFileSync('node', [SCRIPT], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GLOSSARY_FRESH_DAYS: '9999999' },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function goodEntry() {
  return [
    '---', 'id: widget', 'term: "Widget"', 'status: stable', 'owner: "@me"',
    'bounded_context: x', 'last_verified: 2026-06-28', 'confidence: high',
    'source_refs:', '  - { type: doc, path: "docs/x.md" }',
    'code_refs:', '  - { path: "lib/foo.mjs", symbol: "WIDGET" }',
    'related: []', '---', '## 定義', 'w.', '',
  ].join('\n');
}

function setupGood() {
  const dir = mkdtempSync(join(tmpdir(), 'glossary-val-'));
  write(dir, 'docs/x.md', '# x\n');
  write(dir, 'lib/foo.mjs', 'export const WIDGET = 1;\n');
  write(dir, 'glossary/x/widget.md', goodEntry());
  return dir;
}

test('正しい用語集は exit 0', () => {
  const dir = setupGood();
  try {
    const r = runValidate(dir);
    assert.equal(r.code, 0, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('必須フィールド欠落は exit 1', () => {
  const dir = setupGood();
  try {
    write(dir, 'glossary/x/widget.md', goodEntry().replace('owner: "@me"\n', ''));
    const r = runValidate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /owner/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('code_refs.symbol がファイルに無いと exit 1', () => {
  const dir = setupGood();
  try {
    write(dir, 'lib/foo.mjs', 'export const OTHER = 1;\n'); // WIDGET を消す
    const r = runValidate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /symbol/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('related の孤立リンクは exit 1', () => {
  const dir = setupGood();
  try {
    write(dir, 'glossary/x/widget.md', goodEntry().replace('related: []', 'related: ["ghost"]'));
    const r = runValidate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /孤立/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('id とファイル名の不一致は exit 1', () => {
  const dir = setupGood();
  try {
    write(dir, 'glossary/x/widget.md', goodEntry().replace('id: widget', 'id: other'));
    const r = runValidate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /ファイル名|bounded_context|id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
