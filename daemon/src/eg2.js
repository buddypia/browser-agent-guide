// EmbeddingGemma 2 (eg2-cli) ローカル連携クライアント。
// 堅牢性・セキュリティ（SSRF防御、DoS防御）、503リトライ、キャッシュを備えた最適化実装。

import { createHash } from 'node:crypto';

export const DEFAULT_EG2_URL = process.env.EG2_URL || 'http://127.0.0.1:38765';

// セキュリティ制約
const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_IMAGE_BASE64_LENGTH = 12 * 1024 * 1024; // 12MB（DoS/OOM防御）
const MAX_GOAL_LENGTH = 2000;
const MAX_CHOICES_COUNT = 20;
const MAX_CHOICE_TEXT_LENGTH = 500;

// 短期インメモリ評価キャッシュ（同一画像+ゴールに対する反復GPU推論の負荷軽減）
const EVAL_CACHE = new Map();
const CACHE_TTL_MS = 15000; // 15秒
const MAX_CACHE_SIZE = 30;

/**
 * SSRF 防御: eg2 サーバー URL が安全な loopback アドレスであることを検証する。
 * @param {string} urlStr
 * @returns {{ valid: boolean, url?: string, error?: string }}
 */
export function validateEg2Url(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { valid: false, error: 'eg2Url must be a non-empty string' };
  }
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { valid: false, error: `SSRF Guard: invalid protocol "${u.protocol}". Only http: and https: are allowed.` };
    }
    const hostname = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!ALLOWED_LOOPBACK_HOSTS.has(hostname) && hostname !== 'localhost') {
      return {
        valid: false,
        error: `SSRF Guard: eg2Url host must be a loopback address (127.0.0.1 / localhost), got "${u.hostname}".`,
      };
    }
    // パス正規化
    const normalized = `${u.protocol}//${u.host}`;
    return { valid: true, url: normalized };
  } catch (e) {
    return { valid: false, error: `Malformed eg2Url: ${e?.message || e}` };
  }
}

/**
 * eg2 サーバーの稼働状態を確認する。
 * @param {object} [opts]
 * @param {string} [opts.eg2Url]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, status?: string, error?: string, hint?: string }>}
 */
export async function checkEg2Health({ eg2Url = DEFAULT_EG2_URL, timeoutMs = 2500 } = {}) {
  const urlCheck = validateEg2Url(eg2Url);
  if (!urlCheck.valid) {
    return { ok: false, error: urlCheck.error, hint: 'eg2Url にはローカルのアドレス（例: http://127.0.0.1:38765）を指定してください。' };
  }

  const endpoint = `${urlCheck.url}/health`;
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return {
        ok: false,
        status: `HTTP ${res.status}`,
        error: `eg2 server returned HTTP ${res.status}`,
        hint: 'eg2 サーバーのログを確認してください: eg2 logs',
      };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, status: data.status || 'ok' };
  } catch (err) {
    const isConnRefused = err?.cause?.code === 'ECONNREFUSED' || String(err?.message).includes('ECONNREFUSED');
    return {
      ok: false,
      error: String(err?.message || err),
      hint: isConnRefused
        ? 'eg2 サーバーが起動していません。ターミナルで `eg2 start` を実行してください。'
        : 'eg2 サーバーへの接続に失敗しました。',
    };
  }
}

/**
 * キャッシュキーを計算する。
 */
function computeCacheKey(cleanBase64, goal, choices, model) {
  const hash = createHash('sha256');
  // 画像先頭と末尾のダイジェスト＋長さで高速ハッシュ
  hash.update(String(cleanBase64.length));
  hash.update(cleanBase64.slice(0, 1024));
  hash.update(cleanBase64.slice(-1024));
  hash.update(goal);
  hash.update(JSON.stringify(choices));
  hash.update(model);
  return hash.digest('hex');
}

/**
 * キャッシュから取得する。
 */
function getFromCache(key) {
  const entry = EVAL_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    EVAL_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * キャッシュに保存する。
 */
function setInCache(key, value) {
  if (EVAL_CACHE.size >= MAX_CACHE_SIZE) {
    const oldestKey = EVAL_CACHE.keys().next().value;
    if (oldestKey) EVAL_CACHE.delete(oldestKey);
  }
  EVAL_CACHE.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * スクリーンショットとゴール文言から、eg2 の POST /v1/evaluate を呼び出してゼロデコーディング視覚判定を行う。
 *
 * @param {object} params
 * @param {string} params.imageBase64 画像の base64 文字列（data URL または純 base64）
 * @param {string} params.goal 判定したいゴール（例: "モーダルが閉じているか"）
 * @param {Record<string, string>} [params.choices] 選択肢の辞書（既定: success / failure）
 * @param {string} [params.model] 使用モデル（既定: '440m'）
 * @param {string} [params.eg2Url] eg2 サーバー URL
 * @param {number} [params.timeoutMs] タイムアウト（既定 15000ms）
 * @param {number} [params.maxRetries] 503 時のリトライ回数（既定 2）
 * @param {boolean} [params.bypassCache] キャッシュをバイパスするか（既定 false）
 * @returns {Promise<{ ok: boolean, choice?: string, score?: number, scores?: Record<string, number>, cached?: boolean, error?: string, hint?: string }>}
 */
export async function evaluateGoalWithEg2({
  imageBase64,
  goal,
  choices = { success: 'ゴールを達成している', failure: 'ゴールを達成していない' },
  model = '440m',
  eg2Url = DEFAULT_EG2_URL,
  timeoutMs = 15000,
  maxRetries = 2,
  bypassCache = false,
}) {
  // 1. 引数バリデーション & DoS ガード
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return { ok: false, error: 'imageBase64 is required for evaluateGoalWithEg2' };
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
    return {
      ok: false,
      error: `Image payload too large (${Math.round(imageBase64.length / 1024)}KB). Maximum allowed is ${MAX_IMAGE_BASE64_LENGTH / (1024 * 1024)}MB.`,
      hint: '画像を圧縮するか、コンパクトな inline 変種を使用してください。',
    };
  }

  const trimmedGoal = String(goal || '').trim();
  if (!trimmedGoal) {
    return { ok: false, error: 'goal is required for evaluateGoalWithEg2' };
  }
  if (trimmedGoal.length > MAX_GOAL_LENGTH) {
    return { ok: false, error: `goal text too long (max ${MAX_GOAL_LENGTH} chars)` };
  }

  // choices の正規化
  let normalizedChoices = choices;
  if (!normalizedChoices || typeof normalizedChoices !== 'object' || Object.keys(normalizedChoices).length === 0) {
    normalizedChoices = { success: 'ゴールを達成している', failure: 'ゴールを達成していない' };
  }
  const choiceKeys = Object.keys(normalizedChoices);
  if (choiceKeys.length > MAX_CHOICES_COUNT) {
    return { ok: false, error: `Too many choices (max ${MAX_CHOICES_COUNT})` };
  }
  for (const k of choiceKeys) {
    if (typeof normalizedChoices[k] !== 'string' || normalizedChoices[k].length > MAX_CHOICE_TEXT_LENGTH) {
      return { ok: false, error: `Choice description for "${k}" must be a string under ${MAX_CHOICE_TEXT_LENGTH} chars` };
    }
  }

  // 2. SSRF ガード
  const urlCheck = validateEg2Url(eg2Url);
  if (!urlCheck.valid) {
    return { ok: false, error: urlCheck.error, hint: 'eg2Url にはローカルのアドレス（例: http://127.0.0.1:38765）を指定してください。' };
  }

  // data:image/png;base64,... プレフィックスの安全な除去
  const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');

  // 3. 評価キャッシュチェック
  const cacheKey = computeCacheKey(cleanBase64, trimmedGoal, normalizedChoices, model);
  if (!bypassCache) {
    const cached = getFromCache(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const endpoint = `${urlCheck.url}/v1/evaluate`;
  const body = JSON.stringify({
    goal: trimmedGoal,
    choices: normalizedChoices,
    images: [cleanBase64],
    embedding_model: model,
  });

  // 4. 指数バックオフ付きリクエスト実行（503 過負荷時の自動再試行）
  let lastErr = null;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 503 || res.status === 429) {
        // eg2 サーバー過負荷（MPS/CUDA 単一推論スレッド競合）
        if (attempt < maxRetries) {
          attempt += 1;
          const retryAfterSec = parseFloat(res.headers.get('Retry-After') || '0.5');
          const delayMs = Math.min(2000, Math.max(200, isNaN(retryAfterSec) ? 500 : retryAfterSec * 1000));
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        return {
          ok: false,
          error: `eg2 server busy (HTTP ${res.status}) after ${attempt} retries`,
          hint: 'eg2 サーバーが他の推論で混雑しています。少し時間をおいて再試行してください。',
        };
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          ok: false,
          error: `eg2 /v1/evaluate failed with HTTP ${res.status}: ${errText.slice(0, 300)}`,
        };
      }

      const data = await res.json();
      const result = {
        ok: true,
        choice: data.choice,
        score: typeof data.score === 'number' ? data.score : null,
        scores: data.scores || (data.choice && data.score != null ? { [data.choice]: data.score } : {}),
        raw: data,
      };

      // 成功結果をキャッシュ
      setInCache(cacheKey, result);
      return result;
    } catch (err) {
      lastErr = err;
      const isConnRefused = err?.cause?.code === 'ECONNREFUSED' || String(err?.message).includes('ECONNREFUSED');
      if (isConnRefused) {
        // 接続拒否はリトライせず即座に案内
        break;
      }
      if (err?.name === 'TimeoutError' || String(err?.message).includes('timeout')) {
        return {
          ok: false,
          error: `eg2 evaluation request timed out after ${timeoutMs}ms`,
          hint: 'eg2 サーバーの推論がタイムアウトしました。GPU負荷や画像サイズを確認してください。',
        };
      }
      if (attempt < maxRetries) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 300 * attempt));
        continue;
      }
      break;
    }
  }

  const isConnRefused = lastErr?.cause?.code === 'ECONNREFUSED' || String(lastErr?.message).includes('ECONNREFUSED');
  return {
    ok: false,
    error: String(lastErr?.message || lastErr),
    hint: isConnRefused
      ? 'eg2 サーバーが起動していません。ターミナルで `eg2 start` を実行してください。'
      : 'eg2 評価リクエストに失敗しました。',
  };
}

/**
 * キャッシュをクリアする（テスト用）。
 */
export function clearEg2Cache() {
  EVAL_CACHE.clear();
}
