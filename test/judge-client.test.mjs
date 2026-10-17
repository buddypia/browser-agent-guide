// judge-client (判断AI: TypeSafe Jev / Cloudflare Clef / eg2) の単体テスト。ネットワーク・課金なし(fetch を差し替える)。
// bare node script: `node test/judge-client.test.mjs`

import assert from 'node:assert/strict';
import {
  DEFAULT_JUDGE,
  isJudgeReady,
  validateJudgeBaseUrl,
  buildJudgeRequest,
  parseJudgeAnswer,
  judgeMinConfidence,
  callJudgeChoice,
  callJudgeVisualCheck,
  clefRoute,
} from '../lib/judge-client.js';
import { DEFAULT_SETTINGS } from '../lib/storage.js';
import { normalizeRun, normalizeStep } from '../lib/workflow.js';

const bodyHas = (seen, text) => String(seen.init.body).includes(text);

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
    assert.equal(isJudgeReady({ provider: 'eg2', apiKey: '' }), true);
    assert.equal(isJudgeReady({ ...DEFAULT_JUDGE, provider: 'clef' }), false);
    assert.equal(isJudgeReady({ ...DEFAULT_JUDGE, provider: 'clef', apiKey: 'jev-key' }), false, 'the Jev key is not a Clef route');
    assert.equal(isJudgeReady({ ...DEFAULT_JUDGE, provider: 'clef', clefAccountId: 'a'.repeat(32), clefApiKey: 't' }), true);
    assert.equal(isJudgeReady({ ...DEFAULT_JUDGE, provider: 'clef', clefEndpoint: 'https://clef.example.workers.dev' }), true);
    ok('judge is opt-in and supports jev (with key), clef (with a route) and eg2');
  }

  // Clef の宛先: プロキシ優先、REST はアカウントID(32桁16進)だけをパスに入れる。プロキシも https のみ。
  {
    const acct = '0123456789abcdef0123456789ABCDEF';
    const rest = clefRoute({ clefAccountId: acct, clefApiKey: 'tok', clefModel: 'clef-flash' });
    assert.equal(rest.url, `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/cloudflare/clef-flash`);
    assert.equal(rest.token, 'tok');
    assert.equal(clefRoute({ clefAccountId: acct, clefApiKey: 'tok', clefModel: '../evil' }).model, 'clef');
    assert.equal(clefRoute({ clefAccountId: `${acct}/../x`, clefApiKey: 'tok' }), null);
    assert.equal(clefRoute({ clefAccountId: acct, clefApiKey: '' }), null);
    const proxy = clefRoute({ clefEndpoint: 'https://clef.example.workers.dev/', clefApiKey: 'pk', clefAccountId: acct });
    assert.equal(proxy.url, 'https://clef.example.workers.dev');
    assert.equal(proxy.rest, false);
    assert.match(clefRoute({ clefEndpoint: 'http://clef.example.com' }).error, /Clef endpoint must be https/);
    assert.equal(isJudgeReady({ provider: 'clef', clefEndpoint: 'http://clef.example.com' }), false);
    ok('clef route prefers the proxy and only puts a hex account id in the REST path');
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

    // 範囲外のキーは採らず、pick.choice ではなく確率表の最大で決める。
    const foreign = parseJudgeAnswer({ answers: { pick: { choice: 'evil', confidence: 1, probabilities: { evil: 1, c2: 0.2 } } } }, keys, 0.7);
    assert.equal(foreign.choice, 'c2');
    assert.equal(foreign.confident, false);
    const lying = parseJudgeAnswer({ answers: { pick: { choice: 'c0', probabilities: { c0: 0.1, c1: 0.8, none: 0.1 } } } }, keys, 0.7);
    assert.equal(lying.choice, 'c1');
    ok('answer parsing is closed-set, argmax-based and confidence-gated');
  }

  // 契約外の応答は「該当なし」と誤読せず例外(真実の失敗理由で止める)。
  {
    const keys = ['c0', 'c1'];
    assert.throws(() => parseJudgeAnswer({}, keys), /no usable probabilities/);
    assert.throws(() => parseJudgeAnswer({ answers: { pick: { choice: 'c0', confidence: 0.9 } } }, keys), /no usable/);
    assert.throws(() => parseJudgeAnswer({ answers: { pick: { probabilities: { c0: 85, c1: 15 } } } }, keys), /no usable/, 'percent scale is not trusted');
    assert.throws(() => parseJudgeAnswer({ answers: { pick: { probabilities: { evil: 1 } } } }, keys), /no usable/);
    ok('malformed Jev responses throw instead of reading as "no match"');
  }

  // しきい値の保存値が壊れていたら既定値(空欄を 0 と読んで常に自信ありにしない)。
  {
    assert.equal(judgeMinConfidence({ minConfidence: 0.85 }), 0.85);
    for (const bad of [null, '', '0.9', -1, 2, NaN, undefined]) assert.equal(judgeMinConfidence({ minConfidence: bad }), DEFAULT_JUDGE.minConfidence);
    ok('minConfidence falls back to the default unless it is a number in 0..1');
  }

  // 入力値(変数を埋めた後はパスワード等になりうる)は外部 AI へ送らない。
  {
    const fill = { ...pickStep, action: { verb: 'fill', value: 'hunter2-secret' }, locator: { kind: 'fixed', anchor: { css: '#pw' } }, choice: null };
    const body = JSON.stringify(buildJudgeRequest({ step: fill, candidates: candidates.slice(0, 2), reason: 'missing' }));
    assert.ok(!body.includes('hunter2-secret'), body);
    const sel = { ...fill, action: { verb: 'select', value: 'secret-option' } };
    assert.ok(!JSON.stringify(buildJudgeRequest({ step: sel, candidates, reason: 'missing' })).includes('secret-option'));
    ok('step values are never sent to the judge');
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

  // provider: 'clef' の候補選択: Jev と同じ要求/解釈。REST の {success,result} を開け、失敗は例外。
  {
    let seen;
    const answer = { answers: { pick: { choice: 'c1', probabilities: { c0: 0.01, c1: 0.97, none: 0.02 }, confidence: 0.94 } } };
    const fetchImpl = async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ success: true, result: answer }) };
    };
    const judge = { ...DEFAULT_JUDGE, provider: 'clef', clefAccountId: 'a'.repeat(32), clefApiKey: 'cf-token', clefModel: 'clef-flash' };
    const step = { ...pickStep, action: { verb: 'fill', value: 'hunter2-secret' } };
    const r = await callJudgeChoice({ judge, step, candidates: candidates.slice(0, 2), reason: 'none', url: 'https://shop.example.com/s', title: '検索', fetchImpl });
    assert.match(seen.url, /\/ai\/run\/@cf\/cloudflare\/clef-flash$/);
    assert.equal(seen.init.headers.Authorization, 'Bearer cf-token');
    assert.equal(seen.body.model, 'clef-flash');
    assert.deepEqual(Object.keys(seen.body.questions.pick.criteria), ['c0', 'c1', 'none']);
    assert.ok(!bodyHas(seen, 'hunter2-secret'), 'step values are never sent to Clef');
    assert.deepEqual([r.choice, r.confident, r.model], ['c1', true, 'clef-flash']);

    const proxyJudge = { ...DEFAULT_JUDGE, provider: 'clef', clefEndpoint: 'https://clef.example.workers.dev' };
    await callJudgeChoice({ judge: proxyJudge, step: pickStep, candidates, reason: 'none', fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ ...answer, model: 'clef' }) };
    } });
    assert.equal(seen.url, 'https://clef.example.workers.dev');
    assert.equal(seen.init.headers.Authorization, undefined, 'no bearer without a proxy key');

    await assert.rejects(() => callJudgeChoice({ judge, step: pickStep, candidates, reason: 'none', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }) }), /Clef API error 403/);
    await assert.rejects(() => callJudgeChoice({ judge, step: pickStep, candidates, reason: 'none', fetchImpl: async () => ({ ok: true, json: async () => ({ success: false, errors: [{ message: 'no model' }] }) }) }), /no model/);
    await assert.rejects(() => callJudgeChoice({ judge, step: pickStep, candidates, reason: 'none', fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, result: {} }) }) }), /no usable probabilities/);
    ok('callJudgeChoice supports provider clef (REST and proxy) and fails closed');
  }

  // provider: 'eg2' の候補選択: 高類似度・僅差(保留)・低類似度(none)・秘密の入力値除外・障害時例外
  {
    const seenBodies = [];
    const makeEg2Fetch = (docVecs) => async (_url, init) => {
      const body = JSON.parse(init.body);
      seenBodies.push(body);
      if (body.input_type === 'query') {
        return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
      }
      return {
        ok: true,
        json: async () => ({ data: docVecs.map((v, i) => ({ index: i, embedding: v })) }),
      };
    };
    const judge = { ...DEFAULT_JUDGE, provider: 'eg2', minConfidence: 0.7 };
    const eg2 = { url: 'http://127.0.0.1:38765', model: '270m' };

    // 1) 高類似度で c1 を選ぶ
    const rHigh = await callJudgeChoice({
      judge,
      eg2,
      step: { ...pickStep, action: { verb: 'fill', value: 'top-secret-pw' } },
      candidates,
      reason: 'none',
      fetchImpl: makeEg2Fetch([
        [0.1, 0.99],
        [0.98, 0.2],
      ]),
    });
    assert.equal(rHigh.choice, 'c1');
    assert.equal(rHigh.confident, true);
    assert.equal(rHigh.best, 'c1');
    assert.equal(rHigh.model, 'eg2-270m');
    assert.ok(!JSON.stringify(seenBodies).includes('top-secret-pw'), 'secret action.value must not be sent to eg2');

    // 2) 僅差で迷う場合は confident: false で best を返す
    const rTie = await callJudgeChoice({
      judge,
      eg2,
      step: pickStep,
      candidates: candidates.slice(0, 2),
      reason: 'ambiguous',
      fetchImpl: makeEg2Fetch([
        [0.95, 0.31],
        [0.94, 0.34],
      ]),
    });
    assert.equal(rTie.confident, false);
    assert.equal(rTie.best, 'c0');

    // 3) どの候補とも似ていない (< 0.35) 場合は choice: 'none', confident: true
    const rNone = await callJudgeChoice({
      judge,
      eg2,
      step: pickStep,
      candidates: candidates.slice(0, 2),
      reason: 'none',
      fetchImpl: makeEg2Fetch([
        [0.1, 0.99],
        [0.2, 0.98],
      ]),
    });
    assert.equal(rNone.choice, 'none');
    assert.equal(rNone.confident, true);

    // 4) eg2 エラーは「該当なし」と誤読せず例外にする
    const failingEg2 = async () => ({ ok: false, status: 500, text: async () => 'eg2 down' });
    await assert.rejects(() => callJudgeChoice({ judge, eg2, step: pickStep, candidates, reason: 'none', fetchImpl: failingEg2 }), /eg2/);
    ok('callJudgeChoice supports provider eg2 with confidence/margin gating and secret-free queries');
  }

  // callJudgeVisualCheck: Jev マルチモーダル と eg2 /v1/evaluate の両方で視覚・UI崩れ判定ができる
  {
    let jevReq;
    const jevFetch = async (url, init) => {
      jevReq = { url, headers: init.headers, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({
          model: 'jev-1.14.0',
          answers: { visual: { choice: 'pass', probabilities: { pass: 0.91, fail: 0.09 } } },
        }),
      };
    };
    const vJev = await callJudgeVisualCheck({
      judge: { ...DEFAULT_JUDGE, provider: 'jev', apiKey: 'k', minConfidence: 0.7 },
      imageDataUrl: 'data:image/png;base64,AAAA',
      goal: 'モーダルが閉じ、画面崩れがない',
      fetchImpl: jevFetch,
    });
    assert.equal(vJev.passed, true);
    assert.equal(vJev.provider, 'jev');
    assert.equal(jevReq.headers['TypeSafe-Danger-Zone-Images'], 'true');
    assert.equal(jevReq.body.assets['<image:page>'].url, 'data:image/png;base64,AAAA');

    let eg2Req;
    const eg2Fetch = async (url, init) => {
      eg2Req = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({ choice: 'fail', score: 0.88, scores: { pass: 0.12, fail: 0.88 } }),
      };
    };
    const vEg2 = await callJudgeVisualCheck({
      judge: { ...DEFAULT_JUDGE, provider: 'eg2', minConfidence: 0.7 },
      eg2: { url: 'http://127.0.0.1:38765' },
      imageDataUrl: 'data:image/png;base64,BBBB',
      goal: 'エラーバナーが出ていない',
      fetchImpl: eg2Fetch,
    });
    assert.equal(vEg2.passed, false);
    assert.equal(vEg2.provider, 'eg2');
    assert.equal(eg2Req.url, 'http://127.0.0.1:38765/v1/evaluate');
    assert.deepEqual(eg2Req.body.images, ['BBBB']);

    // provider: 'llm' でも eg2.enabled: true ならローカル eg2 にフォールバックする
    const vFallback = await callJudgeVisualCheck({
      judge: { ...DEFAULT_JUDGE, provider: 'llm', minConfidence: 0.7 },
      eg2: { enabled: true, url: 'http://127.0.0.1:38765' },
      imageDataUrl: 'data:image/png;base64,CCCC',
      goal: '正常表示',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choice: 'pass', score: 0.92, scores: { pass: 0.92, fail: 0.08 } }),
      }),
    });
    assert.equal(vFallback.passed, true);
    assert.equal(vFallback.provider, 'eg2');

    // Clef: 画像は images 配列で渡し、確率表で pass/fail を決める
    let clefReq;
    const vClef = await callJudgeVisualCheck({
      judge: { ...DEFAULT_JUDGE, provider: 'clef', clefEndpoint: 'https://clef.example.workers.dev', clefApiKey: 'pk', minConfidence: 0.7 },
      imageDataUrl: 'data:image/png;base64,EEEE',
      goal: 'レポートのダウンロード完了が表示される',
      fetchImpl: async (url, init) => {
        clefReq = { url, headers: init.headers, body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({ answers: { visual: { choice: 'pass', probabilities: { pass: 0.97, fail: 0.03 } } } }) };
      },
    });
    assert.deepEqual([vClef.passed, vClef.provider, vClef.model], [true, 'clef', 'clef']);
    assert.deepEqual(clefReq.body.images, ['data:image/png;base64,EEEE']);
    assert.equal(clefReq.headers.Authorization, 'Bearer pk');
    assert.match(clefReq.body.questions.visual.instructions, /ダウンロード完了/);

    // Jev も eg2 も未設定なら例外にする
    await assert.rejects(
      () =>
        callJudgeVisualCheck({
          judge: { ...DEFAULT_JUDGE, provider: 'llm' },
          eg2: { enabled: false },
          imageDataUrl: 'data:image/png;base64,DDDD',
          goal: '正常表示',
        }),
      /視覚確認/
    );
    ok('callJudgeVisualCheck supports Jev / Clef multimodal, eg2 fallback, and unconfigured error');
  }

  // 実行セッション/手順メモの新フィールドは保存形を往復できる。
  {
    const r = normalizeRun({ heldKind: 'judge', judgeApprovedStepId: 's1', heldLabel: 'A', approvedLabel: 'B' });
    assert.equal(r.heldKind, 'judge');
    assert.equal(r.judgeApprovedStepId, 's1');
    assert.equal(r.heldLabel, 'A');
    assert.equal(r.approvedLabel, 'B');
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
