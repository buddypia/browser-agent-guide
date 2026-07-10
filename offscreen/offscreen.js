// Offscreen document の合成器。service worker から COMPOSITE_PAGE_FEEDBACK を受け取り、
// captureVisibleTab の PNG（device px）の上にユーザー注釈を Canvas 2D で burn-in して返す。
//
// 罠対策（handoff §4.1 / §6）:
//  - OffscreenCanvas + Canvas 2D のみ。SVG/foreignObject を使わない → SecurityError 回避。
//  - 2000px ガード（computeOutputSize）+ DPR 整合（factor = dpr × outputScale）は compositor.js に集約。

import { computeOutputSize, composeFeedback } from '../lib/page-feedback/compositor.js';
import { encodeInline } from './inline-encode.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return; // 自分宛て以外は無視（SW/sidepanel 宛てと混線させない）
  if (msg.type === 'COMPOSITE_PAGE_FEEDBACK') {
    composite(msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // 非同期応答
  }
  return false;
});

async function composite({ screenshotDataUrl, data }) {
  // エラーは i18n キーで投げる。SW 側が受け取った res.error を t() でユーザー言語へ翻訳する
  // (offscreen はロケール設定を持たないため、文言の解決は SW に委ねる)。
  if (!screenshotDataUrl) throw new Error('errors.offscreen.noScreenshot');
  const blob = await (await fetch(screenshotDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const rawWidth = bitmap.width;
  const rawHeight = bitmap.height;

  const { scale: outputScale, width: outWidth, height: outHeight } = computeOutputSize(rawWidth, rawHeight);

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const ctx = canvas.getContext('2d');
  // @term: page-feedback  (用語定義: glossary/daemon/page-feedback.md。背景描画で drawImage を使う唯一の箇所)
  // 背景 = スクリーンショット（device px → output px へ一様縮小）。
  ctx.drawImage(bitmap, 0, 0, outWidth, outHeight);
  // @endterm: page-feedback
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

  // MCP inline 専用のコンパクト変種（WebP/JPEG, ~12KB 予算）。フル解像度 PNG（上の dataUrl）は
  // file_path/shot_url/DL 用にそのまま温存し、これは Claude Code のトークン上限対策として併走させる。
  // 失敗しても致命的でない（daemon はフル PNG にフォールバックし、超過なら image を omit する）。
  let inline = null;
  try {
    const enc = await encodeInline(canvas, { outWidth, outHeight });
    if (enc?.blob) {
      inline = {
        dataUrl: await blobToDataUrl(enc.blob),
        mime: enc.mime,
        byteLength: enc.byteLength,
        width: enc.width,
        height: enc.height,
      };
    }
  } catch {
    inline = null;
  }

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
    // inline（コンパクト変種）。無ければ全て null（古い engine / エンコード失敗）。
    inlineDataUrl: inline?.dataUrl || null,
    inlineMime: inline?.mime || null,
    inlineByteLength: inline?.byteLength || null,
    inlineWidth: inline?.width || null,
    inlineHeight: inline?.height || null,
  };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('errors.offscreen.pngConvertFailed'));
    reader.readAsDataURL(blob);
  });
}
