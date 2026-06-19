/**
 * worktree-path.mjs — "이 타깃 절대경로가 어느 worktree 소속인가" 단일 SSOT.
 *
 * 근본 설계 원칙 (R-CM-037 Worktree Target-Context):
 *   path-분류 hook 의 worktree 판정은 **편집 대상의 절대경로** 만으로 결정한다.
 *   트리거 세션의 ENV/cwd/CLAUDE_PROJECT_DIR(=resolveProjectDir) 에 절대 의존하지
 *   않는다. 세션축은 per-target 판정에 잘못된 축 — 멀티세션 worktree 에서
 *   wt1 세션이 wt2/자기 worktree 를 오판정(cross-worktree 컨텍스트 오전달)한다.
 *
 * 본 모듈은 **순수함수만** 제공한다 — 파일 읽기·git 호출·전역상태 0.
 *   → 멀티세션·멀티worktree 동시 호출에도 공유 상태 충돌 구조적 불가.
 *   → hook 모듈이 아니므로 import 해도 standalone stdin 선소비 부작용 없음.
 *
 * worktree 경로 규약 (R-CM-034 "Worktree 운영"): 모든 worktree 는
 *   `<repo-root>/.worktrees/<branch>` 하위. GitHub Flow 브랜치는 `<type>/<slug>`
 *   2 세그먼트 (`feature/foo`) — 첫 세그먼트가 KNOWN_BRANCH_PREFIXES 일 때만 2-seg
 *   로 판정. escape 변형 (`hotfix-foo`) · 비표준 단일 이름 (`wt1`) 은 1-seg.
 */

import { KNOWN_BRANCH_PREFIXES } from './worktree-plan-path.mjs';

/**
 * 절대경로가 `.worktrees/<a>[/<b>]` 하위면 그 worktree 루트 절대경로 반환.
 * `.worktrees/` 하위 아님 → null.
 *
 * - lastIndexOf — 중첩 `.worktrees/` 시 가장 안쪽(파일의 실제 소속) 우선.
 * - **2-세그먼트(`<prefix>/<slug>`) 판정은 첫 세그먼트가 정확히 KNOWN_BRANCH_PREFIXES
 *   일 때만**. 그래야 단일 세그먼트 worktree (`hotfix-foo` / `wt1`) 의 하위 파일을
 *   2-세그먼트로 오판해 자기 worktree 안 작업을 false-deny 하지 않는다 (DEBT-182).
 *
 * @param {string} absPath
 * @returns {string|null}
 */
export function resolveWorktreeRoot(absPath) {
  if (!absPath || typeof absPath !== 'string') return null;
  const norm = absPath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/.worktrees/');
  if (idx === -1) return null;
  const after = norm.slice(idx + '/.worktrees/'.length).split('/').filter(Boolean);
  if (after.length === 0) return null;
  const base = norm.slice(0, idx) + '/.worktrees';
  if (after.length >= 2 && KNOWN_BRANCH_PREFIXES.includes(after[0])) {
    return `${base}/${after[0]}/${after[1]}`;
  }
  return `${base}/${after[0]}`;
}

/**
 * 절대경로가 어떤 worktree 안인지 (boolean shortcut).
 * 세션 ENV/cwd/projectDir 완전 무관 — 타깃 경로 세그먼트만 본다.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
export function isWorktreeAbsPath(absPath) {
  return resolveWorktreeRoot(absPath) !== null;
}
