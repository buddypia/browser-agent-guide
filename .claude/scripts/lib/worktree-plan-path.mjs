/**
 * worktree-plan-path.mjs — worktree PLAN.md 위치 SSOT 헬퍼
 *
 * Why: PLAN.md 가 worktree 루트에 있으면 한 번 tracked 되는 순간 .gitignore 가
 * 무력화되어 main 으로 머지된다. `.tmp/worktree-<safeBranch>/PLAN.md` 위치는
 * .gitignore 의 `.tmp/` 패턴으로 git tracking 자체가 봉쇄된다.
 *
 * branch namespace 격리로 병렬 worktree 작업 충돌도 자연스럽게 해소된다.
 *
 * This helper applies to local worktree sessions in this repository.
 */

import { basename, join } from 'node:path';

/**
 * branch 명을 파일/디렉토리 안전 키로 변환. `/` → `__`.
 * pre-ship-review-guard.mjs 는 본 함수를 import 한다 (SSOT).
 */
export function safeBranchKey(branch) {
  return (branch || 'staged').replace(/[\/\\]/g, '__');
}

// GitHub Flow branch prefix — `.worktrees/<prefix>__name` escape 변형 reverse 대상.
// `release/*` `support/*` 는 의도적 미포함 (GitHub Flow only).
// 사용자 정의 brand prefix 추가 시 본 배열 갱신 + tests/unit/worktree-plan-path.test.mjs 회귀 케이스 추가.
// worktree-path.mjs#resolveWorktreeRoot 도 본 배열을 import (R-CM-037 2-세그먼트 판정 SSOT 공유).
export const KNOWN_BRANCH_PREFIXES = ['feature', 'fix', 'hotfix', 'chore', 'refactor', 'docs', 'test'];

/**
 * single-segment escape 변형 (`feature__foo`) 을 slash 형식 (`feature/foo`) 으로 reverse.
 * KNOWN_BRANCH_PREFIXES 로 시작하지 않으면 null 반환 (정규화 미적용 시그널).
 */
function reverseEscapeIfKnownPrefix(segment) {
  for (const prefix of KNOWN_BRANCH_PREFIXES) {
    if (segment.startsWith(`${prefix}__`)) {
      const suffix = segment.slice(prefix.length + 2);
      if (!suffix) return null; // `fix__` 빈 suffix — git 가 trailing-slash branch 거부하므로 정규화 skip
      return `${prefix}/${suffix}`;
    }
  }
  return null;
}

/**
 * worktree 절대/상대 경로에서 branch 명을 추론. 두 컨벤션 모두 같은 branch 로 정규화 (R-CM-024).
 *
 *   `.worktrees/feature/foo`            → `feature/foo` (slash 보존)
 *   `.worktrees/feature__foo`           → `feature/foo` (escape 변형 reverse, KNOWN_BRANCH_PREFIXES)
 *   `.worktrees/fix__bar-baz`           → `fix/bar-baz`
 *   `/abs/path/.worktrees/feature/baz`  → `feature/baz`
 *   `.worktrees/random__name`           → `.worktrees/random__name` (알려진 prefix 아님, 정규화 skip)
 *   `.worktrees/<single>`               → `.worktrees/<single>` (fallback)
 *   `<a>/<b>`                            → `<a>/<b>` (마지막 2 segments)
 *
 * pre-ship-review-guard.mjs 는 본 함수를 import 한다 (SSOT). worktree-shipping-guard +
 * Local worktree helpers depend on this path convention.
 */
export function inferBranchFromWorktreePath(wtPath) {
  if (!wtPath) return null;
  const parts = wtPath.split(/[\/\\]/).filter(Boolean);
  const idx = parts.lastIndexOf('.worktrees');
  if (idx >= 0) {
    if (parts.length > idx + 2) {
      return parts.slice(idx + 1, idx + 3).join('/');
    }
    if (parts.length === idx + 2) {
      const normalized = reverseEscapeIfKnownPrefix(parts[idx + 1]);
      if (normalized) return normalized;
    }
  }
  if (parts.length >= 2 && parts[parts.length - 2] !== '.worktrees') {
    return parts.slice(-2).join('/');
  }
  return parts[parts.length - 1] || null;
}

/**
 * worktree 안에서의 PLAN.md 상대 경로 (worktree 루트 기준).
 * `.tmp/worktree-<safeBranch>/PLAN.md`.
 */
export function planRelPath(branch) {
  return join('.tmp', `worktree-${safeBranchKey(branch)}`, 'PLAN.md');
}

/**
 * Pre-Ship Review Panel 컨펌 마커 절대 경로.
 * pre-ship-review-guard.mjs (hook) + mark-pre-ship-confirmed.mjs (CLI) 양쪽에서 import.
 * 양 호출 경로가 동일 키 산출 보장 → marker create/check 정합성 SSOT (R-CM-024).
 *
 * @param {string} mainRoot — main project root 절대 경로 (worktree 가 아님)
 * @param {string|null} branch — branch 명 또는 null (ship-feature 모드 = 'staged')
 */
export function preShipMarkerPath(mainRoot, branch) {
  return join(mainRoot, '.tmp', `pre-ship-review-confirmed-${safeBranchKey(branch)}`);
}

/**
 * worktree 절대 경로로부터 PLAN.md 절대 경로를 반환.
 * branch 미명시 시 worktree path 에서 추론.
 */
export function resolveWorktreePlanPath(worktreePath, branch = null) {
  const inferred = branch || inferBranchFromWorktreePath(worktreePath) || basename(worktreePath);
  return join(worktreePath, planRelPath(inferred));
}

/**
 * worktree 의 세션 소유권 사이드카 (`.session-owner`) 절대 경로 (R-CM-036).
 * `worktree-owner-tracker` (PostToolUse) 가 생성 시 현재 session_id 를 1줄 기록하고,
 * `worktree-session-owner-guard` (PreToolUse Layer 2) 가 읽어 소유권을 판정한다.
 *
 * PLAN.md 와 같은 `.tmp/worktree-<safeBranch>/` 디렉토리에 둔다 — `.gitignore` 의
 * `.tmp/` 패턴으로 git tracking 봉쇄 + branch namespace 격리로 병렬 worktree 충돌 해소.
 *
 * @param {string} worktreePath — worktree 루트 절대 경로
 * @param {string|null} branch — branch 명 또는 null (worktree path 에서 추론)
 */
export function worktreeOwnerPath(worktreePath, branch = null) {
  const inferred = branch || inferBranchFromWorktreePath(worktreePath) || basename(worktreePath);
  return join(worktreePath, '.tmp', `worktree-${safeBranchKey(inferred)}`, '.session-owner');
}

/**
 * `git worktree list --porcelain` 출력 파싱.
 * 각 entry: { path, branch } (branch 는 'refs/heads/' 제거된 short name 또는 detached 시 null).
 * 부수효과 없는 본 lib 에 둔다 (hook 모듈 import 시 bottom auto-run 부수실행 회피).
 * worktree-shipping-guard.mjs / worktree-owner-tracker.mjs 가 본 함수를 import (SSOT).
 * `.filter((e) => e.path)` — path 없는 detached/incomplete block 제외 (worktree-shipping-guard 동작 보존).
 *
 * @param {string} stdout
 * @returns {Array<{path: string, branch: string|null}>}
 */
export function parseWorktreeList(stdout) {
  if (!stdout) return [];
  const blocks = stdout.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const entry = { path: null, branch: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) {
        entry.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      }
    }
    return entry;
  }).filter((e) => e.path);
}
