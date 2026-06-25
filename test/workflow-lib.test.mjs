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
  scopeKeyForUrl,
  actionableSteps,
  pendingStepsForUrl,
  isRunComplete,
  isAutoRunNavLoop,
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

// (9) actionableSteps は本文 or 対象のある手順だけ(本文の無いお描き/対象だけの手順も拾う)。
{
  const wf = { steps: [{ text: 'やる', url: 'u1' }, { text: '', url: 'u2' }, { text: '  ', url: 'u3' }] };
  assert.equal(actionableSteps(wf).length, 1);
  // 本文は空でも対象(target)があれば実行対象として残す(crossPageWorkflowForPrompt と判定を揃える)。
  const wf2 = {
    steps: [
      { text: '', target: '送信ボタン', url: 'u1', kind: 'drawing' }, // 対象だけ → 残る
      { text: '', target: '', url: 'u2', kind: 'drawing' }, // 本文も対象も無い → 落ちる
    ],
  };
  assert.equal(actionableSteps(wf2).length, 1, '対象だけのお描き手順は残す');
  assert.equal(actionableSteps(wf2)[0].url, 'u1');
  ok('actionableSteps は本文 or 対象のある手順のみ');
}

// (10) pendingStepsForUrl: 未実行 & URL一致のみ。記録 pattern と着地URLの正規化ズレも吸収する。
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
  // Amazon: 記録 pattern は /dp/ASIN へ短縮されるが、着地 URL は /Title/dp/ASIN/ref=… になる。
  // live URL も scopeKeyForUrl で正規化して突き合わせるので、これでも未実行手順を取りこぼさない。
  const amz = {
    steps: [{ id: 'a1', text: 'カートに入れる', url: 'https://www.amazon.co.jp/dp/B0ABCDEFGH', pattern: 'https://www.amazon.co.jp/dp/B0ABCDEFGH' }],
  };
  const pa = pendingStepsForUrl(amz, { active: true, doneStepIds: [] }, 'https://www.amazon.co.jp/Some-Title/dp/B0ABCDEFGH/ref=sr_1_1?keywords=x');
  assert.equal(pa.length, 1, 'Amazon の /dp/ASIN/ref=… でも pattern と一致して pending に出る');
  assert.equal(pa[0].id, 'a1');
  ok('pendingStepsForUrl は未実行かつURL一致(正規化込み)のみ返す');
}

// (11) isRunComplete: 全 actionable が done なら true。
{
  const wf = { steps: [{ id: 's1', text: 'a' }, { id: 's2', text: 'b' }] };
  assert.equal(isRunComplete(wf, { doneStepIds: ['s1'] }), false);
  assert.equal(isRunComplete(wf, { doneStepIds: ['s1', 's2'] }), true);
  assert.equal(isRunComplete({ steps: [] }, { doneStepIds: [] }), true);
  ok('isRunComplete は全手順実行で true');
}

// (12) isIrreversibleLabel: 購入/確定/送金/同意/削除 等(真に不可逆な確定動線)だけを検出する。
// ★ページ送り語(次へ/続ける/続行/進む/continue/proceed/next)は held しない=跨ぎを止めない。
{
  for (const yes of [
    '注文を確定する', '今すぐ購入', '今すぐ買う', '確認', '送金する', '課金する',
    'Place your order', 'Checkout', 'アカウントを削除', 'Submit payment', 'Subscribe', 'Remove item',
  ]) {
    assert.equal(isIrreversibleLabel(yes), true, `「${yes}」は不可逆/確定系`);
  }
  // ページ送り/前進ボタンは「不可逆」ではない(これらを held すると複数ページ手順が最初のページで止まる)。
  for (const no of [
    'カートに入れる', '数量を更新', 'Add to cart', '戻る', '閉じる', 'Close',
    '次へ', '続ける', '続行', '進む', 'Continue', 'Proceed', 'Next', 'Go to next step',
  ]) {
    assert.equal(isIrreversibleLabel(no), false, `「${no}」はページ送り/無害でhold対象外`);
  }
  assert.equal(isIrreversibleLabel(''), false);
  ok('isIrreversibleLabel は真の確定/不可逆系のみ検出し、ページ送り語は通す');
}

// (12b) scopeKeyForUrl: content の annotationScopeKey と同じ正規化(Amazon は /dp/ASIN へ短縮)。
{
  assert.equal(scopeKeyForUrl('https://x.com/a?q=1#h'), 'https://x.com/a', 'origin+pathname へ正規化');
  assert.equal(
    scopeKeyForUrl('https://www.amazon.co.jp/Some-Title/dp/B0ABCDEFGH/ref=sr_1_1?keywords=x'),
    'https://www.amazon.co.jp/dp/B0ABCDEFGH',
    'Amazon 商品ページは /dp/ASIN へ短縮',
  );
  // 既に正規化済みキーを通しても変わらない(冪等)。
  assert.equal(scopeKeyForUrl('https://www.amazon.co.jp/dp/B0ABCDEFGH'), 'https://www.amazon.co.jp/dp/B0ABCDEFGH', '冪等');
  assert.equal(scopeKeyForUrl('not a url'), 'not a url', '不正URLは入力をそのまま返す');
  ok('scopeKeyForUrl は記録時 pattern と同じ正規化を行う');
}

// (12c) isAutoRunNavLoop: 前進していれば同一URLでも遷移を許可、未前進で同一URLへ再遷移のみループ判定。
{
  assert.equal(isAutoRunNavLoop({ candidateUrl: 'u1', lastNavUrl: 'u1', madeProgress: false }), true, '未前進で同一URLはループ');
  assert.equal(isAutoRunNavLoop({ candidateUrl: 'u1', lastNavUrl: 'u1', madeProgress: true }), false, '前進していれば同一URLでも許可');
  assert.equal(isAutoRunNavLoop({ candidateUrl: 'u2', lastNavUrl: 'u1', madeProgress: false }), false, '別URLはループでない');
  assert.equal(isAutoRunNavLoop({ candidateUrl: 'u1', lastNavUrl: undefined, madeProgress: false }), false, 'lastNav未設定はループでない');
  ok('isAutoRunNavLoop は未前進の同一URL再遷移だけをループ判定する');
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
