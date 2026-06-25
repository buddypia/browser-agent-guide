// lib/workflow.js 単体テスト（bare node script: `node test/workflow-lib.test.mjs`）。
// ページ跨ぎワークフローの純データ層(正規化 / ステップ upsert / 削除 / プロンプト用整形)を検証する。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WORKFLOW_KEY,
  RUN_KEY,
  normalizeWorkflow,
  normalizeStep,
  upsertStep,
  removeStepByAnno,
  crossPageWorkflowForPrompt,
  normalizeRun,
  samePageUrl,
  actionableSteps,
  pendingStepsForUrl,
  isRunComplete,
  isIrreversibleLabel,
  IRREVERSIBLE_KEYWORDS,
  AUTORUN_ALLOWED_VERBS,
  isAutoRunVerbAllowed,
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

// ===== 自動実行(セッション)関連 =====

// (7) RUN_KEY 固定 + normalizeRun が壊れた入力を吸収。
{
  assert.equal(RUN_KEY, 'aiAdvisorWorkflowRun');
  assert.deepEqual(normalizeRun(null), { active: false, doneStepIds: [], tabId: null, navCount: 0, startedAt: '' });
  const r = normalizeRun({ active: true, doneStepIds: ['a', 1, 'b'], tabId: 7, navCount: 3, startedAt: 't' });
  assert.equal(r.active, true);
  assert.deepEqual(r.doneStepIds, ['a', 'b']); // 非文字列は落とす
  assert.equal(r.tabId, 7);
  assert.equal(r.navCount, 3);
  assert.equal(normalizeRun({ tabId: 'x', navCount: -2 }).tabId, null); // 不正値は既定へ
  assert.equal(normalizeRun({ navCount: -2 }).navCount, 0);
  ok('normalizeRun は実行セッションを正規化する');
}

// (8) samePageUrl は origin+pathname で比較(query/hash 無視)。
{
  assert.equal(samePageUrl('https://x.com/a?q=1', 'https://x.com/a#h'), true);
  assert.equal(samePageUrl('https://x.com/a', 'https://x.com/b'), false);
  assert.equal(samePageUrl('https://x.com/a', 'https://y.com/a'), false);
  ok('samePageUrl は origin+pathname 一致を見る');
}

// (9) actionableSteps は本文のある手順だけ。
{
  const wf = { steps: [{ text: 'やる', url: 'u1' }, { text: '', url: 'u2' }, { text: '  ', url: 'u3' }] };
  assert.equal(actionableSteps(wf).length, 1);
  ok('actionableSteps は本文のある手順のみ');
}

// (10) pendingStepsForUrl: 未実行 & URL一致のみ。
{
  const wf = {
    steps: [
      { id: 's1', text: 'p1手順', url: 'https://shop/item', pattern: 'https://shop/item' },
      { id: 's2', text: 'p2手順', url: 'https://shop/cart', pattern: 'https://shop/cart' },
    ],
  };
  const run = { active: true, doneStepIds: ['s1'] };
  const p1 = pendingStepsForUrl(wf, run, 'https://shop/item?x=1');
  assert.equal(p1.length, 0, 's1 は done なので出ない');
  const p2 = pendingStepsForUrl(wf, run, 'https://shop/cart');
  assert.equal(p2.length, 1);
  assert.equal(p2[0].id, 's2');
  ok('pendingStepsForUrl は未実行かつURL一致のみ返す');
}

// (11) isRunComplete: 全 actionable が done なら true。
{
  const wf = { steps: [{ id: 's1', text: 'a' }, { id: 's2', text: 'b' }] };
  assert.equal(isRunComplete(wf, { doneStepIds: ['s1'] }), false);
  assert.equal(isRunComplete(wf, { doneStepIds: ['s1', 's2'] }), true);
  assert.equal(isRunComplete({ steps: [] }, { doneStepIds: [] }), true);
  ok('isRunComplete は全手順実行で true');
}

// (12) isIrreversibleLabel: 購入/確定/送金/同意/continue 等(広めの確定動線)を検出、無害語は false。
{
  for (const yes of [
    '注文を確定する', '今すぐ購入', '今すぐ買う', '確認', '続ける', '次へ', '送金する', '課金する',
    'Place your order', 'Checkout', 'アカウントを削除', 'Submit payment', 'Continue', 'Proceed', 'Subscribe', 'Remove item',
  ]) {
    assert.equal(isIrreversibleLabel(yes), true, `「${yes}」は不可逆/確定系`);
  }
  for (const no of ['カートに入れる', '数量を更新', 'Add to cart', '戻る', '閉じる', 'Close']) {
    assert.equal(isIrreversibleLabel(no), false, `「${no}」は無害`);
  }
  assert.equal(isIrreversibleLabel(''), false);
  ok('isIrreversibleLabel は確定/不可逆系を広めに検出する');
}

// (13) autorun allow-list は安全動詞のみ。危険動詞は拒否、必要動詞は許可。
{
  for (const danger of ['navigateTo', 'submitForm', 'injectScript', 'injectHtml', 'removeElement', 'setStyle', 'goBack', 'addWorkflowStep']) {
    assert.equal(isAutoRunVerbAllowed(danger), false, `${danger} は autorun 不許可`);
  }
  for (const ok2 of ['clickAffordance', 'clickElement', 'fillAffordance', 'fillInput', 'selectOption', 'readText', 'scrollToElement']) {
    assert.equal(isAutoRunVerbAllowed(ok2), true, `${ok2} は autorun 許可`);
  }
  ok('AUTORUN_ALLOWED_VERBS は deny-by-default で危険動詞を排除する');
}

// (14) パリティ: content-script.js 内蔵コピーが lib の定義と一致する(drift 防止)。
{
  const src = fs.readFileSync(new URL('../content/content-script.js', import.meta.url), 'utf8');
  const extract = (marker) => {
    const i = src.indexOf(marker);
    assert.ok(i >= 0, `${marker} が content に存在する`);
    const open = src.indexOf('[', i);
    const close = src.indexOf(']', open);
    return [...src.slice(open + 1, close).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  };
  assert.deepEqual(extract('const IRREVERSIBLE_KEYWORDS'), IRREVERSIBLE_KEYWORDS, 'keyword リスト一致');
  assert.deepEqual(extract('const AUTORUN_ALLOWED_VERBS'), AUTORUN_ALLOWED_VERBS, 'allow-list 一致');
  ok('content と lib の autorun 定義はパリティが取れている');
}

console.log(`\n${passed} passed`);
