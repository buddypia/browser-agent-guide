/**
 * governance-writer.mjs — governance-events.jsonl append SSOT
 *
 * 거버넌스 이벤트(guard deny/block 발동, secret_detected 등)를
 * `.claude/state/governance-events.jsonl` 에 1줄씩 append 한다.
 *
 * 설계 원칙:
 *   - fail-safe: 기록 실패는 절대 호출부 동작(orchestrator dispatch / guard 결정)에 영향을 주지 않는다.
 *   - call-time path 해결: CLAUDE_PROJECT_DIR 를 호출 시점에 읽어 테스트/멀티워크트리에서 정확한 경로.
 *   - 포맷: { ts: ISO8601, eventType, ...payload }.
 *
 * 기존 동일 파일 writer(secret-leak-guard#appendSecretAudit / governance-capture)의
 * append 패턴을 일반화한 포맷 SSOT. 소비자: completion-evidence-guard(Check 1),
 * 향후 hook 발동 빈도 기반 ROI/REMOVE 심사.
 *
 * 커버리지 한계 (정직 명시 — R-CM-024):
 *   recordFiringIfDenyBlock 은 hook-orchestrator 경유 hook(orchestrated:true)의 deny/block 만 기록한다.
 *   orchestrated:false standalone hook(commit-guard / destructive-git-guard / guardrail-guard /
 *   secret-leak-guard 등)은 orchestrator 를 거치지 않아 본 경로로 미포착된다.
 *   secret-leak-guard 는 자체 appendSecretAudit(secret_detected)로 별도 기록(중복 아님 — 다른 eventType).
 *   standalone 발동 측정 확장은 데이터 가치 확인 후 별도 결정(현재 scope 밖).
 *
 * @boundary brief2dev-only (관점 1). orchestrator(scaffold 미배포 — scaffold 는 standalone
 *   settings.json dispatch)가 유일 호출부이므로 wiring 이 scaffold 에서 발화하지 않는다.
 *   scaffold-deployed hook(secret-leak-guard 등)은 본 lib 에 결합하지 않는다(R-CM-028 배포 분리).
 */

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';

/**
 * governance-events.jsonl 경로를 호출 시점 CLAUDE_PROJECT_DIR 기준으로 해결한다.
 * @returns {string}
 */
export function governanceEventsPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.claude', 'state', 'governance-events.jsonl');
}

/**
 * 거버넌스 이벤트 1건을 append 한다.
 * @param {{eventType: string, [key: string]: unknown}} event - eventType 필수. ts 는 자동 부여.
 * @returns {boolean} 기록 성공 여부 (실패해도 throw 하지 않음).
 */
export function appendGovernanceEvent(event) {
  try {
    if (!event || typeof event !== 'object' || typeof event.eventType !== 'string' || !event.eventType) {
      return false;
    }
    const eventsPath = governanceEventsPath();
    const dir = dirname(eventsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const record = { ts: new Date().toISOString(), ...event };
    appendFileSync(eventsPath, JSON.stringify(record) + '\n', 'utf-8');
    return true;
  } catch {
    return false; // fail-safe: 기록 실패는 호출부 동작과 무관
  }
}

/**
 * hook 결과가 deny/block 발동이면 governance-events 에 기록한다.
 * orchestrator executeHook 의 단일 chokepoint 용 헬퍼.
 * @param {string} hookId - registry entry id
 * @param {unknown} result - hook run() 반환값
 * @param {string} hookEvent - PreToolUse / Stop 등 hook event 이름
 * @returns {boolean} 기록 발생 여부
 */
export function recordFiringIfDenyBlock(hookId, result, hookEvent) {
  try {
    if (!result || typeof result !== 'object') return false;
    // try/catch 가 null 접근을 fail-safe 처리하므로 방어 체인 대신 local 변수 사용.
    const pre = result.hookSpecificOutput;
    const isDeny = !!pre && pre.permissionDecision === 'deny';
    const isBlock = result.decision === 'block';
    if (!isDeny && !isBlock) return false;
    const reason = isDeny ? pre.permissionDecisionReason : result.reason;
    return appendGovernanceEvent({
      eventType: isDeny ? 'deny_fired' : 'block_fired',
      hookId: typeof hookId === 'string' ? hookId : 'unknown',
      // hookEvent/reason 은 항상 bounded string 으로 강제 — 비문자열(객체) 직렬화 + 라인 비대 방어.
      hookEvent: typeof hookEvent === 'string' ? hookEvent.slice(0, 100) : '',
      reason: typeof reason === 'string' ? reason.slice(0, 500) : '',
    });
  } catch {
    return false; // fail-safe
  }
}
