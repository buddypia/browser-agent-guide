// check-staleness.mjs の統合テスト。一時 git リポジトリで「コードを直したら用語更新」の
// 失敗経路と成功経路を実証する。これがメカニズムの心臓部の保証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'glossary', 'check-staleness.mjs');

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function write(repo, rel, content) {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// check-staleness をモード指定で実行し {code, out} を返す。
function runStaleness(repo, mode) {
  try {
    const out = execFileSync('node', [SCRIPT, mode], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function setupRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'glossary-stale-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  // ガード範囲付きのコード
  write(repo, 'lib/foo.mjs', [
    'export function foo() {',
    '  // @term: widget',
    '  return 1;',
    '  // @endterm: widget',
    '}',
    '',
  ].join('\n'));
  // 対応する用語エントリ
  write(repo, 'glossary/x/widget.md', [
    '---',
    'id: widget',
    'term: "Widget"',
    'status: stable',
    'owner: "@me"',
    'bounded_context: x',
    'last_verified: 2026-01-01',
    'confidence: high',
    '---',
    '## 定義',
    'widget.',
    '',
  ].join('\n'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

test('コードのガード範囲を変えて用語を更新しない → 失敗(exit 1)', () => {
  const repo = setupRepo();
  try {
    // ガード範囲内(return 行)を変更、用語は触らない
    write(repo, 'lib/foo.mjs', [
      'export function foo() {',
      '  // @term: widget',
      '  return 2;',           // 変更
      '  // @endterm: widget',
      '}',
      '',
    ].join('\n'));
    const r = runStaleness(repo, '--working');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /widget/);
    assert.match(r.out, /last_verified/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('コードのガード範囲を変え、用語の last_verified も前進 → 成功(exit 0)', () => {
  const repo = setupRepo();
  try {
    write(repo, 'lib/foo.mjs', [
      'export function foo() {',
      '  // @term: widget',
      '  return 2;',
      '  // @endterm: widget',
      '}',
      '',
    ].join('\n'));
    write(repo, 'glossary/x/widget.md', [
      '---', 'id: widget', 'term: "Widget"', 'status: stable', 'owner: "@me"',
      'bounded_context: x', 'last_verified: 2026-06-28', 'confidence: high', '---',
      '## 定義', 'widget (再検証済み).', '',
    ].join('\n'));
    const r = runStaleness(repo, '--working');
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('ガード範囲外のコード変更は用語更新を要求しない(誤検出しない)', () => {
  const repo = setupRepo();
  try {
    // ガード範囲の外(関数の外)に行を足す
    write(repo, 'lib/foo.mjs', [
      'export function foo() {',
      '  // @term: widget',
      '  return 1;',
      '  // @endterm: widget',
      '}',
      'export const unrelated = 99;', // 範囲外
      '',
    ].join('\n'));
    const r = runStaleness(repo, '--working');
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('--staged: ステージした変更だけを見る', () => {
  const repo = setupRepo();
  try {
    write(repo, 'lib/foo.mjs', [
      'export function foo() {',
      '  // @term: widget',
      '  return 3;',
      '  // @endterm: widget',
      '}',
      '',
    ].join('\n'));
    git(repo, ['add', 'lib/foo.mjs']); // コードだけステージ、用語は未更新
    const r1 = runStaleness(repo, '--staged');
    assert.equal(r1.code, 1, r1.out);
    // 用語も更新してステージ
    write(repo, 'glossary/x/widget.md', [
      '---', 'id: widget', 'term: "Widget"', 'status: stable', 'owner: "@me"',
      'bounded_context: x', 'last_verified: 2026-06-28', 'confidence: high', '---',
      '## 定義', 'widget.', '',
    ].join('\n'));
    git(repo, ['add', '-A']);
    const r2 = runStaleness(repo, '--staged');
    assert.equal(r2.code, 0, r2.out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
