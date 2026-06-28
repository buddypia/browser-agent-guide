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

/** 11 섹션 모두 채운 유효 REVIEW.md (bilingual heading + HEAD stamp). */
function fullReport(sha = SHA) {
  return [
    '# Worktree 承認依頼レビュー — feature/x',
    '',
    `<!-- bag-review: head=${sha} -->`,
    '',
    '## 1. 承認依頼',
    '以下の worktree 作業は完了状態です。承認して進める / 修正が必要 / 停止する。',
    '',
    '## 2. 状態サマリー',
    '- Worktree path: .worktrees/feature/x',
    '- Branch: feature/x',
    '- PLAN.md checklist: all checked',
    '',
    '## 3. Worktree のコミット情報',
    '```text',
    'abc1234 test commit',
    '```',
    '- Commit count: 1',
    '- Commit range: origin/main..HEAD',
    '- Latest commit: abc1234 test commit',
    '',
    '## 4. PR Draft',
    '- PR URL: not created yet',
    '- PR status: Draft',
    '- Merge status: pending',
    '- CI status: not run',
    '',
    '## 5. 修正 / 追加したファイル',
    '```text',
    '.claude/scripts/lib/review-report.mjs',
    '```',
    '',
    '## 6. 変更内容',
    '| Path | 種別 | 役割 | 変更理由 |',
    '| --- | --- | --- | --- |',
    '| .claude/scripts/lib/review-report.mjs | EDIT | validation SSOT | enforce approval review |',
    '',
    '## 7. なぜ修正したか',
    '- 背景: marker-only bypass.',
    '- 解決した問題: review body is now required.',
    '- 採用した方針: file artifact validation.',
    '- ユーザー要求との対応: approval review before PR.',
    '',
    '## 8. トレードオフ',
    '- 採用案: REVIEW.md artifact.',
    '- 代替案: transcript scan.',
    '- 採用理由: deterministic.',
    '- 犠牲にした点: one more local artifact.',
    '- 将来見直す条件: CLI hook API improves.',
    '',
    '## 9. リスク / Rollback',
    '- 影響範囲: governance hooks.',
    '- 既知リスク: stale report.',
    '- 未検証事項: none.',
    '- Rollback 方法: revert hook change.',
    '',
    '## 10. セッション内の残タスク',
    '- なし / あり: なし',
    '- 次に必要な作業: PR approval.',
    '',
    '## 11. セッション内の問題点や改善点',
    '- 問題点: none.',
    '- 改善案: none.',
    '- 次回の注意: keep report updated.',
    '',
  ].join('\n');
}

test('validateReport: 완전한 11 섹션 + 일치 stamp → ok', () => {
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

test('validateReport: 한 섹션(리스크/Rollback) 누락 → missing 에 risks_rollback', () => {
  const without = fullReport().replace(
    '## 9. リスク / Rollback\n- 影響範囲: governance hooks.\n- 既知リスク: stale report.\n- 未検証事項: none.\n- Rollback 方法: revert hook change.\n',
    '',
  );
  const v = validateReport(without, { headSha: SHA });
  assert.equal(v.ok, false);
  assert.ok(v.missing.includes('risks_rollback'), JSON.stringify(v.missing));
});

test('validateReport: placeholder/공란 본문 → 미작성으로 missing', () => {
  const report = fullReport().replace(
    '## 11. セッション内の問題点や改善点\n- 問題点: none.\n- 改善案: none.\n- 次回の注意: keep report updated.\n',
    '## 11. セッション内の問題点や改善点\nTODO\n',
  );
  const v = validateReport(report, { headSha: SHA });
  assert.ok(v.missing.includes('session_issues'), JSON.stringify(v.missing));
});

test('validateReport: 빈 field label / table header only → 미작성으로 missing', () => {
  const report = fullReport()
    .replace('- Worktree path: .worktrees/feature/x\n- Branch: feature/x\n- PLAN.md checklist: all checked\n', '- Worktree path:\n- Branch:\n- PLAN.md checklist:\n')
    .replace('| .claude/scripts/lib/review-report.mjs | EDIT | validation SSOT | enforce approval review |\n', '|  | NEW/EDIT/DELETE |  |  |\n');
  const v = validateReport(report, { headSha: SHA });
  assert.ok(v.missing.includes('state_summary'), JSON.stringify(v.missing));
  assert.ok(v.missing.includes('change_table'), JSON.stringify(v.missing));
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

test('renderTemplate: 생성 템플릿은 11 섹션 헤더를 모두 가진다', () => {
  const t = renderTemplate({ branch: 'feature/x', headSha: SHA });
  const secs = splitSections(t);
  // 템플릿 본문은 placeholder/빈 필드라 missing 이지만, 헤더는 11개 모두 매칭돼야 한다.
  for (const req of REQUIRED_SECTIONS) {
    const present = secs.some((s) =>
      req.aliases.some((a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(s.heading)),
    );
    assert.ok(present, `template missing heading for ${req.key}`);
  }
  // stamp 가 박혀 있으면 staleness 통과
  assert.equal(validateReport(t, { headSha: SHA }).stale, false);
  assert.equal(validateReport(t, { headSha: SHA }).ok, false);
});
