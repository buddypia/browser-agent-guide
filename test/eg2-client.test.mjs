// eg2-client (EmbeddingGemma 2 高速マッチング) の単体テスト。
// bare node script: `node test/eg2-client.test.mjs`

import assert from 'node:assert/strict';
import {
  DEFAULT_EG2_URL,
  validateEg2Url,
  cosineSimilarity,
  checkEg2Health,
  embedTextsWithEg2,
  matchAffordanceFastPath,
  resolveFastPathAction,
} from '../lib/eg2-client.js';
import { DEFAULT_SETTINGS, migrateEg2 } from '../lib/storage.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok - ${name}`);
}

async function runTests() {
  // 1. validateEg2Url: SSRF ガード & URL 形式検証
  {
    const v1 = validateEg2Url('http://127.0.0.1:8765');
    assert.equal(v1.valid, true);
    assert.equal(v1.url, 'http://127.0.0.1:8765');

    const v2 = validateEg2Url('http://localhost:8765/foo/bar');
    assert.equal(v2.valid, true);
    assert.equal(v2.url, 'http://localhost:8765');

    const v3 = validateEg2Url('http://[::1]:8765');
    assert.equal(v3.valid, true);

    const v4 = validateEg2Url('https://127.0.0.1:8766');
    assert.equal(v4.valid, true);

    // SSRF 拒絶テスト
    const v5 = validateEg2Url('http://192.168.1.1:8765');
    assert.equal(v5.valid, false);
    assert.match(v5.error, /loopback/);

    const v6 = validateEg2Url('http://google.com');
    assert.equal(v6.valid, false);

    const v7 = validateEg2Url('ftp://127.0.0.1:8765');
    assert.equal(v7.valid, false);
    assert.match(v7.error, /protocol/);

    assert.equal(validateEg2Url('').valid, false);
    assert.equal(validateEg2Url(null).valid, false);

    ok('validateEg2Url validates loopback addresses and blocks SSRF targets');
  }

  // 2. cosineSimilarity
  {
    // 同一ベクトル
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
    assert.equal(cosineSimilarity([0, 3, 0], [0, 5, 0]), 1);

    // 直交ベクトル
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);

    // 逆向きベクトル
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);

    // 45度
    const s = cosineSimilarity([1, 1], [1, 0]);
    assert(Math.abs(s - Math.SQRT1_2) < 1e-6);

    // 空配列・不整合
    assert.equal(cosineSimilarity([], []), 0);
    assert.equal(cosineSimilarity([1, 2], [1]), 0);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);

    ok('cosineSimilarity computes standard cosine similarity correctly');
  }

  // 3. resolveFastPathAction
  {
    const aff = { aiId: 'button#1', text: 'カートに入れる' };

    // クリック意図
    const a1 = resolveFastPathAction('カートに入れるボタンを押して', aff);
    assert.deepEqual(a1, {
      verb: 'clickAffordance',
      args: { aiId: 'button#1' },
      reason: 'System 1 (eg2) 高速マッチング: "button#1" を特定して即時クリック',
    });

    const a2 = resolveFastPathAction('次へをクリック', aff);
    assert.equal(a2.verb, 'clickAffordance');

    const a3 = resolveFastPathAction('Submit button tap', aff);
    assert.equal(a3.verb, 'clickAffordance');

    // 入力意図（Fast Path は引数文字列の解析を要するため、callAI に委ねる）
    const a4 = resolveFastPathAction('検索窓にテキストを入力して', aff);
    assert.equal(a4, null);

    // 不正な要素
    assert.equal(resolveFastPathAction('クリック', null), null);
    assert.equal(resolveFastPathAction('クリック', {}), null);

    ok('resolveFastPathAction generates clickAffordance for click intents and returns null for fill');
  }

  // 4. matchAffordanceFastPath (モック fetch による判定ロジック検証)
  {
    const originalFetch = globalThis.fetch;
    try {
      // (a) 高信頼度マッチのシミュレーション
      // query: [1, 0]
      // doc1:  [0.99, 0.1] (高スコア)
      // doc2:  [0.1, 0.99] (低スコア)
      globalThis.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.input_type === 'query') {
          return {
            ok: true,
            json: async () => ({
              data: [{ index: 0, embedding: [1, 0] }],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: [
              { index: 0, embedding: [0.99, 0.1] },
              { index: 1, embedding: [0.1, 0.99] },
            ],
          }),
        };
      };

      const res1 = await matchAffordanceFastPath({
        query: 'カートに入れる',
        affordances: [
          { aiId: 'button#1', label: 'カートに入れる' },
          { aiId: 'button#2', label: 'キャンセル' },
        ],
      });
      assert.equal(res1.matched, true);
      assert.equal(res1.best.aiId, 'button#1');
      assert(res1.score > 0.9);
      assert(res1.margin > 0.5);

      // (b) 曖昧なケース（1位と2位が僅差: margin 不足）
      globalThis.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.input_type === 'query') {
          return {
            ok: true,
            json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: [
              { index: 0, embedding: [0.95, 0.1] },
              { index: 1, embedding: [0.93, 0.1] },
            ],
          }),
        };
      };

      const res2 = await matchAffordanceFastPath({
        query: 'ボタン',
        affordances: [
          { aiId: 'button#1', label: '保存' },
          { aiId: 'button#2', label: '保存して閉じる' },
        ],
        margin: 0.08,
      });
      assert.equal(res2.matched, false);
      assert.match(res2.reason, /Below threshold or ambiguous/);

      // (c) サーバーエラー時の安全なフォールバック
      globalThis.fetch = async () => ({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      const res3 = await matchAffordanceFastPath({
        query: '検索',
        affordances: [{ aiId: 'button#1', label: '検索' }],
      });
      assert.equal(res3.matched, false);
      assert.match(res3.reason, /failed to embed/);

      // (d) 空の入力
      const res4 = await matchAffordanceFastPath({ query: '', affordances: [] });
      assert.equal(res4.matched, false);

      ok('matchAffordanceFastPath identifies best affordance with threshold/margin and gracefully falls back');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 5. checkEg2Health
  {
    const originalFetch = globalThis.fetch;
    try {
      // 正常
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ status: 'ok' }),
      });
      const h1 = await checkEg2Health({ url: 'http://127.0.0.1:8765' });
      assert.equal(h1.ok, true);
      assert.equal(h1.status, 'ok');

      // 404 / 500
      globalThis.fetch = async () => ({
        ok: false,
        status: 500,
      });
      const h2 = await checkEg2Health({ url: 'http://127.0.0.1:8765' });
      assert.equal(h2.ok, false);
      assert.match(h2.error, /HTTP 500/);

      // 不正な URL (SSRF)
      const h3 = await checkEg2Health({ url: 'http://10.0.0.1:8765' });
      assert.equal(h3.ok, false);
      assert.match(h3.error, /loopback/);

      ok('checkEg2Health verifies server status and handles failures');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 6. 既定 URL はデーモン既定ポート (8765) と衝突しない。旧既定のまま保存された設定は新既定で読む
  {
    assert.equal(DEFAULT_EG2_URL, 'http://127.0.0.1:38765');
    assert.equal(DEFAULT_SETTINGS.eg2.url, DEFAULT_EG2_URL);
    assert.equal(migrateEg2({ enabled: true, url: 'http://127.0.0.1:8765' }).url, DEFAULT_EG2_URL);
    assert.equal(migrateEg2({ enabled: true, url: 'http://localhost:9999' }).url, 'http://localhost:9999');
    // 新しい保存値 (urlVersion あり) で明示的に選んだ 8765 は書き換えない
    assert.equal(migrateEg2({ url: 'http://127.0.0.1:8765', urlVersion: 2 }).url, 'http://127.0.0.1:8765');
    assert.equal(migrateEg2(undefined).url, DEFAULT_EG2_URL);
    assert.equal(migrateEg2({}).model, DEFAULT_SETTINGS.eg2.model);
    ok('eg2 default URL avoids the daemon port and legacy saved URL migrates');
  }

  console.log(`\nAll ${passed} tests passed.`);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
