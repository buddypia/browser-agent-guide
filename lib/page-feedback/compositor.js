// ページフィードバックの合成（burn-in）モジュール。
// 役割: captureVisibleTab で得たスクリーンショット（device px）の上に、
// ユーザーが描いた図形（円/四角/矢印/ペン）・番号バッジ・凡例を Canvas 2D で直接描く。
//
// 設計上の重要な決定（handoff §4.1 / §6 の罠への対応）:
//  - ★ SVG foreignObject は使わない。canvas が taint されて convertToBlob() が
//    SecurityError を投げる（ブラウザ未解決）。図形はすべて Canvas 2D の
//    strokeRect / ellipse / moveTo+lineTo / fillText で描く。
//  - ★ DPR 整合: 図形座標は「CSS viewport px」で渡され、device px = css px × dpr。
//    さらに 2000px ガードの outputScale を掛けた合計係数 factor = dpr × outputScale を
//    全座標に一様適用する。スクリーンショット（既に device px）には outputScale だけを掛ける。
//  - ★ 2000px ダウンスケールガード: vision API は長辺 2000px 超を拒否しうる。
//    computeOutputSize で長辺を 2000 に収め、図形も同じ factor で縮める。
//
// このモジュールは「ctx 風オブジェクト」だけに依存する純粋関数群。実 OffscreenCanvas でも
// テスト用の記録モック ctx でも同じ呼び出し列を生む（決定的・byte 安定）。DOM/SVG/Image に触れない。

export const MAX_OUTPUT_DIM = 2000;
const TAU = Math.PI * 2;
const DEFAULT_COLOR = '#ef4444';

/**
 * 2000px ガード。生サイズ（device px）の長辺が maxDim を超えたら一様縮小する。
 * @returns {{ scale:number, width:number, height:number }} scale は 0<scale<=1
 */
export function computeOutputSize(rawWidth, rawHeight, maxDim = MAX_OUTPUT_DIM) {
  const w = Math.max(1, Math.round(rawWidth || 0));
  const h = Math.max(1, Math.round(rawHeight || 0));
  const longest = Math.max(w, h);
  const scale = longest > maxDim ? maxDim / longest : 1;
  return {
    scale,
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

// 矢印を1本のポリライン（線→先端→かえし）として表す。content-script の arrowPointsPx と
// 同じ式。CSS px 空間で組み立て、呼び出し側が factor を掛けるので比率は画面と一致する。
export function arrowPolyline(x1, y1, x2, y2) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.min(16, Math.max(8, Math.hypot(x2 - x1, y2 - y1) * 0.25));
  const spread = 0.45;
  const hx1 = x2 - len * Math.cos(ang - spread);
  const hy1 = y2 - len * Math.sin(ang - spread);
  const hx2 = x2 - len * Math.cos(ang + spread);
  const hy2 = y2 - len * Math.sin(ang + spread);
  return [
    [x1, y1],
    [x2, y2],
    [hx1, hy1],
    [x2, y2],
    [hx2, hy2],
  ];
}

function strokePolyline(ctx, pts) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

/**
 * 1図形を描く。shape の座標は CSS viewport px。factor = dpr × outputScale を掛けて output px へ。
 * rect は {x,y,w,h}, ellipse は {cx,cy,rx,ry}, arrow は {x1,y1,x2,y2}, path は {pts:[[x,y]...]}。
 */
// @term: page-feedback  (用語定義: glossary/daemon/page-feedback.md。Canvas-2D 専用の図形描画)
export function drawShape(ctx, shape, factor) {
  if (!shape) return;
  const f = factor || 1;
  ctx.strokeStyle = shape.color || DEFAULT_COLOR;
  ctx.lineWidth = Math.max(1, (shape.width || 3) * f);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (shape.type === 'rect') {
    const x = Math.min(shape.x, shape.x + shape.w);
    const y = Math.min(shape.y, shape.y + shape.h);
    ctx.strokeRect(x * f, y * f, Math.abs(shape.w) * f, Math.abs(shape.h) * f);
  } else if (shape.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(shape.cx * f, shape.cy * f, Math.abs(shape.rx) * f, Math.abs(shape.ry) * f, 0, 0, TAU);
    ctx.stroke();
  } else if (shape.type === 'arrow') {
    strokePolyline(
      ctx,
      arrowPolyline(shape.x1, shape.y1, shape.x2, shape.y2).map(([x, y]) => [x * f, y * f])
    );
  } else if (shape.type === 'path') {
    strokePolyline(ctx, (shape.pts || []).map(([x, y]) => [x * f, y * f]));
  }
}
// @endterm: page-feedback

/** 図形の隣に置く丸数字バッジ。(x,y) は output px。 */
export function drawBadge(ctx, x, y, label, color, factor) {
  const f = factor || 1;
  const r = Math.max(9, 11 * f);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = color || DEFAULT_COLOR;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 2 * f);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(label), x, y);
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// CJK 対応の簡易折り返し（単語境界に頼らず1文字ずつ詰める）。\n は明示改行。
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let cur = '';
  for (const ch of String(text)) {
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
    const test = cur + ch;
    if (cur && ctx.measureText(test).width > maxWidth) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// メモ吹き出しに入れる本文（メモ→図形説明→なし の順でフォールバック、目的を併記）。
export function memoText(item) {
  const memo = (item.note || '').trim() || (item.shapeText || '').trim() || '(メモなし)';
  const intent = (item.intent || '').trim();
  return intent ? `${memo}\n目的: ${intent}` : memo;
}

// 短い1行サマリ（画面外リスト用）。
export function legendLine(n, item) {
  const base = memoText(item).replace(/\n/g, ' ／ ');
  let suffix = '';
  if (!item.resolved) suffix = '（対象未解決）';
  else if (!item.inViewport) suffix = '（画面外）';
  return truncate(`${n}. ${base}${suffix}`, 90);
}

// 吹き出しの置き場所を決める（右→左→下→上の順で画像内に収める）。
function placeCallout(box, w, h, outWidth, outHeight, gap, pad) {
  const midY = clampNum((box.minY + box.maxY) / 2 - h / 2, pad, Math.max(pad, outHeight - h - pad));
  if (box.maxX + gap + w <= outWidth - pad) return { x: box.maxX + gap, y: midY, side: 'right' };
  if (box.minX - gap - w >= pad) return { x: box.minX - gap - w, y: midY, side: 'left' };
  const midX = clampNum((box.minX + box.maxX) / 2 - w / 2, pad, Math.max(pad, outWidth - w - pad));
  if (box.maxY + gap + h <= outHeight - pad) return { x: midX, y: box.maxY + gap, side: 'below' };
  return { x: midX, y: clampNum(box.minY - gap - h, pad, Math.max(pad, outHeight - h - pad)), side: 'above' };
}

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// 図形 bbox → 吹き出しを結ぶ引き出し線。番号バッジ(①)とメモが同じ注釈だと一目で分かるようにする。
function drawConnector(ctx, box, place, w, h, color, factor) {
  let sx;
  let sy;
  let mx;
  let my;
  const midY = (box.minY + box.maxY) / 2;
  if (place.side === 'right') {
    sx = box.maxX; sy = midY; mx = place.x; my = place.y + h / 2;
  } else if (place.side === 'left') {
    sx = box.minX; sy = midY; mx = place.x + w; my = place.y + h / 2;
  } else if (place.side === 'below') {
    sx = (box.minX + box.maxX) / 2; sy = box.maxY; mx = place.x + w / 2; my = place.y;
  } else {
    sx = (box.minX + box.maxX) / 2; sy = box.minY; mx = place.x + w / 2; my = place.y + h;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 1.5 * factor);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(mx, my);
  ctx.stroke();
}

/**
 * 1注釈ぶんの番号バッジ(①)+メモ吹き出しを、図形のすぐ隣に描く。
 * box は output px の bbox。吹き出しの先頭にも同じ丸数字を置き、引き出し線で図形と結ぶ。
 */
export function drawMemoCallout(ctx, n, item, box, color, opts = {}) {
  const { factor = 1, outWidth = 0, outHeight = 0 } = opts;
  const f = factor;
  const fs = Math.max(12, Math.round(13 * f));
  const padc = Math.round(fs * 0.7);
  const lineH = Math.round(fs * 1.45);
  const badgeR = Math.max(9, 11 * f);
  const badgeCol = Math.round(badgeR * 2 + fs * 0.45); // 吹き出し内の丸数字ぶんの横幅
  const maxTextW = Math.min(Math.round(outWidth * 0.42), Math.round(340 * f));

  ctx.font = `${fs}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const lines = wrapText(ctx, memoText(item), maxTextW);
  let textW = 0;
  for (const l of lines) textW = Math.max(textW, ctx.measureText(l).width);

  const w = padc * 2 + badgeCol + textW;
  const h = Math.max(badgeR * 2, lines.length * lineH) + padc * 2;
  const gap = Math.round(14 * f);
  const place = placeCallout(box, w, h, outWidth, outHeight, gap, gap);

  // 引き出し線 → 吹き出し背景 → 枠(色) → 丸数字 → メモ本文。
  drawConnector(ctx, box, place, w, h, color, f);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(place.x, place.y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 1.5 * f);
  ctx.strokeRect(place.x, place.y, w, h);
  drawBadge(ctx, place.x + padc + badgeR, place.y + padc + badgeR, n, color, f);
  ctx.fillStyle = '#ffffff';
  ctx.font = `${fs}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let ty = place.y + padc;
  for (const l of lines) {
    ctx.fillText(l, place.x + padc + badgeCol, ty);
    ty += lineH;
  }
  return { x: place.x, y: place.y, w, h, side: place.side };
}

// 画面外/未解決の注釈を左上にまとめて出す（その場に図形を置けないため）。
function drawOffscreenList(ctx, entries, opts = {}) {
  const { factor = 1, outWidth = 0 } = opts;
  if (!entries.length) return;
  const f = factor;
  const fs = Math.max(12, Math.round(13 * f));
  const pad = Math.round(fs * 0.7);
  const lineH = Math.round(fs * 1.5);
  ctx.font = `${fs}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const lines = entries.map((e) => legendLine(e.n, e.item));
  let maxText = 0;
  for (const l of lines) maxText = Math.max(maxText, ctx.measureText(l).width);
  const w = Math.min(outWidth - pad * 2, maxText + pad * 2);
  const h = lines.length * lineH + pad * 2;
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(pad, pad, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  let ty = pad + pad;
  for (const l of lines) {
    ctx.fillText(l, pad + pad, ty);
    ty += lineH;
  }
}

/**
 * メイン入口。スクリーンショット描画済みの ctx に、全 item の図形・番号バッジ・メモ吹き出しを burn-in する。
 * 図形を先に全部描き、その上にバッジ＋吹き出しを重ねる。各注釈は「図形・角の丸数字・吹き出し先頭の丸数字」が
 * 引き出し線で結ばれ、AI が「①の指示＝この図形」と取り違えないようにする。
 * @param {object} ctx Canvas 2D 風コンテキスト
 * @param {{items:Array, factor:number, outWidth:number, outHeight:number}} params
 *   factor = dpr × outputScale。item.shapesPx / bboxPx は CSS viewport px。
 */
export function composeFeedback(ctx, params = {}) {
  const { items = [], factor = 1, outWidth = 0, outHeight = 0 } = params;
  const inView = [];
  const offView = [];
  items.forEach((item, i) => {
    const entry = { n: i + 1, item, color: item.color || DEFAULT_COLOR };
    if (item.resolved && item.inViewport && Array.isArray(item.shapesPx) && item.bboxPx) inView.push(entry);
    else offView.push(entry);
  });

  // 1) 図形を全部描く（背景レイヤ）。
  for (const e of inView) for (const shape of e.item.shapesPx) drawShape(ctx, shape, factor);

  // 2) 図形の上に、角の番号バッジ＋メモ吹き出しを描く。
  for (const e of inView) {
    const b = e.item.bboxPx;
    const box = { minX: b.minX * factor, minY: b.minY * factor, maxX: b.maxX * factor, maxY: b.maxY * factor };
    drawMemoCallout(ctx, e.n, e.item, box, e.color, { factor, outWidth, outHeight });
    drawBadge(ctx, box.minX, box.minY, e.n, e.color, factor); // 図形の角の丸数字（最前面）
  }

  // 3) 画面外/未解決はその場に置けないので左上にリスト化。
  drawOffscreenList(ctx, offView, { factor, outWidth });

  return { drawn: inView.length, total: items.length };
}
