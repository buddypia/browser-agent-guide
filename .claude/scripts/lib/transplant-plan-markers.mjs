/**
 * transplant-plan-markers.mjs — Migration Sentinel Marker 탐지 (결함 1 보강)
 *
 * (b) migrate-transplant-plans.mjs가 backfill한 TODO 위치를 표시하기 위해
 * `_MIGRATION_TODO_AUDIT_REQUIRED_` 문자열을 심는다.
 *
 * 이 marker는 schema minLength는 통과하지만 의미적으로 "비어있음"을 나타내므로,
 * plan의 신규 편집 시 실제 값으로 교체되어야 한다. 이 모듈은 marker의 위치를
 * 탐지하여 (a) schema-guard의 DENY, phase-gate의 CONTEXT 경고, E20의 warning에
 * 공통 사용되도록 한다.
 *
 * 재귀 순회: object/array의 모든 문자열 리프를 검사하여 marker 포함 여부 리턴.
 *
 * Returns: [{ path: "critical_assessment.rationale", value: "..." }, ...]
 */

export const MIGRATION_MARKER = '_MIGRATION_TODO_AUDIT_REQUIRED_';

/**
 * @param {unknown} node - plan 루트 또는 하위 노드
 * @param {string} path - 현재 경로 (초기 '')
 * @param {Array<{path: string, value: string}>} found - 누적 결과
 * @param {number} depth - 재귀 깊이 제한
 * @returns {Array<{path: string, value: string}>}
 */
// `_migration` 블록은 마이그레이션 감사 메타데이터로, marker 리터럴을 **설명**하는
// notes 필드를 포함한다. 이 블록을 스캔하면 자기-참조 false positive 발생 → 제외.
const EXCLUDED_SUBTREES = new Set(['_migration']);

export function detectMigrationMarkers(node, path = '', found = [], depth = 0) {
  if (depth > 20) return found; // 병적 중첩 방어
  if (node === null || node === undefined) return found;

  if (typeof node === 'string') {
    if (node.includes(MIGRATION_MARKER)) {
      found.push({ path: path || '(root)', value: node });
    }
    return found;
  }

  if (Array.isArray(node)) {
    node.forEach((item, i) => detectMigrationMarkers(item, `${path}[${i}]`, found, depth + 1));
    return found;
  }

  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (depth === 0 && EXCLUDED_SUBTREES.has(k)) continue; // 루트의 메타 블록 skip
      const nextPath = path ? `${path}.${k}` : k;
      detectMigrationMarkers(v, nextPath, found, depth + 1);
    }
  }
  return found;
}

/**
 * 요약 문자열 생성 — Hook 메시지에 삽입하기 쉬운 형태.
 * 각 marker 위치를 최대 3개 표시하고 나머지는 +N 으로 축약.
 */
export function summarizeMarkers(markers) {
  if (markers.length === 0) return null;
  const shown = markers.slice(0, 3).map((m) => m.path);
  const more = markers.length > 3 ? ` (+${markers.length - 3}개)` : '';
  return `${markers.length}개 위치: ${shown.join(', ')}${more}`;
}
