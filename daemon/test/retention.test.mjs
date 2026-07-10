// retention sweep の単体テスト。temp inbox を作り utimesSync で mtime を決定的に制御する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coerceDuration, familyKey, resolveRetentionPolicy, archiveOne, pruneInbox } from '../src/retention.js';
import { listEntries, findEntry, queryEntries, buildEntryContent } from '../src/inbox.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function tmpInbox() {
  return mkdtempSync(join(tmpdir(), 'bag-retention-'));
}

// id 直下に shot.png を置き、shot.png mtime を「今から ageMs 前」に設定する（listEntries はこの mtime を読む）。
function makeEntry(inboxDir, id, { ageMs = 0, annotation } = {}) {
  const dir = join(inboxDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'shot.png'), PNG);
  if (annotation) writeFileSync(join(dir, 'annotation.json'), JSON.stringify(annotation));
  const t = new Date(Date.now() - ageMs);
  utimesSync(join(dir, 'shot.png'), t, t);
  return dir;
}

function policy(over = {}) {
  return {
    enabled: true,
    graceWindowMs: 30 * MIN,
    maxAgeMs: 14 * DAY,
    maxPerFamily: 5,
    doneTtlMs: 7 * DAY,
    sweepIntervalMs: 60 * MIN,
    ...over,
  };
}

function withInbox(fn) {
  const inbox = tmpInbox();
  try {
    return fn(inbox);
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
}

test('coerceDuration: 単位付き / 純数値(ms) / 不正は fallback', () => {
  assert.equal(coerceDuration('30m', 0), 30 * MIN);
  assert.equal(coerceDuration('14d', 0), 14 * DAY);
  assert.equal(coerceDuration('2h', 0), 2 * 60 * MIN);
  assert.equal(coerceDuration('500ms', 0), 500);
  assert.equal(coerceDuration('1000', 0), 1000); // suffix 無しは ms
  assert.equal(coerceDuration('bogus', 777), 777);
  assert.equal(coerceDuration('', 777), 777);
  assert.equal(coerceDuration(null, 777), 777);
  assert.equal(coerceDuration('0', 777), 777, '0 は fallback（grace floor を無効化させない）');
  assert.equal(coerceDuration('0m', 777), 777);
  assert.equal(coerceDuration('0d', 777), 777);
});

test('resolveRetentionPolicy: 既定 OFF / flag>env / grace クランプ / count 既定', () => {
  assert.equal(resolveRetentionPolicy({}).enabled, false, '既定は OFF');
  assert.equal(resolveRetentionPolicy({ args: { retention: 'on' }, env: { BAG_PF_RETENTION: 'off' } }).enabled, true, 'flag > env');
  assert.equal(resolveRetentionPolicy({ args: {}, env: { BAG_PF_RETENTION: 'on' } }).enabled, true, 'env も効く');
  const p = resolveRetentionPolicy({
    args: { retention: 'on', retentionGrace: '10d', retentionMaxAge: '1d', retentionDoneTtl: '1h' },
  });
  assert.equal(p.graceWindowMs, 10 * DAY);
  assert.equal(p.maxAgeMs, 10 * DAY, 'maxAge は grace 未満にならない');
  assert.equal(p.doneTtlMs, 10 * DAY, 'doneTtl は grace 未満にならない');
  assert.equal(resolveRetentionPolicy({ args: { retention: 'on', retentionMaxPerFamily: '3' } }).maxPerFamily, 3);
  assert.equal(resolveRetentionPolicy({ args: { retention: 'on', retentionMaxPerFamily: '0' } }).maxPerFamily, 5, '不正値は既定5');
});

test('familyKey: stamp と hash を外した host__title。別 stamp も同 family。旧形式は null', () => {
  assert.equal(
    familyKey('20260619-164608__d1mcqbsalv1tpw-cloudfront-net__slide-studio__1rp2ii8'),
    'd1mcqbsalv1tpw-cloudfront-net__slide-studio'
  );
  assert.equal(
    familyKey('20260619-164551__d1mcqbsalv1tpw-cloudfront-net__slide-studio__1x7117h'),
    'd1mcqbsalv1tpw-cloudfront-net__slide-studio',
    '別 stamp でも同一ページ族'
  );
  assert.equal(familyKey('20260101-000000__example-com__title__abc1234-2'), 'example-com__title', '衝突 -2 も同 family');
  assert.equal(familyKey('2026-06-17T08-00-00-000Z'), null, '旧 timestamp 形式は cap 対象外');
  assert.equal(familyKey(''), null);
});

test('grace floor: family cap 超過でも grace 内なら絶対 archive しない', () =>
  withInbox((inbox) => {
    const fam = '__example-com__page__'; // 中央が host__title
    makeEntry(inbox, `20260101-000400${fam}h4`, { ageMs: 1 * MIN });
    makeEntry(inbox, `20260101-000300${fam}h3`, { ageMs: 2 * MIN });
    makeEntry(inbox, `20260101-000200${fam}h2`, { ageMs: 3 * MIN });
    makeEntry(inbox, `20260101-000100${fam}h1`, { ageMs: 4 * MIN });
    const r = pruneInbox(inbox, policy({ maxPerFamily: 2, graceWindowMs: 30 * MIN }));
    assert.equal(r.archived, 0, 'grace 内は cap 超過でも保護');
    assert.equal(listEntries(inbox).length, 4);
  }));

test('MAX-AGE: 過去 maxAge かつ grace 外は done/ へ。listEntries/queryEntries から消え findEntry で復元可能', () =>
  withInbox((inbox) => {
    const id = '20260101-000000__example-com__page__old0001';
    makeEntry(inbox, id, {
      ageMs: 20 * DAY,
      annotation: { url: 'https://example.com/page', title: 'page', capturedAt: '2026-01-01T00:00:00.000Z' },
    });
    makeEntry(inbox, '20260120-000000__example-com__page__new0001', { ageMs: 1 * MIN });
    const r = pruneInbox(inbox, policy({ maxAgeMs: 14 * DAY }));
    assert.equal(r.archived, 1);
    assert.ok(!listEntries(inbox).some((e) => e.id === id), 'latest/list から消える');
    assert.ok(!queryEntries(inbox).some((e) => e.id === id));
    assert.ok(existsSync(join(inbox, 'done', id, 'shot.png')), 'done/ に退避');
    assert.equal(findEntry(inbox, id)?.id, id, 'findEntry は id 指定で done/ から復元');
  }));

test('SAME-FAMILY cap: 同一ページ族は新しい maxPerFamily だけ残す。別プロジェクトは無傷', () =>
  withInbox((inbox) => {
    // family A: 4世代（全部 grace 外, maxAge 未満）。maxPerFamily=2 → 古い2世代 archive。
    makeEntry(inbox, '20260101-000000__a-com__page__a1', { ageMs: 1 * 60 * MIN }); // 最新
    makeEntry(inbox, '20260101-000000__a-com__page__a2', { ageMs: 2 * 60 * MIN });
    makeEntry(inbox, '20260101-000000__a-com__page__a3', { ageMs: 3 * 60 * MIN });
    makeEntry(inbox, '20260101-000000__a-com__page__a4', { ageMs: 4 * 60 * MIN }); // 最古
    // family B: 別プロジェクト（別 host）。1世代。絶対無傷。
    makeEntry(inbox, '20260105-000000__b-com__other__b1', { ageMs: 2 * 60 * MIN });
    const r = pruneInbox(inbox, policy({ maxPerFamily: 2, graceWindowMs: 30 * MIN, maxAgeMs: 365 * DAY }));
    assert.equal(r.archived, 2, 'family A の古い2世代だけ');
    const live = listEntries(inbox).map((e) => e.id);
    assert.ok(live.includes('20260101-000000__a-com__page__a1'), '最新は残る');
    assert.ok(live.includes('20260101-000000__a-com__page__a2'));
    assert.ok(!live.includes('20260101-000000__a-com__page__a3'), '古い世代は退避');
    assert.ok(!live.includes('20260101-000000__a-com__page__a4'));
    assert.ok(live.includes('20260105-000000__b-com__other__b1'), '別プロジェクトは無傷（cross-project 安全）');
  }));

test('SAME-FAMILY cap: grace-young は cap カウントに含むが archive されない（混在ケース・I3）', () =>
  withInbox((inbox) => {
    // maxPerFamily=2, grace=30m。新しい順: y1(1m,young) y2(2m,young) o1(60m,old) o2(90m,old)。
    // grace-young 2件が cap を消費 → grace-old 2件があふれて退避。young は保護される。
    const fam = '__example-com__page__';
    makeEntry(inbox, `20260101-000400${fam}y1`, { ageMs: 1 * MIN });
    makeEntry(inbox, `20260101-000300${fam}y2`, { ageMs: 2 * MIN });
    makeEntry(inbox, `20260101-000200${fam}o1`, { ageMs: 60 * MIN });
    makeEntry(inbox, `20260101-000100${fam}o2`, { ageMs: 90 * MIN });
    const r = pruneInbox(inbox, policy({ maxPerFamily: 2, graceWindowMs: 30 * MIN, maxAgeMs: 365 * DAY }));
    assert.equal(r.archived, 2, 'grace-young 2件が cap を消費し、あふれた grace-old 2件が退避');
    const live = listEntries(inbox).map((e) => e.id);
    assert.ok(live.some((id) => id.endsWith('y1')), 'grace-young は残る');
    assert.ok(live.some((id) => id.endsWith('y2')));
    assert.ok(!live.some((id) => id.endsWith('o1')), 'あふれた grace-old は退避');
    assert.ok(!live.some((id) => id.endsWith('o2')));
  }));

test('archived id は image を取得できる（I4: done/ 退避後も by-id image fetch が壊れない）', () =>
  withInbox((inbox) => {
    const id = '20260101-000000__example-com__page__img0001';
    makeEntry(inbox, id, { ageMs: 20 * DAY, annotation: { url: 'https://example.com/page', title: 'page' } });
    const r = pruneInbox(inbox, policy({ maxAgeMs: 14 * DAY }));
    assert.equal(r.archived, 1);
    assert.ok(existsSync(join(inbox, 'done', id, 'shot.png')), 'done/ へ退避');
    const entry = findEntry(inbox, id);
    const content = buildEntryContent(entry);
    const img = content.find((c) => c.type === 'image');
    assert.ok(img, 'archived id でも image content を返す');
    assert.equal(img.mimeType, 'image/png');
    const head = Buffer.from(img.data, 'base64').subarray(0, 4);
    assert.deepEqual([...head], [137, 80, 78, 71], '有効な PNG バイトを done/ から返す');
  }));

test('archived id は inline(webp) 変種があればそれを返す（done/ 退避後も inline を維持）', () =>
  withInbox((inbox) => {
    const id = '20260101-000000__example-com__page__inl0001';
    const dir = makeEntry(inbox, id, { ageMs: 20 * DAY, annotation: { url: 'https://example.com/page', title: 'page' } });
    // shot.inline.webp を隣に置く（RIFF....WEBP の偽 WebP）。
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(32, 0x20)]);
    writeFileSync(join(dir, 'shot.inline.webp'), webp);
    const r = pruneInbox(inbox, policy({ maxAgeMs: 14 * DAY }));
    assert.equal(r.archived, 1);
    assert.ok(existsSync(join(inbox, 'done', id, 'shot.inline.webp')), 'inline 変種も done/ へ一緒に退避');
    const entry = findEntry(inbox, id);
    const img = buildEntryContent(entry).find((c) => c.type === 'image');
    assert.equal(img.mimeType, 'image/webp', 'archived でも inline(webp) を優先して返す');
    assert.deepEqual([...Buffer.from(img.data, 'base64').subarray(0, 4)], [0x52, 0x49, 0x46, 0x46], 'RIFF');
  }));

test('grace floor: mtime=0（stat 失敗）は MAX-AGE で archive せず触らない（N2）', () =>
  withInbox((inbox) => {
    const id = '20260101-000000__example-com__page__nomt001';
    const dir = join(inbox, id);
    mkdirSync(dir, { recursive: true });
    // shot.png を作らずに annotation だけ置くと listEntries に乗らない。代わりに shot を作り mtime=0 を模す。
    writeFileSync(join(dir, 'shot.png'), PNG);
    utimesSync(join(dir, 'shot.png'), new Date(0), new Date(0)); // epoch=0 ≒ mtime 欠落相当
    const r = pruneInbox(inbox, policy({ maxAgeMs: 14 * DAY }));
    assert.equal(r.archived, 0, 'mtime=0 は判定不能として archive しない');
    assert.equal(listEntries(inbox).length, 1);
  }));

test('done-TTL purge: done/ の dir mtime が古いものを削除、新しいものは残す', () =>
  withInbox((inbox) => {
    const doneDir = join(inbox, 'done');
    const oldId = 'old__done__entry__x1';
    const newId = 'new__done__entry__x2';
    for (const id of [oldId, newId]) {
      mkdirSync(join(doneDir, id), { recursive: true });
      writeFileSync(join(doneDir, id, 'shot.png'), PNG);
    }
    const old = new Date(Date.now() - 10 * DAY);
    const recent = new Date(Date.now() - 1 * DAY);
    utimesSync(join(doneDir, oldId), old, old);
    utimesSync(join(doneDir, newId), recent, recent);
    makeEntry(inbox, '20260120-000000__example-com__page__live1', { ageMs: 1 * MIN });
    const r = pruneInbox(inbox, policy({ doneTtlMs: 7 * DAY }));
    assert.equal(r.purged, 1);
    assert.ok(!existsSync(join(doneDir, oldId)), '10日前は削除');
    assert.ok(existsSync(join(doneDir, newId)), '1日前は残る');
  }));

test('archiveOne: rename で done/ へ、衝突は -2、traversal 名は skip', () =>
  withInbox((inbox) => {
    makeEntry(inbox, 'slug__a__b__h1', { ageMs: 1 * MIN });
    assert.equal(archiveOne(inbox, 'slug__a__b__h1'), true);
    assert.ok(!existsSync(join(inbox, 'slug__a__b__h1')), 'src は消える');
    assert.ok(existsSync(join(inbox, 'done', 'slug__a__b__h1', 'shot.png')), 'done に在る');
    makeEntry(inbox, 'slug__a__b__h1', { ageMs: 1 * MIN });
    assert.equal(archiveOne(inbox, 'slug__a__b__h1'), true);
    assert.ok(existsSync(join(inbox, 'done', 'slug__a__b__h1-2', 'shot.png')), '衝突は -2 で世代を潰さない');
    assert.equal(archiveOne(inbox, '../escape'), false, 'traversal は skip');
    assert.equal(archiveOne(inbox, 'a/b'), false);
    assert.equal(archiveOne(inbox, '..'), false);
    assert.equal(archiveOne(inbox, 'missing__entry__x__y'), false, '存在しない src は false');
  }));

test('pruneInbox: 2回目は no-op（冪等）', () =>
  withInbox((inbox) => {
    makeEntry(inbox, '20260101-000000__example-com__page__old1', { ageMs: 20 * DAY });
    makeEntry(inbox, '20260120-000000__example-com__page__new1', { ageMs: 1 * MIN });
    assert.equal(pruneInbox(inbox, policy()).archived, 1);
    assert.equal(pruneInbox(inbox, policy()).archived, 0, '2回目は archive なし');
  }));

test('pruneInbox: enabled=false は完全 no-op', () =>
  withInbox((inbox) => {
    makeEntry(inbox, '20260101-000000__example-com__page__old1', { ageMs: 99 * DAY });
    assert.deepEqual(pruneInbox(inbox, policy({ enabled: false })), { archived: 0, purged: 0 });
    assert.equal(listEntries(inbox).length, 1, 'OFF なら一切動かない');
  }));
