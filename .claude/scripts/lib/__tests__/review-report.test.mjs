/**
 * review-report.test.mjs — review-report.mjs lib 단위 테스트 (node:test, 의존 0)
 *
 * 실행: node --test .claude/scripts/lib/__tests__/review-report.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_SECTIONS,
  reviewReportRelPath,
  resolveReviewReportPath,
  splitSections,
  isFilled,
  validateReport,
  renderTemplate,
} from '../review-report.mjs';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** 9 섹션 모두 채운 유효 REVIEW.md (bilingual heading + HEAD stamp). */
function fullReport(sha = SHA) {
  return [
    '# Worktree Review — feature/x',
    '',
    `<!-- bag-review: head=${sha} -->`,
    '',
    '## Summary / 概要 (作業内容)',
    'Added a Stop-hook gate that enforces REVIEW.md.',
    '',
    '## Why / なぜ',
    'Closes the marker-only bypass documented in R-CM-030.',
    '',
    '## Changed Files / 変更ファイル',
    '- lib/review-report.mjs | NEW | 120 | validation SSOT',
    '',
    '## How / 作業方法',
    'Pure-function lib + Stop hook + Codex adapter + node:test.',
    '',
    '## Impact / 影響範囲',
    'Adds one Stop hook; fail-open; owned+committed worktrees only.',
    '',
    '## Trade-offs / トレードオフ',
    'File artifact over transcript scan (deterministic, testable).',
    '',
    '## Remaining Work / 残作業',
    'None; cleanup + PR after approval.',
    '',
    '## File Structure / フォルダー構造',
    '.claude/hooks/, .claude/scripts/lib/',
    '',
    '## Review Requests / レビュー依頼',
    '- Confirm the 9-section list matches intent.',
    '',
  ].join('\n');
}

test('validateReport: 완전한 9 섹션 + 일치 stamp → ok', () => {
  const v = validateReport(fullReport(), { headSha: SHA });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(v.missing, []);
  assert.equal(v.stale, false);
  assert.equal(v.present, true);
});

test('validateReport: 본문 null/빈 → present=false + 모든 섹션 missing', () => {
  const v = validateReport(null, { headSha: SHA });
  assert.equal(v.present, false);
  assert.equal(v.ok, false);
  assert.equal(v.missing.length, REQUIRED_SECTIONS.length);
});

test('validateReport: 한 섹션(Impact) 누락 → missing 에 impact', () => {
  const without = fullReport().replace('## Impact / 影響範囲\nAdds one Stop hook; fail-open; owned+committed worktrees only.\n', '');
  const v = validateReport(without, { headSha: SHA });
  assert.equal(v.ok, false);
  assert.ok(v.missing.includes('impact'), JSON.stringify(v.missing));
});

test('validateReport: placeholder/공란 본문 → 미작성으로 missing', () => {
  const report = fullReport().replace(
    '## Review Requests / レビュー依頼\n- Confirm the 9-section list matches intent.\n',
    '## Review Requests / レビュー依頼\nTODO\n',
  );
  const v = validateReport(report, { headSha: SHA });
  assert.ok(v.missing.includes('review_requests'), JSON.stringify(v.missing));
});

test('validateReport: stamp 부재 → stale (headSha 제공 시)', () => {
  const noStamp = fullReport().replace(/<!-- bag-review: head=.* -->/, '');
  const v = validateReport(noStamp, { headSha: SHA });
  assert.equal(v.stale, true);
  assert.equal(v.ok, false);
});

test('validateReport: stamp 불일치 → stale', () => {
  const v = validateReport(fullReport('ffffffffffffffffffffffffffffffffffffffff'), { headSha: SHA });
  assert.equal(v.stale, true);
});

test('validateReport: short stamp 가 full HEAD 의 prefix 면 일치', () => {
  const v = validateReport(fullReport(SHA.slice(0, 12)), { headSha: SHA });
  assert.equal(v.stale, false);
  assert.equal(v.ok, true);
});

test('validateReport: headSha 미제공 시 stamp 무관 (섹션만 검증)', () => {
  const noStamp = fullReport().replace(/<!-- bag-review: head=.* -->/, '');
  const v = validateReport(noStamp, {});
  assert.equal(v.stale, false);
  assert.deepEqual(v.missing, []);
});

test('splitSections: 코드펜스 내부 # 는 heading 으로 보지 않음', () => {
  const md = ['## Real', 'body', '```', '# not a heading', '```', '## Second', 'x'].join('\n');
  const secs = splitSections(md);
  assert.equal(secs.length, 2);
  assert.deepEqual(secs.map((s) => s.heading), ['Real', 'Second']);
});

test('isFilled: 공란/HTML주석만 → false, 실내용 → true', () => {
  assert.equal(isFilled(''), false);
  assert.equal(isFilled('<!-- guide -->'), false);
  assert.equal(isFilled('TODO'), false);
  assert.equal(isFilled('-'), false);
  assert.equal(isFilled('real content line'), true);
  assert.equal(isFilled('- path | NEW | 10 | role'), true);
});

test('resolveReviewReportPath / reviewReportRelPath: safeBranch 경로', () => {
  assert.equal(reviewReportRelPath('feature/foo'), '.tmp/worktree-feature__foo/REVIEW.md');
  assert.equal(
    resolveReviewReportPath('/repo/.worktrees/feature/foo', 'feature/foo'),
    '/repo/.worktrees/feature/foo/.tmp/worktree-feature__foo/REVIEW.md',
  );
});

test('renderTemplate: 생성 템플릿은 9 섹션 헤더를 모두 가진다', () => {
  const t = renderTemplate({ branch: 'feature/x', headSha: SHA });
  const secs = splitSections(t);
  // 템플릿 본문은 placeholder 주석이라 missing 이지만, 헤더는 9개 모두 매칭돼야 한다.
  for (const req of REQUIRED_SECTIONS) {
    const present = secs.some((s) => new RegExp(req.aliases[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(s.heading));
    assert.ok(present, `template missing heading for ${req.key}`);
  }
  // stamp 가 박혀 있으면 staleness 통과
  assert.equal(validateReport(t, { headSha: SHA }).stale, false);
});
