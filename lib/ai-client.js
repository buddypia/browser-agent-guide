// プロバイダ非依存のAI呼び出し。Structured Outputs(構造化出力)で必ずJSONを得る。
// - openai / custom : chat/completions の response_format=json_schema(strict)
// - anthropic       : 単一ツールの input_schema を強制(tool_choice)して構造化出力を得る
// - gemini          : generateContent の responseMimeType + responseJsonSchema で構造化出力を得る

/**
 * 拡張が期待する応答スキーマを動詞名リストから生成する。
 * AIは reply(自然文) と actions(動詞の列) を返す。
 * 動詞ごとに引数の形が異なるため、args は JSON文字列(argsJson)として受け取り、
 * strictなStructured Outputsの制約(全プロパティrequired/additionalProperties:false)を満たす。
 */
export function buildResponseSchema(verbNames) {
  const verbEnum = verbNames.length ? verbNames : ['noop'];
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: {
        type: 'string',
        description: 'ユーザーへの日本語の自然文での応答。実行した/する操作の要約も含める。',
      },
      actions: {
        type: 'array',
        description: 'ページに対して順番に実行する操作(動詞)の列。操作不要なら空配列。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verb: {
              type: 'string',
              enum: verbEnum,
              description: '実行する動詞。必ずレジストリの動詞から選ぶ。',
            },
            argsJson: {
              type: 'string',
              description: 'この動詞へ渡す引数オブジェクトのJSON文字列。引数が無ければ "{}"。',
            },
            reason: {
              type: 'string',
              description: 'この操作を行う理由(短く)。',
            },
          },
          required: ['verb', 'argsJson', 'reason'],
        },
      },
    },
    required: ['reply', 'actions'],
  };
}

const SCHEMA_NAME = 'page_agent_plan';

/**
 * AIを呼び出して構造化された計画(reply + actions)を得る。
 * @returns {Promise<{reply:string, actions:Array<{verb,args,reason}>, raw:object}>}
 */
export async function callAI({ ai, messages, verbNames }) {
  const schema = buildResponseSchema(verbNames);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let parsed;
      if (ai.provider === 'anthropic') {
        parsed = await callAnthropic({ ai, messages, schema });
      } else if (ai.provider === 'gemini') {
        parsed = await callGemini({ ai, messages, schema });
      } else {
        parsed = await callOpenAICompatible({ ai, messages, schema });
      }
      // argsJson を実際のオブジェクトへ復元する。
      const actions = Array.isArray(parsed.actions)
        ? parsed.actions.map((a) => ({
            verb: a.verb,
            reason: a.reason || '',
            args: safeParseJson(a.argsJson),
          }))
        : [];
      return { reply: parsed.reply || '', actions, raw: parsed };
    } catch (err) {
      lastError = err;
      console.warn(`AI call attempt ${attempt} failed: ${err.message || err}. Retrying...`);
    }
  }
  throw lastError;
}

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// ---- OpenAI互換 (OpenAI / 任意のOpenAI互換エンドポイント) ----
async function callOpenAICompatible({ ai, messages, schema }) {
  const url = `${trimSlash(ai.baseUrl || 'https://api.openai.com/v1')}/chat/completions`;
  const body = {
    model: ai.model,
    temperature: typeof ai.temperature === 'number' ? ai.temperature : 0,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: SCHEMA_NAME,
        strict: true,
        schema,
      },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ai.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API エラー ${res.status}: ${await safeText(res)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI応答が空でした。');
  return cleanAndParseJson(content);
}

// ---- Anthropic (tool_choice で構造化出力を強制) ----
async function callAnthropic({ ai, messages, schema }) {
  const url = 'https://api.anthropic.com/v1/messages';
  // system メッセージは Anthropic では top-level の system へ分離する。
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const body = {
    model: ai.anthropicModel || 'claude-sonnet-4-6',
    max_tokens: 2048,
    temperature: typeof ai.temperature === 'number' ? ai.temperature : 0,
    system,
    messages: convo,
    tools: [
      {
        name: SCHEMA_NAME,
        description: 'ページ操作の計画(reply と actions)を構造化して返す。',
        input_schema: schema,
      },
    ],
    tool_choice: { type: 'tool', name: SCHEMA_NAME },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ai.apiKey,
      'anthropic-version': '2023-06-01',
      // 拡張(ブラウザ)からの直接呼び出しを許可する。
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API エラー ${res.status}: ${await safeText(res)}`);
  }
  const data = await res.json();
  const toolUse = (data?.content || []).find((c) => c.type === 'tool_use');
  if (!toolUse) throw new Error('AIがツール出力を返しませんでした。');
  return toolUse.input;
}

// ---- Gemini (generateContent の Structured Outputs) ----
async function callGemini({ ai, messages, schema }) {
  const model = geminiModelPath(ai.geminiModel || 'gemini-3.5-flash');
  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const body = {
    contents,
    generationConfig: {
      temperature: typeof ai.temperature === 'number' ? ai.temperature : 0,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseJsonSchema: withGeminiPropertyOrdering(schema),
    },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': ai.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Gemini API エラー ${res.status}: ${await safeText(res)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p.text || '').join('').trim();
  if (!content) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'unknown';
    throw new Error(`Gemini応答が空でした。finishReason=${reason}`);
  }
  return cleanAndParseJson(content);
}

function trimSlash(s) {
  return String(s).replace(/\/+$/, '');
}

function geminiModelPath(model) {
  const name = String(model || 'gemini-3.5-flash').trim();
  const path = name.startsWith('models/') ? name : `models/${name}`;
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function withGeminiPropertyOrdering(value) {
  if (Array.isArray(value)) return value.map(withGeminiPropertyOrdering);
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = withGeminiPropertyOrdering(child);
  }
  if (next.type === 'object' && next.properties && !next.propertyOrdering) {
    next.propertyOrdering = Object.keys(next.properties);
  }
  return next;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '(本文取得失敗)';
  }
}

export function cleanAndParseJson(content) {
  let clean = content.trim();

  // 1. Markdown code blocks を除去
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```[a-zA-Z0-9]*\n/, '').replace(/\n```$/, '').trim();
  }

  // 2. コントロール文字(改行やタブなど)をエスケープ
  let sanitized = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inString) {
      if (escape) {
        sanitized += c;
        escape = false;
      } else if (c === '\\') {
        sanitized += c;
        escape = true;
      } else if (c === '"') {
        sanitized += c;
        inString = false;
      } else {
        const code = c.charCodeAt(0);
        if (code < 32) {
          if (c === '\n') sanitized += '\\n';
          else if (c === '\r') sanitized += '\\r';
          else if (c === '\t') sanitized += '\\t';
          else if (c === '\b') sanitized += '\\b';
          else if (c === '\f') sanitized += '\\f';
          else {
            const hex = code.toString(16).padStart(4, '0');
            sanitized += '\\u' + hex;
          }
        } else {
          sanitized += c;
        }
      }
    } else {
      if (c === '"') {
        inString = true;
      }
      sanitized += c;
    }
  }

  try {
    return JSON.parse(sanitized);
  } catch (err) {
    console.error('JSON Parse failed. Original content:', content);
    console.error('Sanitized content:', sanitized);

    const posMatch = err.message.match(/at position (\d+)/);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const start = Math.max(0, pos - 50);
      const end = Math.min(sanitized.length, pos + 50);
      const snippet = sanitized.slice(start, end);
      const indicator = ' '.repeat(pos - start) + '^';
      throw new Error(
        `JSONパースエラー: ${err.message}\n` +
        `エラー周辺のテキスト:\n` +
        `>>> ${snippet}\n` +
        `>>> ${indicator}\n` +
        `元の応答テキスト(部分): ${content.slice(0, 200)}...`
      );
    }
    throw new Error(`JSONパースエラー: ${err.message}. 元の応答テキスト: ${content}`);
  }
}
