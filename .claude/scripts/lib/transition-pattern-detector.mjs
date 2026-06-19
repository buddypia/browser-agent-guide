/**
 * transition-pattern-detector.mjs — P2-5 phase 2
 *
 * archive-and-reset 시점에 active-run.json 의 transition_log 를 분석하여
 * learnings.jsonl 후보 entries 를 추출한다. 사용자에게 자동 prompt 만 하고
 * 등록은 수동 (R-CM-016 Rule 10 User Sovereignty 정합).
 *
 * 검출 패턴 (R-CM-020 type 매핑):
 *   - retry_after_failure ≥ 3 in same stage → pitfall (같은 stage 반복 실패)
 *   - compensation 발생 → pitfall (rollback 트리거됨)
 *   - cascading_invalidation 발생 → operational (downstream stale)
 *   - rewind_resume 발생 → operational (completed run 사용자 rewind)
 *
 * R-CM-020 confidence: inferred default = 4-5 (자동 추출은 추론 신호).
 */

const RETRY_THRESHOLD = 3;
const OPERATIONAL_TRIGGERS = new Set(['cascading_invalidation', 'rewind_resume']);

/**
 * transition_log 에서 learnings 후보 패턴을 검출한다.
 *
 * @param {object} run - active-run state object
 * @returns {Array<{type, key, insight, confidence, source, files, pattern_evidence}>}
 *   사용자 검토용 candidate entries. 빈 배열 = 패턴 없음.
 */
export function detectTransitionPatterns(run) {
  if (!run || !Array.isArray(run.transition_log) || run.transition_log.length === 0) {
    return [];
  }
  const log = run.transition_log;
  const runId = run.run_id || 'unknown-run';
  const candidates = [];

  const retryCounts = new Map();
  for (const e of log) {
    if (e?.trigger !== 'retry_after_failure') continue;
    const stage = e.to || '(unknown)';
    retryCounts.set(stage, (retryCounts.get(stage) || 0) + 1);
  }
  for (const [stage, count] of retryCounts) {
    if (count >= RETRY_THRESHOLD) {
      candidates.push({
        type: 'pitfall',
        key: `${runId}-retry-pitfall-${stage}`,
        insight: `Run ${runId} 의 ${stage} stage 에서 retry_after_failure 가 ${count}회 발생 — 반복 실패 함정 후보. R-CM-017 3-Strike Escalation 발동 조건 충족.`,
        confidence: 5,
        source: 'inferred',
        files: ['.brief2dev/run/active.json'], // @layout-resolver-allow
        pattern_evidence: { stage, count, trigger: 'retry_after_failure' },
      });
    }
  }

  for (const e of log) {
    if (e?.trigger === 'compensation') {
      candidates.push({
        type: 'pitfall',
        key: `${runId}-compensation-${e.from || 'unknown'}-to-${e.to || 'unknown'}`,
        insight: `Run ${runId} 에서 compensation 발생 (${e.from} → ${e.to}). 사용자 또는 시스템이 rollback 을 트리거 — 의사결정 정정 후보.`,
        confidence: 4,
        source: 'inferred',
        files: ['.brief2dev/run/active.json'], // @layout-resolver-allow
        pattern_evidence: { trigger: 'compensation', from: e.from, to: e.to, at: e.at },
      });
    }
    if (OPERATIONAL_TRIGGERS.has(e?.trigger)) {
      candidates.push({
        type: 'operational',
        key: `${runId}-${e.trigger}-${e.to || 'unknown'}`,
        insight: `Run ${runId} 에서 ${e.trigger} 발생 — ${e.note || '(no note)'}.`,
        confidence: 4,
        source: 'inferred',
        files: ['.brief2dev/run/active.json'], // @layout-resolver-allow
        pattern_evidence: { trigger: e.trigger, from: e.from, to: e.to, at: e.at },
      });
    }
  }

  return candidates;
}

/**
 * candidates 배열을 사용자 안내 stdout 메시지로 포맷.
 *
 * 등록 명령은 raw `node .claude/scripts/lib/learnings.mjs log ...` —
 * 사용자가 검토 후 수동 실행. 자동 등록 X (R-CM-016 Rule 10).
 *
 * @param {Array} candidates - detectTransitionPatterns 반환값
 * @returns {string} 사용자용 안내 메시지 (empty candidates 시 빈 문자열)
 */
export function formatLearningsPrompt(candidates) {
  if (!candidates || candidates.length === 0) return '';
  const lines = [
    '',
    `[learnings prompt — P2-5] transition_log 안에서 ${candidates.length}건의 학습 후보 발견:`,
    '',
  ];
  for (const c of candidates) {
    lines.push(`  - [${c.type}] ${c.key}`);
    lines.push(`    ${c.insight}`);
    lines.push(
      `    등록: node .claude/scripts/lib/learnings.mjs log --type ${c.type} --key ${c.key} --insight "..." --confidence ${c.confidence} --source ${c.source}`,
    );
    lines.push('');
  }
  lines.push('검토 후 의미 있는 항목만 수동 등록 (R-CM-016 User Sovereignty).');
  return lines.join('\n');
}
