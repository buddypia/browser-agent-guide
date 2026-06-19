/**
 * hook-output.mjs — Hook Output 표준화 라이브러리
 *
 * Claude Code Hooks API 공식 스펙에 준거한 출력 헬퍼.
 * 각 Hook Event Type별로 올바른 JSON 구조를 생성.
 *
 * API 스펙 참조:
 * - PreToolUse: hookSpecificOutput.permissionDecision ("deny"/"allow"/"ask")
 * - PostToolUse: 최상위 decision ("block") 또는 hookSpecificOutput.additionalContext
 * - Stop/SubagentStop: 최상위 decision ("block") + reason
 * - UserPromptSubmit: 최상위 decision ("block") + reason
 *
 * 사용법:
 *   import { output } from './utils.mjs';
 *   import { HookOutput } from './hook-output.mjs';
 *   return output(HookOutput.deny('이유'));
 */

// ═══════════════════════════════════════════════════════════════
// PreToolUse 출력 (permissionDecision 기반)
// ═══════════════════════════════════════════════════════════════

/**
 * PreToolUse: 도구 호출을 거부한다.
 * reason은 Claude에게 피드백으로 전달됨.
 *
 * @param {string} reason - 거부 이유 (Claude가 읽고 대응)
 * @returns {object} Hook output JSON
 */
export function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * PreToolUse: 도구 호출을 허용하되 경고 메시지를 표시한다.
 * reason은 사용자에게만 표시됨 (Claude에게는 비노출). (비고: Claude 0.2.x 부터 permissionDecisionReason이 Claude에게 전달될 수 있음)
 *
 * @param {string} reason - 경고 메시지 (사용자가 읽음)
 * @param {string} [contextBlock] - 선택적 추가 컨텍스트. reason에 병합되어 전달.
 * @returns {object} Hook output JSON
 */
export function allowWithWarning(reason, contextBlock) {
  const fullReason = contextBlock ? `${reason}\n\n${contextBlock}` : reason;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: fullReason,
    },
  };
}

/**
 * PreToolUse: 도구 호출을 허용하되 입력을 수정한다.
 * 입력 파라미터를 자동 교정할 때 사용 (예: model routing).
 *
 * @param {string} reason - 수정 이유 (사용자에게 표시)
 * @param {object} updatedInput - 수정된 tool_input 전체 객체
 * @returns {object} Hook output JSON
 */
export function allowWithUpdatedInput(reason, updatedInput) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
      updatedInput,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Stop / SubagentStop 출력 (decision 기반)
// ═══════════════════════════════════════════════════════════════

/**
 * Stop: 세션 종료를 차단한다.
 * reason은 Claude에게 전달되어 계속 진행하도록 지시.
 *
 * @param {string} reason - 차단 이유 (Claude가 읽고 대응)
 * @returns {object} Hook output JSON
 */
export function block(reason) {
  return { decision: 'block', reason };
}

// ═══════════════════════════════════════════════════════════════
// 컨텍스트 주입 (PostToolUse, PostToolBatch, UserPromptSubmit, SessionStart 에서 사용)
// ═══════════════════════════════════════════════════════════════

/**
 * Claude에게 추가 컨텍스트를 주입한다.
 * 차단하지 않고 정보성 메시지를 전달.
 *
 * 지원 이벤트: PostToolUse, PostToolBatch, UserPromptSubmit, SessionStart
 * 미지원: Stop, SubagentStop (decision 기반만 지원 — block() 또는 passthrough() 사용)
 *         PreToolUse (permissionDecision 기반 — deny()/allowWithWarning() 사용)
 *         PreCompact (Claude Code spec 상 hookSpecificOutput.additionalContext 미지원 —
 *                     compact 후 컨텍스트 보존이 필요하면 SessionStart hook 에서 source==='compact' 분기 사용)
 *
 * @param {string} message - 주입할 컨텍스트 메시지
 * @param {string} [hookEventName] - 이벤트명. 명시적 인자 > CLAUDE_HOOK_EVENT_NAME > PostToolUse.
 * @returns {object} Hook output JSON
 */
export function context(message, hookEventName) {
  const resolvedEvent = hookEventName || process.env.CLAUDE_HOOK_EVENT_NAME || 'PostToolUse';
  return {
    hookSpecificOutput: {
      hookEventName: resolvedEvent,
      additionalContext: message,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 패스스루 (모든 이벤트에서 사용 가능)
// ═══════════════════════════════════════════════════════════════

/**
 * 아무 작업 없이 통과.
 * @returns {object} 빈 객체
 */
export function passthrough() {
  return {};
}

// ═══════════════════════════════════════════════════════════════
// 이벤트 타입별 팩토리 (타입 안전 — 유효한 출력만 노출)
// ═══════════════════════════════════════════════════════════════

/**
 * Stop/SubagentStop 전용 출력 셋.
 * block() 또는 passthrough()만 유효.
 *
 * 사용법:
 *   const H = HookOutput.forStop();
 *   return output(H.block('이유'));
 *   return output(H.passthrough());
 */
export function forStop() {
  return { block, passthrough };
}

/**
 * PreToolUse 전용 출력 셋.
 * deny(), allowWithWarning(), allowWithUpdatedInput(), passthrough()만 유효.
 */
export function forPreToolUse() {
  return { deny, allowWithWarning, allowWithUpdatedInput, passthrough };
}

/**
 * PostToolUse 전용 출력 셋.
 * block(), context(), passthrough()만 유효.
 */
export function forPostToolUse() {
  return {
    block,
    context: (message) => context(message, 'PostToolUse'),
    passthrough,
  };
}

/**
 * UserPromptSubmit 전용 출력 셋.
 * block(), context(), passthrough()만 유효.
 */
export function forUserPromptSubmit() {
  return {
    block,
    context: (message) => context(message, 'UserPromptSubmit'),
    passthrough,
  };
}

/**
 * SessionStart 전용 출력 셋.
 * context(), passthrough()만 유효.
 *
 * 주의: PreCompact 는 hookSpecificOutput.additionalContext 를 spec 상 미지원.
 * compact 후 컨텍스트 보존이 필요하면 SessionStart hook 에서 source==='compact' 분기 사용.
 */
export function forSession(hookEventName = process.env.CLAUDE_HOOK_EVENT_NAME || 'SessionStart') {
  return {
    context: (message) => context(message, hookEventName),
    passthrough,
  };
}

// ═══════════════════════════════════════════════════════════════
// 네임스페이스 내보내기
// ═══════════════════════════════════════════════════════════════

export const HookOutput = {
  // 개별 함수 (레거시 호환 — 신규 코드는 팩토리 사용 권장)
  deny,
  allowWithWarning,
  allowWithUpdatedInput,
  block,
  context,
  passthrough,
  // 이벤트 타입별 팩토리 (권장)
  forStop,
  forPreToolUse,
  forPostToolUse,
  forUserPromptSubmit,
  forSession,
};
