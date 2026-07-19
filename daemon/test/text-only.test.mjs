// text-only(メモのみ同期; image.shot なし) entry の受理・列挙・MCP 応答を検証する。
// 不変条件: image ツールは text-only entry でも structuredContent を載せない（Codex#10334 パリティ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { createPageFeedbackStore } from '../src/store.js';
import { writeEntry } from '../src/writer.js';
import { buildEntryContent, buildEntryContext, entryHasImage, listEntries } from '../src/inbox.js';

const NOW = Date.parse('2026-07-18T10:00:00.000Z');
const CAPTURED = '2026-07-18T09:59:00.000Z';

function textOnlyPayload(overrides = {}) {
  return {
    type: 'page_feedback',
    capturedAt: CAPTURED,
    url: 'https://example.com/memo',
    title: 'MemoPage',
    annotation: {
      schema: 'bag.page-feedback/v1',
      url: 'https://example.com/memo',
      title: 'MemoPage',
      capturedAt: CAPTURED,
      image: null,
      items: [
        {
          n: 1,
          note: 'ここを直して',
          selector: '#target',
          html: { outerHTML: '<div id="target"></div>', bytes: 24, truncated: false },
        },
      ],
    },
    memo: '# memo only\n',
    ...overrides,
  };
}

test('writeEntry: text-only は annotation.json/memo.md だけを書く（shot.png なし）', () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-pf-textonly-'));
  try {
    const w = writeEntry(inboxDir, textOnlyPayload());
    assert.deepEqual(w.files.sort(), ['annotation.json', 'memo.md']);
    assert.ok(!existsSync(join(w.dir, 'shot.png')));
    const [entry] = listEntries(inboxDir, 10);
    assert.equal(entry.id, w.id, 'annotation.json だけでも listEntries で見える');
    assert.equal(entry.shot, '', '存在しない shot パスを広告しない');
    assert.equal(entryHasImage(entry), false);
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('writeEntry: image も annotation も無い空 payload は throw（entry を残さない）', () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-pf-textonly-'));
  try {
    assert.throws(() => writeEntry(inboxDir, { type: 'page_feedback', memo: '# only memo\n' }), /annotation/);
    assert.ok(!existsSync(inboxDir) || readdirSync(inboxDir).length === 0, '中途半端な entry を残さない');
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('memory store(既定): text-only を RAM 受理し、materialize しても shot.png を作らない', () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-pf-textonly-'));
  const store = createPageFeedbackStore({ inboxDir, storageMode: 'memory' });
  try {
    const ack = store.save(textOnlyPayload());
    assert.equal(ack.storage, 'memory');
    const [entry] = store.queryEntries({ limit: 5 });
    assert.equal(entry.id, ack.id);
    assert.equal(entryHasImage(entry), false);

    const shotUrlFor = (id, kind = 'shot') => `http://127.0.0.1:1/${kind}/${id}.png`;
    const context = buildEntryContext(entry, { shotUrlFor });
    assert.equal(context.hasImage, false);
    assert.equal(context.urls, null, 'text-only は 404 になる画像 URL を広告しない');

    const materialized = store.materialize(entry);
    assert.equal(materialized.shot, '', 'materialize 後も shot パスは空');
    assert.ok(!materialized.files.includes('shot.png'));
    assert.ok(materialized.files.includes('annotation.json'));

    const content = buildEntryContent(materialized, { shotUrlFor });
    assert.ok(!content.some((c) => c.type === 'image'), '存在しない画像を返さない');
    const text = content.find((c) => c.type === 'text').text;
    assert.ok(text.includes('text-only'), 'text-only である旨を案内する');
    assert.ok(!text.includes('shot_url:'), 'shot_url を広告しない');
  } finally {
    store.cleanup?.();
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('store: image も annotation も無い空 push は memory 受理でも throw', () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-pf-textonly-'));
  const store = createPageFeedbackStore({ inboxDir, storageMode: 'memory' });
  try {
    assert.throws(() => store.save({ type: 'page_feedback', memo: '# only memo\n' }), /annotation/);
  } finally {
    store.cleanup?.();
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

// tmp inbox に text-only entry を1件だけ置き、実 MCP クライアント（Streamable HTTP）で叩くヘルパ。
async function withTextOnlyClient(fn) {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-pf-textonly-mcp-'));
  const id = writeEntry(inboxDir, textOnlyPayload()).id;
  const server = createHttpServer({ inboxDir, nowMs: NOW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new Client({ name: 'text-only-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    return await fn(client, id);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
}

test('MCP: text-only entry の context は hasImage=false + 「image ツールを呼ばない」案内', async () => {
  await withTextOnlyClient(async (client, id) => {
    const res = await client.callTool({ name: 'get_latest_feedback_context', arguments: {} });
    assert.equal(res.structuredContent.id, id);
    assert.equal(res.structuredContent.hasImage, false);
    const text = res.content.find((c) => c.type === 'text').text;
    assert.ok(text.includes('image: none'), 'text に画像なしを明記する');
    assert.ok(!text.includes('shot_url:'), 'shot_url を広告しない');
  });
});

test('MCP: text-only entry の image ツールは image ブロック無し・structuredContent 無し（Codex パリティ）', async () => {
  await withTextOnlyClient(async (client, id) => {
    const res = await client.callTool({
      name: 'get_latest_feedback_image',
      arguments: { contextId: id, imageReason: '見た目の確認が必要か検証するテスト' },
    });
    assert.equal(res.structuredContent, undefined, 'image ツールは text-only でも structuredContent を載せない');
    assert.ok(!res.content.some((c) => c.type === 'image'), '存在しない画像を返さない');
    const text = res.content.find((c) => c.type === 'text').text;
    assert.ok(text.includes('text-only'), '画像が最初から存在しない旨を案内する');
  });
});

test('MCP: 空 inbox 応答は「メモはブラウザ内に留まる」仕組みと復旧手順を案内する（AI 勘違い防止）', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-pf-empty-'));
  const server = createHttpServer({ inboxDir, nowMs: NOW });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new Client({ name: 'empty-inbox-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  try {
    const bare = await client.callTool({ name: 'get_latest_feedback_context', arguments: {} });
    const bareText = bare.content.find((c) => c.type === 'text').text;
    assert.ok(bareText.includes('chrome.storage.local'), '「メモを残すだけでは届かない」仕組みを説明する');
    assert.ok(bareText.includes('自動送信'), '復旧手順（デーモン有効化＝自動送信）を案内する');

    const filtered = await client.callTool({
      name: 'get_latest_feedback_context',
      arguments: { urlContains: 'no-such-project' },
    });
    const filteredText = filtered.content.find((c) => c.type === 'text').text;
    assert.ok(filteredText.includes('chrome.storage.local'), 'フィルタ空振り時も同じ仕組みを案内する');
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
});
