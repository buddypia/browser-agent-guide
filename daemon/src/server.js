// MCP サーバー定義。inbox を 5 つのツールで公開する。
//   - list_visual_feedback                 : 一覧（id を取得）
//   - get_latest_visual_feedback_context  : 最新を text/structured context で取得（画像なし）
//   - get_visual_feedback_context         : id 指定で text/structured context を取得（画像なし）
//   - get_latest_visual_feedback          : context 確認後のみ image+パスで取得（必要時の vision）
//   - get_visual_feedback                 : context 確認後のみ id 指定で image+パスを取得
// image ツールは、image を見られない CLI 向けに file_path テキストを必ず併走させる（§3.2）。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildEntryContent, buildEntryContext, buildEntryContextText, peekDistinctRecent } from './inbox.js';
import { createDiskEntryStore } from './store.js';

// 引数なし latest が曖昧（直近に複数プロジェクト）と判定する時間窓（既定90分、capturedAt 基準）。
const DEFAULT_LATEST_WINDOW_MS = 90 * 60 * 1000;

// 複数プロジェクトが1つの inbox に積まれる時の絞り込み引数（部分一致・任意）。
const FILTER_SCHEMA = {
  urlContains: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  tabId: z.number().int().optional(),
  windowId: z.number().int().optional(),
};

// image は token 消費が大きいので、context-first の確認済み id と理由を必須にする。
const IMAGE_GATE_SCHEMA = {
  contextId: z
    .string()
    .min(1)
    .describe('get_latest_visual_feedback_context / get_visual_feedback_context で先に確認した entry id。'),
  imageReason: z
    .string()
    .min(1)
    .describe('@agent: / selector / testid / anchorLabel だけでは不十分で、vision が必要な具体的理由。'),
};

// shotUrlFor(id, kind) は、ディスクパス非依存の loopback HTTP 取得先（/shot|/raw/<id>.png?token=…）を
// 返すオプション関数。渡された時だけ context/image テキストに shot_url/raw_url を併走させる。
export function createMcpServer(entrySource, { shotUrlFor, latestWindowMs = DEFAULT_LATEST_WINDOW_MS, nowMs } = {}) {
  const entryStore = asEntryStore(entrySource);
  const currentNowMs = typeof nowMs === 'function' ? nowMs : () => (Number.isFinite(nowMs) ? nowMs : Date.now());
  const server = new McpServer(
    { name: 'bag-visual-feedback', version: '0.1.0' },
    {
      instructions:
        'ブラウザのお描き注釈スクリーンショットと構造化メタを受け取るための inbox。' +
        'ユーザーが「画面のこの部分をこう直して」と図で示したら、まず get_latest_visual_feedback_context を呼び、' +
        '@agent: / selector / testid / anchorLabel を最優先で対象特定する。@agent: がある時は ' +
        'data-agent-id="@agent:" を属性名込みでソース検索し、画像を呼ばない。曖昧または見た目の判断が必要な時だけ ' +
        'contextId と imageReason を渡して get_latest_visual_feedback / get_visual_feedback を呼び、返ってきた image を絵として解釈する。',
    }
  );

  server.registerTool(
    'list_visual_feedback',
    {
      title: '視覚フィードバック一覧',
      description:
        'ブラウザのお描き注釈スクショ inbox を新しい順に一覧する（id・取得元 url/title/tab 付き）。' +
        '複数プロジェクトが混在する時は urlContains / titleContains、同一URLの複数タブは tabId / windowId で絞れる。',
      inputSchema: { limit: z.number().int().min(1).max(50).optional(), ...FILTER_SCHEMA },
    },
    async ({ limit, urlContains, titleContains, tabId, windowId }) => {
      const entries = entryStore.queryEntries({ limit: limit || 20, urlContains, titleContains, tabId, windowId });
      const text = entries.length
        ? entries
            .map(
              (e, i) =>
                `${i + 1}. id=${e.id}  (${new Date(e.mtime).toISOString()})${entryStatus(e)}\n   url=${e.url || '(不明)'}  title=${e.title || '(不明)'}${entryTab(e)}`
            )
            .join('\n')
        : filterEmptyMessage({ urlContains, titleContains, tabId, windowId });
      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'get_latest_visual_feedback_context',
    {
      title: '最新の視覚フィードバック文脈を取得',
      description:
        '最新のお描きメタデータを image なしで返す。@agent: / selector / testid / anchorLabel を先に読み、' +
        '画像 vision を使わず対象特定できるか判断するための軽量ツール。' +
        '複数プロジェクトが混在する時は urlContains / titleContains、同一URLの複数タブは tabId / windowId で絞れる。',
      inputSchema: { ...FILTER_SCHEMA },
    },
    async ({ urlContains, titleContains, tabId, windowId }) => {
      // 引数なし（無フィルタ）の時だけ曖昧検知。直近に複数プロジェクトが居れば単一を返さず候補一覧を返す。
      if (!urlContains && !titleContains && tabId == null && windowId == null) {
        const rows = entryStore.queryEntries({ limit: 8 });
        const entry = rows[0];
        if (!entry) {
          return { content: [{ type: 'text', text: filterEmptyMessage({}) }] };
        }
        const stale = staleLatestResult(entry, { latestWindowMs, nowMs: currentNowMs(), urlContains, titleContains });
        if (stale) return stale;
        const peek = peekDistinctRecent(rows, { windowMs: latestWindowMs });
        if (peek.distinctCount >= 2) {
          return ambiguousLatestResult(peek);
        }
        // 単一プロジェクト（または空）→ 従来どおり最新を返す。
        const context = buildEntryContext(entry, { shotUrlFor });
        return {
          content: [{ type: 'text', text: buildEntryContextText(context) }],
          structuredContent: context,
        };
      }
      // フィルタ指定時は従来どおり（呼び出し側が既にスコープを絞っている）。
      const [entry] = entryStore.queryEntries({ limit: 1, urlContains, titleContains, tabId, windowId });
      if (!entry) {
        return { content: [{ type: 'text', text: filterEmptyMessage({ urlContains, titleContains, tabId, windowId }) }] };
      }
      const stale = staleLatestResult(entry, { latestWindowMs, nowMs: currentNowMs(), urlContains, titleContains, tabId, windowId });
      if (stale) return stale;
      const context = buildEntryContext(entry, { shotUrlFor });
      return {
        content: [{ type: 'text', text: buildEntryContextText(context) }],
        structuredContent: context,
      };
    }
  );

  server.registerTool(
    'get_latest_visual_feedback',
    {
      title: '必要時のみ: 最新の視覚フィードバック画像を取得',
      description:
        '高コストな image(PNG) + ファイルパス取得。先に get_latest_visual_feedback_context を読み、' +
        '@agent: / selector / testid / anchorLabel で特定できない時だけ呼ぶ。' +
        'context で確認した id を contextId に渡し、imageReason に vision が必要な理由を書く。' +
        '複数プロジェクトが混在する時は urlContains / titleContains、同一URLの複数タブは tabId / windowId で絞れる' +
        '（例: 作業中ページの URL 断片を渡す）。',
      inputSchema: { ...FILTER_SCHEMA, ...IMAGE_GATE_SCHEMA },
    },
    async ({ urlContains, titleContains, tabId, windowId, contextId, imageReason }) => {
      // 引数なしの時だけ曖昧検知。複数プロジェクトが直近に居る時は、別案件の image を
      // サイレントに返さない。例外として contextId が「窓内の候補 id」に一致し imageReason がある
      // 場合だけ、その候補の image を返す（候補 context を読んだ上での再取得を妨げない）。
      if (!urlContains && !titleContains && tabId == null && windowId == null) {
        const rows = entryStore.queryEntries({ limit: 8 });
        const entry = rows[0];
        if (!entry) {
          return { content: [{ type: 'text', text: filterEmptyMessage({}) }] };
        }
        const stale = staleLatestResult(entry, { latestWindowMs, nowMs: currentNowMs(), urlContains, titleContains });
        if (stale) return stale;
        const peek = peekDistinctRecent(rows, { windowMs: latestWindowMs });
        if (peek.distinctCount >= 2) {
          const picked = peek.candidates.find((c) => c.id === contextId);
          if (picked && String(imageReason || '').trim()) {
            const entry = entryStore.findEntry(picked.id);
            if (entry) {
              const content = buildEntryContent(materializeForImage(entryStore, entry), { shotUrlFor });
              // 別案件混在の警告を image と一緒に必ず連れて行く。
              content.unshift({ type: 'text', text: ambiguousLatestMessage(peek.candidates) });
              return { content };
            }
          }
          return ambiguousLatestResult(peek);
        }
        // 単一プロジェクト（または空）→ 従来の imageGate 経路をそのまま。
        const blocked = imageGateMessage(entry, { contextId, imageReason });
        if (blocked) return { content: [{ type: 'text', text: blocked }] };
        return { content: buildEntryContent(materializeForImage(entryStore, entry), { shotUrlFor }) };
      }
      // フィルタ指定時は従来どおり。
      const [entry] = entryStore.queryEntries({ limit: 1, urlContains, titleContains, tabId, windowId });
      if (!entry) {
        return { content: [{ type: 'text', text: filterEmptyMessage({ urlContains, titleContains, tabId, windowId }) }] };
      }
      const stale = staleLatestResult(entry, { latestWindowMs, nowMs: currentNowMs(), urlContains, titleContains, tabId, windowId });
      if (stale) return stale;
      const blocked = imageGateMessage(entry, { contextId, imageReason });
      if (blocked) return { content: [{ type: 'text', text: blocked }] };
      return { content: buildEntryContent(materializeForImage(entryStore, entry), { shotUrlFor }) };
    }
  );

  server.registerTool(
    'get_visual_feedback_context',
    {
      title: 'IDで視覚フィードバック文脈を取得',
      description:
        'id を指定してお描きメタデータを image なしで返す。@agent: / selector / testid / anchorLabel を先に読むための軽量ツール。',
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const entry = entryStore.findEntry(id);
      if (!entry) return { content: [{ type: 'text', text: `id=${id} は見つかりません。` }], isError: true };
      const context = buildEntryContext(entry, { shotUrlFor });
      return {
        content: [{ type: 'text', text: buildEntryContextText(context) }],
        structuredContent: context,
      };
    }
  );

  server.registerTool(
    'get_visual_feedback',
    {
      title: '必要時のみ: IDで視覚フィードバック画像を取得',
      description:
        '高コストな image(PNG) + ファイルパス取得。先に get_visual_feedback_context で同じ id の ' +
        '@agent: / selector / testid / anchorLabel を確認し、それでも vision が必要な時だけ呼ぶ。',
      inputSchema: { id: z.string().min(1), ...IMAGE_GATE_SCHEMA },
    },
    async ({ id, contextId, imageReason }) => {
      const entry = entryStore.findEntry(id);
      if (!entry) return { content: [{ type: 'text', text: `id=${id} は見つかりません。` }], isError: true };
      const blocked = imageGateMessage(entry, { contextId, imageReason });
      if (blocked) return { content: [{ type: 'text', text: blocked }] };
      return { content: buildEntryContent(materializeForImage(entryStore, entry), { shotUrlFor }) };
    }
  );

  return server;
}

// image 応答用に entry を materialize する。/shot ルートと同じく「画像バイトはメモリ優先」で、
// disk 書き込み（file_path fallback の materialize）は best-effort 扱いにする。
// 書き込みに失敗（read-only inbox / disk full 等）しても、メモリの画像バイト + shot_url で応答を返す。
// 成功時は従来どおり file_path を materialize する（image fallback 不変条件を満たす）。
function materializeForImage(entryStore, entry) {
  try {
    return entryStore.materialize(entry);
  } catch {
    return entry;
  }
}

function asEntryStore(entrySource) {
  if (entrySource?.queryEntries && entrySource?.findEntry && entrySource?.materialize) return entrySource;
  return createDiskEntryStore(entrySource);
}

function entryStatus(entry) {
  if (!entry?.storage) return '';
  return `  storage=${entry.storage}${entry.materialized === false ? '/memory' : '/materialized'}`;
}

function entryTab(entry) {
  const tab = entry?.tab;
  if (!tab) return '';
  const parts = [
    Number.isInteger(tab.tabId) && `tabId=${tab.tabId}`,
    Number.isInteger(tab.windowId) && `windowId=${tab.windowId}`,
    Number.isInteger(tab.index) && `index=${tab.index}`,
    typeof tab.active === 'boolean' && `active=${tab.active}`,
  ].filter(Boolean);
  return parts.length ? `  tab=${parts.join(' ')}` : '';
}

function imageGateMessage(entry, { contextId, imageReason } = {}) {
  if (contextId !== entry.id) {
    return (
      'visual_feedback_image: image omitted by context-first guard\n' +
      `current_id: ${entry.id}\n` +
      `provided_contextId: ${contextId || '(missing)'}\n` +
      '先に get_latest_visual_feedback_context または get_visual_feedback_context で context を読み、' +
      'その id を contextId に渡してください。@agent: / selector / testid / anchorLabel で特定できる場合は image を取得しないでください。'
    );
  }
  if (!String(imageReason || '').trim()) {
    return (
      'visual_feedback_image: image omitted by context-first guard\n' +
      `current_id: ${entry.id}\n` +
      'imageReason が空です。@agent: / selector / testid / anchorLabel だけでは不十分で vision が必要な理由を書いてください。'
    );
  }
  return '';
}

// 引数なし latest が曖昧な時の案内文。別案件を誤って掴ませないため image は返さず候補を列挙する。
const AMBIGUOUS_HINT =
  'urlContains に作業中ページの URL 断片（例: ホスト名）を渡して絞るか、list_visual_feedback で一覧を確認してください。' +
  'image が要る時は、候補の context を読んだ上でその id を contextId に渡してください。';

// 曖昧時の警告本文。text(content[]) と structuredContent.disambiguation.message の両方で共有する。
// Codex(#10334) は structuredContent があると content[] を丸ごと落として structuredContent だけを
// surface するため、この警告が text にしか無いと Codex は読めず Claude Code と非対称になる。
// 1 か所に集約し両チャネルへ同じ文言を載せてパリティを保つ（文言ドリフトも防ぐ）。
const AMBIGUOUS_MESSAGE =
  'latest が曖昧です: 直近に複数プロジェクトのキャプチャがあります（別案件を誤って掴まないため image は返しません）。';

function ambiguousLatestMessage(candidates = []) {
  const lines = [];
  lines.push(AMBIGUOUS_MESSAGE);
  lines.push('candidates (newest-first):');
  for (const c of candidates) {
    lines.push(`  - id=${c.id}  host=${c.host}  title=${c.title || '(不明)'}  captured_at=${c.capturedAt || '(不明)'}`);
  }
  lines.push(AMBIGUOUS_HINT);
  return lines.join('\n');
}

// 曖昧時の text-only 応答。structuredContent には id を載せず disambiguation だけを返す
// （別案件の id を機械的にエコーして image を取り戻す経路を塞ぐ）。
function ambiguousLatestResult(peek) {
  return {
    content: [{ type: 'text', text: ambiguousLatestMessage(peek.candidates) }],
    structuredContent: {
      // message は content[] の警告文と同一。Codex は structuredContent しか surface しない場面が
      // あるため、警告を structuredContent 側にも載せて Claude Code とパリティを保つ。
      // 不変条件: top-level に id を載せない（別案件 id の laundering 防止）。message は disambiguation 内。
      disambiguation: {
        distinctCount: peek.distinctCount,
        candidates: peek.candidates,
        hint: AMBIGUOUS_HINT,
        message: AMBIGUOUS_MESSAGE,
      },
    },
  };
}

const STALE_MESSAGE =
  'latest が古すぎます: 最新候補が freshness window を超えているため、誤った過去画面を掴まないよう context/image は返しません。';
const STALE_HINT =
  'ブラウザ拡張でいまの画面を再キャプチャしてください。過去データが必要な場合だけ list_visual_feedback で id を確認し、' +
  'get_visual_feedback_context / get_visual_feedback を id 指定で使ってください。';

function staleLatestResult(entry, { latestWindowMs, nowMs, urlContains, titleContains, tabId, windowId } = {}) {
  if (!isStaleLatest(entry, { latestWindowMs, nowMs })) return null;
  return {
    content: [{ type: 'text', text: staleLatestMessage(entry, { latestWindowMs, nowMs, urlContains, titleContains, tabId, windowId }) }],
    structuredContent: {
      stale: {
        message: STALE_MESSAGE,
        latest: staleLatestSummary(entry, { latestWindowMs, nowMs }),
        scope: latestScope({ urlContains, titleContains, tabId, windowId }),
        hint: STALE_HINT,
      },
    },
  };
}

function staleLatestMessage(entry, { latestWindowMs, nowMs, urlContains, titleContains, tabId, windowId } = {}) {
  const summary = staleLatestSummary(entry, { latestWindowMs, nowMs });
  const lines = [STALE_MESSAGE];
  const scope = latestScope({ urlContains, titleContains, tabId, windowId });
  if (scope) lines.push(`scope: ${scope}`);
  if (summary.url) lines.push(`url: ${summary.url}`);
  if (summary.title) lines.push(`title: ${summary.title}`);
  lines.push(`captured_at: ${summary.capturedAt || '(不明)'}`);
  lines.push(`age_minutes: ${summary.ageMinutes}`);
  lines.push(`freshness_window_minutes: ${summary.staleAfterMinutes}`);
  lines.push(STALE_HINT);
  return lines.join('\n');
}

function staleLatestSummary(entry, { latestWindowMs, nowMs } = {}) {
  const capturedAtMs = entryTimeMs(entry);
  const ageMs = Math.max(0, Number(nowMs) - capturedAtMs);
  return {
    url: entry?.url || '',
    title: entry?.title || '',
    capturedAt: entry?.capturedAt || (capturedAtMs > 0 ? new Date(capturedAtMs).toISOString() : ''),
    ageMinutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : null,
    staleAfterMinutes: Number.isFinite(latestWindowMs) ? Math.round(latestWindowMs / 60000) : null,
  };
}

function latestScope({ urlContains, titleContains, tabId, windowId } = {}) {
  return [
    urlContains && `urlContains=${urlContains}`,
    titleContains && `titleContains=${titleContains}`,
    tabId != null && `tabId=${tabId}`,
    windowId != null && `windowId=${windowId}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function isStaleLatest(entry, { latestWindowMs, nowMs } = {}) {
  if (!entry || !Number.isFinite(latestWindowMs) || latestWindowMs <= 0) return false;
  const capturedAtMs = entryTimeMs(entry);
  if (!Number.isFinite(capturedAtMs) || capturedAtMs <= 0) return true;
  return Number(nowMs) - capturedAtMs > latestWindowMs;
}

function entryTimeMs(entry) {
  const capturedAt = Date.parse(entry?.capturedAt || '');
  if (!Number.isNaN(capturedAt)) return capturedAt;
  return Number(entry?.mtime) || 0;
}

// フィルタ有無で空時メッセージを出し分ける（誤って別プロジェクトのを掴ませない案内）。
function filterEmptyMessage({ urlContains, titleContains, tabId, windowId } = {}) {
  const cond = [
    urlContains && `url に「${urlContains}」`,
    titleContains && `title に「${titleContains}」`,
    tabId != null && `tabId=${tabId}`,
    windowId != null && `windowId=${windowId}`,
  ]
    .filter(Boolean)
    .join(' かつ ');
  if (cond) {
    return `${cond} を含む視覚フィードバックは見つかりません。条件を外すか、list_visual_feedback で一覧を確認してください。`;
  }
  return 'inbox は空です。ブラウザ拡張の「お描きを画像でAIへ」で保存してください。';
}
