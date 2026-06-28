// frontmatter STRICT パーサの単体テスト。node --test で実行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, splitFrontmatter } from '../../scripts/glossary/lib/frontmatter.mjs';

test('スカラー / 引用符 / 日付', () => {
  const { data } = parseFrontmatter('---\nid: verb-registry\nterm: "A / B"\nlast_verified: 2026-06-28\n---\nbody\n');
  assert.equal(data.id, 'verb-registry');
  assert.equal(data.term, 'A / B');
  assert.equal(data.last_verified, '2026-06-28');
});

test('インラインリスト / 空リスト', () => {
  const { data } = parseFrontmatter('---\naliases: ["x", "y"]\ndeprecated_terms: []\n---\n');
  assert.deepEqual(data.aliases, ['x', 'y']);
  assert.deepEqual(data.deprecated_terms, []);
});

test('シーケンス(インラインマップ要素) — 値内の URL/コロンを保持', () => {
  const text = '---\ncode_refs:\n  - { path: "a/b.js", symbol: "AI_VERBS" }\n  - { path: "c.js" }\n---\n';
  const { data } = parseFrontmatter(text);
  assert.equal(data.code_refs.length, 2);
  assert.deepEqual(data.code_refs[0], { path: 'a/b.js', symbol: 'AI_VERBS' });
  assert.deepEqual(data.code_refs[1], { path: 'c.js' });
});

test('ネストしたサブマップ(progress)と URL 値', () => {
  const text = '---\nprogress:\n  state: shipped\n  tracking: "https://example.com/issues/12#a"\n---\n';
  const { data } = parseFrontmatter(text);
  assert.deepEqual(data.progress, { state: 'shipped', tracking: 'https://example.com/issues/12#a' });
});

test('行頭コメントと空行は無視する', () => {
  const { data } = parseFrontmatter('---\n# comment\n\nid: x\n---\n');
  assert.equal(data.id, 'x');
});

test('body を正しく切り出す', () => {
  const { body } = parseFrontmatter('---\nid: x\n---\n## 定義\n本文\n');
  assert.match(body, /## 定義/);
});

test('frontmatter が無ければ splitFrontmatter は raw=null', () => {
  assert.equal(splitFrontmatter('no frontmatter').raw, null);
});

test('STRICT: frontmatter 欠如は throw', () => {
  assert.throws(() => parseFrontmatter('no frontmatter'), /frontmatter/);
});

test('STRICT: 閉じない引用符は throw', () => {
  assert.throws(() => parseFrontmatter('---\nterm: "unclosed\n---\n'), /引用符/);
});

test('STRICT: マップとシーケンスの混在は throw', () => {
  assert.throws(() => parseFrontmatter('---\nx:\n  - a\n  k: v\n---\n'), /混在/);
});

test('STRICT: トップレベルが key: でなければ throw', () => {
  assert.throws(() => parseFrontmatter('---\nnot a key line\n---\n'), /key:/);
});
