// resolve_feedback: 対応済みにした capture は latest で返さず、拡張へメモの id を渡して「AI対応済み」にさせる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { createDiskEntryStore, createPageFeedbackStore } from '../src/store.js';

const NOW = Date.parse('2026-10-17T10:05:00.000Z');
const payload = (n) => ({
  annotation: {
    url: 'https://app.test/settings',
    title: '設定',
    capturedAt: `2026-10-17T10:0${n}:00.000Z`,
    tab: { tabId: 7, windowId: 1 },
    items: [{ id: `anno-${n}`, note: '保存ボタンを赤に' }],
  },
  memo: '保存ボタンを赤に',
});

async function withClient(opts, fn) {
  const server = createHttpServer({ nowMs: NOW, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'resolve-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  try {
    return await fn(client);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
  }
}
const text = (res) => res.content.find((c) => c.type === 'text').text;

test('resolve_feedback: 対応済みの最新は中身を返さず、拡張へメモの id を渡す', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-resolve-'));
  const entryStore = createPageFeedbackStore({ inboxDir, storageMode: 'memory' });
  const { id } = entryStore.save(payload(1));
  const calls = [];
  const extensionRequest = async (type, params) => {
    calls.push({ type, params });
    return { ok: true, marked: params.ids };
  };
  try {
    await withClient({ inboxDir, entryStore, extensionRequest }, async (client) => {
      const res = await client.callTool({ name: 'resolve_feedback', arguments: { id, summary: '保存ボタンの色を赤にした' } });
      assert.equal(res.isError, undefined);
      assert.deepEqual(calls, [{ type: 'mark_annotations_done', params: { tabId: 7, url: 'https://app.test/settings', ids: ['anno-1'] } }]);
      assert.deepEqual(res.structuredContent.extension, { marked: ['anno-1'], missing: [] });

      const latest = await client.callTool({ name: 'get_latest_feedback_context', arguments: { tabId: 7 } });
      assert.match(text(latest), /対応済みです/);
      assert.equal(latest.structuredContent.id, undefined, '対応済みの id を top-level に載せない');
      const bare = await client.callTool({ name: 'get_latest_feedback_context', arguments: {} });
      assert.match(text(bare), /対応済みです/);
      const image = await client.callTool({ name: 'get_latest_feedback_image', arguments: { tabId: 7, contextId: id, imageReason: 'x' } });
      assert.match(text(image), /対応済みです/);

      const byId = await client.callTool({ name: 'get_feedback_context', arguments: { id } });
      assert.equal(byId.structuredContent.resolution.summary, '保存ボタンの色を赤にした');
      assert.match(text(byId), /^resolved: /m);
      assert.match(text(await client.callTool({ name: 'list_feedback', arguments: {} })), /resolved=2026-10-17T10:05:00.000Z/);

      // 新しいメモが届けば、latest はそれを返す。
      entryStore.save(payload(2));
      const next = await client.callTool({ name: 'get_latest_feedback_context', arguments: { tabId: 7 } });
      assert.equal(next.structuredContent.annotations[0].id, 'anno-2');
    });
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('resolve_feedback: 拡張に届かなくても daemon 側は対応済みにし、その旨を伝える', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-resolve-'));
  const entryStore = createPageFeedbackStore({ inboxDir, storageMode: 'memory' });
  const { id } = entryStore.save(payload(1));
  try {
    await withClient({ inboxDir, entryStore, extensionRequest: async () => { throw new Error('No extension clients connected to daemon.'); } }, async (client) => {
      const res = await client.callTool({ name: 'resolve_feedback', arguments: { id } });
      assert.match(text(res), /ページ上のメモは更新できませんでした/);
      assert.match(text(await client.callTool({ name: 'get_latest_feedback_context', arguments: { tabId: 7 } })), /対応済みです/);
      const missing = await client.callTool({ name: 'resolve_feedback', arguments: { id: 'nope' } });
      assert.equal(missing.isError, true);
    });
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('resolve_feedback: disk では resolution.json に残り、再起動後も対応済みのまま', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-resolve-'));
  const { id } = createDiskEntryStore(inboxDir).save(payload(1));
  try {
    await withClient({ inboxDir, entryStore: createDiskEntryStore(inboxDir) }, async (client) => {
      const res = await client.callTool({ name: 'resolve_feedback', arguments: { id, summary: 'done' } });
      assert.match(text(res), /拡張との接続が無い/);
    });
    assert.ok(existsSync(join(inboxDir, id, 'resolution.json')));
    const reread = createDiskEntryStore(inboxDir).findEntry(id);
    assert.equal(reread.resolution.summary, 'done');
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('resolve_feedback: 最新が対応済みでも、窓内の別案件の未対応は隠さない(曖昧検知が先)', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-resolve-'));
  const entryStore = createPageFeedbackStore({ inboxDir, storageMode: 'memory' });
  const other = entryStore.save({ ...payload(1), annotation: { ...payload(1).annotation, url: 'https://other.test/', title: '別案件' } });
  const { id } = entryStore.save(payload(2));
  try {
    await withClient({ inboxDir, entryStore }, async (client) => {
      await client.callTool({ name: 'resolve_feedback', arguments: { id } });
      const bare = await client.callTool({ name: 'get_latest_feedback_context', arguments: {} });
      const candidates = bare.structuredContent.disambiguation.candidates;
      assert.deepEqual(candidates.map((c) => [c.id, Boolean(c.resolvedAt)]), [[id, true], [other.id, false]]);
      assert.match(text(bare), /resolved=.*\(対応済み\)/);
      // 未対応の別候補は contextId で選べば画像経路に進める(対応済みで弾かない)。
      const picked = await client.callTool({ name: 'get_latest_feedback_image', arguments: { contextId: other.id, imageReason: '色を確かめる' } });
      assert.doesNotMatch(text(picked), /対応済みです/);
    });
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('resolve_feedback: 記録の保存に失敗しても拡張側のメモは更新し、失敗を伝える', async () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-resolve-'));
  const entryStore = createPageFeedbackStore({ inboxDir, storageMode: 'memory' });
  const { id } = entryStore.save(payload(1));
  entryStore.markResolved = () => {
    throw new Error('EACCES');
  };
  const calls = [];
  try {
    await withClient({ inboxDir, entryStore, extensionRequest: async (type, params) => (calls.push(type), { ok: true, marked: params.ids }) }, async (client) => {
      const res = await client.callTool({ name: 'resolve_feedback', arguments: { id } });
      assert.equal(res.structuredContent.stored, false);
      assert.match(text(res), /保存できませんでした: EACCES/);
      assert.deepEqual(calls, ['mark_annotations_done']);
    });
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('resolve_feedback: hybrid で書き出す前に対応済みにしても、書き出し時に resolution.json を残す', () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-resolve-'));
  const entryStore = createPageFeedbackStore({ inboxDir, storageMode: 'hybrid' });
  const { id } = entryStore.save(payload(1));
  try {
    entryStore.markResolved(id, { at: '2026-10-17T10:05:00.000Z', summary: 'done' });
    assert.equal(existsSync(join(inboxDir, id, 'resolution.json')), false);
    entryStore.materialize(entryStore.findEntry(id));
    assert.equal(createDiskEntryStore(inboxDir).findEntry(id).resolution.summary, 'done');
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});
