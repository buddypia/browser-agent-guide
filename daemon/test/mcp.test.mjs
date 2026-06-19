// MCP 統合テスト: 実際の MCP クライアント（Streamable HTTP）でデーモンに接続し、
// ツール一覧 / lightweight context / image+パス取得を検証する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const INBOX = resolve(here, 'fixtures/inbox');
const NEWER = '2026-06-17T09-58-00-021Z';

let httpServer;
let baseUrl;

before(async () => {
  httpServer = createHttpServer({ inboxDir: INBOX });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const { port } = httpServer.address();
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

after(async () => {
  await new Promise((r) => httpServer.close(r));
});

async function withClient(fn) {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('tools/list が 5 ツールを公開する', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'get_latest_visual_feedback',
      'get_latest_visual_feedback_context',
      'get_visual_feedback',
      'get_visual_feedback_context',
      'list_visual_feedback',
    ]);
    const latestImage = tools.find((t) => t.name === 'get_latest_visual_feedback');
    assert.ok(latestImage.inputSchema.required.includes('contextId'), 'image tool は contextId が必須');
    assert.ok(latestImage.inputSchema.required.includes('imageReason'), 'image tool は imageReason が必須');
  });
});

test('list_visual_feedback が新しい順に id を返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'list_visual_feedback', arguments: {} });
    const text = res.content.find((c) => c.type === 'text').text;
    assert.ok(text.includes(`id=${NEWER}`));
    // 新しい方が先頭行
    assert.ok(text.split('\n')[0].includes(NEWER));
  });
});

test('get_latest_visual_feedback が image(PNG) + file_path を返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_visual_feedback',
      arguments: {
        contextId: NEWER,
        imageReason: 'test intentionally verifies the high-cost vision transport path',
      },
    });
    const img = res.content.find((c) => c.type === 'image');
    const txt = res.content.find((c) => c.type === 'text');
    assert.ok(img, 'image content がある（vision 経路）');
    assert.equal(img.mimeType, 'image/png');
    const head = Buffer.from(img.data, 'base64').subarray(0, 8);
    assert.deepEqual([...head], [137, 80, 78, 71, 13, 10, 26, 10], '有効な PNG');
    assert.ok(txt.text.includes('file_path: '), 'パス fallback がある');
    assert.ok(txt.text.includes(NEWER), '最新エントリのパス');
  });
});

test('get_latest_visual_feedback は contextId が一致しない時 image を返さない', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_visual_feedback',
      arguments: {
        contextId: 'stale-context',
        imageReason: 'test verifies stale context guard before vision transport',
      },
    });
    assert.ok(!res.content.some((c) => c.type === 'image'), 'stale context では image を返さない');
    const txt = res.content.find((c) => c.type === 'text').text;
    assert.ok(txt.includes('image omitted by context-first guard'));
    assert.ok(txt.includes(`current_id: ${NEWER}`));
  });
});

test('get_latest_visual_feedback_context が image 無しで @agent と selector を返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_latest_visual_feedback_context', arguments: {} });
    assert.ok(!res.content.some((c) => c.type === 'image'), 'context-only なので image を返さない');
    const txt = res.content.find((c) => c.type === 'text');
    assert.ok(txt.text.includes('visual_feedback_context: image omitted'));
    assert.ok(txt.text.includes('agent="@agent:docs/api-list"'));
    assert.ok(txt.text.includes('selector="main h2"'));
    assert.ok(txt.text.includes('candidate: source=nearest-link'));
    assert.ok(txt.text.includes('agent_lookup:'));
    assert.ok(txt.text.includes('image_gate: pass contextId='));
    assert.equal(res.structuredContent.id, NEWER);
    assert.equal(res.structuredContent.annotations[0].dataAgentId, '@agent:docs/api-list');
    assert.equal(res.structuredContent.annotations[0].targetCandidates[0].dataAsin, 'B012345678');
    assert.equal(res.structuredContent.agentLookup.imageGate.contextId, NEWER);
  });
});

test('get_visual_feedback_context が id 指定で image 無し context を返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_visual_feedback_context', arguments: { id: NEWER } });
    assert.ok(!res.content.some((c) => c.type === 'image'), 'id 指定 context も image を返さない');
    assert.equal(res.structuredContent.id, NEWER);
  });
});

test('get_visual_feedback: 不明 id は isError', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_visual_feedback',
      arguments: {
        id: 'nope',
        contextId: 'nope',
        imageReason: 'test verifies unknown id still returns an MCP error',
      },
    });
    assert.equal(res.isError, true);
  });
});

test('get_visual_feedback_context: 不明 id は isError', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_visual_feedback_context', arguments: { id: 'nope' } });
    assert.equal(res.isError, true);
  });
});

const OLDER = '2026-06-17T08-00-00-000Z'; // fixture: title="OLD"

test('list_visual_feedback: titleContains で該当のみ（OLD で古い方だけ）', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'list_visual_feedback', arguments: { titleContains: 'OLD' } });
    const text = res.content.find((c) => c.type === 'text').text;
    assert.ok(text.includes(`id=${OLDER}`), '古い方が出る');
    assert.ok(!text.includes(`id=${NEWER}`), '新しい方(title=API)は出ない');
  });
});

test('get_latest_visual_feedback: urlContains で絞った最新を image で返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_visual_feedback',
      arguments: {
        urlContains: 'example.com',
        contextId: NEWER,
        imageReason: 'test intentionally verifies filtered high-cost vision transport',
      },
    });
    const img = res.content.find((c) => c.type === 'image');
    const txt = res.content.find((c) => c.type === 'text');
    assert.ok(img, 'image を返す');
    assert.ok(txt.text.includes(NEWER), 'example.com 一致のうち最新');
  });
});

test('get_latest_visual_feedback: 不一致フィルタは image 無しの案内テキスト', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_visual_feedback',
      arguments: {
        urlContains: 'no-such-project',
        contextId: NEWER,
        imageReason: 'test verifies no image is returned when the filter has no matching entry',
      },
    });
    assert.ok(!res.content.some((c) => c.type === 'image'), '誤って別プロジェクトの image を返さない');
    const txt = res.content.find((c) => c.type === 'text').text;
    assert.ok(txt.includes('no-such-project'), '条件を案内');
  });
});
