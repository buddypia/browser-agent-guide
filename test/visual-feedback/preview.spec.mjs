// 開発用プレビュー: ユーザーのスクショに似た擬似ページに注釈を焼き込み、PNG を .tmp に保存する。
// 目視確認専用（CI 対象外でよい）。実行: npx playwright test test/visual-feedback/preview.spec.mjs
import { test } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const compositorSrc = readFileSync(resolve(here, '../../lib/visual-feedback/compositor.js'), 'utf8');
const injected =
  compositorSrc.replace(/^export\s+/gm, '') +
  '\nwindow.__VF__ = { computeOutputSize, composeFeedback };';
const outPath = resolve(here, '../../.tmp/vf-preview.png');

test('preview: 擬似ページに注釈を焼き込んで保存', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ content: injected });
  await page.waitForFunction(() => Boolean(window.__VF__));

  const dataUrl = await page.evaluate(async () => {
    const VF = window.__VF__;
    const W = 1400;
    const H = 1000;
    // 擬似ページ背景（ユーザーのスクショ風: 見出し + リスト + 段落）。
    const bg = new OffscreenCanvas(W, H);
    const b = bg.getContext('2d');
    b.fillStyle = '#ffffff';
    b.fillRect(0, 0, W, H);
    b.fillStyle = '#333';
    b.font = 'bold 34px sans-serif';
    b.fillText('グループIT推進提供API', 110, 70);
    b.strokeStyle = '#e5e5e5';
    b.beginPath(); b.moveTo(110, 100); b.lineTo(1300, 100); b.stroke();
    b.fillStyle = '#444'; b.font = '20px sans-serif';
    b.fillText('提供API一覧', 130, 250);
    b.fillStyle = '#666'; b.font = '16px sans-serif';
    const apis = ['MDB v2（人事データベース）', 'Manip(オフィスIP取得API)', 'ODB (拠点マスタ)', 'NASCA（スケジューラ）'];
    apis.forEach((t, i) => b.fillText('• ' + t, 150, 360 + i * 34));
    b.fillStyle = '#444'; b.font = '20px sans-serif';
    b.fillText('ご申請方法', 110, 560);

    const bmp = await createImageBitmap(bg);
    const { scale, width, height } = VF.computeOutputSize(W, H);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, width, height);

    // 「提供API一覧」セクションを赤枠で囲み、隣にメモ。
    const items = [
      {
        color: '#ef4444',
        note: 'ここをAIにマークダウンで出力',
        intent: 'API一覧を構造化して抽出',
        resolved: true,
        inViewport: true,
        bboxPx: { minX: 110, minY: 210, maxX: 780, maxY: 520 },
        shapesPx: [{ type: 'rect', x: 110, y: 210, w: 670, h: 310, width: 3, color: '#ef4444' }],
      },
    ];
    VF.composeFeedback(ctx, { items, factor: scale, outWidth: width, outHeight: height });
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
    return 'data:image/png;base64,' + btoa(bin);
  });

  mkdirSync(dirname(outPath), { recursive: true });
  const base64 = dataUrl.split(',')[1];
  writeFileSync(outPath, Buffer.from(base64, 'base64'));
  console.log('saved preview to', outPath);
});
