// decision-session-path.mjs — cross-worktree 세션 decisions 디렉터리 단일 SSOT helper (PADR-013).
//
// Loom WebUI 는 *임의의 세션 worktree* (자기 worktree 가 아닌 다른 CLI 세션 포함) 의 decision 을
// 읽고(aggregator) / 쓴다(mutator). 그래서 PROJECT_DIR 에 고정된 layout-resolver(resolveRunScopedDirFor)
// 로는 경로를 해결할 수 없다 — 세션의 worktree_path 를 base 로 직접 조립해야 한다.
//
// reader(decision-aggregator)와 writer(decision-mutator)가 *동일 물리 경로* 를 보장하도록
// 경로 조립을 이 한 곳에 모은다 (둘이 독립 조립하면 drift 시 WebUI write 가 CLI 가 안 읽는
// 경로로 새는 silent decision loss 위험). 이것이 interpretation contract(PADR-013 검증 #4)의
// 물리 계약 차원이다.
//
// 본 helper 는 의도적 layout-aware 코드라 `// @layout-resolver-allow` 로 R-CM-026 H1/H2 audit
// 에서 제외된다 (cross-worktree 는 layout-resolver 단일 진입점의 PROJECT_DIR 가정 밖).

import { join, resolve } from 'node:path';

/**
 * 한 세션의 decisions 디렉터리 절대 경로를 반환한다.
 *
 * runId path traversal 방어는 호출자(aggregator/mutator)가 수행한다 — 이 helper 는 순수 경로 조립만.
 *
 * @param {string} worktreePath - 세션 worktree 루트 (multi-session-discovery 가 제공)
 * @param {string} runId        - run id (단일 segment slug 가정)
 * @returns {string} `<worktreePath>/.brief2dev/runs/<runId>/decisions` 절대 경로
 */
export function resolveSessionDecisionsDir(worktreePath, runId) {
  return join(resolve(worktreePath), '.brief2dev', 'runs', runId, 'decisions'); // @layout-resolver-allow
}
