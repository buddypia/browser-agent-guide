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
  matchesFilter,
  queryEntries,
  peekDistinctRecent,
} from '../src/inbox.js';

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
  assert.equal(context.annotations[0].dataAgentId, '@agent:docs/api-list');
  assert.equal(context.annotations[0].selector, 'main h2');
  assert.equal(context.annotations[0].targetCandidates[0].href, 'https://example.com/dp/B012345678');
  assert.equal(context.agentLookup.priority[0], 'dataAgentId');
  assert.equal(context.agentLookup.imageGate.contextId, NEWER);
  const text = buildEntryContextText(context);
  assert.ok(text.includes('visual_feedback_context: image omitted'));
  assert.ok(text.includes('agent_lookup:'));
  assert.ok(text.includes("source_search: rg -n 'data-agent-id=\"@agent:'"));
  assert.ok(text.includes(`image_gate: pass contextId="${NEWER}"`));
  assert.ok(text.includes('agent="@agent:docs/api-list"'));
  assert.ok(text.includes('selector="main h2"'));
  assert.ok(text.includes('candidate: source=nearest-link'));
  assert.ok(text.includes('href="https://example.com/dp/B012345678"'));
});

test('matchesFilter: url/title の部分一致（大文字小文字無視）。未指定は素通し', () => {
  const ann = { url: 'https://example.com/API', title: 'API ダッシュボード' };
  assert.equal(matchesFilter(ann, {}), true);
  assert.equal(matchesFilter(ann, { urlContains: 'example.com' }), true);
  assert.equal(matchesFilter(ann, { urlContains: 'EXAMPLE' }), true); // 大小無視
  assert.equal(matchesFilter(ann, { urlContains: 'other.com' }), false);
  assert.equal(matchesFilter(ann, { titleContains: 'ダッシュボード' }), true);
  assert.equal(matchesFilter(ann, { urlContains: 'example.com', titleContains: '存在しない' }), false); // AND
});

test('queryEntries: フィルタで該当 slug だけ返し、url/title/capturedAt メタを付与', () => {
  // fixture の2件はどちらも url=https://example.com/api。example.com で2件、other で0件。
  const hit = queryEntries(INBOX, { urlContains: 'example.com' });
  assert.equal(hit.length, 2);
  assert.ok(hit.every((e) => e.url === 'https://example.com/api'));
  assert.ok('title' in hit[0]);
  assert.ok('capturedAt' in hit[0], 'capturedAt メタも付与');
  assert.equal(hit[0].capturedAt, '2026-06-17T09:58:00.021Z');
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
