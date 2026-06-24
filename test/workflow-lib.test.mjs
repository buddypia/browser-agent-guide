// lib/workflow.js 単体テスト（bare node script: `node test/workflow-lib.test.mjs`）。
// ページ跨ぎワークフローの純データ層(正規化 / ステップ upsert / 削除 / プロンプト用整形)を検証する。

import assert from 'node:assert/strict';
import {
  WORKFLOW_KEY,
  normalizeWorkflow,
  normalizeStep,
  upsertStep,
  removeStepByAnno,
  crossPageWorkflowForPrompt,
} from '../lib/workflow.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`ok - ${name}`);
};

// (0) キーは content/SW と共有する固定値。
{
  assert.equal(WORKFLOW_KEY, 'aiAdvisorWorkflow');
  ok('WORKFLOW_KEY は固定値');
}

// (1) normalizeWorkflow は欠落・型崩れに耐え、既定形へ落とす。
{
  assert.deepEqual(normalizeWorkflow(null), { recording: false, steps: [], saved: [] });
  assert.deepEqual(normalizeWorkflow('garbage'), { recording: false, steps: [], saved: [] });
  const wf = normalizeWorkflow({ recording: true, steps: [null, { text: 'x' }], saved: 'nope' });
  assert.equal(wf.recording, true);
  assert.equal(wf.steps.length, 1);
  assert.equal(wf.steps[0].text, 'x');
  assert.equal(wf.steps[0].kind, 'note'); // 既定 kind
  assert.deepEqual(wf.saved, []);
  ok('normalizeWorkflow は壊れた入力を吸収する');
}

// (2) normalizeStep は kind を note/drawing に限定し、文字列化する。
{
  const s = normalizeStep({ kind: 'drawing', url: 'https://x/p', text: 5, target: null });
  assert.equal(s.kind, 'drawing');
  assert.equal(s.url, 'https://x/p');
  assert.equal(s.text, '5'); // 数値は文字列化
  assert.equal(s.target, ''); // null は空文字
  assert.equal(normalizeStep({ kind: 'weird' }).kind, 'note'); // 未知 kind は note へ
  ok('normalizeStep は kind と型を正規化する');
}

// (3) upsertStep は annoId 一致で更新、無ければ末尾追加（=記録順を保つ）。
{
  let steps = [];
  steps = upsertStep(steps, { annoId: 'a1', text: '1番目', url: 'https://x/a' });
  steps = upsertStep(steps, { annoId: 'a2', text: '2番目', url: 'https://x/b' });
  assert.equal(steps.length, 2);
  // 同じ annoId は更新（追加されない）。
  steps = upsertStep(steps, { annoId: 'a1', text: '1番目(改)', url: 'https://x/a' });
  assert.equal(steps.length, 2);
  assert.equal(steps[0].text, '1番目(改)');
  // annoId 無しは常に追加。
  steps = upsertStep(steps, { text: '匿名', url: 'https://x/c' });
  assert.equal(steps.length, 3);
  ok('upsertStep は annoId で冪等、無ければ追加');
}

// (4) removeStepByAnno は該当 annoId のステップだけ落とす。
{
  const steps = [
    { annoId: 'a1', text: '1' },
    { annoId: 'a2', text: '2' },
  ];
  const next = removeStepByAnno(steps, 'a1');
  assert.equal(next.length, 1);
  assert.equal(next[0].annoId, 'a2');
  ok('removeStepByAnno は該当ステップを除去');
}

// (5) crossPageWorkflowForPrompt は本文/対象が空のステップを落とし、order を 1 起点で振る。
{
  const out = crossPageWorkflowForPrompt({
    steps: [
      { url: 'https://site/p1', text: 'ページ1でメモ', target: '送信ボタン', kind: 'note' },
      { url: 'https://site/p2', text: '', target: '', kind: 'note' }, // 空 → 落ちる
      { url: 'https://site/p3', text: 'ページ3でメモ', kind: 'drawing' },
    ],
  });
  assert.equal(out.count, 2);
  assert.deepEqual(out.steps.map((s) => s.order), [1, 2]);
  assert.equal(out.steps[0].url, 'https://site/p1');
  assert.equal(out.steps[1].text, 'ページ3でメモ');
  ok('crossPageWorkflowForPrompt は空を除外し order を振る');
}

// (6) ステップが1件も無ければ null（プロンプトに節を出さない）。
{
  assert.equal(crossPageWorkflowForPrompt(null), null);
  assert.equal(crossPageWorkflowForPrompt({ steps: [{ text: '', target: '' }] }), null);
  ok('実体ステップ無しは null');
}

console.log(`\n${passed} passed`);
