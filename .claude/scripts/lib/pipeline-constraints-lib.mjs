/**
 * pipeline-constraints-lib.mjs — 파이프라인 제약 검증 공통 유틸
 *
 * pipeline-rules.mjs와 pipeline-validator.mjs가 각자 복제하던 검증 로직을
 * 단일 모듈로 추출한 SSOT. 양쪽 파일이 이 모듈을 import하여 사용한다.
 *
 * 담당 영역:
 *   - Mode-aware 외부 유저 규제 판단 (GDPR/PIPA/CCPA)
 *   - LTV:CAC 단위경제학 평가 (mode-aware 경계 판정)
 *   - 규제→Must 갭 탐지 (builder mode skip)
 *
 * SSOT 계약:
 *   - mode는 pipeline-config.getPipelineMode()에서 읽는다 (business-context.json.mode)
 *   - 외부 유저 대상 규제는 builder mode에서 자동 skip
 *   - LTV:CAC < 1.5는 mode 무관하게 criticals, 1.5-3.0은 builder에서 skip
 *
 * 다른 guard의 mode-aware 적용 범위 (검토 결과, 2026-04-18):
 *   - ecosystem-health-guard: 불필요 — YAML↔STAGE_MAP/hook registry/transplant 정합성 검증만 수행.
 *     비즈니스/규제 조건 체크 없음. mode-independent.
 *   - handoff-consistency-guard: 불필요 — handoff JSON schema, confidence ratchet, evidence 건수만 검증.
 *     파이프라인 구조적 무결성 guard. mode-independent.
 *   → 현재 mode-aware는 pipeline-rules.mjs + pipeline-validator.mjs 2개 파일로 충분.
 */

/** Builder Mode 등 외부 유저 대상 규제 검증을 skip하는 모드 집합 */
export const MODES_SKIPPING_EXTERNAL_USER_REGULATIONS = new Set(['builder']);

/**
 * 주어진 규제명이 외부 유저 대상 규제(GDPR/PIPA/CCPA/개인정보보호)인지 판정.
 * @param {string} regulation - 규제 이름
 * @returns {boolean}
 */
export function isExternalUserRegulation(regulation) {
  const s = (regulation || '').toUpperCase();
  return s.includes('GDPR') || s.includes('PIPA') || s.includes('개인정보') || s.includes('CCPA');
}

/**
 * 주어진 모드에서 특정 규제 체크를 skip해야 하는지 판정.
 * @param {string} mode - pipeline mode (builder/production/learning 등)
 * @param {object} regulation - regulatory_landscape.applicable_regulations 항목
 * @returns {boolean}
 */
export function shouldSkipRegulation(mode, regulation) {
  if (!regulation) return true;
  if (regulation.applicability === 'not_applicable' || regulation.applicability === 'low') {
    return true;
  }
  if (MODES_SKIPPING_EXTERNAL_USER_REGULATIONS.has(mode) && isExternalUserRegulation(regulation.regulation)) {
    return true;
  }
  return false;
}

/**
 * LTV:CAC 비율을 평가하여 criticals/warnings 분류.
 * Builder mode에서는 WARN 경계(1.5-3.0) skip.
 *
 * @param {number} ratio - ltv_cac_ratio
 * @param {string} mode - pipeline mode
 * @returns {{ severity: 'critical'|'warning'|null, message: string|null }}
 */
export function evaluateLtvCac(ratio, mode) {
  if (typeof ratio !== 'number') return { severity: null, message: null };
  if (ratio < 1.5) {
    return {
      severity: 'critical',
      message: `단위경제학 위험: LTV:CAC = ${ratio} (< 1.5). 비즈니스 모델 재검토 필요.`,
    };
  }
  if (ratio < 3.0 && mode !== 'builder') {
    return {
      severity: 'warning',
      message: `단위경제학 경계: LTV:CAC = ${ratio} (< 3.0). CAC 최적화 또는 ARPU 상향 권장.`,
    };
  }
  return { severity: null, message: null };
}
