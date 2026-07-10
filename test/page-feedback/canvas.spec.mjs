// 実ブラウザ統合テスト（最もリスクの高いランタイム経路の検証）。
// compositor.js を本物の Canvas 2D で走らせ、handoff §6 の罠を実測で潰す:
//   - SecurityError 罠: 注釈を焼き込んだ canvas が taint されず convertToBlob / getImageData が成功する
//   - 全図形種(rect/ellipse/arrow/path)+バッジ+凡例が本物の 2D API で例外なく描ける
//   - 出力が有効な PNG（シグネチャ一致）
//   - DPR 整合: factor を掛けた座標に実際に色が乗る（赤枠のストローク画素を実測）
//
// 注: ES module を file:// で import すると Chromium が CORS で弾くため、compositor の
// ソースから `export` を剥がして classic script として注入し window.__VF__ に載せる。

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const compositorSrc = readFileSync(resolve(here, '../../lib/page-feedback/compositor.js'), 'utf8');
// `export` を剥がしてグローバル関数化し、必要なシンボルを window に公開する。
const injected =
  compositorSrc.replace(/^export\s+/gm, '') +
  '\nwindow.__VF__ = { computeOutputSize, composeFeedback, drawShape, arrowPolyline, legendLine, MAX_OUTPUT_DIM };';

test('compositor は実 canvas で taint せず有効な PNG を焼き込む', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: injected });
  await page.waitForFunction(() => Boolean(window.__VF__));

  const result = await page.evaluate(async () => {
    const VF = window.__VF__;
    // captureVisibleTab の代わりに同一オリジンの OffscreenCanvas を背景画像に使う。
    const raw = new OffscreenCanvas(400, 300);
    const rctx = raw.getContext('2d');
    rctx.fillStyle = '#dddddd';
    rctx.fillRect(0, 0, 400, 300);
    const bmp = await createImageBitmap(raw);

    const { scale, width, height } = VF.computeOutputSize(bmp.width, bmp.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, width, height);
    if (bmp.close) bmp.close();

    const items = [
      {
        color: '#ff0000',
        note: '赤枠で囲んだ',
        intent: '送信前に確認',
        resolved: true,
        inViewport: true,
        bboxPx: { minX: 50, minY: 50, maxX: 150, maxY: 120 },
        shapesPx: [
          { type: 'rect', x: 50, y: 50, w: 100, h: 70, width: 4, color: '#ff0000' },
          { type: 'ellipse', cx: 250, cy: 150, rx: 40, ry: 30, width: 3, color: '#00aa00' },
          { type: 'arrow', x1: 300, y1: 60, x2: 360, y2: 110, width: 3, color: '#0000ff' },
          { type: 'path', pts: [[60, 200], [120, 220], [180, 200]], width: 3, color: '#111111' },
        ],
      },
    ];
    VF.composeFeedback(ctx, { items, factor: scale, outWidth: width, outHeight: height });

    // taint していれば下の2つが SecurityError を投げる。
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const sig = Array.from(buf.slice(0, 8));
    // 赤枠の上辺ストローク付近(x=100,y=50)の画素を実測。
    const px = ctx.getImageData(100, 50, 1, 1).data;
    return { size: blob.size, sig, width, height, r: px[0], g: px[1], b: px[2] };
  });

  // PNG マジックナンバー
  expect(result.sig).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(result.size).toBeGreaterThan(100);
  expect(result.width).toBe(400);
  expect(result.height).toBe(300);
  // 赤枠のストローク座標に実際に赤が乗っている（座標整合の実測。背景#ddd より赤が強い）
  expect(result.r).toBeGreaterThan(150);
  expect(result.r).toBeGreaterThan(result.g);
  expect(result.r).toBeGreaterThan(result.b);
});
