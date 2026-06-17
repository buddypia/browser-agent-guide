// Offscreen document の合成器。service worker から COMPOSITE_VISUAL_FEEDBACK を受け取り、
// captureVisibleTab の PNG（device px）の上にユーザー注釈を Canvas 2D で burn-in して返す。
//
// 罠対策（handoff §4.1 / §6）:
//  - OffscreenCanvas + Canvas 2D のみ。SVG/foreignObject を使わない → SecurityError 回避。
//  - 2000px ガード（computeOutputSize）+ DPR 整合（factor = dpr × outputScale）は compositor.js に集約。

import { computeOutputSize, composeFeedback } from '../lib/visual-feedback/compositor.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return; // 自分宛て以外は無視（SW/sidepanel 宛てと混線させない）
  if (msg.type === 'COMPOSITE_VISUAL_FEEDBACK') {
    composite(msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // 非同期応答
  }
  return false;
});

async function composite({ screenshotDataUrl, data }) {
  if (!screenshotDataUrl) throw new Error('スクリーンショットがありません。');
  const blob = await (await fetch(screenshotDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const rawWidth = bitmap.width;
  const rawHeight = bitmap.height;

  const { scale: outputScale, width: outWidth, height: outHeight } = computeOutputSize(rawWidth, rawHeight);

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const ctx = canvas.getContext('2d');
  // 背景 = スクリーンショット（device px → output px へ一様縮小）。
  ctx.drawImage(bitmap, 0, 0, outWidth, outHeight);
  if (typeof bitmap.close === 'function') bitmap.close();

  // 図形座標は CSS viewport px → device px(×dpr) → output px(×outputScale)。
  const factor = (data?.dpr || 1) * outputScale;
  const summary = composeFeedback(ctx, {
    items: data?.items || [],
    factor,
    outWidth,
    outHeight,
  });

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(outBlob);
  return {
    dataUrl,
    width: outWidth,
    height: outHeight,
    rawWidth,
    rawHeight,
    downscaled: outputScale < 1,
    outputScale,
    factor,
    drawn: summary.drawn,
    total: summary.total,
    byteLength: outBlob.size,
  };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('PNG の data URL 変換に失敗しました。'));
    reader.readAsDataURL(blob);
  });
}
