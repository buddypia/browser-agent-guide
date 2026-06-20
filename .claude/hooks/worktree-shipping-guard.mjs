#!/usr/bin/env node

/**
 * worktree-shipping-guard.mjs - Stop Hook
 *
 * worktree 안에 uncommitted 변경 또는 unmerged commit 이 있으면 Stop 을 BLOCK 한다.
 * uncommitted 변경은 먼저 commit 하도록, unmerged commit 은 사용자에게 PR/merge 진행 여부를
 * 확인한 뒤 명시 컨펌이 있을 때만 `/create-pr ship-worktree` 실행을 유도한다.
 *
 * 정책 SSOT: R-CM-030 (worktree-auto-ship.md) + R-CM-036 (worktree-session-ownership.md)
 *
 * 동작:
 *   - user abort / context limit → passthrough (사용자 명시 중단 존중)
 *   - .tmp/create-pr-active 신선 (30min) → passthrough (/create-pr 진행 중)
 *   - 모든 worktree 가 다음 중 하나면 → passthrough
 *       · main 브랜치 (worktree list 의 첫 entry)
 *       · hotfix/* / hotfix-* 브랜치 (escape hatch, R-CM-008 정합)
 *       · 본 세션 소유가 아닌 worktree (타 세션 / orphan — R-CM-036 세션 소유권 필터)
 *       · 시도 마커 신선 (5min) — 이미 한 번 ship 시도한 clean worktree
 *       · origin/main..HEAD 가 비어있고 uncommitted 변경도 없음
 *   - 본 세션 소유 (owned) + uncommitted 변경 있는 worktree 1+ → BLOCK (시도 마커 생성 안 함)
 *   - 위 외에 owned + unmerged commit 있는 worktree 1+ → 시도 마커 생성 + BLOCK
 *   - error → passthrough (R-CM-006 Rule 2 fail-open)
 *
 * 세션 소유권 (R-CM-036, 2-Layer): Stop stdin 의 session_id + cwd 로 소유 worktree 만 차단 대상에
 *   포함한다. Layer 1 = cwd 가 worktree 내부 (Codex/Antigravity), Layer 2 = `.session-owner`
 *   사이드카 === session_id (Claude Code, cwd=main). 타 세션/orphan 은 stderr 알림 후 passthrough.
 *
 * 사용자 결정 (2026-05-10):
 *   - 트리거: uncommitted 변경 또는 commit + unmerged 시 BLOCK
 *   - 실패 정책: 한 번 시도 후 다음 Stop 통과 (사용자에게 보고하고 멈춤)
 *     단, uncommitted 변경은 작업 완료로 볼 수 없으므로 마커로 통과시키지 않음.
 *
 * Reference 패턴: worktree-policy-guard.mjs, quality-gate-stop-guard.mjs
 */

import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  output,
  safeHookMainWithProfile,
  readStdin,
  isUserAbort,
  isContextLimitStop,
  resolveProjectDir,
  safeGit,
} from '../scripts/lib/utils.mjs';
import { HookOutput } from '../scripts/lib/hook-output.mjs';
import {
  resolveWorktreePlanPath,
  parseWorktreeList,
  worktreeOwnerPath,
} from '../scripts/lib/worktree-plan-path.mjs';
// worktree 루트 판정 = 단일 SSOT (R-CM-037). 세션축 무관 순수함수.
import { resolveWorktreeRoot } from '../scripts/lib/worktree-path.mjs';
// parseWorktreeList SSOT 는 worktree-plan-path.mjs (R-CM-036 worktree-owner-tracker 와 공유).
// 기존 import 계약(테스트 + 외부 import) 보존을 위해 로컬 바인딩 re-export.
export { parseWorktreeList };

const CREATE_PR_ACTIVE_TTL_MS = 30 * 60 * 1000; // 30 min — /create-pr 진행 중 마커
const ATTEMPT_MARKER_TTL_MS = 5 * 60 * 1000; // 5 min — 한 번 시도 후 사용자 보고/멈춤
const ESCAPE_HATCH_PATTERNS = [/^hotfix\//, /^hotfix-/];

// Layer 2 staleness 임계 (사용자 결정 부재 — AI default; R-CM-033 #6 패턴, 운영 후 조정).
// 측정은 **이미 fetch 된 origin/main** 기준 (네트워크 호출 X — Stop hook 비용 회피).
// worktree-new.mjs 가 첫 진입 시 fetch 하므로 baseline 신선. 시간 경과로 stale 가시화.
export const STALENESS_BEHIND_THRESHOLD = 20;
export const STALENESS_AGE_DAYS_THRESHOLD = 7;

/**
 * 파일 mtime freshness 검사. 부재 / stat 실패 → false.
 */
export function isFresh(absPath, ttlMs) {
  if (!existsSync(absPath)) return false;
  try {
    const ageMs = Date.now() - statSync(absPath).mtime.getTime();
    return ageMs <= ttlMs;
  } catch {
    return false;
  }
}

export function isEscapeHatchBranch(branch) {
  if (!branch) return false;
  return ESCAPE_HATCH_PATTERNS.some((p) => p.test(branch));
}

/**
 * worktree 의 unmerged commit 수.
 *   - origin/main 우선, 부재 시 main fallback.
 *   - git rev-list 실패 → 0 (보수적, fail-open 으로 false negative).
 */
export function countUnmergedCommits(worktreePath) {
  for (const base of ['origin/main', 'main']) {
    const out = safeGit(`rev-list --count ${base}..HEAD`, worktreePath, { timeout: 3000 });
    if (out !== null && /^\d+$/.test(out.trim())) return parseInt(out.trim(), 10);
  }
  return 0;
}

/**
 * worktree 의 uncommitted 변경 수.
 *   - tracked 수정 + untracked 파일 포함
 *   - git status 실패 → 0 (fail-open)
 */
export function countUncommittedChanges(worktreePath) {
  const out = safeGit('status --porcelain --untracked-files=all', worktreePath, { timeout: 3000 });
  if (out === null) return 0;
  if (!out.trim()) return 0;
  return out.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * worktree base freshness 측정 (Layer 2 — 측정만, 차단 추가 X).
 *   - behind: HEAD 가 origin/main 에서 얼마나 뒤쳐졌나 (commit 개수)
 *   - merge_base_age_days: merge-base(HEAD, origin/main) commit 의 경과 일수
 *   - origin/main 없으면 main fallback. 둘 다 없으면 null (측정 불가 — fail-open).
 *   - 네트워크 호출 안 함 — 이미 fetch 된 ref 기준. Stop hook 비용 회피.
 */
export function measureStaleness(worktreePath, opts = {}) {
  const _safeGit = opts._safeGit || safeGit;
  const _now = opts._now || Date.now;
  for (const base of ['origin/main', 'main']) {
    const behindOut = _safeGit(`rev-list --count HEAD..${base}`, worktreePath, { timeout: 3000 });
    if (behindOut === null || !/^\d+$/.test(behindOut.trim())) continue;
    const mergeBaseOut = _safeGit(`merge-base HEAD ${base}`, worktreePath, { timeout: 3000 });
    if (mergeBaseOut === null || !mergeBaseOut.trim()) continue;
    const tsOut = _safeGit(`log -1 --format=%ct ${mergeBaseOut.trim()}`, worktreePath, {
      timeout: 3000,
    });
    if (tsOut === null || !/^\d+$/.test(tsOut.trim())) continue;
    const tsSec = parseInt(tsOut.trim(), 10);
    const ageDays = Math.floor((_now() / 1000 - tsSec) / 86400);
    return {
      base,
      behind: parseInt(behindOut.trim(), 10),
      merge_base_age_days: ageDays,
    };
  }
  return null;
}

/**
 * staleness 측정 결과를 임계와 비교. 임계 초과 시 reason 배열 반환, 아니면 [].
 */
export function evaluateStaleness(staleness) {
  if (!staleness) return [];
  const reasons = [];
  if (staleness.behind > STALENESS_BEHIND_THRESHOLD) {
    reasons.push(`behind ${staleness.behind} commits (>${STALENESS_BEHIND_THRESHOLD})`);
  }
  if (staleness.merge_base_age_days > STALENESS_AGE_DAYS_THRESHOLD) {
    reasons.push(
      `base ${staleness.merge_base_age_days}d old (>${STALENESS_AGE_DAYS_THRESHOLD}d)`,
    );
  }
  return reasons;
}

/**
 * 시도 마커 경로. branch 의 슬래시는 `__` 로 치환 (filename safe).
 */
export function attemptMarkerPath(projectDir, branch) {
  const safe = (branch || 'unknown').replace(/[\/\\]/g, '__');
  return join(projectDir, '.tmp', `worktree-shipping-attempted-${safe}`);
}

export function touchAttemptMarker(projectDir, branch) {
  const path = attemptMarkerPath(projectDir, branch);
  try {
    mkdirSync(join(projectDir, '.tmp'), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop hook 핵심 판정.
 *   @param {string} projectDir - main repo path
 *   @returns {{ block: boolean, candidates: Array<{path, branch, commits, uncommitted, commit_required?: boolean}>, reason: string }}
 */
/**
 * worktree 안에 PLAN.md 가 존재하는지 검사 (M1 — stop loop 회피용 사전 안내).
 *   ship-worktree 는 PLAN.md 미존재 시 거부 → 5분 마커 후 재차단 무한 반복 위험.
 *   본 검사는 BLOCK 메시지에 plan_missing 정보를 실어 AI 가 자동 작성하도록 유도.
 */
export function isPlanPresent(worktreePath, opts = {}) {
  const _existsSync = opts._existsSync || existsSync;
  // PLAN.md 위치: .tmp/worktree-<safeBranch>/PLAN.md (worktree-plan-path.mjs SSOT).
  // 기존 worktree 루트 PLAN.md 는 머지 누출 차단 위해 폐기.
  return _existsSync(resolveWorktreePlanPath(worktreePath));
}

/**
 * worktree 의 `.session-owner` 사이드카 첫 줄(session_id). 부재/실패/빈 파일 → null.
 *   R-CM-036 의 worktree-session-owner-guard.readSessionOwner 와 동일 의미. 사이드카 경로 SSOT 는
 *   worktree-plan-path.mjs#worktreeOwnerPath — hook 간 직접 import 금지(R-CM-006)라 lib 만 공유한다.
 *   `worktree-owner-tracker` (PostToolUse) 가 worktree 생성 시 1줄 기록.
 */
export function readSessionOwner(worktreePath, branch = null) {
  try {
    const id = readFileSync(worktreeOwnerPath(worktreePath, branch), 'utf-8').split('\n')[0].trim();
    return id || null;
  } catch {
    return null;
  }
}

/**
 * 본 Stop 세션이 worktree 를 소유하는지 판정 (R-CM-036 2-Layer 모델을 Stop 시점에 정합 적용).
 *   Layer 1 — cwd-confinement (session_id 무관, 결정론적): 현재 cwd 가 이 worktree 내부면 'owned'.
 *     Codex/Antigravity 는 worktree 로 cd 하여 작업하므로(cwd=worktree) 이 축으로 자기 worktree 를
 *     판정한다. session_id 가 stdin 에 없는 CLI 에서도 shipping nag 가 유지되는 핵심.
 *   Layer 2 — session_id 사이드카: `.session-owner` === 현재 session_id 면 'owned'.
 *     Some CLI sessions run from main, so the sidecar is the ownership signal.
 *     `make wt.new` leaves the sidecar, so a single session is normally 'owned'.
 *   사이드카 owner 가 존재하나 현재 session_id 와 불일치 → 'other' (타 세션 소유).
 *   둘 다 미확정(사이드카 부재 + cwd 불일치, 또는 session_id 부재) → 'orphan'.
 *
 *   판정의 목적: 타 세션/orphan worktree 의 미완료 작업으로 본 세션 Stop 을 차단하지 않는다.
 *   R-CM-036 Anti-Pattern "모든 worktree 검사 Stop hook" 의 cross-session 오차단 회피.
 *
 *   @param {string} wtPath - worktree 루트 절대 경로 (git worktree list porcelain 기준)
 *   @param {string|null} branch - branch 명 (사이드카 경로 추론용)
 *   @param {{sessionId?: string, cwd?: string, _resolveWorktreeRoot?: Function, _readSessionOwner?: Function}} opts
 *   @returns {'owned'|'other'|'orphan'}
 */
export function classifyOwnership(wtPath, branch, opts = {}) {
  const _resolveWorktreeRoot = opts._resolveWorktreeRoot || resolveWorktreeRoot;
  const _readSessionOwner = opts._readSessionOwner || readSessionOwner;
  const sessionId = opts.sessionId;

  // Layer 1 — cwd-confinement (결정론적, session_id 무관)
  const cwdWt = _resolveWorktreeRoot(opts.cwd || '');
  if (cwdWt && cwdWt === wtPath) return 'owned';

  // Layer 2 — session_id 사이드카
  const owner = _readSessionOwner(wtPath, branch);
  if (owner && sessionId) {
    return owner === sessionId ? 'owned' : 'other';
  }
  // 사이드카 부재(orphan) 또는 session_id 부재 → 소유 미확정
  return 'orphan';
}

export function evaluate(projectDir, opts = {}) {
  const _now = opts._now || Date.now;
  const _isFresh = opts._isFresh || isFresh;
  const _safeGit = opts._safeGit || safeGit;
  const _countUnmerged = opts._countUnmerged || countUnmergedCommits;
  const _countUncommitted = opts._countUncommitted || countUncommittedChanges;
  const _isPlanPresent = opts._isPlanPresent || ((p) => isPlanPresent(p, opts));
  const _measureStaleness =
    opts._measureStaleness || ((p) => measureStaleness(p, { _safeGit, _now }));
  // R-CM-036 세션 소유권 필터 — 본 Stop 세션이 소유하지 않는 worktree 는 차단 대상에서 제외.
  const _classifyOwnership =
    opts._classifyOwnership ||
    ((wtPath, branch) => classifyOwnership(wtPath, branch, { sessionId: opts.sessionId, cwd: opts.cwd }));

  // /create-pr 진행 중 → 통과
  const activeFlag = join(projectDir, '.tmp', 'create-pr-active');
  if (_isFresh(activeFlag, CREATE_PR_ACTIVE_TTL_MS)) {
    return { block: false, candidates: [], skipped_attempt: [], not_owned: [], reason: 'create-pr-active 신선' };
  }

  // worktree 목록
  const wtOut = _safeGit('worktree list --porcelain', projectDir, { timeout: 3000 });
  if (wtOut === null) {
    return { block: false, candidates: [], skipped_attempt: [], not_owned: [], reason: 'worktree list 실패' };
  }

  const worktrees = parseWorktreeList(wtOut);
  const candidates = [];
  const skipped_attempt = []; // M3 — 마커 신선으로 인해 skip된 worktree (사용자 인지용)
  const not_owned = []; // R-CM-036 — 타 세션/orphan 소유라 차단하지 않은 worktree (사용자 인지용)

  for (const wt of worktrees) {
    if (!wt.branch) continue; // detached HEAD 무시
    if (wt.branch === 'main') continue; // main 자체 worktree 는 본 hook 대상 아님
    if (isEscapeHatchBranch(wt.branch)) continue; // escape hatch
    if (wt.path === projectDir) continue; // main repo 자체

    const uncommitted = _countUncommitted(wt.path);
    const commits = _countUnmerged(wt.path);
    if (commits === 0 && uncommitted === 0) continue;

    // R-CM-036 세션 소유권 — 본 세션이 소유하지 않는 worktree(타 세션/orphan)는 차단하지 않는다.
    // (멀티세션 cross-session 오차단 회피. owned 만 candidate 진입.)
    const ownership = _classifyOwnership(wt.path, wt.branch);
    if (ownership !== 'owned') {
      not_owned.push({ path: wt.path, branch: wt.branch, commits, uncommitted, ownership });
      continue;
    }

    const staleness = _measureStaleness(wt.path);
    const stale_reasons = evaluateStaleness(staleness);

    if (uncommitted > 0) {
      candidates.push({
        path: wt.path,
        branch: wt.branch,
        commits,
        uncommitted,
        commit_required: true,
        plan_missing: commits > 0 ? !_isPlanPresent(wt.path) : false,
        staleness,
        stale_reasons,
      });
      continue;
    }

    const marker = attemptMarkerPath(projectDir, wt.branch);
    if (_isFresh(marker, ATTEMPT_MARKER_TTL_MS)) {
      // 이미 한 번 시도 — passthrough but 사용자 인지 위해 누적 (M3)
      skipped_attempt.push({
        path: wt.path,
        branch: wt.branch,
        commits,
        uncommitted,
        staleness,
        stale_reasons,
      });
      continue;
    }

    candidates.push({
      path: wt.path,
      branch: wt.branch,
      commits,
      uncommitted,
      commit_required: false,
      plan_missing: !_isPlanPresent(wt.path), // M1
      staleness,
      stale_reasons,
    });
  }

  if (candidates.length === 0) {
    return { block: false, candidates: [], skipped_attempt, not_owned, reason: 'no unmerged worktree' };
  }

  return {
    block: true,
    candidates,
    skipped_attempt,
    not_owned,
    reason: `${candidates.length} worktree(s) need completion`,
  };
}

/**
 * worktree path 를 projectDir 기준 상대 경로로 변환. 외부 경로면 절대 그대로.
 */
function relativizePath(absPath, projectDir) {
  return absPath.startsWith(projectDir) ? absPath.slice(projectDir.length + 1) : absPath;
}

export function buildBlockMessage(projectDir, candidates) {
  const lines = [
    '[worktree-shipping-guard] Stop 차단: 완료되지 않은 worktree 작업이 있습니다.',
    '',
    '사용자 정책 (R-CM-030): worktree 에서 시스템 코드 변경을 수행했다면 최종 응답 전 반드시 commit 을 남겨야 합니다.',
    'commit 된 작업은 사용자 컨펌 후 /create-pr ship-worktree → squash merge → cleanup 까지 진행되어야 합니다.',
    '',
    '대상 worktree:',
  ];
  for (const c of candidates) {
    const rel = relativizePath(c.path, projectDir);
    const planTag = c.plan_missing ? ' [PLAN.md 부재 — 자동 작성 필요]' : '';
    const dirtyTag = c.uncommitted > 0 ? `, uncommitted=${c.uncommitted} file(s)` : '';
    const actionTag = c.commit_required ? ' [commit 필요]' : '';
    lines.push(`  - ${rel}  (branch=${c.branch}, unmerged=${c.commits} commit${dirtyTag})${actionTag}${planTag}`);
  }
  if (candidates.some((c) => c.commit_required)) {
    lines.push('');
    lines.push('uncommitted 변경이 있는 worktree 는 작업 완료로 간주하지 않습니다.');
    lines.push('먼저 본인이 만든 변경만 stage/commit 하세요:');
    lines.push('');
    for (const c of candidates.filter((item) => item.commit_required)) {
      lines.push(`  cd "${relativizePath(c.path, projectDir)}"`);
      lines.push('  git status --short');
      lines.push('  git add <owned-files-only>');
      lines.push('  git commit -m "<Conventional Commits>"');
    }
  }
  if (candidates.some((c) => c.plan_missing)) {
    lines.push('');
    lines.push('PLAN.md 부재 worktree (M1 stop loop 회피):');
    lines.push('  - ship-worktree 는 PLAN.md 미체크박스 검증을 자체 수행 — PLAN.md 부재 시 거부.');
    lines.push('  - 위치: `.tmp/worktree-<safeBranch>/PLAN.md` (worktree 루트 아님, R-CM-008/R-CM-030 — 머지 누출 차단).');
    lines.push('  - 위 worktree 에 PLAN.md 를 먼저 작성 (목표 / 체크리스트 / 검증 / handoff) 후 ship 호출.');
    lines.push('  - 또는 사용자에게 작업 의도 확인 후 worktree 자체 폐기.');
  }
  lines.push('');
  lines.push('commit 이 이미 있는 worktree 는 먼저 사용자에게 PR/merge 진행 여부를 확인하세요.');
  lines.push('사용자가 "yes" / "진행" 으로 명시 컨펌한 후에만 다음 명령을 실행합니다 (멱등 — 이미 PR 있으면 재사용):');
  lines.push('');
  lines.push('  질문: PR을 생성하고 squash merge 후 worktree/branch/stash cleanup까지 진행할까요?');
  lines.push('');
  for (const c of candidates.filter((item) => item.commits > 0 && !item.commit_required)) {
    const rel = relativizePath(c.path, projectDir);
    lines.push(`  # Verify PLAN.md checklist in "${rel}" before shipping.`);
    lines.push(`  node .claude/scripts/mark-pre-ship-confirmed.mjs "${c.branch}" --quality self_review_pass`);
    lines.push(`  # Then open the PR and merge only after user confirmation.`);
  }
  // Layer 2 — base staleness 경고 (BLOCK 추가 X — ship 시점 non-FF 가 차단 담당)
  const stale = candidates.filter((c) => Array.isArray(c.stale_reasons) && c.stale_reasons.length);
  if (stale.length > 0) {
    lines.push('');
    lines.push('base freshness 경고 (Layer 2 — 차단 X, 사후 게이트는 ship-worktree non-FF 검사):');
    for (const c of stale) {
      lines.push(`  - ${relativizePath(c.path, projectDir)}: ${c.stale_reasons.join(', ')}`);
    }
    lines.push('  → 다음 worktree 부터 표준 진입점 사용: make wt.new BR=<branch> (또는 node .claude/scripts/worktree-new.mjs --branch <branch>)');
    lines.push('  → 현 worktree 는 ship 직전 rebase 권장: git fetch origin main && git rebase origin/main');
  }
  lines.push('');
  lines.push('이번 한 번 시도 후 pending/실패 시 본 hook 은 다음 Stop 을 통과시킵니다 (5분간 재차단 안 함).');
  lines.push('hotfix/* 브랜치 worktree 는 면제됩니다.');
  return lines.join('\n');
}

/**
 * M3 — 마커 신선으로 passthrough 처리된 worktree 가 있으면 stderr 알림.
 *   사용자가 "ship 미수행 + 5분 재차단 안 함" 상태를 인지하지 못해 silently 진행되는
 *   함정 차단. settings.json hook 의 stderr 는 사용자에게 노출되지만 Claude 컨텍스트에는
 *   영향 없음 — 정확히 의도된 채널.
 */
export function emitSkippedAttemptNotice(skipped, write = (m) => process.stderr.write(m)) {
  if (!Array.isArray(skipped) || skipped.length === 0) return;
  const lines = ['[worktree-shipping-guard] passthrough — 5분 시도 마커 신선 (재차단 안 함):'];
  for (const c of skipped) {
    const staleTag =
      Array.isArray(c.stale_reasons) && c.stale_reasons.length
        ? ` [stale: ${c.stale_reasons.join(', ')}]`
        : '';
    lines.push(`  - branch=${c.branch}, unmerged=${c.commits} commit (path=${c.path})${staleTag}`);
  }
  lines.push('  → 마커 만료 후 자동 재차단. 즉시 처리하려면 마커 삭제 + 재진입.');
  write(`${lines.join('\n')}\n`);
}

/**
 * R-CM-036 — 본 세션이 소유하지 않는(타 세션/orphan) worktree 가 미완료 작업을 가졌으나
 *   차단하지 않은 경우 stderr 알림. silent drop 차단 — 다른 세션의 WIP 를 본 세션이
 *   조용히 무시하지 않고 사용자에게 가시화한다 (block 여부와 무관하게 항상 호출).
 *   stderr 는 사용자에게 노출되지만 Claude 컨텍스트에는 영향 없음 — 의도된 채널.
 */
export function emitNotOwnedNotice(notOwned, write = (m) => process.stderr.write(m)) {
  if (!Array.isArray(notOwned) || notOwned.length === 0) return;
  const lines = [
    '[worktree-shipping-guard] passthrough — 본 세션 소유가 아닌 worktree 의 미완료 작업 (차단 안 함, R-CM-036):',
  ];
  for (const c of notOwned) {
    const dirty = c.uncommitted > 0 ? `, uncommitted=${c.uncommitted} file(s)` : '';
    const tag = c.ownership === 'other' ? '타 세션 소유' : 'orphan (소유 세션 미상)';
    lines.push(`  - branch=${c.branch}, unmerged=${c.commits} commit${dirty} [${tag}] (path=${c.path})`);
  }
  lines.push('  → 해당 worktree 를 만든 세션에서 ship 하거나, 본인 작업이면 그 worktree 안에서 진행하세요.');
  write(`${lines.join('\n')}\n`);
}

export async function run(data) {
  try {
    if (isUserAbort(data) || isContextLimitStop(data)) {
      return HookOutput.passthrough();
    }
    const projectDir = resolveProjectDir(data);
    // session_id / cwd 는 모든 hook 이벤트 공통 stdin 필드 (Stop 포함, 공식 문서) — R-CM-036 소유권 판정 입력.
    const verdict = evaluate(projectDir, { sessionId: data?.session_id, cwd: data?.cwd });

    // R-CM-036 — 타 세션/orphan worktree 의 미완료 작업은 block/passthrough 무관하게 항상 알림
    emitNotOwnedNotice(verdict.not_owned);

    // M3 — passthrough 케이스에서도 시도 마커 신선으로 skip된 항목 있으면 사용자 알림
    if (!verdict.block) {
      emitSkippedAttemptNotice(verdict.skipped_attempt);
      return HookOutput.passthrough();
    }

    // 한 번만 시도 — ship 대상에만 마커 즉시 생성 (다음 Stop 은 5분간 통과).
    // uncommitted 변경은 "작업 완료 전 commit" 의무이므로 마커로 통과시키지 않는다.
    for (const c of verdict.candidates) {
      if (!c.commit_required) touchAttemptMarker(projectDir, c.branch);
    }
    return HookOutput.block(buildBlockMessage(projectDir, verdict.candidates));
  } catch {
    return HookOutput.passthrough();
  }
}

if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMainWithProfile('worktree-shipping-guard', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
