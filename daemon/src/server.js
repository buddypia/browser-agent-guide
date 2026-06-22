// MCP サーバー定義。inbox を 5 つのツールで公開する。
//   - list_visual_feedback                 : 一覧（id を取得）
//   - get_latest_visual_feedback_context  : 最新を text/structured context で取得（画像なし）
//   - get_visual_feedback_context         : id 指定で text/structured context を取得（画像なし）
//   - get_latest_visual_feedback          : context 確認後のみ image+パスで取得（必要時の vision）
//   - get_visual_feedback                 : context 確認後のみ id 指定で image+パスを取得
// image ツールは、image を見られない CLI 向けに file_path テキストを必ず併走させる（§3.2）。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildEntryContent, buildEntryContext, buildEntryContextText } from './inbox.js';
import { createDiskEntryStore } from './store.js';

// 複数プロジェクトが1つの inbox に積まれる時の絞り込み引数（部分一致・任意）。
const FILTER_SCHEMA = {
  urlContains: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
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
export function createMcpServer(entrySource, { shotUrlFor } = {}) {
  const entryStore = asEntryStore(entrySource);
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
        'ブラウザのお描き注釈スクショ inbox を新しい順に一覧する（id・取得元 url/title 付き）。' +
        '複数プロジェクトが混在する時は urlContains / titleContains で今のプロジェクトのものに絞れる。',
      inputSchema: { limit: z.number().int().min(1).max(50).optional(), ...FILTER_SCHEMA },
    },
    async ({ limit, urlContains, titleContains }) => {
      const entries = entryStore.queryEntries({ limit: limit || 20, urlContains, titleContains });
      const text = entries.length
        ? entries
            .map(
              (e, i) =>
                `${i + 1}. id=${e.id}  (${new Date(e.mtime).toISOString()})${entryStatus(e)}\n   url=${e.url || '(不明)'}  title=${e.title || '(不明)'}`
            )
            .join('\n')
        : filterEmptyMessage({ urlContains, titleContains });
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
        '複数プロジェクトが混在する時は urlContains / titleContains で今のプロジェクトのものに絞れる。',
      inputSchema: { ...FILTER_SCHEMA },
    },
    async ({ urlContains, titleContains }) => {
      const [entry] = entryStore.queryEntries({ limit: 1, urlContains, titleContains });
      if (!entry) {
        return { content: [{ type: 'text', text: filterEmptyMessage({ urlContains, titleContains }) }] };
      }
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
        '複数プロジェクトが混在する時は urlContains / titleContains で今のプロジェクトのものに絞れる' +
        '（例: 作業中ページの URL 断片を渡す）。',
      inputSchema: { ...FILTER_SCHEMA, ...IMAGE_GATE_SCHEMA },
    },
    async ({ urlContains, titleContains, contextId, imageReason }) => {
      const [entry] = entryStore.queryEntries({ limit: 1, urlContains, titleContains });
      if (!entry) {
        return { content: [{ type: 'text', text: filterEmptyMessage({ urlContains, titleContains }) }] };
      }
      const blocked = imageGateMessage(entry, { contextId, imageReason });
      if (blocked) return { content: [{ type: 'text', text: blocked }] };
      return { content: buildEntryContent(entryStore.materialize(entry), { shotUrlFor }) };
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
      return { content: buildEntryContent(entryStore.materialize(entry), { shotUrlFor }) };
    }
  );

  return server;
}

function asEntryStore(entrySource) {
  if (entrySource?.queryEntries && entrySource?.findEntry && entrySource?.materialize) return entrySource;
  return createDiskEntryStore(entrySource);
}

function entryStatus(entry) {
  if (!entry?.storage) return '';
  return `  storage=${entry.storage}${entry.materialized === false ? '/memory' : '/materialized'}`;
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

// フィルタ有無で空時メッセージを出し分ける（誤って別プロジェクトのを掴ませない案内）。
function filterEmptyMessage({ urlContains, titleContains } = {}) {
  const cond = [urlContains && `url に「${urlContains}」`, titleContains && `title に「${titleContains}」`]
    .filter(Boolean)
    .join(' かつ ');
  if (cond) {
    return `${cond} を含む視覚フィードバックは見つかりません。条件を外すか、list_visual_feedback で一覧を確認してください。`;
  }
  return 'inbox は空です。ブラウザ拡張の「お描きを画像でAIへ」で保存してください。';
}
