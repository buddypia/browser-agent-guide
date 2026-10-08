// EmbeddingGemma 2 (eg2-cli) ローカル連携クライアント。
// http://127.0.0.1:8765 (/v1/evaluate, /v1/embeddings, /health) と通信する。

export const DEFAULT_EG2_URL = process.env.EG2_URL || 'http://127.0.0.1:8765';

/**
 * eg2 サーバーの稼働状態を確認する。
 * @param {object} [opts]
 * @param {string} [opts.eg2Url]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, status?: string, error?: string, hint?: string }>}
 */
export async function checkEg2Health({ eg2Url = DEFAULT_EG2_URL, timeoutMs = 2500 } = {}) {
  const url = `${eg2Url.replace(/\/+$/, '')}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
 * スクリーンショットとゴール文言から、eg2 の POST /v1/evaluate を呼び出してゼロデコーディング視覚判定を行う。
 *
 * @param {object} params
 * @param {string} params.imageBase64 画像の base64 文字列（data URL または純 base64）
 * @param {string} params.goal 判定したいゴール（例: "モーダルが閉じているか"）
 * @param {Record<string, string>} [params.choices] 選択肢の辞書（既定: success / failure）
 * @param {string} [params.model] 使用モデル（既定: '440m'）
 * @param {string} [params.eg2Url] eg2 サーバー URL
 * @param {number} [params.timeoutMs] タイムアウト（既定 15000ms）
 * @returns {Promise<{ ok: boolean, choice?: string, score?: number, scores?: Record<string, number>, error?: string, hint?: string }>}
 */
export async function evaluateGoalWithEg2({
  imageBase64,
  goal,
  choices = { success: 'ゴールを達成している', failure: 'ゴールを達成していない' },
  model = '440m',
  eg2Url = DEFAULT_EG2_URL,
  timeoutMs = 15000,
}) {
  if (!imageBase64) {
    return { ok: false, error: 'imageBase64 is required for evaluateGoalWithEg2' };
  }
  if (!goal) {
    return { ok: false, error: 'goal is required for evaluateGoalWithEg2' };
  }

  // data:image/png;base64,... 形式であれば純 base64 に整える
  const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  const endpoint = `${eg2Url.replace(/\/+$/, '')}/v1/evaluate`;
  const body = {
    goal,
    choices,
    images: [cleanBase64],
    embedding_model: model,
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
      return {
        ok: false,
        error: `eg2 /v1/evaluate failed with HTTP ${res.status}: ${errText.slice(0, 300)}`,
        hint: res.status === 503 ? 'eg2 サーバーが過負荷です。少し待って再試行してください。' : undefined,
      };
    }

    const data = await res.json();
    return {
      ok: true,
      choice: data.choice,
      score: data.score,
      scores: data.scores || (data.choice && data.score != null ? { [data.choice]: data.score } : {}),
      raw: data,
    };
  } catch (err) {
    const isConnRefused = err?.cause?.code === 'ECONNREFUSED' || String(err?.message).includes('ECONNREFUSED');
    return {
      ok: false,
      error: String(err?.message || err),
      hint: isConnRefused
        ? 'eg2 サーバーが起動していません。ターミナルで `eg2 start` を実行してください。'
        : 'eg2 評価リクエストがタイムアウトまたは失敗しました。',
    };
  }
}
