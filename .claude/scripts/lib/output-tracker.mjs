/**
 * output-tracker.mjs - 파이프라인 산출물 변경 추적 유틸리티
 *
 * 세션 동안 변경된 산출물을 스테이지별로 추적 → handoff/정합성 동기화 지시 생성.
 *
 * 설계 원칙:
 * - state.mjs의 readState/writeState/clearState를 재사용 (원자적 파일 쓰기 보장)
 * - pipeline-config.mjs의 classifyOutputFile를 재사용 (스테이지 매칭)
 * - 에러 시 안전 기본값 반환 (throw 안 함)
 */

import { readState, writeState, clearState } from './state.mjs';
import { classifyOutputFile, STAGE_MAP, checkStageOutputs } from './pipeline-config.mjs';
import { loadActiveRun } from './saga-manager.mjs';

/** state.mjs에서 사용하는 모드 이름 */
const STATE_MODE = 'output-changes';

// ===============================================================
// 스테이지 감지
// ===============================================================

/**
 * 파일 경로에서 파이프라인 스테이지를 감지한다.
 *
 * @param {string} filePath - 프로젝트 상대 경로
 * @returns {string|null} 스테이지 ID 또는 null
 */
export function detectStage(filePath) {
  const { stageId } = classifyOutputFile(filePath);
  return stageId;
}

// ===============================================================
// 변경 추적 API
// ===============================================================

/**
 * 변경 파일을 레지스트리에 기록한다.
 *
 * @param {string} stateDir - .claude/state 디렉토리 경로
 * @param {string} filePath - 변경된 파일의 프로젝트 상대 경로
 * @param {string} stageId - 스테이지 ID
 * @returns {boolean} 성공 여부
 */
export function trackChange(stateDir, filePath, stageId) {
  try {
    const current = readState(stateDir, STATE_MODE) || {};
    if (!current[stageId]) {
      current[stageId] = [];
    }

    const normalizedPath = filePath.replace(/\\/g, '/');
    let isNewChange = false;
    if (!current[stageId].includes(normalizedPath)) {
      current[stageId].push(normalizedPath);
      isNewChange = true;
    }

    const success = writeState(stateDir, STATE_MODE, current);

    // 연쇄 무효화 (Cascading Invalidation): 상류 스테이지 변경 시 하류 스테이지 stale 처리
    if (isNewChange && stageId) {
      const affected = getAffectedStages(stageId);
      if (affected.length > 0) {
        import('./saga-manager.mjs').then(sm => {
          sm.markStagesAsStale(affected);
        }).catch(() => {});
      }
    }

    return success;
  } catch {
    return false;
  }
}

/**
 * 현재 세션의 변경 내역을 조회한다.
 *
 * @param {string} stateDir - .claude/state 디렉토리 경로
 * @returns {{ [stageId: string]: string[] } | null}
 */
export function getChanges(stateDir) {
  try {
    const state = readState(stateDir, STATE_MODE);
    if (!state || Object.keys(state).length === 0) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * 변경 내역을 초기화한다.
 *
 * @param {string} stateDir - .claude/state 디렉토리 경로
 * @returns {boolean} 성공 여부
 */
export function clearChanges(stateDir) {
  return clearState(stateDir, STATE_MODE);
}

// ===============================================================
// 변경 규모 판정
// ===============================================================

/**
 * 현재 세션이 파이프라인 실행 중인지 판별한다.
 * active-run.json의 status가 'running'이면 pipeline_run, 아니면 infra_change.
 *
 * @returns {'pipeline_run' | 'infra_change'}
 */
export function detectChangeType() {
  try {
    const run = loadActiveRun();
    return (run && run.status === 'running') ? 'pipeline_run' : 'infra_change';
  } catch {
    return 'infra_change';
  }
}

/**
 * 변경된 파일 목록에서 변경 규모를 판정한다.
 *
 * TRIVIAL: 1~2파일, 단일 스테이지
 * MINOR: 3+파일, 단일 스테이지
 * MAJOR: 2+ 스테이지 변경 AND 파이프라인 실행 중
 *
 * Level 3C: 파이프라인 실행이 아닌 인프라 변경(리팩토링 등)은
 * 2+ 스테이지를 건드려도 MINOR로 제한. pipeline-progress.json 갱신을
 * 강제하지 않아 false positive를 방지한다.
 *
 * @param {{ [stageId: string]: string[] }} changes - 변경 내역
 * @returns {'TRIVIAL' | 'MINOR' | 'MAJOR'}
 */
export function classifyChangeScale(changes) {
  if (!changes) return 'TRIVIAL';

  const stageCount = Object.keys(changes).length;
  const totalFiles = Object.values(changes).flat().length;

  if (stageCount >= 2) {
    const changeType = detectChangeType();
    if (changeType === 'infra_change') return 'MINOR';
    return 'MAJOR';
  }
  if (totalFiles <= 2) return 'TRIVIAL';
  return 'MINOR';
}

// ===============================================================
// 자동 동기화 지시 생성
// ===============================================================

/**
 * 변경 규모에 따른 handoff/정합성 동기화 지시 문자열을 생성한다.
 *
 * @param {{ [stageId: string]: string[] }} changes - 변경 내역
 * @param {'TRIVIAL' | 'MINOR' | 'MAJOR'} scale - 변경 규모
 * @returns {string} 동기화 지시 문자열
 */
export function buildSyncInstructions(changes, scale) {
  if (!changes) return '';

  const stageIds = Object.keys(changes);
  const lines = [];
  let hasActionableItems = false;

  lines.push(`[파이프라인 산출물 동기화 — 변경 규모: ${scale}]`);
  lines.push('');

  for (const stageId of stageIds) {
    const files = changes[stageId];
    const stageInfo = STAGE_MAP.get(stageId);
    if (!stageInfo) continue;

    const outputs = checkStageOutputs(stageId);

    // handoff 파일 미존재 체크
    if (!outputs.handoffExists && stageInfo.handoffFile) {
      hasActionableItems = true;
      lines.push(`  Stage ${stageInfo.order} (${stageId}) — ${files.length}파일 변경:`);
      lines.push(`    1. ${outputs.handoffPath} 생성 필요 (confidence, assumptions, open_questions)`);
    }

    // JSON과 MD 정합성 체크
    if (outputs.jsonExists && !outputs.mdExists && stageInfo.mdFile) {
      hasActionableItems = true;
      lines.push(`    2. ${outputs.mdPath} 미존재 — JSON은 있지만 MD 문서가 없습니다.`);
    }

    if (scale === 'MAJOR') {
      hasActionableItems = true;
      lines.push(`    3. [MAJOR] pipeline-progress.json 갱신 필요`);
    }
  }

  if (!hasActionableItems) return '';

  lines.push('');
  lines.push('위 동기화를 완료한 후 세션을 종료하세요.');

  return lines.join('\n');
}

/**
 * 변경 현황 요약을 생성한다 (경고 메시지용).
 *
 * @param {{ [stageId: string]: string[] }} changes - 변경 내역
 * @returns {string} 요약 문자열 (예: "intake (3파일), market_research (1파일)")
 */
export function summarizeChanges(changes) {
  if (!changes) return '없음';

  return Object.entries(changes)
    .map(([stageId, files]) => {
      const info = STAGE_MAP.get(stageId);
      const label = info ? `Stage ${info.order} ${stageId}` : stageId;
      return `${label} (${files.length}파일)`;
    })
    .join(', ');
}
