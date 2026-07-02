// /shot|/raw/<id>.png 画像配信ルートのテスト。
// 目的: ブラウザの DL 先と inbox がズレても、CLI/人間が id だけで PNG を取れること（パス非依存）を保証する。
// - token 必須（不一致/無しは 401）
// - disk store とメモリ保持(hybrid)store の両方で 200 + image/png
// - hybrid は materialize せずメモリから配信（memory-first）
// - context/image テキストに shot_url/raw_url が併走する（token 設定時のみ）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { writeEntry } from '../src/writer.js';
import { createVisualFeedbackStore } from '../src/store.js';
import { listEntries, buildEntryContext, buildEntryContextText } from '../src/inbox.js';

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const TOKEN = 'test-secret-token';

async function get(base, path) {
  const res = await fetch(`${base}${path}`);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type'), body };
}

// ---- disk store ----
{
  let httpServer;
  let inboxDir;
  let base;
  let diskId;

  before(async () => {
    inboxDir = mkdtempSync(join(tmpdir(), 'vf-shot-disk-'));
    const written = writeEntry(inboxDir, {
      capturedAt: '2026-06-18T01:02:03.004Z',
      url: 'https://example.com/x',
      title: 'X',
      image: { shot: PNG_B64, raw: PNG_B64 },
      annotation: { url: 'https://example.com/x', items: [{ n: 1, note: 'a' }] },
    });
    diskId = written.id;
    httpServer = createHttpServer({ inboxDir, token: TOKEN });
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    await new Promise((r) => httpServer.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  });

  test('disk: GET /shot/<id>.png?token=… → 200 image/png + 有効な PNG', async () => {
    const r = await get(base, `/shot/${diskId}.png?token=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'image/png');
    assert.deepEqual([...r.body.subarray(0, 8)], PNG_MAGIC);
  });

  test('disk: GET /raw/<id>.png?token=… → 200 image/png', async () => {
    const r = await get(base, `/raw/${diskId}.png?token=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'image/png');
    assert.deepEqual([...r.body.subarray(0, 8)], PNG_MAGIC);
  });

  test('token 不一致は 401（画像は返さない）', async () => {
    const r = await get(base, `/shot/${diskId}.png?token=WRONG`);
    assert.equal(r.status, 401);
    assert.notEqual(r.contentType, 'image/png');
  });

  test('token 無しは 401', async () => {
    const r = await get(base, `/shot/${diskId}.png`);
    assert.equal(r.status, 401);
  });

  test('不明 id は 404', async () => {
    const r = await get(base, `/shot/nope.png?token=${TOKEN}`);
    assert.equal(r.status, 404);
  });

  test('traversal 系パスはルート不一致で 404（200/500 を返さない）', async () => {
    // ドット入り・本物の traversal（生/エンコード）いずれも id 文字種 [a-z0-9_-] に弾かれてルート不一致。
    for (const p of [
      `/shot/a.b.png?token=${TOKEN}`,
      `/shot/../../../etc/passwd.png?token=${TOKEN}`,
      `/shot/..%2f..%2fetc%2fpasswd.png?token=${TOKEN}`,
    ]) {
      const r = await get(base, p);
      assert.equal(r.status, 404, `${p} は 404`);
      assert.notEqual(r.contentType, 'image/png');
    }
  });

  test('raw が無いエントリの /raw は 404', async () => {
    const written = writeEntry(inboxDir, {
      capturedAt: '2026-06-18T02:02:03.004Z',
      url: 'https://example.com/y',
      image: { shot: PNG_B64 }, // raw 無し
    });
    const r = await get(base, `/raw/${written.id}.png?token=${TOKEN}`);
    assert.equal(r.status, 404);
    // shot は取れる
    const ok = await get(base, `/shot/${written.id}.png?token=${TOKEN}`);
    assert.equal(ok.status, 200);
  });

  test('/healthz が画像ルートを広告する（token 設定時）', async () => {
    const res = await fetch(`${base}/healthz`);
    const json = await res.json();
    assert.equal(json.imageRoute, '/shot/<id>.png');
  });

  test('/healthz は bridgeStatus 未指定なら拡張未接続の既定値を返す', async () => {
    const res = await fetch(`${base}/healthz`);
    const json = await res.json();
    assert.deepEqual(json.extension, { connected: false, everConnected: false, lastConnectedAt: null, lastPushAt: null });
  });

  test('MCP context に shot_url が併走し、そのまま GET で 200 になる', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    try {
      // id 指定で決定的に（latest は他テストの書き込みで変わりうる）。
      const res = await client.callTool({ name: 'get_feedback_context', arguments: { id: diskId } });
      const text = res.content.find((c) => c.type === 'text').text;
      const m = text.match(/shot_url: (\S+)/);
      assert.ok(m, 'context テキストに shot_url がある');
      assert.ok(m[1].includes(`/shot/${diskId}.png`), 'URL に対象 id が入る');
      assert.ok(!m[1].includes('token'), 'token は URL に埋め込まない（/mcp は無認証なので漏らさない）');
      assert.equal(res.structuredContent.urls.shot, m[1], 'structuredContent.urls.shot と一致');
      // token 無しでは 401、?token= を付ければ到達できる（file_path 無しで取得可能）。
      assert.equal((await fetch(m[1])).status, 401);
      const got = await fetch(`${m[1]}?token=${TOKEN}`);
      assert.equal(got.status, 200);
      assert.equal(got.headers.get('content-type'), 'image/png');
    } finally {
      await client.close();
    }
  });
}

// ---- hybrid(memory) store: materialize せずメモリから配信 ----
{
  let httpServer;
  let inboxDir;
  let base;
  let memId;

  before(async () => {
    inboxDir = mkdtempSync(join(tmpdir(), 'vf-shot-mem-'));
    const entryStore = createVisualFeedbackStore({ inboxDir, storageMode: 'hybrid' });
    const ack = entryStore.save({
      capturedAt: '2026-06-18T03:02:03.004Z',
      url: 'https://example.com/m',
      title: 'M',
      image: { shot: PNG_B64, raw: PNG_B64 },
      annotation: { url: 'https://example.com/m', items: [] },
    });
    memId = ack.id;
    httpServer = createHttpServer({ inboxDir, entryStore, token: TOKEN });
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    await new Promise((r) => httpServer.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  });

  test('hybrid: GET /shot は 200、かつディスクへ materialize しない（memory-first）', async () => {
    const r = await get(base, `/shot/${memId}.png?token=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'image/png');
    assert.deepEqual([...r.body.subarray(0, 8)], PNG_MAGIC);
    // shot 配信ではディスクに書き出されない（inbox にエントリディレクトリが無い）。
    assert.equal(listEntries(inboxDir, 10).length, 0, 'shot 取得では materialize されない');
  });

  test('hybrid: GET /raw は payload から 200', async () => {
    const r = await get(base, `/raw/${memId}.png?token=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'image/png');
  });
}

// ---- URL 併走（純関数）: shotUrlFor を渡した時だけ shot_url/raw_url が出る ----
test('buildEntryContext: shotUrlFor 有りで urls、無しで null', () => {
  const entry = { id: 'abc__def', dir: '/tmp/x', storage: 'disk' };
  const shotUrlFor = (id, kind) => `http://127.0.0.1:8765/${kind}/${id}.png?token=t`;
  const withUrl = buildEntryContext(entry, { shotUrlFor });
  assert.equal(withUrl.urls.shot, 'http://127.0.0.1:8765/shot/abc__def.png?token=t');
  assert.equal(withUrl.urls.raw, 'http://127.0.0.1:8765/raw/abc__def.png?token=t');
  assert.ok(buildEntryContextText(withUrl).includes('shot_url: http://127.0.0.1:8765/shot/abc__def.png'));

  const without = buildEntryContext(entry);
  assert.equal(without.urls, null);
  assert.ok(!buildEntryContextText(without).includes('shot_url:'));
});
