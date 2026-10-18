// ai-client の候補選択(callAIChoice)の単体テスト。ネットワーク・課金なし(globalThis.fetch を差し替える)。
// bare node script: `node test/ai-client.test.mjs`

import assert from 'node:assert/strict';
import { callAIChoice } from '../lib/ai-client.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok - ${name}`);
}

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const ai = { provider: 'custom', apiKey: 'k', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' };
const messages = [{ role: 'user', content: 'pick' }];

// (1) 応答しない呼び出しは上限で打ち切って失敗にする(自動実行が「実行中」のまま止まり続けない)。
{
  let calls = 0;
  globalThis.fetch = (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  console.warn = () => {};
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout のタイマーはプロセスを生かさない
  try {
    const started = Date.now();
    await assert.rejects(callAIChoice({ ai, messages, keys: ['c0'], timeoutMs: 50 }), (e) => e.name === 'TimeoutError');
    assert.equal(calls, 2); // 1回だけ再試行する
    assert.ok(Date.now() - started < 2000);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
  ok('callAIChoice は応答の無い呼び出しを timeoutMs で打ち切る');
}

// (2) 通常の応答は enum に閉じた選択として返す(enum 外は none)。
{
  const reply = (content) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  try {
    globalThis.fetch = reply(JSON.stringify({ choice: 'none', reason: '価格情報がない' }));
    assert.deepEqual(await callAIChoice({ ai, messages, keys: ['c0', 'c1'] }), { choice: 'none', reason: '価格情報がない' });
    globalThis.fetch = reply(JSON.stringify({ choice: 'c9', reason: 'x' }));
    assert.equal((await callAIChoice({ ai, messages, keys: ['c0', 'c1'] })).choice, 'none');
  } finally {
    globalThis.fetch = realFetch;
  }
  ok('callAIChoice は候補キーか none だけを返す');
}

console.log(`\n${passed} passed`);
