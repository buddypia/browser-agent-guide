// inbox スキャナ + content ビルダーの単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
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

test('queryEntries: フィルタで該当 slug だけ返し、url/title メタを付与', () => {
  // fixture の2件はどちらも url=https://example.com/api。example.com で2件、other で0件。
  const hit = queryEntries(INBOX, { urlContains: 'example.com' });
  assert.equal(hit.length, 2);
  assert.ok(hit.every((e) => e.url === 'https://example.com/api'));
  assert.ok('title' in hit[0]);
  assert.equal(queryEntries(INBOX, { urlContains: 'no-such-project' }).length, 0);
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
