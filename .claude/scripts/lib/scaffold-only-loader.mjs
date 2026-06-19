/**
 * scaffold-only-loader.mjs
 *
 * SCAFFOLD-ONLY hook 목록의 단일 진입점 (R-CM-026 Rule 8 정신).
 *
 * SSOT: `.claude/hooks/SCAFFOLD-ONLY.md` (markdown 테이블).
 * 본 모듈은 .md 의 markdown 테이블을 직접 파싱하여 Set 을 동적 생성한다.
 *
 * **사용처 (R-CM-006 Rule 4 듀얼 SSOT 정합 — 2 validator 가 동일 SSOT 인식)**:
 *   - `.claude/scripts/ecosystem-integrity-validator.mjs` (EI3 검사)
 *   - `.claude/hooks/ecosystem-health-guard.mjs` (E1 Stop hook 검사)
 *
 * **회귀 차단 이유**: 이전엔 2 validator 가 각자 인라인 SCAFFOLD_ONLY_HOOKS 를 보유하여
 * SCAFFOLD-ONLY.md 갱신 시 silent miss 위험. 이제 lib 단일 진입점으로 통일.
 *
 * **fallback 정책**: SSOT 부재 / 파싱 실패 시 MINIMUM_SCAFFOLD_ONLY (TEMPLATE.md 1개) 만
 * 보장하여 자기 차단 회피 (R-CM-006 Rule 2 fail-open 정신).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_LIB_DIR = dirname(__filename);
// .claude/scripts/lib/ → .claude/hooks/SCAFFOLD-ONLY.md
export const SCAFFOLD_ONLY_MD_PATH = join(SCRIPTS_LIB_DIR, '..', '..', 'hooks', 'SCAFFOLD-ONLY.md');

/**
 * 자기 차단 회피 fallback. SSOT 파싱 실패 시 최소 보장.
 * TEMPLATE.md 는 훅 템플릿 문서 (실제 훅 아님 — markdown 파싱 대상 외).
 */
export const MINIMUM_SCAFFOLD_ONLY = new Set([
  'TEMPLATE.md',
]);

/**
 * SCAFFOLD-ONLY.md 의 markdown 테이블에서 hook 파일명 추출.
 *
 * 매칭 패턴: `| \`<name>.mjs\` | <rationale> |`
 * 코드 블록 안의 backtick 패턴은 무시 (테이블 행만 — 시작 `|` 검사).
 *
 * @param {string} mdContent - SCAFFOLD-ONLY.md 본문
 * @returns {Set<string>} hook 파일명 Set (예: 'adr-compliance-guard.mjs')
 */
export function parseScaffoldOnlyMd(mdContent) {
  const set = new Set();
  if (!mdContent || typeof mdContent !== 'string') return set;
  const lines = mdContent.split('\n');
  for (const line of lines) {
    // markdown 테이블 row: 시작 `|` + backtick 으로 감싼 hook 파일명
    if (!line.trim().startsWith('|')) continue;
    const m = /\|\s*`([a-z0-9_-]+\.mjs)`/.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

/**
 * SCAFFOLD-ONLY.md 를 read 하여 SCAFFOLD_ONLY_HOOKS Set 을 동적 생성.
 *
 * - SSOT 부재 시: MINIMUM_SCAFFOLD_ONLY (자기 차단 회피)
 * - 파싱 실패 시: MINIMUM_SCAFFOLD_ONLY (graceful degradation)
 * - 정상: MINIMUM_SCAFFOLD_ONLY ∪ parseScaffoldOnlyMd 결과
 *
 * @param {string} [mdPath] - 테스트용 override path. 미지정 시 SCAFFOLD_ONLY_MD_PATH 사용.
 * @returns {Set<string>} hook 파일명 Set + TEMPLATE.md
 */
export function loadScaffoldOnlyHooks(mdPath = SCAFFOLD_ONLY_MD_PATH) {
  const set = new Set(MINIMUM_SCAFFOLD_ONLY);
  if (!existsSync(mdPath)) return set;
  try {
    const content = readFileSync(mdPath, 'utf8');
    const parsed = parseScaffoldOnlyMd(content);
    for (const hook of parsed) set.add(hook);
  } catch {
    // 파싱 실패 시 minimum 유지 (graceful degradation)
  }
  return set;
}
