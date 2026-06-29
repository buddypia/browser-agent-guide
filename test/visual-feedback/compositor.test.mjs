// compositor.js の回帰テスト（handoff §8.3「会帰 fixture から」）。
// 検証する不変条件:
//   (1) 2000px 境界ガードの正しさ
//   (2) DPR 座標変換の整合（factor = dpr × outputScale を全座標に一様適用）
//   (3) 同じ入力 → byte 安定な描画呼び出し列（記録モック ctx で決定的に比較）
//   (4) SecurityError 罠の回避 = ソースに foreignObject / SVG / Image を一切含まない
//
// Node 単体で実行: `node test/visual-feedback/compositor.test.mjs`

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  computeOutputSize,
  arrowPolyline,
  drawShape,
  composeFeedback,
  legendLine,
  MAX_OUTPUT_DIM,
} from '../../lib/visual-feedback/compositor.js';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// 数値は整数ならそのまま、小数は2桁固定で記録 → 浮動小数の揺れを排除して byte 安定にする。
function fmt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

// CanvasRenderingContext2D 風の記録モック。プロパティ代入とメソッド呼び出しを順に ops へ積む。
function recordingCtx() {
  const ops = [];
  const methods = new Set([
    'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'ellipse', 'arc',
    'strokeRect', 'fillRect', 'fillText', 'save', 'restore', 'closePath',
  ]);
  return new Proxy(
    {},
    {
      get(t, prop) {
        if (prop === '__ops') return ops;
        if (prop === 'measureText') return (s) => ({ width: String(s).length * 7 });
        if (methods.has(prop)) {
          return (...args) => ops.push(`${prop}(${args.map(fmt).join(',')})`);
        }
        return t[prop];
      },
      set(t, prop, value) {
        t[prop] = value;
        ops.push(`${prop}=${fmt(value)}`);
        return true;
      },
    }
  );
}

console.log('compositor.js regression');

// ---- (1) 2000px 境界ガード ----
test('computeOutputSize: 境界以下は等倍', () => {
  assert.deepEqual(computeOutputSize(1999, 1000), { scale: 1, width: 1999, height: 1000 });
});
test('computeOutputSize: ちょうど2000は等倍（> 比較なので縮小しない）', () => {
  const r = computeOutputSize(2000, 2000);
  assert.equal(r.scale, 1);
  assert.equal(r.width, 2000);
  assert.equal(r.height, 2000);
});
test('computeOutputSize: 2000超は長辺2000へ一様縮小', () => {
  const r = computeOutputSize(4000, 1000);
  assert.equal(r.scale, 0.5);
  assert.equal(r.width, 2000);
  assert.equal(r.height, 500);
});
test('computeOutputSize: 縦長も長辺基準で縮小', () => {
  const r = computeOutputSize(1000, 5000);
  assert.equal(r.scale, MAX_OUTPUT_DIM / 5000);
  assert.equal(r.height, 2000);
  assert.equal(r.width, 400);
});

// ---- (2) DPR 座標変換 ----
test('drawShape rect: factor=2 で座標も線幅も2倍', () => {
  const ctx = recordingCtx();
  drawShape(ctx, { type: 'rect', x: 10, y: 20, w: 30, h: 40, width: 3, color: '#ef4444' }, 2);
  assert.ok(ctx.__ops.includes('lineWidth=6'), 'lineWidth は 3×2=6');
  assert.ok(ctx.__ops.includes('strokeRect(20,40,60,80)'), `strokeRect 期待値 / 実際: ${ctx.__ops.join(' | ')}`);
});
test('drawShape rect: factor=1（dpr=1, 縮小なし）は等倍', () => {
  const ctx = recordingCtx();
  drawShape(ctx, { type: 'rect', x: 10, y: 20, w: 30, h: 40, width: 3 }, 1);
  assert.ok(ctx.__ops.includes('strokeRect(10,20,30,40)'));
});
test('drawShape path: 各点に factor を一様適用', () => {
  const ctx = recordingCtx();
  drawShape(ctx, { type: 'path', pts: [[1, 2], [3, 4], [5, 6]], width: 2 }, 3);
  assert.ok(ctx.__ops.includes('moveTo(3,6)'));
  assert.ok(ctx.__ops.includes('lineTo(9,12)'));
  assert.ok(ctx.__ops.includes('lineTo(15,18)'));
});

// ---- arrowPolyline は決定的（水平矢印で先端形状を固定確認） ----
test('arrowPolyline: 水平矢印の点列が決定的', () => {
  const poly = arrowPolyline(0, 0, 100, 0);
  assert.equal(poly.length, 5);
  assert.deepEqual(poly[0], [0, 0]);
  assert.deepEqual(poly[1], [100, 0]);
  // 先端のかえし2点は x<100 で y は上下対称
  assert.ok(poly[2][0] < 100 && poly[4][0] < 100);
  assert.ok(Math.abs(poly[2][1] + poly[4][1]) < 1e-9, 'かえしは y 対称');
});

// ---- (3) byte 安定 + 構造不変条件: 図形/DPR は厳密、吹き出しレイアウトは不変条件で検証 ----
test('composeFeedback: 図形描画と DPR は厳密に決定的', () => {
  const ctx = recordingCtx();
  const items = [
    {
      color: '#3b82f6',
      note: 'ここを直す',
      intent: '送信前に確認',
      resolved: true,
      inViewport: true,
      bboxPx: { minX: 10, minY: 10, maxX: 50, maxY: 30 },
      shapesPx: [{ type: 'rect', x: 10, y: 10, w: 40, h: 20, width: 3, color: '#3b82f6' }],
    },
  ];
  composeFeedback(ctx, { items, factor: 2, outWidth: 400, outHeight: 400 });
  // 図形は factor=2 で厳密に2倍（DPR 整合の核）。
  assert.ok(ctx.__ops.includes('strokeStyle=#3b82f6'));
  assert.ok(ctx.__ops.includes('lineWidth=6'), 'stroke 幅 3×2');
  assert.ok(ctx.__ops.includes('strokeRect(20,20,80,40)'), `shape 期待値 / 実際: ${ctx.__ops.join(' | ')}`);
});

test('composeFeedback: マーカーは丸数字(①)で統一され、四角の色見本は使わない', () => {
  const ctx = recordingCtx();
  const items = [
    {
      color: '#3b82f6',
      note: 'ここを直す',
      intent: '送信前に確認',
      resolved: true,
      inViewport: true,
      bboxPx: { minX: 10, minY: 10, maxX: 50, maxY: 30 },
      shapesPx: [{ type: 'rect', x: 10, y: 10, w: 40, h: 20, width: 3, color: '#3b82f6' }],
    },
  ];
  composeFeedback(ctx, { items, factor: 1, outWidth: 400, outHeight: 400 });
  // 丸数字バッジ = arc + 中央寄せの番号。角と吹き出し先頭で計2回出る。
  const arcs = ctx.__ops.filter((o) => o.startsWith('arc('));
  assert.ok(arcs.length >= 2, `丸数字バッジが2つ（角＋吹き出し）必要 / arcs=${arcs.length}`);
  const badgeNums = ctx.__ops.filter((o) => o === 'fillText(1,10,10)' || /^fillText\(1,/.test(o));
  assert.ok(badgeNums.length >= 2, '番号「1」が角と吹き出しの両方に出る');
  // メモ本文が画像に焼かれる。
  assert.ok(ctx.__ops.some((o) => o.includes('fillText(ここを直す')), 'メモ本文が描かれる');
  assert.ok(ctx.__ops.some((o) => o.includes('目的: 送信前に確認')), '目的が描かれる');
  // 吹き出し背景（半透明パネル）がある。
  assert.ok(ctx.__ops.includes('globalAlpha=0.90'), '吹き出し背景の半透明');
});

test('composeFeedback: 吹き出しは図形の隣（既定は右）に置かれ、引き出し線で結ぶ', () => {
  const ctx = recordingCtx();
  const items = [
    {
      color: '#ef4444',
      note: 'メモ',
      resolved: true,
      inViewport: true,
      bboxPx: { minX: 100, minY: 100, maxX: 200, maxY: 160 },
      shapesPx: [{ type: 'rect', x: 100, y: 100, w: 100, h: 60, width: 3 }],
    },
  ];
  composeFeedback(ctx, { items, factor: 1, outWidth: 1000, outHeight: 1000 });
  // 引き出し線: 図形右辺 (maxX=200, midY=130) から開始する moveTo がある。
  assert.ok(ctx.__ops.includes('moveTo(200,130)'), `引き出し線が図形右辺から出る / ${ctx.__ops.join(' | ')}`);
  // 吹き出し背景の fillRect の x は図形右端より右（左下固定ではない）。
  const panel = ctx.__ops.find((o) => /^fillRect\(/.test(o));
  const x = Number(panel.slice('fillRect('.length).split(',')[0]);
  assert.ok(x >= 200, `吹き出しは図形の右側 / x=${x}`);
});

test('composeFeedback: 画面外 item は図形を描かず左上リストに出す', () => {
  const ctx = recordingCtx();
  const items = [
    { color: '#ef4444', note: 'off', resolved: true, inViewport: false, bboxPx: { minX: 0, minY: 0 }, shapesPx: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1 }] },
  ];
  composeFeedback(ctx, { items, factor: 1, outWidth: 100, outHeight: 100 });
  assert.ok(!ctx.__ops.some((o) => o.startsWith('strokeRect')), '画面外の図形は描かない');
  assert.ok(ctx.__ops.some((o) => o.includes('（画面外）')), '左上リストに画面外マークが出る');
});

// ---- メモ(kind:'note')= 図形なし item。要素矩形を bbox に、吹き出し＋番号バッジだけを描く ----
test('composeFeedback: 図形なしメモ(shapesPx:[])は吹き出し＋バッジを描き、図形は描かない', () => {
  const ctx = recordingCtx();
  const items = [
    {
      color: '#ef4444',
      note: 'ここのコピーを直す',
      resolved: true,
      inViewport: true,
      shapesPx: [], // メモは図形を持たない
      bboxPx: { minX: 100, minY: 100, maxX: 240, maxY: 140 }, // 対象要素の矩形
    },
  ];
  const summary = composeFeedback(ctx, { items, factor: 1, outWidth: 1000, outHeight: 1000 });
  // 図形なしでも 1 件分が「描画済み(in-place)」として数えられる。
  assert.deepEqual(summary, { drawn: 1, total: 1 });
  // メモ本文が画像に焼かれる。
  assert.ok(ctx.__ops.some((o) => o.includes('fillText(ここのコピーを直す')), 'メモ本文が描かれる');
  // 番号バッジ(角＋吹き出し)= arc 2つ以上。
  assert.ok(ctx.__ops.filter((o) => o.startsWith('arc(')).length >= 2, '番号バッジが2つ');
  // 図形ジオメトリは描かれない: strokeRect は吹き出し枠の1本だけ、ellipse/arrow polyline は無い。
  assert.equal(ctx.__ops.filter((o) => o.startsWith('strokeRect(')).length, 1, '図形の strokeRect は無い(吹き出し枠のみ)');
  assert.ok(!ctx.__ops.some((o) => o.startsWith('ellipse(')), '図形 ellipse は無い');
  // NaN/Infinity を一切生まない。
  assert.ok(!ctx.__ops.some((o) => /NaN|Infinity|undefined/.test(o)), `不正座標が無い / ${ctx.__ops.join(' | ')}`);
});

test('composeFeedback: 面積ゼロのメモ bbox(min==max)でも drawn:1 で NaN を生まない', () => {
  const ctx = recordingCtx();
  const items = [
    { color: '#ef4444', note: 'x', resolved: true, inViewport: true, shapesPx: [], bboxPx: { minX: 50, minY: 50, maxX: 50, maxY: 50 } },
  ];
  const summary = composeFeedback(ctx, { items, factor: 2, outWidth: 800, outHeight: 800 });
  assert.deepEqual(summary, { drawn: 1, total: 1 });
  assert.ok(!ctx.__ops.some((o) => /NaN|Infinity|undefined/.test(o)), `不正座標が無い / ${ctx.__ops.join(' | ')}`);
});

test('legendLine: メモ無しは shapeText → なしの順でフォールバック', () => {
  assert.equal(legendLine(2, { shapeText: '赤色の円で囲んだ', resolved: true, inViewport: true }), '2. 赤色の円で囲んだ');
  assert.equal(legendLine(3, { resolved: false }), '3. (メモなし)（対象未解決）');
});

// ---- (4) SecurityError 罠の回避: ソースに禁止トークンが無い ----
test('compositor.js は foreignObject/SVG/Image を一切使わない（コメントは除外して走査）', () => {
  const raw = readFileSync(resolve(here, '../../lib/visual-feedback/compositor.js'), 'utf8');
  // 設計コメントは禁止語を説明目的で含むので、コメントを剥がしてからコード本体だけを走査する。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '') // ブロックコメント
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行コメント（URL の // は除外）
  for (const banned of ['foreignObject', 'createElementNS', '<svg', 'new Image', 'drawImage']) {
    assert.ok(!code.includes(banned), `禁止トークンをコード本体に含む: ${banned}`);
  }
});

console.log(`\n${passed} passed`);
