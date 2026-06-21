// 学習レシピのマージ（lib/recipe-merge.js）の単体テスト（bare node script: `node test/recipe-merge.test.mjs`）。
// 目的:
//  (1) mergeRecipeActions が when/waitFor を保持すること（以前は剥がれていた — AGENTS.md の既知の制約）。
//  (2) 既存の手編集アクション（when/waitFor 付き）がマージで壊れないこと。
//  (3) 重複判定が verb+args(+when+waitFor) で行われ、画面別アクションが誤って統合されないこと。
//  (4) when/waitFor を持たないアクションのキーは従来と byte 同一（後方互換）。

import assert from 'node:assert/strict';
import { mergeRecipeActions, recipeKey, cleanCondition, cleanWaitFor } from '../lib/recipe-merge.js';

const RECIPE_VERBS = new Set(['injectHtml', 'injectCss', 'injectScript', 'outlineElement', 'injectButton', 'injectPanel']);

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok - ${name}`);
}

// (1) when を持つ取り込みアクションが保持される（剥がれない）。
{
  const merged = mergeRecipeActions(
    [],
    [{ verb: 'injectHtml', args: { id: 'x', html: '<p>a</p>' }, reason: 'r', when: { urlContains: '#/orders' } }],
    RECIPE_VERBS
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].when, { urlContains: '#/orders' });
  ok('when を持つ取り込みアクションが永続化される');
}

// (2) waitFor を持つ取り込みアクションが保持される（timeoutMs 含む）。
{
  const merged = mergeRecipeActions(
    [],
    [{ verb: 'injectHtml', args: { id: 'x' }, waitFor: { selector: '#async', timeoutMs: 8000 } }],
    RECIPE_VERBS
  );
  assert.deepEqual(merged[0].waitFor, { selector: '#async', timeoutMs: 8000 });
  ok('waitFor を持つ取り込みアクションが永続化される');
}

// (3) 既存の手編集アクション（when 付き）はそのまま保持される。
{
  const existing = [{ verb: 'injectHtml', args: { id: 'x' }, reason: 'hand', when: { selectorAbsent: '[data-bag-injected="x"]' } }];
  const merged = mergeRecipeActions(existing, [{ verb: 'injectCss', args: { id: 'y', css: 'a{}' } }], RECIPE_VERBS);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], existing[0]); // 手編集アクションが byte 同一で残る
  ok('既存の手編集 when 付きアクションがマージで壊れない');
}

// (4) 画面別: 同 verb/args で when が異なる2アクションは両方残る（誤統合しない）。
{
  const merged = mergeRecipeActions(
    [],
    [
      { verb: 'injectButton', args: { label: 'A' }, when: { urlContains: '#/orders' } },
      { verb: 'injectButton', args: { label: 'A' }, when: { urlContains: '#/cart' } },
    ],
    RECIPE_VERBS
  );
  assert.equal(merged.length, 2);
  ok('when が異なる同一 verb/args は別アクションとして両方残る');
}

// (5) 完全一致（verb/args/when すべて同じ）は重複排除されて1つ。
{
  const a = { verb: 'injectButton', args: { label: 'A' }, when: { urlContains: '#/orders' } };
  const merged = mergeRecipeActions([], [a, { ...a }], RECIPE_VERBS);
  assert.equal(merged.length, 1);
  ok('verb/args/when 完全一致は重複排除される');
}

// (6) recipeVerbs 外の verb は永続化しない。
{
  const merged = mergeRecipeActions([], [{ verb: 'removeElement', args: {} }], RECIPE_VERBS);
  assert.equal(merged.length, 0);
  ok('許可外 verb は永続化されない');
}

// (7) 後方互換: when/waitFor を持たないアクションのキーは従来フォーマット {verb,args} と同一。
{
  const legacy = JSON.stringify({ verb: 'injectHtml', args: { a: 1, b: 2 } });
  // キー順に依存しないこと（sortKeys）も同時に確認。
  assert.equal(recipeKey({ verb: 'injectHtml', args: { b: 2, a: 1 } }), legacy);
  ok('when/waitFor 無しのキーは従来フォーマットと byte 同一（後方互換）');
}

// (8) 不正な when / selector 無し waitFor は付与しない。
{
  assert.equal(cleanCondition({ unknownKey: 'v' }), null);
  assert.equal(cleanCondition({}), null);
  assert.equal(cleanWaitFor({ timeoutMs: 1000 }), null); // selector 無し
  const merged = mergeRecipeActions([], [{ verb: 'injectHtml', args: {}, when: {}, waitFor: { timeoutMs: 1 } }], RECIPE_VERBS);
  assert.equal('when' in merged[0], false);
  assert.equal('waitFor' in merged[0], false);
  ok('空/不正な when・selector 無し waitFor は付与しない');
}

// (9) 既存と同 verb/args だが when 付きの取り込みは「別物」として追加される
//     （既存=when無し と 取り込み=when有り のキーが異なるため）。
{
  const existing = [{ verb: 'injectHtml', args: { id: 'x' }, reason: 'base' }];
  const merged = mergeRecipeActions(existing, [{ verb: 'injectHtml', args: { id: 'x' }, when: { urlContains: '#/a' } }], RECIPE_VERBS);
  assert.equal(merged.length, 2);
  ok('when 有無でキーが分かれ、画面別の上乗せが追加される');
}

console.log(`\n${passed} passed`);
