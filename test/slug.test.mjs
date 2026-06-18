// slug 生成の単体テスト（bare node script: `node test/slug.test.mjs`）。
// 目的:
//  (1) 拡張(lib/slug.js)とデーモン(daemon/src/slug.js)が「同一内容」で複製されている前提を守る
//      → 同じ入力から同じフォルダー名を生成することを検証（ドリフト検出）。
//  (2) フォーマット/サニタイズ/ソート性/決定性のリグレッションガード。
// 決定的に評価するため TZ=UTC に固定する（stamp はローカル時刻なので固定しないと環境依存になる）。
process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import * as ext from '../lib/slug.js';
import * as dmn from '../daemon/src/slug.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`ok - ${name}`);
}

// 多様な入力（ASCII / 日本語 / 絵文字 / 空タイトル / 変な URL / 不正 ISO）。
const CASES = [
  { capturedAt: '2026-06-18T02:03:04.005Z', url: 'https://example.com/e2e', title: 'E2E' },
  { capturedAt: '2026-06-18T10:29:00.000Z', url: 'https://www.example.com/sales', title: 'Sales Dashboard | Acme' },
  { capturedAt: '2026-01-02T03:04:05.006Z', url: 'https://app.notion.so/x', title: '' },
  { capturedAt: '2026-12-31T23:59:59.000Z', url: 'https://日本語.example/パス', title: 'ダッシュボード🚀' },
  { capturedAt: 'not-a-date', url: 'not a url', title: 'CON' },
  { capturedAt: '2026-06-18T09:09:09.000Z', url: '', title: undefined },
];

// (1) 拡張とデーモンの出力が完全一致すること（複製ドリフト検出の要）。
for (const c of CASES) {
  assert.equal(
    ext.slugFromCapture(c),
    dmn.slugFromCapture(c),
    `ext と daemon の slug が一致しない: ${JSON.stringify(c)}`
  );
  // 補助関数レベルでも一致を確認。
  assert.equal(ext.stampFromIso(c.capturedAt), dmn.stampFromIso(c.capturedAt));
  assert.equal(ext.hostSlug(c.url), dmn.hostSlug(c.url));
  assert.equal(ext.sanitizeToken(c.title, 24), dmn.sanitizeToken(c.title, 24));
  assert.equal(ext.shortHash(`${c.capturedAt}\n${c.url}`), dmn.shortHash(`${c.capturedAt}\n${c.url}`));
}
ok('拡張とデーモンの slug が全ケースでバイト一致（複製ドリフトなし）');

// (2) 既知入力 → 既知の正確な名前（TZ=UTC 固定なので stamp も決定的）。
assert.equal(
  ext.slugFromCapture({ capturedAt: '2026-06-18T02:03:04.005Z', url: 'https://example.com/e2e', title: 'E2E' }),
  '20260618-020304__example-com__e2e__0x8scuf'
);
ok('既知入力がゴールデンな名前を生成');

// (3) フォーマット: {YYYYMMDD-HHMMSS}__{host}__{title}__{id 7字}。全セグメントは [a-z0-9-]、id は [a-z0-9]{7}。
const FORMAT = /^\d{8}-\d{6}__[a-z0-9-]+__[a-z0-9-]+__[a-z0-9]{7}$/;
for (const c of CASES) {
  const name = ext.slugFromCapture(c);
  assert.match(name, FORMAT, `フォーマット不一致: ${name}`);
  // 区切り '__' は各セグメント内に出現しない（4 セグメントちょうど）。
  assert.equal(name.split('__').length, 4, `セグメント数が4でない: ${name}`);
  // 不正文字（: * ? " < > | スペース等）が一切無い。
  assert.match(name, /^[a-z0-9_-]+$/, `不正文字を含む: ${name}`);
}
ok('フォーマット/区切り/文字集合が安全');

// (4) Windows 予約名（CON/NUL...）がフルネームとして出ない（中間セグメントに留まる）。
const reserved = ext.slugFromCapture({ capturedAt: '2026-06-18T02:03:04.005Z', url: 'https://x', title: 'CON' });
assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(reserved), `予約名がフルネームに: ${reserved}`);
ok('Windows 予約名がフルフォルダー名にならない');

// (5) 決定性: 同じ入力は同じ名前。
const a = ext.slugFromCapture(CASES[0]);
const b = ext.slugFromCapture(CASES[0]);
assert.equal(a, b);
ok('決定的（同入力→同出力）');

// (6) 辞書順ソート == 時系列（固定長 stamp 先頭）。
const stamps = [
  ext.stampFromIso('2026-06-18T10:29:00.000Z'),
  ext.stampFromIso('2026-01-02T03:04:05.006Z'),
  ext.stampFromIso('2026-12-31T23:59:59.000Z'),
  ext.stampFromIso('2026-06-18T10:28:59.000Z'),
];
const sorted = [...stamps].sort();
assert.deepEqual(sorted, ['20260102-030405', '20260618-102859', '20260618-102900', '20261231-235959']);
ok('辞書順ソート == 時系列');

// (7) 長さの上限（最悪 82 字程度）が現実的な範囲。
for (const c of CASES) {
  assert.ok(ext.slugFromCapture(c).length <= 90, 'フォルダー名が長すぎる');
}
ok('フォルダー名長が妥当');

console.log(`\n# slug tests: ${passed} ok`);
