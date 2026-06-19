/**
 * State Management Module
 *
 * 파일 기반 상태 관리 모듈.
 * Claude Code Hooks 환경에서 모드별 상태를 JSON 파일로 관리.
 *
 * 설계 원칙:
 * - 각 모드는 독립적인 JSON state 파일
 * - 읽기/쓰기/삭제 모두 원자적 (단일 파일 조작)
 * - Staleness 체크로 좀비 상태 방지
 */

import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson, safeReadJson } from './utils.mjs';

/** Stale 판정 기준: 24시간 (BUG-8 fix: 야간/장기 작업 지원을 위해 2시간→24시간) */
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * State 파일 읽기
 * @param {string} stateDir - .claude/state 디렉토리 경로
 * @param {string} mode - state 파일 prefix (예: 마커/플래그 state)
 * @returns {object|null}
 */
export function readState(stateDir, mode) {
  return safeReadJson(join(stateDir, `${mode}-state.json`));
}

/**
 * State 파일 쓰기 (v2.1: 원자적 쓰기 - BUG-3 수정)
 *
 * 임시 파일에 먼저 쓴 뒤 renameSync()로 교체.
 * POSIX에서 rename은 원자적이므로 race condition 방지.
 *
 * @param {string} stateDir
 * @param {string} mode
 * @param {object} state
 * @returns {boolean}
 */
export function writeState(stateDir, mode, state) {
  const path = join(stateDir, `${mode}-state.json`);
  return atomicWriteJson(path, state);
}

/**
 * State 파일 삭제 (= 모드 비활성화)
 */
export function clearState(stateDir, mode) {
  const path = join(stateDir, `${mode}-state.json`);
  try {
    if (existsSync(path)) unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * State가 오래되었는지 체크 (좀비 상태 방지)
 *
 * Claude Code Hooks는 매 실행이 fresh process이므로
 * state 파일의 timestamp로 판단.
 */
export function isStale(state, thresholdMs = DEFAULT_STALE_MS) {
  if (!state) return true;

  const lastChecked = state.last_checked_at ? new Date(state.last_checked_at).getTime() : 0;
  const startedAt = state.started_at ? new Date(state.started_at).getTime() : 0;
  const recent = Math.max(lastChecked, startedAt);

  return recent === 0 || (Date.now() - recent) > thresholdMs;
}

/**
 * 특정 모드 state가 현재 세션에 속하는지 확인 (BUG-9 수정)
 *
 * - state에 session_id 없음 (레거시): 모든 세션 매칭 (하위 호환)
 * - sessionId를 모름 (빈 문자열): 모든 세션 매칭 (안전 폴백)
 * - 양쪽 모두 있음: 일치 여부 비교
 *
 * @param {object} state - 모드 state 객체
 * @param {string} sessionId - 현재 세션 ID
 * @returns {boolean}
 */
export function isSessionOwned(state, sessionId) {
  if (!state?.session_id) return true;
  if (!sessionId) return true;
  return state.session_id === sessionId;
}

/**
 * State 디렉토리 보장
 */
export function ensureStateDir(stateDir) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
}

// ═══════════════════════════════════════════════════════════════════
// Evidence Cache
//
// 파이프라인 실행 결과를 캐시하여 중복 검증 방지.
// CLAUDE.md의 Evidence Caching 규칙을 코드로 강제.
//
// State 파일: .claude/state/evidence-cache.json
// ═══════════════════════════════════════════════════════════════════

/**
 * Evidence TTL SSOT (CLAUDE.md "Evidence Caching" 섹션과 동기화)
 *
 * 키별 기본 TTL (분 단위). writeEvidenceCache() 호출 시
 * entry.ttl_minutes를 생략하면 이 맵의 값을 사용.
 */
export const EVIDENCE_TTL_MAP = {
  market_research: 7 * 24 * 60,   // 7일 (업종/규모 변경 시 무효화)
  nfr_analysis:    14 * 24 * 60,   // 14일 (composite_profile 변경 시 무효화)
  atam_scores:     30,              // 30분 (제약 조건 변경 시 무효화)
  stack_compat:    60,              // 1시간 (stack-config.json 변경 시 무효화)
  lint_result:     30,              // 30분
  test_result:     30,              // 30분
};

const EVIDENCE_CACHE_FILE = 'evidence-cache.json';

/**
 * Evidence Cache 읽기
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readEvidenceCache(stateDir) {
  return safeReadJson(join(stateDir, EVIDENCE_CACHE_FILE));
}

/**
 * Evidence Cache에 결과 기록
 * @param {string} stateDir
 * @param {string} key - 캐시 키 (예: 'market_research', 'atam_scores', 'lint_result')
 * @param {{ result: string, ttl_minutes: number, invalidated_by: string }} entry
 * @returns {boolean}
 */
export function writeEvidenceCache(stateDir, key, entry) {
  const cache = readEvidenceCache(stateDir) || {};
  cache[key] = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  const path = join(stateDir, EVIDENCE_CACHE_FILE);
  return atomicWriteJson(path, cache);
}

/**
 * Evidence Cache 특정 키 무효화
 * @param {string} stateDir
 * @param {string} key - 캐시 키
 * @returns {boolean}
 */
export function invalidateEvidenceCache(stateDir, key) {
  const cache = readEvidenceCache(stateDir);
  if (!cache || !cache[key]) return true;
  delete cache[key];
  const path = join(stateDir, EVIDENCE_CACHE_FILE);
  return atomicWriteJson(path, cache);
}

/**
 * Evidence Cache 항목이 유효한지 확인
 * @param {object} entry - cache[key] 항목
 * @param {string} [key] - 캐시 키 (EVIDENCE_TTL_MAP에서 기본 TTL 조회)
 * @returns {boolean}
 */
export function isEvidenceCacheValid(entry, key) {
  if (!entry || !entry.timestamp || !entry.result) return false;
  const defaultTtl = (key && EVIDENCE_TTL_MAP[key]) || 30;
  const ttl = (entry.ttl_minutes || defaultTtl) * 60 * 1000;
  const age = Date.now() - new Date(entry.timestamp).getTime();
  return age < ttl && entry.result === 'pass';
}

// ═══════════════════════════════════════════════════════════════════
// Pipeline State
//
// Pipeline Engine의 실행 상태 관리.
// 현재 스테이지, 히스토리, 세션 정보를 추적.
//
// State 파일: .claude/state/pipeline-state.json
// ═══════════════════════════════════════════════════════════════════

const PIPELINE_STATE_FILE = 'pipeline-state.json';

/**
 * Pipeline State 읽기
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readPipelineState(stateDir) {
  return safeReadJson(join(stateDir, PIPELINE_STATE_FILE));
}

/**
 * Pipeline State 쓰기 (원자적)
 * @param {string} stateDir
 * @param {object} state
 * @returns {boolean}
 */
export function writePipelineState(stateDir, state) {
  const path = join(stateDir, PIPELINE_STATE_FILE);
  return atomicWriteJson(path, state);
}

/**
 * Pipeline State 삭제 (파이프라인 종료)
 * @param {string} stateDir
 * @returns {boolean}
 */
export function clearPipelineState(stateDir) {
  const path = join(stateDir, PIPELINE_STATE_FILE);
  try {
    if (existsSync(path)) unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
