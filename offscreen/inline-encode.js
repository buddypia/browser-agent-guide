// MCP inline 画像のコンパクト変種エンコーダ（offscreen コンテキスト専用、OffscreenCanvas を使う）。
//
// なぜ必要か:
//   daemon は MCP の {type:'image'} で注釈 burn-in 済みスクショを返すが、Claude Code は
//   その base64 を「テキスト」としてトークン化し MAX_MCP_OUTPUT_TOKENS（既定 25,000）で
//   ハードエラーにする（image は text と違い disk 退避フォールバックが無く、画像ごと落ちる）。
//   2000px のフル解像度 PNG（数百KB〜数MB）は確実にこの上限を超えるため、Claude Code は
//   inline 画像を 1 度も受け取れない。そこで「フル解像度 PNG は file_path/shot_url/DL 用に温存」
//   しつつ、MCP inline 専用に小さな WebP/JPEG をここで別途生成する。
//
// 予算（INLINE_BYTE_BUDGET）の根拠 — ここは load-bearing なので安易に上げないこと:
//   base64 はバイナリの 4/3 倍に膨らむ（1 byte → ~1.37 文字）。高エントロピー base64 の
//   トークン密度は実測 ~0.68-0.72 tok/char（OpenAI 系）で、Claude Opus 4.7+/4.8 は更に ~+30%。
//   保守的に ~1.0 tok/char と置くと tokens ≈ bytes × 1.37。ラップするテキスト/JSON 用に
//   ~2,500 tokens を確保すると、25,000 上限に収まる image の最大は (25000-2500)/1.37 ≈ 16.4 KB。
//   余裕を見て 12 KB を既定にする（≈16.4k image tok + ~2.5k text ≈ 18.9k = 上限の ~76%）。
//   ※ かつて検討された 30 KB は ~41k tokens = 上限の 164% で **絶対に使ってはいけない**
//     （0.5 tok/char という楽観比は検証で反証済み）。daemon 側にも別途 omit セーフティネットがある。
//
// フォーマット:
//   WebP を優先（同一バイト予算でテキスト輪郭が JPEG より鮮明）。engine が WebP を honor しない
//   場合のみ JPEG にフォールバックする（blob.type を見て判定）。どちらも Claude vision と
//   Codex view_image の受理 4 形式（jpeg/png/gif/webp）に含まれる。mimeType は実際に生成された
//   blob.type から取り、決め打ちしない（webp と偽った png 等で media_type 不一致 400 を避ける）。
//
// この処理は offscreen.js（drawImage/convertToBlob が許される唯一の場所）に閉じる。
// compositor.js には一切触れない（Canvas-2D-only の banned-token スキャンに掛からない）。

export const INLINE_BYTE_BUDGET = 12 * 1024; // 12 KB（上のコメントの導出に基づく。30KB へ上げない）。
export const INLINE_FORMATS = ['image/webp', 'image/jpeg']; // 優先 WebP → JPEG フォールバック。
export const INLINE_EDGE_LADDER = [1280, 1024, 896, 768]; // inline の長辺。2000px フル解像度キャップとは別物。
export const INLINE_QUALITY_LADDER = [0.82, 0.7, 0.6, 0.5, 0.4];

function isLossy(mime) {
  return mime === 'image/webp' || mime === 'image/jpeg';
}

// 長辺が edge を超えない最大の等比サイズ（拡大はしない）。
function fitWithin(width, height, edge) {
  const long = Math.max(width, height);
  if (!Number.isFinite(long) || long <= 0) return { width: 1, height: 1 };
  if (long <= edge) return { width, height };
  const scale = edge / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// source（合成済み OffscreenCanvas）を width×height の新しい OffscreenCanvas へ高品質縮小する。
function drawScaled(source, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * 注釈 burn-in 済みの合成キャンバスから、MCP inline 用のコンパクト画像 blob を作る。
 * 長辺ラダー × フォーマット × 品質ラダーを降順に試し、最初に予算（budgetBytes）以下になった
 * lossy blob を返す。どれも収まらなければ最小の blob を返す（daemon が超過なら omit する）。
 * @param {OffscreenCanvas} source 合成済みキャンバス（フル解像度、≤2000px）。
 * @returns {Promise<null|{blob:Blob, mime:string, byteLength:number, width:number, height:number, quality:number}>}
 */
export async function encodeInline(source, { outWidth, outHeight, budgetBytes = INLINE_BYTE_BUDGET } = {}) {
  if (typeof OffscreenCanvas === 'undefined' || !source || typeof source.getContext !== 'function') return null;
  const w = outWidth || source.width;
  const h = outHeight || source.height;
  let smallest = null;
  for (const edge of INLINE_EDGE_LADDER) {
    const size = fitWithin(w, h, edge);
    const scaled = drawScaled(source, size.width, size.height);
    for (const mime of INLINE_FORMATS) {
      let honored = false;
      for (const quality of INLINE_QUALITY_LADDER) {
        let blob = null;
        try {
          blob = await scaled.convertToBlob({ type: mime, quality });
        } catch {
          blob = null;
        }
        if (!blob || !blob.size) continue;
        const realMime = blob.type || mime;
        if (!isLossy(realMime)) break; // この engine は要求フォーマットを honor しない → 次フォーマットへ。
        honored = true;
        const candidate = { blob, mime: realMime, byteLength: blob.size, width: size.width, height: size.height, quality };
        if (!smallest || candidate.byteLength < smallest.byteLength) smallest = candidate;
        if (candidate.byteLength <= budgetBytes) return candidate; // 予算内 → 採用。
      }
      if (honored) break; // WebP は機能した（このサイズでは大きいだけ）→ JPEG は試さず次の小さい長辺へ。
    }
  }
  return smallest; // 予算に収まる blob が無い → 最小を返す（daemon 側 omit ネットが拾う）。
}
