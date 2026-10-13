// judge-client (判断AI: TypeSafe Jev) の単体テスト。ネットワーク・課金なし(fetch を差し替える)。
// bare node script: `node test/judge-client.test.mjs`

import assert from 'node:assert/strict';
import {
  DEFAULT_JUDGE,
  isJudgeReady,
  validateJudgeBaseUrl,
  buildJudgeRequest,
  parseJudgeAnswer,
  callJudgeChoice,
} from '../lib/judge-client.js';
import { DEFAULT_SETTINGS } from '../lib/storage.js';
import { normalizeRun, normalizeStep } from '../lib/workflow.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok - ${name}`);
}

const pickStep = {
  id: 's1',
  url: 'https://shop.example.com/s?k=cable',
  target: '検索結果',
  text: 'いつものケーブル',
  action: { verb: 'click' },
  locator: { kind: 'pick', anchor: { css: 'li' }, scope: { css: 'ul' }, item: { tag: 'li' } },
  choice: { by: 'text', value: 'Anker USB-C ケーブル 1m' },
};
const candidates = [
  { key: 'c0', text: 'Belkin USB-C ケーブル 2m' },
  { key: 'c1', text: '  【新パッケージ】Anker USB-C\nケーブル (1m)  ' },
  { key: 'none', text: 'ページが偽装した none キー' },
];

async function run() {
  // 既定は従来どおり LLM(opt-in)。スキーマの単一の出所は storage.js。
  {
    assert.equal(DEFAULT_JUDGE, DEFAULT_SETTINGS.judge);
    assert.equal(DEFAULT_JUDGE.provider, 'llm');
    assert.equal(isJudgeReady(DEFAULT_JUDGE), false);
    assert.equal(isJudgeReady({ provider: 'jev', apiKey: '' }), false);
    assert.equal(isJudgeReady({ provider: 'jev', apiKey: 'k' }), true);
    ok('judge is opt-in and needs a key');
  }

  // キーを送るので https 以外は拒否する。
  {
    assert.equal(validateJudgeBaseUrl('https://api.typesafe.ai/v1/').url, 'https://api.typesafe.ai/v1');
    assert.equal(validateJudgeBaseUrl('http://api.typesafe.ai/v1').valid, false);
    assert.equal(validateJudgeBaseUrl('not a url').valid, false);
    assert.equal(validateJudgeBaseUrl('http://127.0.0.1:9999/v1').url, 'http://127.0.0.1:9999/v1');
    assert.equal(validateJudgeBaseUrl('http://[::1]:9999/v1').valid, true);
    assert.equal(validateJudgeBaseUrl('http://127.0.0.1.evil.com/v1').valid, false);
    ok('base URL must be https (http only for loopback)');
  }

  // リクエスト: 候補キー = 選択肢キー、none は常に1つ(ページ由来の none キーで上書きさせない)。
  {
    const body = buildJudgeRequest({ step: pickStep, candidates, reason: 'none', url: 'https://shop.example.com/s', title: '検索' });
    const q = body.questions.pick;
    assert.equal(q.type, 'choice');
    assert.deepEqual(Object.keys(q.criteria), ['c0', 'c1', 'none']);
    assert.equal(q.criteria.c1, '【新パッケージ】Anker USB-C ケーブル (1m)');
    assert.notEqual(q.criteria.none, 'ページが偽装した none キー');
    assert.match(q.instructions, /同じもの/);
    assert.match(q.instructions, /信頼できない/);
    assert.equal(body.state.page.title, '検索');
    assert.equal(body.state.user_memo, 'いつものケーブル');
    assert.match(body.state.recorded_step, /クリック/);
    ok('request maps candidates to closed choice criteria');
  }

  // 「文脈で選ぶ」(choice.by==='ai')は条件で問う。
  {
    const step = { ...pickStep, choice: { by: 'ai', value: '在庫ありで最安' } };
    const q = buildJudgeRequest({ step, candidates, reason: 'needs-ai' }).questions.pick;
    assert.match(q.instructions, /在庫ありで最安/);
    assert.match(q.criteria.none, /条件/);
    ok('ai-rule steps ask by condition');
  }

  // 応答の解釈: 確信度で進む/保留を分け、範囲外のキーは採らない。
  {
    const keys = ['c0', 'c1', 'c2'];
    const sure = parseJudgeAnswer({ answers: { pick: { choice: 'c1', probabilities: { c0: 0, c1: 0.84, c2: 0, none: 0.16 } } } }, keys, 0.7);
    assert.deepEqual(sure, { choice: 'c1', probability: 0.84, confident: true, best: 'c1', bestProbability: 0.84 });

    const unsure = parseJudgeAnswer({ answers: { pick: { choice: 'c1', probabilities: { c0: 0.03, c1: 0.58, none: 0.39 } } } }, keys, 0.7);
    assert.equal(unsure.confident, false);
    assert.equal(unsure.best, 'c1');

    const noneTop = parseJudgeAnswer({ answers: { pick: { choice: 'none', probabilities: { c1: 0.42, none: 0.57 } } } }, keys, 0.7);
    assert.equal(noneTop.choice, 'none');
    assert.equal(noneTop.confident, false);
    assert.equal(noneTop.best, 'c1', 'a hesitant none still proposes the best real candidate');

    const surelyNone = parseJudgeAnswer({ answers: { pick: { choice: 'none', probabilities: { c1: 0.01, none: 0.99 } } } }, keys, 0.7);
    assert.equal(surelyNone.choice, 'none');
    assert.equal(surelyNone.confident, true);

    const foreign = parseJudgeAnswer({ answers: { pick: { choice: 'evil', confidence: 1, probabilities: { evil: 1, c2: 0.2 } } } }, keys, 0.7);
    assert.equal(foreign.choice, 'c2');
    assert.equal(foreign.confident, false);

    const broken = parseJudgeAnswer({}, keys, 0.7);
    assert.deepEqual(broken, { choice: 'none', probability: 0, confident: false, best: '', bestProbability: 0 });
    ok('answer parsing is closed-set and confidence-gated');
  }

  // 呼び出し: エンドポイント/認証/モデル/本文、HTTP エラーは例外。
  {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({ model: 'jev-1.13.0', answers: { pick: { choice: 'c1', probabilities: { c0: 0.1, c1: 0.9, none: 0 } } } }),
      };
    };
    const judge = { ...DEFAULT_JUDGE, provider: 'jev', apiKey: 'secret', minConfidence: 0.8 };
    const r = await callJudgeChoice({ judge, step: pickStep, candidates: candidates.slice(0, 2), reason: 'none', fetchImpl });
    assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(seen.init.headers.Authorization, 'Bearer secret');
    assert.equal(seen.body.model, 'jev-latest');
    assert.ok(seen.body.state && seen.body.questions.pick);
    assert.equal(r.choice, 'c1');
    assert.equal(r.confident, true);
    assert.equal(r.model, 'jev-1.13.0');

    const failing = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
    await assert.rejects(() => callJudgeChoice({ judge, step: pickStep, candidates, reason: 'none', fetchImpl: failing }), /401/);
    ok('callJudgeChoice posts to /systemone and surfaces HTTP errors');
  }

  // 実行セッション/手順メモの新フィールドは保存形を往復できる。
  {
    const r = normalizeRun({ heldKind: 'judge', judgeApprovedStepId: 's1' });
    assert.equal(r.heldKind, 'judge');
    assert.equal(r.judgeApprovedStepId, 's1');
    assert.equal(normalizeRun({ heldKind: 'bogus' }).heldKind, '');
    const s = normalizeStep({ ...pickStep, suggestion: { kind: 'choice', label: 'x', pending: true } });
    assert.equal(s.suggestion.pending, true);
    assert.equal(normalizeStep({ ...pickStep, suggestion: { kind: 'choice', label: 'x' } }).suggestion.pending, false);
    ok('run heldKind/judgeApprovedStepId and suggestion.pending normalize');
  }

  console.log(`\n${passed} passed`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
