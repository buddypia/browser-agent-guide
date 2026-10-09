// 拡張機能 (Service Worker / Options) 向け EmbeddingGemma 2 (eg2-cli) 連携モジュール。
// 純粋な ES モジュールとして実装し、Service Worker およびテスト環境から直接利用可能。

export const DEFAULT_EG2_URL = 'http://127.0.0.1:38765';

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * SSRF 防御: URL が安全な loopback アドレスであることを確認する。
 */
export function validateEg2Url(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { valid: false, error: 'eg2 URL must be a non-empty string' };
  }
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { valid: false, error: `Invalid protocol "${u.protocol}". Only http: and https: are allowed.` };
    }
    const hostname = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!ALLOWED_LOOPBACK_HOSTS.has(hostname) && hostname !== 'localhost') {
      return { valid: false, error: `eg2 URL must be a loopback address (127.0.0.1 / localhost), got "${u.hostname}".` };
    }
    return { valid: true, url: `${u.protocol}//${u.host}` };
  } catch (e) {
    return { valid: false, error: `Malformed URL: ${e?.message || e}` };
  }
}

/**
 * 2つのベクトルのコサイン類似度を計算する。
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * eg2 サーバーの稼働状態（ヘルスチェック）を確認する。
 */
export async function checkEg2Health({ url = DEFAULT_EG2_URL, timeoutMs = 2500 } = {}) {
  const check = validateEg2Url(url);
  if (!check.valid) {
    return { ok: false, error: check.error };
  }
  try {
    const res = await fetch(`${check.url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { ok: false, status: `HTTP ${res.status}`, error: `Server returned HTTP ${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, status: data.status || 'ok' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * テキスト配列を EmbeddingGemma 2 の POST /v1/embeddings でベクトル化する。
 */
export async function embedTextsWithEg2({
  url = DEFAULT_EG2_URL,
  texts = [],
  inputType = 'document', // 'query' | 'document'
  model = '270m',
  dimensions = 256,
  timeoutMs = 5000,
} = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return { ok: true, embeddings: [] };

  const check = validateEg2Url(url);
  if (!check.valid) return { ok: false, error: check.error };

  const endpoint = `${check.url}/v1/embeddings`;
  const body = {
    model,
    input: texts,
    dimensions,
    input_type: inputType,
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = await res.json();
    const sorted = (data.data || []).sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((d) => d.embedding);
    return { ok: true, embeddings };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * affordance 要素の表現テキストを抽出する。
 */
function affordanceToText(aff) {
  const parts = [
    aff.text,
    aff.label,
    aff.ariaLabel,
    aff.placeholder,
    aff.title,
    aff.intent,
    aff.role,
    aff.tag,
  ].filter((p) => typeof p === 'string' && p.trim().length > 0);
  return parts.join(' ').trim();
}

/**
 * 自然言語クエリと affordance 一覧から、最も合致する要素を高速に特定する（System 1 Fast Path）。
 *
 * @param {object} params
 * @param {string} params.query ユーザーの指示（例: "カートに入れるボタンを押して"）
 * @param {Array<object>} params.affordances ページ上のインタラクティブ要素一覧
 * @param {string} [params.url] eg2 サーバー URL
 * @param {string} [params.model] 使用モデル（既定 '270m'）
 * @param {number} [params.threshold] 最小類似度閾値（既定 0.80）
 * @param {number} [params.margin] 2位との最小差分マージン（既定 0.08）
 * @returns {Promise<{ matched: boolean, best?: object, score?: number, margin?: number, reason?: string }>}
 */
export async function matchAffordanceFastPath({
  query,
  affordances = [],
  url = DEFAULT_EG2_URL,
  model = '270m',
  threshold = 0.80,
  margin = 0.08,
} = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed || !Array.isArray(affordances) || affordances.length === 0) {
    return { matched: false, reason: 'empty query or affordances' };
  }

  // 対象 affordance のフィルタ（aiId とテキスト情報を持つもの）
  const candidates = affordances
    .filter((a) => a && a.aiId)
    .map((a) => ({ aff: a, text: affordanceToText(a) }))
    .filter((c) => c.text.length > 0);

  if (candidates.length === 0) {
    return { matched: false, reason: 'no candidate affordance text' };
  }

  // 1. クエリのベクトル化 (input_type="query")
  const queryEmbedRes = await embedTextsWithEg2({
    url,
    texts: [trimmed],
    inputType: 'query',
    model,
  });
  if (!queryEmbedRes.ok || !queryEmbedRes.embeddings?.[0]) {
    return { matched: false, reason: `failed to embed query: ${queryEmbedRes.error}` };
  }
  const queryVec = queryEmbedRes.embeddings[0];

  // 2. 候補要素テキストのベクトル化 (input_type="document")
  // 最大 60 要素に制限して高速応答を維持
  const cappedCandidates = candidates.slice(0, 60);
  const docTexts = cappedCandidates.map((c) => c.text);

  const docEmbedRes = await embedTextsWithEg2({
    url,
    texts: docTexts,
    inputType: 'document',
    model,
  });
  if (!docEmbedRes.ok || !docEmbedRes.embeddings) {
    return { matched: false, reason: `failed to embed documents: ${docEmbedRes.error}` };
  }

  // 3. 類似度スコアリング
  const scored = cappedCandidates.map((c, i) => {
    const docVec = docEmbedRes.embeddings[i];
    const score = docVec ? cosineSimilarity(queryVec, docVec) : 0;
    return { aff: c.aff, text: c.text, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const bestScore = best.score;
  const secondScore = second ? second.score : 0;
  const actualMargin = bestScore - secondScore;

  if (bestScore >= threshold && actualMargin >= margin) {
    return {
      matched: true,
      best: best.aff,
      score: bestScore,
      margin: actualMargin,
      candidateText: best.text,
      reason: `High confidence match (${bestScore.toFixed(3)}, margin +${actualMargin.toFixed(3)})`,
    };
  }

  return {
    matched: false,
    best: best.aff,
    score: bestScore,
    margin: actualMargin,
    reason: `Below threshold or ambiguous (score=${bestScore.toFixed(3)}, margin=+${actualMargin.toFixed(3)})`,
  };
}

/**
 * ユーザーの指示からアクション種別（clickAffordance 等）を推定し、Fast Path アクションを生成する。
 */
export function resolveFastPathAction(query, matchedAffordance) {
  if (!matchedAffordance || !matchedAffordance.aiId) return null;
  const q = String(query || '').toLowerCase();

  // クリック / 押下意図
  const isClickIntent = /(クリック|押|タップ|選択|選んで|開いて|click|press|tap|open|choose)/.test(q);
  // 入力意図
  const isFillIntent = /(入力|入れて|書いて|タイプ|fill|type|write|input)/.test(q);

  if (isClickIntent || !isFillIntent) {
    return {
      verb: 'clickAffordance',
      args: { aiId: matchedAffordance.aiId },
      reason: `System 1 (eg2) 高速マッチング: "${matchedAffordance.aiId}" を特定して即時クリック`,
    };
  }

  return null;
}
