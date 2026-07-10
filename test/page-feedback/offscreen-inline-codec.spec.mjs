// 実ブラウザ統合テスト: offscreen/inline-encode.js の encodeInline を本物の OffscreenCanvas で走らせ、
// MCP inline 専用のコンパクト変種が「lossy（WebP/JPEG）・予算（12KB）内・有効なフォーマット」で
// 生成されることを実測する。これが Claude Code の MCP 出力トークン上限（25,000）に収まる根拠。
//
// 注: ES module を file:// で import すると Chromium が CORS で弾くため、ソースから `export` を剥がして
// classic script として注入し window.__INLINE__ に載せる（canvas.spec.mjs と同じ手法）。

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const encodeSrc = readFileSync(resolve(here, '../../offscreen/inline-encode.js'), 'utf8');
const injected =
  encodeSrc.replace(/^export\s+/gm, '') +
  '\nwindow.__INLINE__ = { encodeInline, INLINE_BYTE_BUDGET, INLINE_EDGE_LADDER };';

test('encodeInline は 2000px 合成から予算内の lossy（webp/jpeg）inline を生成する', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: injected });
  await page.waitForFunction(() => Boolean(window.__INLINE__));

  const result = await page.evaluate(async () => {
    const { encodeInline, INLINE_BYTE_BUDGET } = window.__INLINE__;
    // フル解像度の合成キャンバス相当（長辺 2000px）。UI スクショ風に「ほぼ平坦＋図形＋テキスト」を描く
    // （WebP が得意な分布。高周波ノイズではないので予算内に収まる）。
    const W = 2000;
    const H = 1200;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#f4f6fb');
    grad.addColorStop(1, '#dfe6f2');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    for (let r = 0; r < 6; r += 1) ctx.fillRect(80, 80 + r * 170, W - 160, 130); // カード風パネル
    ctx.fillStyle = '#222';
    ctx.font = '28px sans-serif';
    for (let r = 0; r < 6; r += 1) ctx.fillText('Browser Agent Guide — inline image budget test ' + r, 110, 150 + r * 170);
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 6;
    ctx.strokeRect(120, 120, 360, 90); // お描き相当の赤枠

    const enc = await encodeInline(canvas, { outWidth: W, outHeight: H });
    if (!enc?.blob) return { ok: false };
    const head = new Uint8Array(await enc.blob.arrayBuffer()).slice(0, 12);
    return {
      ok: true,
      mime: enc.mime,
      byteLength: enc.byteLength,
      width: enc.width,
      height: enc.height,
      budget: INLINE_BYTE_BUDGET,
      head: Array.from(head),
    };
  });

  expect(result.ok).toBe(true);
  // lossy フォーマット（WebP 優先、JPEG フォールバック）。フル解像度の PNG ではない。
  expect(['image/webp', 'image/jpeg']).toContain(result.mime);
  // 予算内（= Claude Code の 25,000 トークン上限に収まるサイズ）。
  expect(result.byteLength).toBeLessThanOrEqual(result.budget);
  // base64 トークン概算（len/3*4 × ~1.0 tok/char）が image 予算 ~16.4k を割らない。
  const base64Tokens = Math.ceil(result.byteLength / 3) * 4;
  expect(base64Tokens).toBeLessThan(16400);
  // フォーマットの magic bytes が宣言 mime と一致（mime 偽装で 400 にならないことの担保）。
  if (result.mime === 'image/webp') {
    expect(result.head.slice(0, 4)).toEqual([0x52, 0x49, 0x46, 0x46]); // 'RIFF'
    expect(result.head.slice(8, 12)).toEqual([0x57, 0x45, 0x42, 0x50]); // 'WEBP'
  } else {
    expect(result.head.slice(0, 3)).toEqual([0xff, 0xd8, 0xff]); // JPEG SOI
  }
  // inline の長辺は 2000px フル解像度キャップとは別の、より小さいラダー値（≤1280）。
  expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1280);
});

test('encodeInline は長辺を inline ラダー（≤1280px）へ縮小し、拡大はしない', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: injected });
  await page.waitForFunction(() => Boolean(window.__INLINE__));

  const small = await page.evaluate(async () => {
    const { encodeInline } = window.__INLINE__;
    // 既に小さい合成（長辺 600px）は拡大されない（≤ 元サイズ）。
    const canvas = new OffscreenCanvas(600, 400);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#eef';
    ctx.fillRect(0, 0, 600, 400);
    const enc = await encodeInline(canvas, { outWidth: 600, outHeight: 400 });
    return { width: enc.width, height: enc.height };
  });
  expect(small.width).toBeLessThanOrEqual(600);
  expect(small.height).toBeLessThanOrEqual(400);
});
