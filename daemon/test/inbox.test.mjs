// inbox スキャナ + content ビルダーの単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  listEntries,
  findEntry,
  buildEntryContent,
  buildEntryContext,
  buildEntryContextText,
  buildEntryText,
  readAnnotation,
  readEntryInline,
  matchesFilter,
  queryEntries,
  peekDistinctRecent,
  INLINE_MAX_BYTES,
} from '../src/inbox.js';
import { writeEntry } from '../src/writer.js';

// 偽 WebP（RIFF....WEBP ヘッダ + パディング）。daemon は中身を検証せず base64 化するだけなので
// ルーティング/mime/サイズの検証にはこれで十分。
function fakeWebp(sizeBytes = 64) {
  const pad = Buffer.alloc(Math.max(0, sizeBytes - 12), 0x20);
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), pad]);
}
// 偽 JPEG（SOI=FFD8FF + パディング）。WebP→JPEG フォールバック経路の検証用。
function fakeJpeg(sizeBytes = 64) {
  const body = Buffer.alloc(Math.max(0, sizeBytes - 3), 0x20);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), body]);
}
const WEBP_MAGIC_RIFF = [0x52, 0x49, 0x46, 0x46]; // 'RIFF'
const JPEG_MAGIC = [0xff, 0xd8, 0xff]; // SOI
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_B64_TINY =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const here = dirname(fileURLToPath(import.meta.url));
const INBOX = resolve(here, 'fixtures/inbox');
const NEWER = '2026-06-17T09-58-00-021Z';
const OLDER = '2026-06-17T08-00-00-000Z';

test('listEntries: shot.png を持つ slug を新しい順に返し done/未完は除外', () => {
  const entries = listEntries(INBOX);
  assert.equal(entries.length, 2, 'shot を持つ2件のみ（done と shot無しは除外）');
  assert.equal(entries[0].id, NEWER, '新しい方が先頭');
  assert.equal(entries[1].id, OLDER);
  assert.ok(entries.every((e) => e.shot.endsWith('shot.png')));
});

test('listEntries: 存在しない inbox は空配列', () => {
  assert.deepEqual(listEntries(join(INBOX, 'nope')), []);
});

test('listEntries: limit を尊重', () => {
  assert.equal(listEntries(INBOX, 1).length, 1);
});

test('findEntry: id で引ける / 無ければ null', () => {
  assert.equal(findEntry(INBOX, OLDER)?.id, OLDER);
  assert.equal(findEntry(INBOX, 'missing'), null);
});

test('buildEntryContent: image(base64 PNG) と file_path テキストの両方を返す', () => {
  const [entry] = listEntries(INBOX, 1);
  const content = buildEntryContent(entry);
  assert.equal(content.length, 2);
  const img = content.find((c) => c.type === 'image');
  const txt = content.find((c) => c.type === 'text');
  assert.ok(img, 'image content がある');
  assert.equal(img.mimeType, 'image/png');
  // PNG マジック（base64 デコード先頭8バイト）
  const head = Buffer.from(img.data, 'base64').subarray(0, 8);
  assert.deepEqual([...head], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(txt.text.startsWith('file_path: '), 'text 先頭は絶対パス');
  assert.ok(txt.text.includes(entry.shot));
});

test('buildEntryContent: includeImage=false なら text のみ', () => {
  const [entry] = listEntries(INBOX, 1);
  const content = buildEntryContent(entry, { includeImage: false });
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
});

test('buildEntryContext: image 無しの軽量文脈に @agent と selector を含む', () => {
  const entry = findEntry(INBOX, NEWER);
  const context = buildEntryContext(entry);
  assert.equal(context.id, NEWER);
  assert.deepEqual(context.tab, { tabId: 321, windowId: 9, index: 2, active: true });
  assert.equal(context.annotations[0].dataAgentId, '@agent:docs/api-list');
  assert.equal(context.annotations[0].selector, 'main h2');
  assert.equal(context.annotations[0].targetCandidates[0].href, 'https://example.com/dp/B012345678');
  assert.equal(context.agentLookup.priority[0], 'dataAgentId');
  assert.equal(context.agentLookup.imageGate.contextId, NEWER);
  const text = buildEntryContextText(context);
  assert.ok(text.includes('feedback_context: image omitted'));
  assert.ok(text.includes('chrome_tab: tabId=321 windowId=9 index=2 active=true'));
  assert.ok(text.includes('agent_lookup:'));
  assert.ok(text.includes("source_search: rg -n 'data-agent-id=\"@agent:'"));
  assert.ok(text.includes(`image_gate: pass contextId="${NEWER}"`));
  assert.ok(text.includes('agent="@agent:docs/api-list"'));
  assert.ok(text.includes('selector="main h2"'));
  assert.ok(text.includes('candidate: source=nearest-link'));
  assert.ok(text.includes('href="https://example.com/dp/B012345678"'));
});

test('matchesFilter: url/title/tab の条件一致。未指定は素通し', () => {
  const ann = { url: 'https://example.com/API', title: 'API ダッシュボード', tab: { tabId: 321, windowId: 9 } };
  assert.equal(matchesFilter(ann, {}), true);
  assert.equal(matchesFilter(ann, { urlContains: 'example.com' }), true);
  assert.equal(matchesFilter(ann, { urlContains: 'EXAMPLE' }), true); // 大小無視
  assert.equal(matchesFilter(ann, { urlContains: 'other.com' }), false);
  assert.equal(matchesFilter(ann, { titleContains: 'ダッシュボード' }), true);
  assert.equal(matchesFilter(ann, { urlContains: 'example.com', titleContains: '存在しない' }), false); // AND
  assert.equal(matchesFilter(ann, { tabId: 321 }), true);
  assert.equal(matchesFilter(ann, { tabId: 111 }), false);
  assert.equal(matchesFilter(ann, { windowId: 9 }), true);
  assert.equal(matchesFilter(ann, { windowId: 10 }), false);
});

test('queryEntries: フィルタで該当 slug だけ返し、url/title/capturedAt メタを付与', () => {
  // fixture の2件はどちらも url=https://example.com/api。example.com で2件、other で0件。
  const hit = queryEntries(INBOX, { urlContains: 'example.com' });
  assert.equal(hit.length, 2);
  assert.ok(hit.every((e) => e.url === 'https://example.com/api'));
  assert.ok('title' in hit[0]);
  assert.deepEqual(hit[0].tab, { tabId: 321, windowId: 9, index: 2, active: true });
  assert.ok('capturedAt' in hit[0], 'capturedAt メタも付与');
  assert.equal(hit[0].capturedAt, '2026-06-17T09:58:00.021Z');
  assert.deepEqual(queryEntries(INBOX, { tabId: 321 }).map((e) => e.id), [NEWER]);
  assert.deepEqual(queryEntries(INBOX, { tabId: 111 }).map((e) => e.id), [OLDER]);
  assert.equal(queryEntries(INBOX, { urlContains: 'no-such-project' }).length, 0);
});

test('peekDistinctRecent: 異なる host が窓内に2件で distinctCount=2、同一 host は 1', () => {
  const base = Date.parse('2026-06-20T10:00:00.000Z');
  const peek = peekDistinctRecent(
    [
      { id: 'n1', url: 'https://amazon.co.jp/x', title: 'A', capturedAt: new Date(base).toISOString(), mtime: base },
      { id: 'n2', url: 'https://example.com/y', title: 'B', capturedAt: new Date(base - 5 * 60000).toISOString(), mtime: base },
    ],
    { windowMs: 90 * 60000 }
  );
  assert.equal(peek.distinctCount, 2);
  assert.equal(peek.candidates[0].id, 'n1', 'head（最新）が先頭候補');
  const same = peekDistinctRecent(
    [
      { id: 's1', url: 'https://example.com/a', capturedAt: new Date(base).toISOString(), mtime: base },
      { id: 's2', url: 'https://example.com/b', capturedAt: new Date(base - 60000).toISOString(), mtime: base },
    ],
    { windowMs: 90 * 60000 }
  );
  assert.equal(same.distinctCount, 1, '同一 host は曖昧でない（単一プロジェクト）');
});

test('peekDistinctRecent: capturedAt 基準（mtime 同値でも capturedAt で窓判定）', () => {
  const base = Date.parse('2026-06-20T10:00:00.000Z');
  const sameMtime = 1782209987000; // git checkout 等で全 entry の mtime が潰れた想定
  const peek = peekDistinctRecent(
    [
      { id: 'h', url: 'https://amazon.co.jp/x', capturedAt: new Date(base).toISOString(), mtime: sameMtime },
      { id: 'in', url: 'https://example.com/y', capturedAt: new Date(base - 5 * 60000).toISOString(), mtime: sameMtime },
      { id: 'out', url: 'https://other.com/z', capturedAt: new Date(base - 200 * 60000).toISOString(), mtime: sameMtime },
    ],
    { windowMs: 90 * 60000 }
  );
  assert.equal(peek.distinctCount, 2, '窓内の amazon+example のみ。窓外 other は capturedAt で除外');
  assert.ok(peek.candidates.some((c) => c.host === 'amazon-co-jp'));
  assert.ok(!peek.candidates.some((c) => c.host === 'other-com'));
});

test('peekDistinctRecent: capturedAt 欠落は mtime フォールバック / 不正 url は site バケット / 空入力は 0', () => {
  const base = 1782209987000;
  const peek = peekDistinctRecent(
    [
      { id: 'a', url: 'https://amazon.co.jp/x', capturedAt: '', mtime: base },
      { id: 'b', url: 'not a url', capturedAt: '', mtime: base - 60000 },
    ],
    { windowMs: 90 * 60000 }
  );
  assert.equal(peek.distinctCount, 2);
  assert.ok(peek.candidates.some((c) => c.host === 'site'), '解析不能 url は site バケット');
  assert.deepEqual(peekDistinctRecent([]), { newest: null, distinctCount: 0, candidates: [] });
});

test('peekDistinctRecent: 窓 anchor は capturedAt 最大（mtime 逆転で曖昧検知を過小評価しない）', () => {
  const base = Date.parse('2026-06-20T10:00:00.000Z');
  // rows は mtime 降順。A は mtime 最大だが capturedAt は最古（DL fallback / rsync で mtime が後から潰れた想定）。
  const rows = [
    { id: 'A', url: 'https://foreign.com/x', capturedAt: new Date(base - 100 * 60000).toISOString(), mtime: 9999 },
    { id: 'B', url: 'https://mine.com/y', capturedAt: new Date(base).toISOString(), mtime: 1000 },
    { id: 'C', url: 'https://other.com/z', capturedAt: new Date(base - 5 * 60000).toISOString(), mtime: 800 },
  ];
  const peek = peekDistinctRecent(rows, { windowMs: 90 * 60000 });
  // anchor=capturedAt最大(=B base)。窓内: B(0), C(5m)。A は 100m で窓外。
  assert.equal(peek.distinctCount, 2, 'mtime 最大の古い別案件を anchor にして真の最新を窓外に落とさない');
  assert.ok(peek.candidates.some((c) => c.host === 'mine-com'));
  assert.ok(peek.candidates.some((c) => c.host === 'other-com'));
  assert.ok(!peek.candidates.some((c) => c.host === 'foreign-com'), 'capturedAt 窓外の foreign は候補に入らない');
});

test('peekDistinctRecent: 多数 distinct host でも distinctCount と candidates 数が一致（cap で取りこぼさない）', () => {
  const base = Date.parse('2026-06-20T10:00:00.000Z');
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push({ id: `id${i}`, url: `https://h${i}.com/p`, capturedAt: new Date(base - i * 60000).toISOString(), mtime: 1000 - i });
  }
  const peek = peekDistinctRecent(rows, { windowMs: 90 * 60000 });
  assert.equal(peek.distinctCount, 6);
  assert.equal(peek.candidates.length, 6, 'candidates は distinctCount と一致（top-5 cap で 6番目を落とさない）');
  assert.ok(peek.candidates.some((c) => c.id === 'id5'), '6番目の host の id も候補に含む（contextId 一致判定で取りこぼさない）');
});

test('findEntry: id 指定なら done/ も解決。listEntries/queryEntries は done/ を除外し続ける', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bag-inbox-done-'));
  try {
    const id = '20260101-000000__example-com__page__arch001';
    const dir = join(tmp, 'done', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shot.png'), Buffer.from([137, 80, 78, 71]));
    assert.equal(findEntry(tmp, id)?.id, id, 'archived id を done/ から復元');
    assert.ok(findEntry(tmp, id).dir.endsWith(join('done', id)));
    assert.equal(listEntries(tmp).length, 0, 'latest/list は done/ を除外');
    assert.equal(queryEntries(tmp).length, 0);
    assert.equal(findEntry(tmp, '../escape'), null, 'traversal id は null');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildEntryText: 指示一覧（番号/メモ/intent/selector）を含む', () => {
  const entry = findEntry(INBOX, NEWER);
  const text = buildEntryText(entry, readAnnotation(entry.dir));
  assert.ok(text.includes('1. ここをAIにマークダウンで出力'));
  assert.ok(text.includes('intent: API一覧を構造化して抽出'));
  assert.ok(text.includes('agent="@agent:docs/api-list"'));
  assert.ok(text.includes('selector="main h2"'));
  assert.ok(text.includes('dataAsin="B012345678"'));
  assert.ok(text.includes('candidate: source=nearest-link'));
  assert.ok(text.includes('vision'), 'vision で見るよう指示');
});

// ── MCP inline コンパクト変種（Claude Code 出力トークン上限対策） ───────────────────────
test('readEntryInline: memory は inlineBuffer、disk は shot.inline.webp を probe、無ければ null', () => {
  // memory: RAM の inlineBuffer を返す。
  const mem = { id: 'm', inlineBuffer: fakeWebp(), inlineMime: 'image/webp' };
  assert.deepEqual([...readEntryInline(mem).buffer.subarray(0, 4)], WEBP_MAGIC_RIFF);
  assert.equal(readEntryInline(mem).mime, 'image/webp');
  // disk: dir 直下の shot.inline.webp を読む。
  const tmp = mkdtempSync(join(tmpdir(), 'bag-inline-'));
  try {
    writeFileSync(join(tmp, 'shot.inline.webp'), fakeWebp(40));
    const hit = readEntryInline({ id: 'd', dir: tmp });
    assert.equal(hit.mime, 'image/webp');
    assert.deepEqual([...hit.buffer.subarray(0, 4)], WEBP_MAGIC_RIFF);
    // 無い dir は null。
    assert.equal(readEntryInline({ id: 'e', dir: join(tmp, 'nope') }), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildEntryContent: inline(webp) があれば inline を image に使い、file_path はフル解像度 PNG のまま', () => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-inline-disk-'));
  try {
    const written = writeEntry(inboxDir, {
      capturedAt: '2026-06-18T01:02:03.004Z',
      url: 'https://example.com/x',
      image: {
        shot: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        inline: `data:image/webp;base64,${fakeWebp(80).toString('base64')}`,
        inlineMime: 'image/webp',
      },
      annotation: { url: 'https://example.com/x', items: [] },
    });
    assert.ok(written.files.includes('shot.inline.webp'), 'inline 変種が disk に永続される');
    const entry = findEntry(inboxDir, written.id);
    const content = buildEntryContent(entry);
    const img = content.find((c) => c.type === 'image');
    const txt = content.find((c) => c.type === 'text').text;
    assert.equal(img.mimeType, 'image/webp', 'inline は webp として返る（PNG ではない）');
    assert.deepEqual([...Buffer.from(img.data, 'base64').subarray(0, 4)], WEBP_MAGIC_RIFF);
    // file_path は引き続きフル解像度 shot.png（Codex view_image / 人間 DL 用）。
    assert.ok(txt.includes(`file_path: ${join(entry.dir, 'shot.png')}`), 'file_path はフル解像度 shot.png のまま');
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});

test('buildEntryContent: inline が無く full-res PNG が予算超過なら image を omit（テキストで案内）', () => {
  // 20KB の shotBuffer（INLINE_MAX_BYTES=14KB 超）。inline 無し → 予算超過で image を載せない。
  const entry = {
    id: 'big__mem',
    dir: join(tmpdir(), 'bag-nope-big'),
    shot: join(tmpdir(), 'bag-nope-big', 'shot.png'),
    shotBuffer: Buffer.alloc(20 * 1024, 0x7f),
    storage: 'memory',
    materialized: false,
    annotation: { url: 'https://x', items: [{ n: 1, note: 'big', selector: '#t' }] },
  };
  const content = buildEntryContent(entry, { shotUrlFor: (id, kind) => `http://h/${kind}/${id}.png` });
  assert.ok(!content.some((c) => c.type === 'image'), '予算超過のフル PNG は inline に載せない');
  const txt = content.find((c) => c.type === 'text').text;
  assert.ok(txt.includes('inline image omitted'), 'omit の注記を出す');
  assert.ok(txt.includes('view_image(file_path)'), 'Codex 向けに view_image を案内');
  assert.ok(txt.includes('shot_url: '), 'フル解像度の取得先 shot_url を併走する');
});

test('buildEntryContent: 小さい full-res PNG（inline 無し）は従来どおり image/png で載る', () => {
  // 既存 fixture（70 byte PNG, inline 無し）は予算内なので image/png で返り、後方互換。
  const [entry] = listEntries(INBOX, 1);
  const content = buildEntryContent(entry);
  const img = content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.deepEqual([...Buffer.from(img.data, 'base64').subarray(0, 8)], PNG_MAGIC);
});

test('buildEntryContent: INLINE_MAX_BYTES 境界（ちょうどは載せ、+1 は omit）', () => {
  const shotUrlFor = (id, kind) => `http://h/${kind}/${id}.png`;
  const make = (n) => ({
    id: `bnd${n}`,
    dir: join(tmpdir(), 'bag-nope-bound'),
    shot: join(tmpdir(), 'bag-nope-bound', 'shot.png'),
    shotBuffer: Buffer.alloc(n, 0x10),
    storage: 'memory',
    materialized: false,
    annotation: { url: 'https://x', items: [] },
  });
  const atLimit = buildEntryContent(make(INLINE_MAX_BYTES), { shotUrlFor });
  assert.ok(atLimit.some((c) => c.type === 'image'), `${INLINE_MAX_BYTES} バイトちょうどは載せる（<=）`);
  const over = buildEntryContent(make(INLINE_MAX_BYTES + 1), { shotUrlFor });
  assert.ok(!over.some((c) => c.type === 'image'), `${INLINE_MAX_BYTES + 1} バイトは omit する`);
});

test('inline(jpeg): WebP→JPEG フォールバックも image/jpeg で返り、disk は shot.inline.jpg を probe', () => {
  // memory: inlineMime=jpeg を返す。
  const mem = { id: 'mj', inlineBuffer: fakeJpeg(), inlineMime: 'image/jpeg' };
  const memHit = readEntryInline(mem);
  assert.equal(memHit.mime, 'image/jpeg');
  assert.deepEqual([...memHit.buffer.subarray(0, 3)], JPEG_MAGIC);
  // disk: shot.inline.webp が無く shot.inline.jpg だけある時、jpg を probe して image/jpeg で返す。
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-inline-jpg-'));
  try {
    const written = writeEntry(inboxDir, {
      capturedAt: '2026-06-18T01:02:03.004Z',
      url: 'https://example.com/j',
      image: { shot: PNG_B64_TINY, inline: `data:image/jpeg;base64,${fakeJpeg(80).toString('base64')}`, inlineMime: 'image/jpeg' },
      annotation: { url: 'https://example.com/j', items: [] },
    });
    assert.ok(written.files.includes('shot.inline.jpg'), 'jpeg は shot.inline.jpg として永続');
    assert.ok(!written.files.includes('shot.inline.webp'), 'webp は作らない');
    const entry = findEntry(inboxDir, written.id);
    const img = buildEntryContent(entry).find((c) => c.type === 'image');
    assert.equal(img.mimeType, 'image/jpeg', 'disk の shot.inline.jpg を image/jpeg で返す');
    assert.deepEqual([...Buffer.from(img.data, 'base64').subarray(0, 3)], JPEG_MAGIC);
  } finally {
    rmSync(inboxDir, { recursive: true, force: true });
  }
});
