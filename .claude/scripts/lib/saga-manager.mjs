/**
 * saga-manager.mjs — Pipeline Saga State Manager
 *
 * trip-jarvis의 Pipeline Run Protocol (active-run.json)에서 이식.
 * brief2dev의 8-Stage 선형 파이프라인에 최적화.
 *
 * 역할:
 *   - active-run.json SSOT 관리 (읽기/쓰기/전환)
 *   - 스테이지 상태 전환 + transition_log 기록
 *   - shared_context 관리 (ADR 1회 읽기 규칙 등)
 *   - 세션 재개 지원 (paused → running)
 *
 * 소비자:
 *   - session-start.mjs (세션 시작 시 상태 복원)
 *   - pipeline-change-tracker.mjs (스테이지 완료 시 상태 업데이트)
 *   - pipeline-boundary-guard.mjs (현재 스테이지 확인)
 *   - brief2dev-orchestrator 스킬 (파이프라인 전체 제어)
 *
 * 설계 원칙:
 *   - 순수 함수 + 최소 부작용 (파일 I/O만)
 *   - 실패 시 안전 기본값 (null 반환, throw 안 함)
 *   - JSON 원자적 쓰기 (write → rename 패턴)
 */

import { existsSync, readFileSync, mkdirSync, cpSync, rmSync, renameSync } from 'fs';
import { join } from 'path';
import { getActiveRunPath, getNextStage, STAGE_MAP, loadRegistry, saveRegistry, getPipelineDataRoot } from './pipeline-config.mjs';
import { getArchivesRoot, resolveRunScopedDir, getProjectDir } from './layout-resolver.mjs';
import { clearChanges } from './output-tracker.mjs';
import { atomicWriteJson, extractConfidenceScore } from './utils.mjs';

/**
 * 허용되는 역전이 (compensation 전용)
 *
 * 2단계 compensation 모델:
 *   1. Self-retry (같은 스테이지 재실행): VALID_STATUS_TRANSITIONS의
 *      completed→running / failed→running으로 처리.
 *      YAML의 revert_to가 자기 자신을 가리키는 경우 (예: mvp_scoping→mvp_scoping)
 *   2. Backward jump (이전 스테이지로 롤백): 아래 BACKWARD_TRANSITIONS로 처리.
 *      YAML의 revert_to가 다른 스테이지를 가리키는 경우 (예: stack_selection→platform_decision)
 */
export const BACKWARD_TRANSITIONS = new Map([
  ['market_research', ['intake']],
  ['mvp_scoping', ['intake', 'market_research']],
  ['platform_decision', ['mvp_scoping']],
  ['stack_selection', ['platform_decision', 'mvp_scoping']],
  ['infra_design', ['stack_selection', 'platform_decision', 'mvp_scoping']],
  ['scaffolding', ['infra_design', 'stack_selection']],
  ['output_gate', ['scaffolding']],
]);

/** 스테이지 상태 유효 전환 (self-retry 포함) */
const VALID_STATUS_TRANSITIONS = {
  pending: ['running', 'skipped'],
  running: ['completed', 'failed'],
  completed: ['running'], // self-retry compensation (같은 스테이지 재실행)
  failed: ['running'],    // retry (실패 후 재시도)
  skipped: [],
};

/**
 * transition_log 에 entry 를 멱등성 보장으로 append 한다.
 *
 * Dedup 정책: 마지막 entry 와 `(from, to, trigger)` 가 동일하면 SKIP.
 * `note` / `at` 만 다른 경우는 같은 transition 의 metadata 변형으로 간주 (중복).
 * last entry 만 비교하므로 사이에 다른 entry 가 끼이면 dedup 하지 않는다.
 *
 * @param {object} run - active-run state object (mutated)
 * @param {object} entry - { from, to, at, trigger, note? }
 * @returns {boolean} push 됐으면 true, dedup SKIP 이면 false
 */
export function appendTransitionLog(run, entry) {
  if (!Array.isArray(run.transition_log)) {
    run.transition_log = [];
  }
  const last = run.transition_log[run.transition_log.length - 1];
  if (last && last.from === entry.from && last.to === entry.to && last.trigger === entry.trigger) {
    return false;
  }
  run.transition_log.push(entry);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 읽기
// ═══════════════════════════════════════════════════════════════

/**
 * active-run.json을 로드한다.
 * @returns {object|null}
 */
export function loadActiveRun() {
  try {
    const runPath = getActiveRunPath();
    if (!existsSync(runPath)) return null;
    return JSON.parse(readFileSync(runPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 현재 파이프라인 상태를 요약한다 (AI 컨텍스트 주입용).
 * @returns {string} 사람이 읽을 수 있는 상태 요약
 */
export function summarizeState() {
  const run = loadActiveRun();
  if (!run || run.status === 'idle') return '파이프라인 미시작 (idle)';

  const completed = Object.entries(run.stages)
    .filter(([_, s]) => s.status === 'completed')
    .map(([id]) => id);
  const skipped = Object.entries(run.stages)
    .filter(([_, s]) => s.status === 'skipped')
    .map(([id]) => id);
  const current = run.current_stage;
  return [
    `상태: ${run.status} | 모드: ${run.pipeline_type} | 현재: ${current || 'none'}`,
    `완료: [${completed.join(', ')}]`,
    skipped.length > 0 ? `스킵: [${skipped.join(', ')}]` : null,
    run.shared_context?.selected_platform
      ? `플랫폼: ${run.shared_context.selected_platform}`
      : null,
    run.shared_context?.budget_constraint
      ? `예산: ${run.shared_context.budget_constraint}`
      : null,
  ].filter(Boolean).join('\n');
}

/**
 * 현재 스테이지를 반환한다.
 * @returns {string|null}
 */
export function getCurrentStage() {
  const run = loadActiveRun();
  return run?.current_stage || null;
}

/**
 * 파이프라인이 실행 중인지 확인한다.
 * @returns {boolean}
 */
export function isRunning() {
  const run = loadActiveRun();
  return run?.status === 'running';
}

// ═══════════════════════════════════════════════════════════════
// 쓰기
// ═══════════════════════════════════════════════════════════════

/**
 * 지정된 스테이지들을 무효화(stale) 처리한다. (Cascading Invalidation)
 * @param {string[]} stageIds
 */
export function markStagesAsStale(stageIds) {
  if (!stageIds || stageIds.length === 0) return null;
  const run = loadActiveRun();
  if (!run) return null;

  let changed = false;
  for (const id of stageIds) {
    if (run.stages[id] && run.stages[id].status === 'completed') {
      run.stages[id].status = 'stale';
      changed = true;
    }
  }

  if (changed) {
    appendTransitionLog(run, {
      from: run.current_stage,
      to: run.current_stage,
      at: new Date().toISOString(),
      trigger: 'cascading_invalidation',
      note: `Upstream change detected. Invalidated downstream stages: ${stageIds.join(', ')}`,
    });
    saveActiveRun(run);
  }
  return run;
}

/**
 * Completed run 을 rewind 가능한 running 상태로 resume 한다.
 *
 * 사용자 결정 2026-05-21 Track 2 (revert) 의 saga 의미 확장:
 *   - compensate() 는 status='running' 만 허용 (line 408)
 *   - 그러나 사용자 보고 케이스 = 8/8 completed run 에서 mvp_scoping 으로 revert
 *   - 본 함수는 completed → running 전이 + current_stage 재설정으로 compensate() 정합
 *
 * 호출 조건: pipeline-rewind.mjs 의 main() 에서 archive 직전.
 * 멱등: 이미 running 이면 no-op.
 *
 * I1 invariant 후 current_stage=null 인 경우 마지막 stage 로 set + status='running'.
 *
 * @param {string} [reason] - transition_log 에 기록될 사유
 * @returns {object|null} 갱신된 run 또는 null
 */
export function resumeForRewind(reason = 'rewind') {
  const run = loadActiveRun();
  if (!run) return null;
  if (run.status === 'running') return run; // 멱등 — 이미 running
  if (run.status !== 'completed') return null; // failed / aborted 등은 별도 처리 필요

  const stageIds = Object.keys(run.stages);
  if (stageIds.length === 0) return null;
  const lastStage = run.current_stage || stageIds[stageIds.length - 1];

  run.status = 'running';
  run.current_stage = lastStage;
  if (run.stages[lastStage]) {
    run.stages[lastStage].status = 'running';
    run.stages[lastStage].completed_at = null;
  }
  appendTransitionLog(run, {
    at: new Date().toISOString(),
    from: 'completed',
    to: lastStage,
    trigger: 'rewind_resume',
    note: reason,
  });
  saveActiveRun(run);
  return run;
}

/**
 * active-run.json 의 정합성 invariant 를 강제한다 (idempotent).
 *
 * 검출 대상:
 *   I1) pipeline status === 'completed' 인데 current_stage 가 null 이 아님 → 잔존
 *   I2) stages 중 status === 'running' 인데 current_stage 가 아님 → orphan running
 *
 * 두 invariant 모두 data drift 의 결과 (예: 외부 path 가 completeStage() 우회).
 * Observatory stepper 가 `raw === 'running'` 또는 `id === currentStage` 매칭으로 첫
 * 단계를 highlight 하는 시각 혼란의 root cause.
 *
 * @param {object} data - active-run object (mutated in-place)
 * @returns {{i1Applied: boolean, i2Applied: string[]}} 적용 내역 (보고/테스트용)
 */
export function enforceActiveRunInvariants(data) {
  const result = { i1Applied: false, i2Applied: [] };
  if (!data || typeof data !== 'object') return result;

  // I1: completed run 의 current_stage 잔존 cleanup
  if (data.status === 'completed' && data.current_stage !== null) {
    data.current_stage = null;
    result.i1Applied = true;
  }

  // I2: orphan running stages cleanup (current_stage 아닌데 running 인 stage)
  if (data.stages && typeof data.stages === 'object') {
    const now = new Date().toISOString();
    for (const [stageId, stage] of Object.entries(data.stages)) {
      if (!stage || typeof stage !== 'object') continue;
      if (stage.status === 'running' && stageId !== data.current_stage) {
        stage.status = 'completed';
        if (!stage.completed_at) stage.completed_at = now;
        result.i2Applied.push(stageId);
      }
    }
  }

  return result;
}

/**
 * active-run.json을 원자적으로 저장한다.
 * 저장 직전 invariant 를 적용하여 drift 를 차단한다.
 * @param {object} data
 */
function saveActiveRun(data) {
  enforceActiveRunInvariants(data);
  data.updated_at = new Date().toISOString();
  const runPath = getActiveRunPath();
  atomicWriteJson(runPath, data);
}

/**
 * 파이프라인을 시작한다.
 * @param {string} [businessDescription] - 사용자 원본 입력
 * @param {object} [options]
 * @param {string} [options.executionMode] - WebUI/오케스트레이터 선택 모드
 * @param {string} [options.pipelineType] - BRIEF2DEV_FULL | BRIEF2DEV_PRODUCTION_SEED
 * @param {object} [options.outputVariant] - WebUI 다중 산출물 카드 메타데이터
 * @returns {object} 업데이트된 active-run
 */
export function startPipeline(businessDescription = null, options = {}) {
  let run = loadActiveRun();
  if (!run) {
    run = createInitialState();
  }

  // BUG-3 fix: running/paused 파이프라인 재진입 방지
  if (run.status !== 'idle') return null;

  const now = new Date().toISOString();
  const dateStr = now.slice(0, 10).replace(/-/g, '');

  // SM-2 fix: 동일 날짜 충돌 방지 — 타임스탬프 기반 고유 접미사
  const timeStr = now.slice(11, 19).replace(/:/g, '');
  run.run_id = `brief2dev-${dateStr}-${timeStr}`;
  run.status = 'running';
  run.pipeline_type = normalizePipelineType(options.pipelineType);
  run.started_at = now;
  run.current_stage = 'intake';
  run.stages.intake.status = 'running';
  run.stages.intake.started_at = now;

  if (businessDescription) {
    run.shared_context.business_description = businessDescription;
  }
  if (options.executionMode) {
    run.shared_context.execution_mode = options.executionMode;
  }
  if (options.outputVariant) {
    run.shared_context.output_variant = options.outputVariant;
  }

  appendTransitionLog(run, {
    from: null,
    to: 'intake',
    at: now,
    trigger: 'manual',
    note: 'Pipeline started',
  });

  saveActiveRun(run);
  return run;
}

function normalizePipelineType(pipelineType) {
  if (pipelineType === 'BRIEF2DEV_PRODUCTION_SEED') return pipelineType;
  return 'BRIEF2DEV_FULL';
}

/**
 * Scaffold 모드로 파이프라인을 시작한다.
 * Phase 1 (Stage 1~6)을 스킵하고 scaffolding에서 직접 시작.
 *
 * @param {string} [businessDescription] - 사용자 원본 입력 (예: "송장 관리 SaaS")
 * @param {object} [stackDecisions] - 대화형 스택 결정 결과 (stack-decisions.json 내용)
 * @returns {object|null} 업데이트된 active-run, 또는 이미 실행 중이면 null
 */
export function startScaffoldPipeline(businessDescription = null, stackDecisions = null) {
  let run = loadActiveRun();
  if (!run) {
    run = createInitialState();
  }

  // BUG-3 fix 동일 적용: running/paused 파이프라인 재진입 방지
  if (run.status !== 'idle') return null;

  const now = new Date().toISOString();
  const dateStr = now.slice(0, 10).replace(/-/g, '');

  // SM-2 fix 동일 적용: 타임스탬프 기반 고유 접미사
  const timeStr = now.slice(11, 19).replace(/:/g, '');
  run.run_id = `brief2dev-scaffold-${dateStr}-${timeStr}`;
  run.status = 'running';
  run.pipeline_type = 'BRIEF2DEV_SCAFFOLD';
  run.started_at = now;
  run.current_stage = 'scaffolding';

  // Phase 1 스테이지 전부 'skipped'
  for (const stageId of [
    'intake', 'market_research', 'mvp_scoping',
    'platform_decision', 'stack_selection', 'infra_design',
  ]) {
    run.stages[stageId].status = 'skipped';
    run.stages[stageId].completed_at = now;
  }

  // scaffolding 스테이지 활성화
  run.stages.scaffolding.status = 'running';
  run.stages.scaffolding.started_at = now;

  // shared_context 설정
  if (businessDescription) {
    run.shared_context.business_description = businessDescription;
  }
  if (stackDecisions) {
    run.shared_context.selected_platform = stackDecisions.platform || null;
    run.shared_context.selected_stack = stackDecisions.framework || null;
    run.shared_context.stack_decisions = stackDecisions;
  }

  appendTransitionLog(run, {
    from: null,
    to: 'scaffolding',
    at: now,
    trigger: 'scaffold_mode',
    note: 'Scaffold-only pipeline started (Phase 1 skipped)',
  });

  saveActiveRun(run);
  return run;
}

/**
 * 세션 재개를 위해 paused → running 전환.
 * @returns {object|null}
 */
export function resumePipeline() {
  const run = loadActiveRun();
  if (!run || run.status !== 'paused') return null;

  const now = new Date().toISOString();
  run.status = 'running';
  // pipeline_type은 변경하지 않음 — 토폴로지(FULL/SCAFFOLD)는 불변
  // resume는 상태 전환(paused→running)이지 타입 변경이 아님

  appendTransitionLog(run, {
    from: run.current_stage,
    to: run.current_stage,
    at: now,
    trigger: 'session_resume',
    note: 'Session resumed',
  });

  saveActiveRun(run);
  return run;
}

/**
 * 세션 종료 시 running → paused 전환.
 * @returns {object|null}
 */
export function pausePipeline() {
  const run = loadActiveRun();
  if (!run || run.status !== 'running') return null;

  run.status = 'paused';
  saveActiveRun(run);
  return run;
}

/**
 * 스테이지를 완료하고 다음 스테이지로 전환한다.
 *
 * @param {string} stageId - 완료할 스테이지
 * @param {object} [options]
 * @param {number} [options.confidence] - handoff confidence (0.0~1.0)
 * @param {string} [options.evidence_grade] - 3-Tier Evidence Grade (A/B/C/D)
 * @param {string} [options.model] - 사용된 모델 (sonnet/opus)
 * @param {object} [options.shared] - shared_context에 병합할 데이터
 * @returns {object|null}
 */
export function completeStage(stageId, options = {}) {
  let run = loadActiveRun();

  // Auto-start: idle 상태에서 첫 stage(intake) 진입 시 startPipeline 자동 호출.
  // Root cause — silently dead startPipeline: 호출 사이트 0 → active.json mutation 0 →
  // Loom WebUI sidebar 영원히 idle (app.js:172 if (!runId) continue).
  // 통합 지점 선택: pipeline-change-tracker (PostToolUse Write/Edit) 가 첫 산출물 Write 시
  // completeStage 호출하므로 여기에 entry point 흡수 → 분석 스킬이 산출물 한 번 작성만 해도 run 시작.
  if ((!run || run.status === 'idle') && stageId === 'intake') {
    const businessDescription = options.shared?.business_description ?? null;
    run = startPipeline(businessDescription);
    if (!run) return null;
  }

  if (!run || run.status !== 'running') return null;

  const stage = run.stages[stageId];
  if (!stage) return null;

  // BUG-2 fix: 현재 스테이지만 완료 가능 (순서 보장)
  if (stageId !== run.current_stage) return null;

  const now = new Date().toISOString();

  // 스테이지 완료
  stage.status = 'completed';
  stage.completed_at = now;
  if (options.confidence != null) stage.confidence = options.confidence;
  if (options.evidence_grade) stage.evidence_grade = options.evidence_grade;
  if (options.model) stage.model = options.model;

  // shared_context 병합
  if (options.shared && typeof options.shared === 'object') {
    Object.assign(run.shared_context, options.shared);
  }

  // 다음 스테이지 전환 (pipeline-config.mjs SSOT)
  const nextStage = getNextStage(stageId, run.pipeline_type);
  if (nextStage === null) {
    // BUG-1 fix: output_gate → null (마지막 스테이지) → pipeline completed
    run.status = 'completed';
    run.current_stage = null;

    // 파이프라인 완료 시: handoff → sync → progress → 레거시 slug migration → registry → archive
    // migration을 registry 등록 전에 실행하여 중복 엔트리 방지.
    autoGenerateHandoff(stageId, stage, run);
    syncStageFromHandoff(stage, stageId);
    autoGeneratePipelineProgress(run);
    autoMigrateLegacySlug(run);
    autoRegisterProject(run);
    autoArchiveCanonical(run);
  } else if (nextStage) {
    run.current_stage = nextStage;
    run.stages[nextStage].status = 'running';
    run.stages[nextStage].started_at = now;
    // 스테이지별 handoff는 완료 즉시 생성한다.
    // 스킬이 이미 상세 handoff를 쓴 경우 autoGenerateHandoff가 존중하고 건너뛴다.
    autoGenerateHandoff(stageId, stage, run);
    // P0-A1: skill 이 detail handoff 를 먼저 썼다면 active.json 의 confidence/evidence_grade 가
    // null 또는 stale 로 남는 버그를 차단. handoff 파일이 SSOT (detail).
    syncStageFromHandoff(stage, stageId);
  }

  appendTransitionLog(run, {
    from: stageId,
    to: nextStage || 'done',
    at: now,
    trigger: 'auto_advance',
    note: `Stage ${stageId} completed (confidence: ${stage.confidence ?? 'N/A'}, evidence: ${stage.evidence_grade ?? 'N/A'})`,
  });

  saveActiveRun(run);
  return run;
}

/**
 * Compensation: 이전 스테이지로 롤백.
 *
 * @param {string} fromStage - 현재 스테이지
 * @param {string} toStage - 롤백 대상 스테이지
 * @param {string} [reason] - 롤백 사유
 * @returns {object|null}
 */
export function compensate(fromStage, toStage, reason = '') {
  const run = loadActiveRun();
  if (!run || run.status !== 'running') return null;

  // max_total_retries 강제 (YAML global.max_total_retries: 10)
  const MAX_TOTAL_RETRIES = 10;
  const totalRetries = Object.values(run.stages)
    .reduce((sum, s) => sum + (s.retry_count || 0), 0);
  if (totalRetries >= MAX_TOTAL_RETRIES) {
    run.status = 'failed';
    run.stages[fromStage].error = `Max total retries (${MAX_TOTAL_RETRIES}) exceeded`;
    saveActiveRun(run);
    return null;
  }

  // Self-retry: 현재 스테이지를 리셋하고 재실행
  if (fromStage === toStage) {
    const now = new Date().toISOString();
    const stage = run.stages[fromStage];
    stage.status = 'running';
    stage.started_at = now;
    stage.completed_at = null;
    stage.error = null;
    stage.retry_count = (stage.retry_count || 0) + 1;

    appendTransitionLog(run, {
      from: fromStage, to: fromStage, at: now,
      trigger: 'self_retry_compensation',
      note: reason || `Self-retry: ${fromStage}`,
    });
    saveActiveRun(run);
    return run;
  }

  const allowed = BACKWARD_TRANSITIONS.get(fromStage);
  if (!allowed || !allowed.includes(toStage)) return null;

  const now = new Date().toISOString();

  // 현재 스테이지 상태 리셋
  run.stages[fromStage].status = 'pending';
  run.stages[fromStage].started_at = null;
  run.stages[fromStage].completed_at = null;

  // 롤백 대상 스테이지 재활성화
  run.stages[toStage].status = 'running';
  run.stages[toStage].started_at = now;
  run.stages[toStage].completed_at = null;
  run.stages[toStage].retry_count = (run.stages[toStage].retry_count || 0) + 1;

  run.current_stage = toStage;

  appendTransitionLog(run, {
    from: fromStage,
    to: toStage,
    at: now,
    trigger: 'compensation',
    note: reason || `Compensation: ${fromStage} → ${toStage}`,
  });

  saveActiveRun(run);
  return run;
}

/**
 * 스테이지 실패 기록.
 *
 * @param {string} stageId
 * @param {string} error - 에러 메시지
 * @returns {object|null}
 */
export function failStage(stageId, error) {
  const run = loadActiveRun();
  if (!run) return null;

  // SM-1 fix: completeStage()와 동일하게 running 상태에서만 실패 마킹 가능
  if (run.status !== 'running') return null;

  const stage = run.stages[stageId];
  if (!stage) return null;
  if (stageId !== run.current_stage) return null;

  stage.status = 'failed';
  stage.error = error;
  run.status = 'failed';

  saveActiveRun(run);
  return run;
}

/**
 * failed 상태에서 복구한다.
 *
 * 오케스트레이터의 에스컬레이션 후 사용자 선택에 대응:
 *   - 'retry': 실패 스테이지를 재시도 (분해/수동입력)
 *   - 'skip':  실패 스테이지를 건너뛰고 다음으로 (경고 진행)
 *
 * @param {'retry'|'skip'} action
 * @returns {object|null}
 */
export function recoverFromFailure(action = 'retry') {
  const run = loadActiveRun();
  if (!run || run.status !== 'failed') return null;

  const failedStageId = run.current_stage;
  const stage = run.stages[failedStageId];
  if (!stage || stage.status !== 'failed') return null;

  const now = new Date().toISOString();

  // max_total_retries 강제 (YAML global.max_total_retries: 10)
  const MAX_TOTAL_RETRIES = 10;
  if (action === 'retry') {
    const totalRetries = Object.values(run.stages)
      .reduce((sum, s) => sum + (s.retry_count || 0), 0);
    if (totalRetries >= MAX_TOTAL_RETRIES) {
      run.stages[failedStageId].error = `Max total retries (${MAX_TOTAL_RETRIES}) exceeded`;
      saveActiveRun(run);
      return null;
    }
  }

  if (action === 'skip') {
    // 실패 스테이지를 skipped로 마킹하고 다음으로 전진
    stage.status = 'skipped';
    stage.completed_at = now;

    const nextStage = getNextStage(failedStageId, run.pipeline_type);
    if (nextStage === null) {
      run.status = 'completed';
      run.current_stage = null;
    } else if (nextStage) {
      run.status = 'running';
      run.current_stage = nextStage;
      run.stages[nextStage].status = 'running';
      run.stages[nextStage].started_at = now;
    }

    appendTransitionLog(run, {
      from: failedStageId,
      to: nextStage || 'done',
      at: now,
      trigger: 'skip_after_failure',
      note: `Stage ${failedStageId} skipped after failure (warning)`,
    });
  } else {
    // retry: 실패 스테이지를 다시 running으로
    stage.status = 'running';
    stage.started_at = now;
    stage.error = null;
    stage.retry_count = (stage.retry_count || 0) + 1;
    run.status = 'running';

    appendTransitionLog(run, {
      from: failedStageId,
      to: failedStageId,
      at: now,
      trigger: 'retry_after_failure',
      note: `Stage ${failedStageId} retry #${stage.retry_count}`,
    });
  }

  saveActiveRun(run);
  return run;
}

/**
 * 파이프라인 전체 리셋 (idle 상태로).
 *
 * 주의: running/paused 상태에서도 강제 리셋한다 (의도적 escape hatch).
 * 실행 중 리셋 시 transition_log에 경고를 기록한다.
 *
 * @returns {object}
 */
export function resetPipeline() {
  const previous = loadActiveRun();
  if (previous && (previous.status === 'running' || previous.status === 'paused')) {
    // 실행 중 강제 리셋 — 이전 상태를 transition_log에 기록 후 리셋
    appendTransitionLog(previous, {
      from: previous.current_stage,
      to: 'reset',
      at: new Date().toISOString(),
      trigger: 'force_reset',
      note: `Pipeline force-reset from ${previous.status} (stage: ${previous.current_stage}). Previous run_id: ${previous.run_id}`,
    });
    saveActiveRun(previous);
  }

  const initial = createInitialState();
  saveActiveRun(initial);

  // Saga 리셋 시 output-tracker state도 함께 초기화
  // 이전 파이프라인의 변경 기록이 새 파이프라인에 leak되지 않도록 보장
  try {
    // worktree_local base (withProjectDirOverride 적용 시 그 worktree 의 .claude/state).
    // cross-worktree run reset(R-CM-035 예외 5) 시 대상 worktree 의 tracker 를 정리한다.
    const stateDir = join(getProjectDir(), '.claude', 'state');
    clearChanges(stateDir);
  } catch {
    // tracker 초기화 실패해도 파이프라인 리셋은 진행
  }

  return initial;
}

// ═══════════════════════════════════════════════════════════════
// 파이프라인 완료 시 자동 처리
//
// PIPELINE_DATA_ROOT는 pipeline-config.mjs의 SSOT export를 import하여 사용.
// 이전에는 saga-manager가 자체 정의하여 pipeline-config와 해결 방식이 불일치했으나,
// 2026-04-19 정합성 감사에서 단일 SSOT로 통합됨.
// ═══════════════════════════════════════════════════════════════

/**
 * 스테이지 완료 직후 handoff JSON 파일을 read 하여 active.json#stages[id] 의
 * confidence/evidence_grade 를 동기화한다. P0-A1 fix.
 *
 * 배경 (2026-05-22 사용자 보고):
 *   - skill 이 상세 handoff 를 먼저 쓰면 autoGenerateHandoff() 가 SKIP (line 719).
 *   - completeStage(options={}) 시 options.confidence 미전달 = stage.confidence null.
 *   - 결과: active.json 8/8 stages 중 6개 confidence null, 2개 stale (handoff 후 갱신 미반영).
 *   - Observatory renderStageCard 가 typeof number 조건이라 배지 8/8 미표시.
 *
 * 정책:
 *   - handoff.confidence 가 object {score, ...} 또는 number 양식 모두 지원
 *   - handoff 부재 / parse 실패 / 필드 부재 = fail-open (stage 값 유지)
 *   - handoff 가 SSOT (skill detail) — options.confidence(호출자 hint) 보다 우선
 *
 * @param {object} stage - active-run.stages[stageId] 객체 (mutated in-place)
 * @param {string} stageId
 */
export function syncStageFromHandoff(stage, stageId) {
  try {
    if (!stage || typeof stage !== 'object') return;
    const stageInfo = STAGE_MAP.get(stageId);
    if (!stageInfo?.handoffFile) return;
    const handoffPath = join(resolveRunScopedDir('handoff'), stageInfo.handoffFile);
    // existsSync 선검사 생략 — readFileSync 의 ENOENT 가 outer catch 로 fail-open
    // (TOCTOU 회피 + 1 syscall 절감)
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf-8'));
    const score = extractConfidenceScore(handoff?.confidence);
    if (score !== null) stage.confidence = score;
    if (typeof handoff?.evidence_grade === 'string' && handoff.evidence_grade) {
      stage.evidence_grade = handoff.evidence_grade;
    }
  } catch {
    // fail-open — R-CM-006 Rule 2 (handoff 부재 / parse 실패 모두 동일)
  }
}

/**
 * 스테이지 완료 시 handoff 파일을 자동 생성한다.
 * STAGE_MAP에 handoffFile이 정의된 스테이지에 대해 동작.
 * 이미 존재하면 스킵 (스킬이 직접 생성한 경우 존중).
 */
function autoGenerateHandoff(stageId, stage, run) {
  try {
    const stageInfo = STAGE_MAP.get(stageId);
    if (!stageInfo?.handoffFile) return;

    const handoffDir = resolveRunScopedDir('handoff');
    if (!existsSync(handoffDir)) mkdirSync(handoffDir, { recursive: true });

    const handoffPath = join(handoffDir, stageInfo.handoffFile);
    if (existsSync(handoffPath)) return; // 스킬이 이미 생성한 경우 존중

    const handoff = {
      schema_version: '1.0',
      stage: stageId,
      stage_number: stageInfo.order,
      status: 'completed',
      skill: stageInfo.skill,
      completed_at: stage.completed_at,
      confidence: {
        level: stage.confidence >= 0.8 ? 'high' : stage.confidence >= 0.5 ? 'medium' : 'low',
        score: stage.confidence ?? 0.8,
        evidence_counts: { t1_direct: 0, t2_inferred: 0, t3_assumed: 0 },
        reasoning: `Auto-generated by saga-manager on pipeline ${run.status}`,
      },
      assumptions: [],
      open_questions: [],
      key_decisions: [],
      next_stage: getNextStage(stageId, run.pipeline_type),
    };

    atomicWriteJson(handoffPath, handoff);
  } catch {
    // 실패해도 파이프라인 완료를 차단하지 않음
  }
}

/**
 * 파이프라인 완료 시 schema-compliant pipeline-progress.json을 자동 생성한다.
 * Schema: data/schemas/stage-output/pipeline-progress.schema.json
 * Required: schema_version (X.Y pattern), pipeline, run_id, status, stages[].{number,name,status,confidence,attempts}
 *
 * 이미 존재하면 스킵 (AI가 output-gate 실행 시 상세 필드를 채워 덮어썼을 수 있음 — 존중).
 */
function autoGeneratePipelineProgress(run) {
  try {
    const stagesDir = resolveRunScopedDir('stage-output');
    const progressPath = join(stagesDir, 'pipeline-progress.json');
    if (existsSync(progressPath)) return; // 기존 파일 존중

    if (!existsSync(stagesDir)) mkdirSync(stagesDir, { recursive: true });

    const toLevel = (score) => score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';

    const stagesArr = [];
    const lowConfidence = [];
    let totalRetries = 0;
    let firstPass = 0;
    let completedCount = 0;

    for (const [stageId, info] of STAGE_MAP) {
      const st = run.stages[stageId];
      if (!st) continue;
      const attempts = (st.retry_count || 0) + 1;
      totalRetries += (st.retry_count || 0);
      if ((st.retry_count || 0) === 0 && st.status === 'completed') firstPass += 1;
      if (st.status === 'completed') completedCount += 1;

      const confidenceScore = st.confidence ?? 0;
      const level = toLevel(confidenceScore);
      if (level === 'low') lowConfidence.push(stageId);

      // R-CM-026 layout: run-scoped 경로 (runs/<run_id>/<subdir>).
      // run_id 부재 시 _unassigned 경로로 매핑
      // 표시용 path-prefix (의도적 layout-aware)
      const stagePrefix = run.run_id
        ? `.brief2dev/runs/${run.run_id}/stage-output`
        : '.brief2dev/runs/_unassigned/stage-output'; // @layout-resolver-allow
      const reportPrefix = run.run_id
        ? `.brief2dev/runs/${run.run_id}/reports`
        : '.brief2dev/runs/_unassigned/reports'; // @layout-resolver-allow
      const outputs = [];
      if (info.jsonFile) outputs.push(`${stagePrefix}/${info.jsonFile}`);
      if (info.mdFile) outputs.push(`${reportPrefix}/${info.mdFile}`);

      stagesArr.push({
        number: info.order,
        name: info.skill,
        status: st.status,
        confidence: level,
        attempts,
        outputs,
      });
    }

    const totalStages = stagesArr.length;
    const progress = {
      schema_version: '1.0',
      pipeline: run.pipeline_type || 'BRIEF2DEV_FULL',
      run_id: run.run_id,
      started_at: run.started_at,
      completed_at: new Date().toISOString(),
      status: run.status, // 'completed' at this point
      stages: stagesArr,
      metrics: {
        total_stages: totalStages,
        completed_stages: completedCount,
        first_pass_rate: totalStages > 0 ? `${((firstPass / totalStages) * 100).toFixed(1)}%` : '0%',
        average_retries: totalStages > 0 ? +(totalRetries / totalStages).toFixed(2) : 0,
        escalations: 0,
        low_confidence_stages: lowConfidence,
        unresolved_open_questions: [],
      },
    };

    atomicWriteJson(progressPath, progress);
  } catch {
    // 실패해도 파이프라인 완료를 차단하지 않음
  }
}

/**
 * run에서 slug(프로젝트 식별자)를 계산한다.
 * business_description 우선, 없으면 run_id. ASCII kebab-case 50자 이내.
 *
 * Regex 전략 (2026-04-28 ASCII-only 정책):
 *   - 허용: 영문/숫자/공백/하이픈(-)/언더스코어(_)
 *   - 비-ASCII (한글, 일본어, 중국어, 이모지, 특수문자) → 공백
 *   - 공백은 하이픈으로 치환, 연속 하이픈은 1개로 축소
 *   - 슬라이싱 후 트레일링 하이픈 재정리 (50자 경계가 단어 중간일 때)
 *   - ASCII 영역이 < 3자면 run_id로 fallback (의미 빈약 방지)
 *
 * 이전(2026-04-19): 한글 보존 → archive 디렉토리/registry key에 한글 포함되어 CLI 사용 불편.
 * autoMigrateLegacySlug가 business_description 기반으로 기존 archive를 자동 rename하므로
 * 알고리즘 변경 시 기존 archive 호환성 유지 가능.
 */
export function computeProjectSlug(run) {
  const desc = run.shared_context?.business_description;
  if (!desc) return run.run_id || 'unknown';
  const slug = desc
    .replace(/[^a-zA-Z0-9\s_-]/g, ' ')     // 비-ASCII → 공백 (한글 등 제거)
    .trim()
    .replace(/\s+/g, '-')                   // 공백 → 하이픈
    .replace(/-+/g, '-')                    // 연속 하이픈 축소
    .replace(/^[-_]+|[-_]+$/g, '')          // 앞뒤 하이픈/언더스코어 제거
    .toLowerCase()
    .slice(0, 50)
    .replace(/[-_]+$/, '');                 // slice 후 트레일링 하이픈/언더스코어 재정리
  if (slug.length < 3) return run.run_id || 'unknown';
  return slug;
}

/**
 * 파이프라인 완료 시 registry.json에 프로젝트를 자동 등록한다.
 *
 * @param {object} run - active run state
 * @param {object} [extra] - registry entry에 추가 보존할 필드
 *   - audit_status: "LEARNING_RUN_ARTIFACT" 등 (R-CM-016 Rule 8.1)
 *   - archive_dir: 실제 archive 디렉토리 이름 (slug와 다를 수 있음 — 충돌 시 timestamp suffix)
 *   - sealed_via: "archive-and-reset" | "auto-complete" | ...
 */
export function autoRegisterProject(run, extra = {}) {
  try {
    const registry = loadRegistry() || { schema_version: '1.0', active_project: null, projects: {} };

    const slug = computeProjectSlug(run);

    registry.projects[slug] = {
      run_id: run.run_id,
      pipeline_type: run.pipeline_type,
      platform: run.shared_context?.selected_platform || null,
      stack: run.shared_context?.selected_stack || null,
      started_at: run.started_at,
      completed_at: new Date().toISOString(),
      status: 'completed',
      // business_description을 보존하여 향후 slug 알고리즘 변경 시 migration 가능
      business_description: run.shared_context?.business_description || null,
      ...extra,
    };
    registry.active_project = slug;

    saveRegistry(registry);
  } catch {
    // 실패해도 파이프라인 완료를 차단하지 않음
  }
}

/**
 * slug 알고리즘 변경으로 기존 archive와 신규 slug가 달라진 경우 자동 migration.
 *
 * 감지 조건:
 *   - registry.projects[*].business_description === run.shared_context.business_description
 *   - entry slug(key) !== computeProjectSlug(run)
 *
 * 처리:
 *   - .brief2dev/archives/<old_slug>/ 존재 시 .brief2dev/archives/<new_slug>/로 renameSync (atomic)
 *   - registry에서 old_slug 엔트리 제거, new_slug 엔트리로 대체
 *
 * 이전에는 slug 알고리즘이 바뀌면 고아 디렉토리 + 이중 registry 엔트리 발생.
 * Task 22 (2026-04-19): business_description 기반 continuity 확보.
 */
function autoMigrateLegacySlug(run) {
  try {
    const newSlug = computeProjectSlug(run);
    const currentDesc = run.shared_context?.business_description;
    if (!currentDesc || !newSlug || newSlug === 'unknown') return;

    const registry = loadRegistry();
    if (!registry) return;
    if (!registry.projects) return;

    for (const [oldSlug, entry] of Object.entries(registry.projects)) {
      if (oldSlug === newSlug) continue;
      if (entry?.business_description !== currentDesc) continue;

      // slug 알고리즘 변경 감지 — archive 디렉토리 rename + registry 재구성
      const oldDir = join(getArchivesRoot(), oldSlug);
      const legacyOldDir = join(getPipelineDataRoot(), oldSlug);
      const newDir = join(getArchivesRoot(), newSlug);
      const sourceDir = existsSync(oldDir) ? oldDir : legacyOldDir;
      if (existsSync(sourceDir) && !existsSync(newDir)) {
        mkdirSync(getArchivesRoot(), { recursive: true });
        renameSync(sourceDir, newDir);
        process.stderr.write(
          `[saga-migrate] slug 알고리즘 변경 감지 — archive 이전: ${oldSlug} → ${newSlug}\n`
        );
      }
      // registry 엔트리 교체 (old 제거, new는 이후 autoRegisterProject가 overwrite)
      delete registry.projects[oldSlug];
    }

    saveRegistry(registry);
  } catch {
    // migration 실패는 파이프라인 완료를 차단하지 않음
  }
}

/**
 * 파이프라인 완료 시 canonical(`.brief2dev/runs/<run_id>/{stage-output,handoff,reports}/`)의 스냅샷을
 * `.brief2dev/archives/<slug>/` 아카이브로 복사한다 (읽기 전용 스냅샷). 이전 아카이브는 원자 교체.
 *
 * R-CM-026 P2 완성 (2026-05-02):
 *   - source 가 PIPELINE_DATA_ROOT/<sub>/ (legacy) 에서 RUNS_ROOT/<run_id>/<sub>/ (layout-aware) 로 변경.
 *   - run.run_id 부재 시 archive 무효 (이전 동작과 일치 — slug 도 unknown).
 *
 * 설계 근거:
 *   - canonical은 활성 파이프라인의 SSOT (R-CM-026 layout: runs/<active>/)
 *   - archives/<slug> 디렉토리는 완료된 파이프라인의 읽기 전용 아카이브
 *   - 수동 cp 없이 완료 시점에 1회 자동 스냅샷 → 이중 관리 문제 해결
 */
export function autoArchiveCanonical(run) {
  const slug = computeProjectSlug(run);
  if (!slug || slug === 'unknown') return;
  if (!run?.run_id) return;

  const archiveRoot = join(getArchivesRoot(), slug);
  const runDir = join(getPipelineDataRoot(), 'runs', run.run_id);
  // transcript: SessionEnd 시 transcript-extractor 가 Claude Code raw jsonl 을
  // runs/<runId>/transcript/ 로 복사. archive 봉인 시 같이 snapshot 떠 loom UI
  // 에서 대화 이력을 인간 친화 chat 으로 surface (R-CM-035 read-only 정합).
  const subdirs = ['stage-output', 'handoff', 'reports', 'transcript'];

  // 각 서브디렉토리를 개별 원자 교체 (temp-copy → rename pattern).
  // cpSync 도중 실패해도 기존 archive는 보존 — 데이터 손실 방지.
  //
  // 원자성 보장:
  //   - tmp/dst/old 모두 .brief2dev/archives/<slug>/ 하위 (동일 파일시스템)
  //   - POSIX rename(2)는 same-FS에서 atomic 교체 보장 (darwin/linux/BSD)
  //   - Windows는 MoveFileEx(MOVEFILE_REPLACE_EXISTING)로 atomic (Node.js 내부)
  //   - 다른 FS 간 rename(EXDEV)은 이 함수에서 발생 불가 (모든 경로가 PIPELINE_DATA_ROOT 내)
  //   - cpSync 자체는 atomic 아니지만 tmp 경로에 누적되므로 dst 영향 없음
  const now = Date.now();
  for (const sub of subdirs) {
    const src = join(runDir, sub);
    if (!existsSync(src)) continue;

    const dst = join(archiveRoot, sub);
    const tmp = join(archiveRoot, `.${sub}.tmp-${now}`);
    const old = join(archiveRoot, `.${sub}.old-${now}`);

    try {
      // 1) archiveRoot 보장
      mkdirSync(archiveRoot, { recursive: true });
      // 2) temp 경로에 새 스냅샷 복사 (실패해도 기존 dst 무사)
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
      cpSync(src, tmp, { recursive: true });
      // 3) 원자 스왑: 기존 dst를 old로 rename (있으면) → tmp를 dst로 rename → old 삭제
      if (existsSync(dst)) renameSync(dst, old);
      renameSync(tmp, dst);
      if (existsSync(old)) rmSync(old, { recursive: true, force: true });
    } catch {
      // 실패 시 temp/old 잔재 정리 — 기존 archive 유지
      try { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      try {
        // old가 존재하면 rename 실패 → 롤백 시도
        if (existsSync(old) && !existsSync(dst)) renameSync(old, dst);
        else if (existsSync(old)) rmSync(old, { recursive: true, force: true });
      } catch { /* ignore */ }
      // 다음 서브디렉토리는 계속 시도 (partial archive가 no archive보다 낫다)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 유틸리티
// ═══════════════════════════════════════════════════════════════

function createInitialState() {
  const stageTemplate = {
    status: 'pending', started_at: null, completed_at: null,
    model: null, confidence: null, evidence_grade: null,
    retry_count: 0, error: null,
  };

  return {
    schema_version: '1.0',
    run_id: null,
    status: 'idle',
    pipeline_type: 'BRIEF2DEV_FULL',
    tier: null,
    current_stage: null,
    started_at: null,
    updated_at: null,
    stages: {
      intake: { ...stageTemplate },
      market_research: { ...stageTemplate },
      mvp_scoping: { ...stageTemplate },
      platform_decision: { ...stageTemplate },
      stack_selection: { ...stageTemplate },
      infra_design: { ...stageTemplate },
      scaffolding: { ...stageTemplate },
      output_gate: { ...stageTemplate },
    },
    shared_context: {
      business_description: null,
      selected_platform: null,
      selected_stack: null,
      budget_constraint: null,
      adr_decisions: [],
      inbox_references: null,
    },
    transition_log: [],
  };
}

/** active-run.json 경로 (외부 참조용) */
export { getActiveRunPath as ACTIVE_RUN_FILE } from './pipeline-config.mjs';
