// MCP 統合テスト: 実際の MCP クライアント（Streamable HTTP）でデーモンに接続し、
// ツール一覧 / lightweight context / image+パス取得を検証する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { writeEntry } from '../src/writer.js';

// 偽 WebP（RIFF....WEBP）。daemon は中身を検証しないので mime/サイズ検証にはこれで十分。
function fakeWebpDataUrl(sizeBytes = 80) {
  const pad = Buffer.alloc(Math.max(0, sizeBytes - 12), 0x20);
  const buf = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), pad]);
  return `data:image/webp;base64,${buf.toString('base64')}`;
}
const WEBP_MAGIC_RIFF = [0x52, 0x49, 0x46, 0x46]; // 'RIFF'
const PNG_B64_TINY =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// tmp inbox を populate して MCP クライアントで叩くヘルパ（fresh nowMs で staleness を避ける）。
async function withTmpDiskClient(populate, fn, { nowMs = Date.parse('2026-06-28T10:05:00.000Z') } = {}) {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-mcp-inline-'));
  const ids = populate(inboxDir);
  const server = createHttpServer({ inboxDir, nowMs });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new Client({ name: 'mcp-inline-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    return await fn(client, ids);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const INBOX = resolve(here, 'fixtures/inbox');
const NEWER = '2026-06-17T09-58-00-021Z';
const OLDER = '2026-06-17T08-00-00-000Z';
const FRESH_NOW = Date.parse('2026-06-17T10:10:00.000Z');
const MIXED_FRESH_NOW = Date.parse('2026-06-20T10:10:00.000Z');
const STALE_NOW = Date.parse('2026-06-17T12:00:00.000Z');

let httpServer;
let baseUrl;

before(async () => {
  httpServer = createHttpServer({ inboxDir: INBOX, nowMs: FRESH_NOW });
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

test('tools/list が新名5ツールのみを公開する（旧 page_feedback エイリアスは撤去済み）', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    // 厳密一致なので、旧 deprecated エイリアス（*_page_feedback*）が1つでも残れば失敗する。
    assert.deepEqual(names, [
      'get_feedback_context',
      'get_feedback_image',
      'get_latest_feedback_context',
      'get_latest_feedback_image',
      'list_feedback',
    ].sort());
    // 2 つの image ツールは context-first ゲート（contextId + imageReason）を必須にする。
    for (const name of ['get_latest_feedback_image', 'get_feedback_image']) {
      const imageTool = tools.find((t) => t.name === name);
      assert.ok(imageTool.inputSchema.required.includes('contextId'), `${name} は contextId が必須`);
      assert.ok(imageTool.inputSchema.required.includes('imageReason'), `${name} は imageReason が必須`);
    }
  });
});

test('list_feedback が新しい順に id を返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'list_feedback', arguments: {} });
    const text = res.content.find((c) => c.type === 'text').text;
    assert.ok(text.includes(`id=${NEWER}`));
    assert.ok(text.includes('tab=tabId=321 windowId=9 index=2 active=true'));
    // 新しい方が先頭行
    assert.ok(text.split('\n')[0].includes(NEWER));
  });
});

test('get_latest_feedback_image が image(PNG) + file_path を返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
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

test('get_latest_feedback_image は contextId が一致しない時 image を返さない', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
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

test('get_latest_feedback_context が image 無しで @agent と selector を返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_latest_feedback_context', arguments: {} });
    assert.ok(!res.content.some((c) => c.type === 'image'), 'context-only なので image を返さない');
    const txt = res.content.find((c) => c.type === 'text');
    assert.ok(txt.text.includes('feedback_context: image omitted'));
    assert.ok(txt.text.includes('agent="@agent:docs/api-list"'));
    assert.ok(txt.text.includes('selector="main h2"'));
    assert.ok(txt.text.includes('chrome_tab: tabId=321 windowId=9 index=2 active=true'));
    assert.ok(txt.text.includes('candidate: source=nearest-link'));
    assert.ok(txt.text.includes('agent_lookup:'));
    assert.ok(txt.text.includes('image_gate: pass contextId='));
    assert.equal(res.structuredContent.id, NEWER);
    assert.deepEqual(res.structuredContent.tab, { tabId: 321, windowId: 9, index: 2, active: true });
    assert.equal(res.structuredContent.annotations[0].dataAgentId, '@agent:docs/api-list');
    assert.equal(res.structuredContent.annotations[0].targetCandidates[0].dataAsin, 'B012345678');
    assert.equal(res.structuredContent.agentLookup.imageGate.contextId, NEWER);
  });
});

test('get_latest_feedback_context: tabId で同一URLの別タブを絞れる', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_latest_feedback_context', arguments: { urlContains: 'example.com/api', tabId: 111 } });
    assert.equal(res.structuredContent.id, OLDER);
    assert.deepEqual(res.structuredContent.tab, { tabId: 111, windowId: 9, index: 0, active: false });
    const text = res.content.find((c) => c.type === 'text').text;
    assert.ok(text.includes('chrome_tab: tabId=111 windowId=9 index=0 active=false'));
  });
});

test('get_latest_feedback_context: 最新候補が鮮度窓を超えたら id を返さない', async () => {
  const server = createHttpServer({ inboxDir: INBOX, nowMs: STALE_NOW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new Client({ name: 'stale-test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'get_latest_feedback_context', arguments: {} });
    assert.ok(!res.content.some((c) => c.type === 'image'), 'stale latest は image を返さない');
    assert.equal(res.structuredContent.id, undefined, 'stale latest は top-level id を返さない');
    assert.ok(res.structuredContent.stale.message.includes('latest が古すぎます'));
    assert.equal(res.structuredContent.stale.latest.capturedAt, '2026-06-17T09:58:00.021Z');
    const txt = res.content.find((c) => c.type === 'text').text;
    assert.ok(txt.includes('latest が古すぎます'));
    assert.ok(txt.includes('再キャプチャ'), '再キャプチャを促す');
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
  }
});

test('get_latest_feedback_image: stale contextId を渡しても古い image を返さない', async () => {
  const server = createHttpServer({ inboxDir: INBOX, nowMs: STALE_NOW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new Client({ name: 'stale-image-test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
      arguments: {
        contextId: NEWER,
        imageReason: 'test verifies stale latest never returns image even when the old id is supplied',
      },
    });
    assert.ok(!res.content.some((c) => c.type === 'image'), 'stale latest は image を返さない');
    assert.equal(res.structuredContent.id, undefined, 'stale latest は top-level id を返さない');
    assert.ok(res.structuredContent.stale.message.includes('latest が古すぎます'));
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
  }
});

test('get_latest_feedback_context: filtered latest でも古ければ id を返さない', async () => {
  const server = createHttpServer({ inboxDir: INBOX, nowMs: STALE_NOW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new Client({ name: 'stale-filter-test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: 'get_latest_feedback_context', arguments: { urlContains: 'example.com' } });
    assert.equal(res.structuredContent.id, undefined, 'filtered stale latest も top-level id を返さない');
    assert.equal(res.structuredContent.stale.scope, 'urlContains=example.com');
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
  }
});

test('get_feedback_context が id 指定で image 無し context を返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_feedback_context', arguments: { id: NEWER } });
    assert.ok(!res.content.some((c) => c.type === 'image'), 'id 指定 context も image を返さない');
    assert.equal(res.structuredContent.id, NEWER);
  });
});

test('get_feedback_image: 不明 id は isError', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_feedback_image',
      arguments: {
        id: 'nope',
        contextId: 'nope',
        imageReason: 'test verifies unknown id still returns an MCP error',
      },
    });
    assert.equal(res.isError, true);
  });
});

test('get_feedback_context: 不明 id は isError', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'get_feedback_context', arguments: { id: 'nope' } });
    assert.equal(res.isError, true);
  });
});

test('list_feedback: titleContains で該当のみ（OLD で古い方だけ）', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'list_feedback', arguments: { titleContains: 'OLD' } });
    const text = res.content.find((c) => c.type === 'text').text;
    assert.ok(text.includes(`id=${OLDER}`), '古い方が出る');
    assert.ok(!text.includes(`id=${NEWER}`), '新しい方(title=API)は出ない');
  });
});

test('get_latest_feedback_image: urlContains で絞った最新を image で返す', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
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

test('get_latest_feedback_image: 不一致フィルタは image 無しの案内テキスト', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
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

// 別プロジェクトが混在する inbox（amazon が最新 + 自分の example）での曖昧検知。
// 単一 host の fixtures/inbox では distinctCount<=1 で従来挙動のままなので、ここは別 fixture を立てる。
const MIXED_INBOX = resolve(here, 'fixtures/inbox-mixed');
const AMAZON_ID = '20260620-100000__amazon-co-jp__amazon__aaa0001';

async function withMixedClient(fn) {
  const server = createHttpServer({ inboxDir: MIXED_INBOX, nowMs: MIXED_FRESH_NOW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
  }
}

test('mixed inbox: bare context は image 無し・foreign id 無し・disambiguation を返す', async () => {
  await withMixedClient(async (client) => {
    const res = await client.callTool({ name: 'get_latest_feedback_context', arguments: {} });
    assert.ok(!res.content.some((c) => c.type === 'image'), '曖昧時は image を返さない');
    assert.equal(res.structuredContent.id, undefined, 'foreign id を top-level に載せない（laundering 防止）');
    assert.equal(res.structuredContent.disambiguation.distinctCount, 2);
    // Codex パリティ: Codex は structuredContent しか surface しない場面があるため、曖昧警告文を
    // structuredContent.disambiguation.message にも載せる。id を top-level に出さない不変条件は維持。
    assert.ok(
      res.structuredContent.disambiguation.message,
      'Codex パリティ: 曖昧警告文を structuredContent にも載せる'
    );
    assert.ok(res.structuredContent.disambiguation.message.includes('image は返しません'));
    const txt = res.content.find((c) => c.type === 'text').text;
    assert.ok(txt.includes('latest が曖昧'));
    assert.ok(txt.includes('amazon-co-jp'), '両プロジェクトを列挙');
    assert.ok(txt.includes('example-com'));
  });
});

test('mixed inbox: bare image で候補外 contextId は image 無し + disambiguation（別案件を漏らさない）', async () => {
  await withMixedClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
      arguments: { contextId: 'not-a-candidate', imageReason: 'verify foreign image is not leaked on a bare ambiguous call' },
    });
    assert.ok(!res.content.some((c) => c.type === 'image'), '別案件の image を漏らさない');
    assert.equal(res.structuredContent.disambiguation.distinctCount, 2);
    const txt = res.content.find((c) => c.type === 'text').text;
    assert.ok(txt.includes('latest が曖昧'));
  });
});

test('mixed inbox: bare image で窓内候補 id + imageReason はその候補の image を警告 banner 付きで返す', async () => {
  await withMixedClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
      arguments: { contextId: AMAZON_ID, imageReason: 'verify an in-window candidate id is honored with the banner' },
    });
    const img = res.content.find((c) => c.type === 'image');
    assert.ok(img, '窓内候補 id は image を返す');
    assert.equal(img.mimeType, 'image/png');
    const txt = res.content.find((c) => c.type === 'text');
    assert.ok(txt.text.includes('latest が曖昧'), '警告 banner が image と一緒に来る');
  });
});

test('mixed inbox: scoped urlContains=amazon は単一 amazon entry を image で返す（filtered path 不変）', async () => {
  await withMixedClient(async (client) => {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
      arguments: { urlContains: 'amazon', contextId: AMAZON_ID, imageReason: 'verify the filtered path still returns the scoped capture image' },
    });
    const img = res.content.find((c) => c.type === 'image');
    assert.ok(img, 'スコープ指定なら image を返す');
    const txt = res.content.find((c) => c.type === 'text');
    assert.ok(txt.text.includes(AMAZON_ID));
  });
});

// ── Codex#10334 パリティ不変条件（本丸の回帰ガード） ─────────────────────────────
// OpenAI Codex CLI は tool 結果に structuredContent があると content[]（image block を含む）を
// 丸ごと落として structuredContent だけを surface する（codex#10334, OPEN）。Claude Code は落とさない。
// したがって「image を含む結果は structuredContent を載せない」を守る限り、両 CLI とも image を
// 受け取れてパリティが保たれる。daemon は元々この規則を満たす（image 分岐は content のみ返す）が、
// 将来の編集でサイレントに壊れて Codex だけ image を失う事故を防ぐため恒久テストで固定する。
function assertImageHasNoStructured(res, label) {
  const hasImage = Array.isArray(res.content) && res.content.some((c) => c.type === 'image');
  if (hasImage) {
    assert.equal(
      res.structuredContent,
      undefined,
      `Codex#10334 パリティ: image を含む結果は structuredContent を持ってはならない (${label})`
    );
  }
}

test('Codex#10334 パリティ: image を返す全分岐で structuredContent を載せない', async () => {
  // 単一プロジェクト inbox の image 分岐 3 種（single / by-id / filtered）。
  await withClient(async (client) => {
    const single = await client.callTool({
      name: 'get_latest_feedback_image',
      arguments: { contextId: NEWER, imageReason: 'parity guard: single-project image must omit structuredContent' },
    });
    assert.ok(single.content.some((c) => c.type === 'image'), '前提: single は image を返す');
    assertImageHasNoStructured(single, 'get_latest_feedback_image single');

    const byId = await client.callTool({
      name: 'get_feedback_image',
      arguments: { id: NEWER, contextId: NEWER, imageReason: 'parity guard: by-id image must omit structuredContent' },
    });
    assert.ok(byId.content.some((c) => c.type === 'image'), '前提: by-id は image を返す');
    assertImageHasNoStructured(byId, 'get_feedback_image by-id');

    const filtered = await client.callTool({
      name: 'get_latest_feedback_image',
      arguments: {
        urlContains: 'example.com',
        contextId: NEWER,
        imageReason: 'parity guard: filtered image must omit structuredContent',
      },
    });
    assert.ok(filtered.content.some((c) => c.type === 'image'), '前提: filtered は image を返す');
    assertImageHasNoStructured(filtered, 'get_latest_feedback_image filtered');
  });

  // 混在 inbox の「窓内候補 id の banner + image」分岐（server.js は content のみ返す経路）。
  await withMixedClient(async (client) => {
    const banner = await client.callTool({
      name: 'get_latest_feedback_image',
      arguments: { contextId: AMAZON_ID, imageReason: 'parity guard: in-window candidate banner image must omit structuredContent' },
    });
    assert.ok(banner.content.some((c) => c.type === 'image'), '前提: banner は image を返す');
    assertImageHasNoStructured(banner, 'mixed-inbox in-window candidate banner');
  });
});

// ── MCP inline コンパクト変種（Claude Code 出力トークン上限対策）のエンドツーエンド ─────────
test('get_feedback_image: inline(webp) があれば webp を返し、file_path はフル解像度のまま、structuredContent 無し', async () => {
  await withTmpDiskClient(
    (inboxDir) => {
      const w = writeEntry(inboxDir, {
        capturedAt: '2026-06-28T10:00:00.000Z',
        url: 'https://inline.example/p',
        title: 'Inline',
        image: { shot: PNG_B64_TINY, inline: fakeWebpDataUrl(), inlineMime: 'image/webp' },
        annotation: { url: 'https://inline.example/p', title: 'Inline', capturedAt: '2026-06-28T10:00:00.000Z', items: [] },
      });
      return { id: w.id };
    },
    async (client, { id }) => {
      const res = await client.callTool({
        name: 'get_feedback_image',
        arguments: { id, contextId: id, imageReason: 'verify compact inline webp is served e2e' },
      });
      const img = res.content.find((c) => c.type === 'image');
      assert.ok(img, 'image を返す');
      assert.equal(img.mimeType, 'image/webp', 'コンパクト inline は webp（フル PNG ではない）');
      assert.deepEqual([...Buffer.from(img.data, 'base64').subarray(0, 4)], WEBP_MAGIC_RIFF);
      assert.equal(res.structuredContent, undefined, 'Codex#10334 パリティ: inline 分岐も structuredContent 無し');
      const txt = res.content.find((c) => c.type === 'text').text;
      assert.ok(txt.includes('shot.png'), 'file_path はフル解像度 shot.png のまま');
    }
  );
});

test('get_feedback_image: inline 無しで full-res PNG が予算超過なら image を omit（text-only, structuredContent 無し）', async () => {
  // 20KB の「PNG」（中身は問わない。daemon はサイズだけ見て omit する）を inline 無しで保存。
  const bigShotB64 = Buffer.alloc(20 * 1024, 0x41).toString('base64');
  await withTmpDiskClient(
    (inboxDir) => {
      const w = writeEntry(inboxDir, {
        capturedAt: '2026-06-28T10:00:00.000Z',
        url: 'https://big.example/p',
        title: 'Big',
        image: { shot: bigShotB64 },
        annotation: { url: 'https://big.example/p', title: 'Big', capturedAt: '2026-06-28T10:00:00.000Z', items: [] },
      });
      return { id: w.id };
    },
    async (client, { id }) => {
      const res = await client.callTool({
        name: 'get_feedback_image',
        arguments: { id, contextId: id, imageReason: 'verify oversized full-res PNG is omitted, not blown past the cap' },
      });
      assert.ok(!res.content.some((c) => c.type === 'image'), '予算超過のフル PNG は image に載せない');
      assert.equal(res.structuredContent, undefined, 'omit 分岐も structuredContent 無し（Codex パリティ維持）');
      const txt = res.content.find((c) => c.type === 'text').text;
      assert.ok(txt.includes('inline image omitted'), 'omit の注記を出す');
      assert.ok(txt.includes('file_path: ') || txt.includes('shot_url: '), 'フル解像度の取得先を案内する');
    }
  );
});

// ── schema v1: メモを残した HTML 要素（outerHTML + a11y）を画像なしで渡す ──────────────────
test('get_latest_feedback_context: 対象要素の outerHTML と a11y を image なしで返す', async () => {
  const OUTER = '<button class="primary" aria-disabled="true">送信</button>';
  await withTmpDiskClient(
    (inboxDir) => {
      const w = writeEntry(inboxDir, {
        capturedAt: '2026-06-28T10:00:00.000Z',
        url: 'https://html.example/checkout',
        title: 'Checkout',
        image: { shot: PNG_B64_TINY },
        annotation: {
          schema: 'bag.visual-feedback/v1',
          url: 'https://html.example/checkout',
          title: 'Checkout',
          capturedAt: '2026-06-28T10:00:00.000Z',
          items: [
            {
              n: 1,
              note: 'この送信ボタンを直したい',
              selector: 'button.primary',
              anchorLabel: '送信',
              html: { outerHTML: OUTER, bytes: OUTER.length, truncated: false },
              a11y: { role: 'button', name: '送信', states: ['disabled=true', 'disabled'] },
            },
          ],
        },
      });
      return { id: w.id };
    },
    async (client, { id }) => {
      const res = await client.callTool({ name: 'get_latest_feedback_context', arguments: { urlContains: 'html.example' } });
      // 画像なしの軽量経路
      assert.ok(!res.content.some((c) => c.type === 'image'), 'context-only なので image は返さない');
      const txt = res.content.find((c) => c.type === 'text').text;
      assert.ok(txt.includes('feedback_context: image omitted'));
      assert.ok(txt.includes(OUTER), 'テキストに outerHTML を載せる');
      assert.ok(txt.includes('a11y: role=button'), 'テキストに a11y を載せる');
      // structuredContent でも構造化して渡す（image を持たないので Codex パリティに抵触しない）
      const item = res.structuredContent.annotations[0];
      assert.equal(item.html.outerHTML, OUTER);
      assert.equal(item.html.truncated, false);
      assert.equal(item.a11y.role, 'button');
      assert.equal(item.a11y.name, '送信');
      assert.deepEqual(item.a11y.states, ['disabled=true', 'disabled']);
      assert.equal(id, res.structuredContent.id, 'context は対象 entry の id を返す');
    },
    { nowMs: Date.parse('2026-06-28T10:05:00.000Z') }
  );
});

// 旧 v0（html/a11y 無し）の entry でも壊れず null 正規化される（後方互換）。
test('get_feedback_context: v0 entry は html=null / a11y=null（後方互換）', async () => {
  await withTmpDiskClient(
    (inboxDir) => {
      const w = writeEntry(inboxDir, {
        capturedAt: '2026-06-28T10:00:00.000Z',
        url: 'https://legacy.example/p',
        title: 'Legacy',
        image: { shot: PNG_B64_TINY },
        annotation: {
          schema: 'bag.visual-feedback/v0',
          url: 'https://legacy.example/p',
          title: 'Legacy',
          capturedAt: '2026-06-28T10:00:00.000Z',
          items: [{ n: 1, note: '古い注釈', selector: 'main h2' }],
        },
      });
      return { id: w.id };
    },
    async (client, { id }) => {
      const res = await client.callTool({ name: 'get_feedback_context', arguments: { id } });
      const item = res.structuredContent.annotations[0];
      assert.equal(item.html, null, 'v0 entry は html=null');
      assert.equal(item.a11y, null, 'v0 entry は a11y=null');
    }
  );
});

// bridgeStatus（拡張の WS 橋渡し状態）が空応答メッセージへ反映されることを検証する。
// 「拡張が一度も繋がっていない」と「繋がってはいるが何も送られていない」を区別して案内する。
async function withBridgeStatusClient(bridgeStatus, fn) {
  const inboxDir = mkdtempSync(join(tmpdir(), 'vf-mcp-bridge-'));
  const server = createHttpServer({ inboxDir, bridgeStatus });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new Client({ name: 'mcp-bridge-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    return await fn(client);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
}

test('list_feedback: bridgeStatus 無し(既定)の空メッセージにも「メモはブラウザ内に留まる」案内が付く', async () => {
  await withBridgeStatusClient(undefined, async (client) => {
    const res = await client.callTool({ name: 'list_feedback', arguments: {} });
    const text = res.content.find((c) => c.type === 'text').text;
    assert.match(text, /^inbox は空です。/);
    // AI 勘違い防止: どの空分岐でも「保存しただけでは届かない」仕組みと復旧手順を案内する。
    assert.ok(text.includes('chrome.storage.local'));
    assert.ok(text.includes('自動同期'));
  });
});

test('get_latest_feedback_context: 拡張が一度も接続していない時は接続手順を案内する', async () => {
  await withBridgeStatusClient(
    () => ({ connected: false, everConnected: false, lastConnectedAt: null, lastPushAt: null }),
    async (client) => {
      const res = await client.callTool({ name: 'get_latest_feedback_context', arguments: {} });
      const text = res.content.find((c) => c.type === 'text').text;
      assert.match(text, /まだ一度も接続していません/);
      assert.match(text, /Options/);
    }
  );
});

test('list_feedback: 拡張は接続済みだが push が無い時は自動同期/手動送信を案内する', async () => {
  await withBridgeStatusClient(
    () => ({ connected: true, everConnected: true, lastConnectedAt: '2026-07-02T00:00:00.000Z', lastPushAt: null }),
    async (client) => {
      const res = await client.callTool({ name: 'list_feedback', arguments: {} });
      const text = res.content.find((c) => c.type === 'text').text;
      assert.match(text, /接続済みですが、まだメモ／お描きが送信されていません/);
      assert.match(text, /自動同期/);
    }
  );
});
