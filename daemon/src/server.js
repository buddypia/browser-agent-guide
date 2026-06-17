// MCP サーバー定義。inbox を 3 つのツールで公開する。
//   - list_visual_feedback        : 一覧（id を取得）
//   - get_latest_visual_feedback  : 最新を image+パスで取得（CLI の主用途）
//   - get_visual_feedback         : id 指定で取得
// いずれも image を見られない CLI 向けに file_path テキストを必ず併走させる（§3.2）。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findEntry, buildEntryContent, queryEntries } from './inbox.js';

// 複数プロジェクトが1つの inbox に積まれる時の絞り込み引数（部分一致・任意）。
const FILTER_SCHEMA = {
  urlContains: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
};

export function createMcpServer(inboxDir) {
  const server = new McpServer(
    { name: 'bag-visual-feedback', version: '0.1.0' },
    {
      instructions:
        'ブラウザのお描き注釈スクリーンショットを vision で受け取るための inbox。' +
        'ユーザーが「画面のこの部分をこう直して」と図で示したら get_latest_visual_feedback を呼び、' +
        '返ってきた image を絵として解釈する（テキスト座標ではなく絵を見る）。',
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
      const entries = queryEntries(inboxDir, { limit: limit || 20, urlContains, titleContains });
      const text = entries.length
        ? entries
            .map(
              (e, i) =>
                `${i + 1}. id=${e.id}  (${new Date(e.mtime).toISOString()})\n   url=${e.url || '(不明)'}  title=${e.title || '(不明)'}`
            )
            .join('\n')
        : filterEmptyMessage(inboxDir, { urlContains, titleContains });
      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'get_latest_visual_feedback',
    {
      title: '最新の視覚フィードバックを取得',
      description:
        '最新のお描き注釈スクショを image(PNG) + ファイルパスで返す。返ってきた image を vision で解釈すること。' +
        '複数プロジェクトが混在する時は urlContains / titleContains で今のプロジェクトのものに絞れる' +
        '（例: 作業中ページの URL 断片を渡す）。',
      inputSchema: { ...FILTER_SCHEMA },
    },
    async ({ urlContains, titleContains }) => {
      const [entry] = queryEntries(inboxDir, { limit: 1, urlContains, titleContains });
      if (!entry) {
        return { content: [{ type: 'text', text: filterEmptyMessage(inboxDir, { urlContains, titleContains }) }] };
      }
      return { content: buildEntryContent(entry) };
    }
  );

  server.registerTool(
    'get_visual_feedback',
    {
      title: 'IDで視覚フィードバックを取得',
      description: 'id を指定してお描き注釈スクショを image(PNG) + ファイルパスで返す。',
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const entry = findEntry(inboxDir, id);
      if (!entry) return { content: [{ type: 'text', text: `id=${id} は見つかりません。` }], isError: true };
      return { content: buildEntryContent(entry) };
    }
  );

  return server;
}

// フィルタ有無で空時メッセージを出し分ける（誤って別プロジェクトのを掴ませない案内）。
function filterEmptyMessage(inboxDir, { urlContains, titleContains } = {}) {
  const cond = [urlContains && `url に「${urlContains}」`, titleContains && `title に「${titleContains}」`]
    .filter(Boolean)
    .join(' かつ ');
  if (cond) {
    return `${cond} を含む視覚フィードバックは見つかりません。条件を外すか、list_visual_feedback で一覧を確認してください。`;
  }
  return 'inbox は空です。ブラウザ拡張の「お描きを画像でAIへ」で保存してください。';
}
