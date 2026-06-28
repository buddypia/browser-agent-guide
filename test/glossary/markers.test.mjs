// @term: マーカー解析とガード範囲の重なり判定の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkers, termsTouchedByRanges } from '../../scripts/glossary/lib/markers.mjs';

test('@term: 〜 @endterm でガード範囲を作る', () => {
  const code = [
    'const a = 1;',          // 1
    '// @term: foo',         // 2
    'function foo() {}',      // 3
    '// @endterm: foo',      // 4
    'const b = 2;',          // 5
  ].join('\n');
  const { markers, errors } = parseMarkers(code);
  assert.equal(errors.length, 0);
  assert.equal(markers.length, 1);
  assert.deepEqual(
    { id: markers[0].id, s: markers[0].startLine, e: markers[0].endLine },
    { id: 'foo', s: 2, e: 4 },
  );
});

test('@endterm が無ければ次マーカー/EOF まで', () => {
  const code = '// @term: a\nx\n// @term: b\ny\n';
  const { markers } = parseMarkers(code);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].endLine, 2); // 次マーカーの手前で閉じる
  assert.equal(markers[1].endLine, 5); // EOF まで(split の末尾空要素含む)
});

test('範囲が重なった用語だけ拾う', () => {
  const markers = [
    { id: 'foo', startLine: 2, endLine: 4 },
    { id: 'bar', startLine: 10, endLine: 12 },
  ];
  assert.deepEqual([...termsTouchedByRanges(markers, [{ start: 3, end: 3 }])], ['foo']);
  assert.deepEqual([...termsTouchedByRanges(markers, [{ start: 11, end: 11 }])], ['bar']);
  assert.deepEqual([...termsTouchedByRanges(markers, [{ start: 6, end: 6 }])], []);
  assert.deepEqual([...termsTouchedByRanges(markers, [{ start: 1, end: 20 }])].sort(), ['bar', 'foo']);
});

test('id 形式違反と孤立 @endterm を errors に出す', () => {
  const bad = parseMarkers('// @term: Bad_Id\nx\n');
  assert.ok(bad.errors.some((e) => /形式違反/.test(e.message)));
  const lone = parseMarkers('// @endterm\n');
  assert.ok(lone.errors.some((e) => /対応する @term/.test(e.message)));
});
