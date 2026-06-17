// MCP 統合テスト: 実際の MCP クライアント（Streamable HTTP）でデーモンに接続し、
// ツール一覧 / 最新取得 / id 取得が image+パスを返すことを検証する。
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

test('tools/list が 3 ツールを公開する', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_latest_visual_feedback', 'get_visual_feedback', 'list_visual_feedback']);
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
    const res = await client.callTool({ name: 'get_latest_visual_feedback', arguments: {} });
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

test('get_visual_feedback: 不明 id は isError', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_visual_feedback', arguments: { id: 'nope' } });
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
    const res = await client.callTool({ name: 'get_latest_visual_feedback', arguments: { urlContains: 'example.com' } });
    const img = res.content.find((c) => c.type === 'image');
    const txt = res.content.find((c) => c.type === 'text');
    assert.ok(img, 'image を返す');
    assert.ok(txt.text.includes(NEWER), 'example.com 一致のうち最新');
  });
});

test('get_latest_visual_feedback: 不一致フィルタは image 無しの案内テキスト', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_latest_visual_feedback', arguments: { urlContains: 'no-such-project' } });
    assert.ok(!res.content.some((c) => c.type === 'image'), '誤って別プロジェクトの image を返さない');
    const txt = res.content.find((c) => c.type === 'text').text;
    assert.ok(txt.includes('no-such-project'), '条件を案内');
  });
});
