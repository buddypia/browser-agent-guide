#!/usr/bin/env node

/**
 * worktree-review-report-guard.mjs — Stop Hook
 *
 * 본 세션이 소유한 worktree 에 **commit 된 작업(unmerged ≥ 1)** 이 있는데, 사람이
 * 리뷰할 수 있는 구조화 레포트(`REVIEW.md`)가 부재 / 미완성 / stale 이면 Stop 을 BLOCK 한다.
 * = "worktree 에서 작업이 끝났으면, 사람이 리뷰할 본문을 반드시 출력해야 한다" 의 결정론적 강제.
 *
 * 정책 SSOT: R-CM-030 (worktree-auto-ship.md) — "Worktree Review Report Gate" 절.
 *   기존 `pre-ship-review-guard` 는 마커 *존재만* 검사하여 "패널 없이 마커 생성 후 ship" 우회가
 *   가능했다 (룰의 "한계 (정직 명시)"). 본 hook 은 그 갭을 REVIEW.md 본문 검증으로 닫는다.
 *
 * 검증 대상 artifact: `<worktree>/.tmp/worktree-<safeBranch>/REVIEW.md` (review-report.mjs SSOT).
 *   `.tmp/` 는 `.gitignore` 로 머지 누출이 봉쇄되며, REVIEW.md 작성은 worktree 의 tracked diff /
 *   uncommitted 상태에 영향을 주지 않는다 (shipping-guard 와 직교).
 *
 * 동작:
 *   - user abort / context limit → passthrough (사용자 명시 중단 존중)
 *   - .tmp/create-pr-active 신선(30min) → passthrough (/create-pr 진행 중)
 *   - 본 세션 소유(owned, R-CM-036) + uncommitted == 0 + unmerged ≥ 1 + REVIEW.md invalid → BLOCK
 *   - uncommitted > 0 인 worktree → skip (먼저 commit — worktree-shipping-guard 담당)
 *   - 타 세션 / orphan 소유 worktree → 차단 안 함 (cross-session 오차단 회피, stderr 알림)
 *   - error → passthrough (R-CM-006 Rule 2 fail-open)
 *
 * 의도된 설계 (shipping-guard 와 다름):
 *   "한 번 시도 후 통과(5분 마커)" 같은 give-up 마커를 두지 않는다 — 강제 의도. REVIEW.md 가
 *   완성되면 자연히 통과하며, deadlock backstop 은 Claude 의 8연속 block 상한 + fail-open 이다.
 *   긴급 비활성화는 `ECC_DISABLED_HOOKS=worktree-review-report-guard` (safeHookMainWithProfile).
 *
 * 세션 소유권(R-CM-036, 2-Layer): Stop stdin 의 session_id + cwd. Layer 1 = cwd 가 worktree 내부,
 *   Layer 2 = `.session-owner` 사이드카 === session_id. hook 간 직접 import 금지(R-CM-006)라
 *   worktree-shipping-guard 와 같은 lib(worktree-path / worktree-plan-path)만 공유한다.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
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
import { parseWorktreeList, worktreeOwnerPath } from '../scripts/lib/worktree-plan-path.mjs';
import { resolveWorktreeRoot } from '../scripts/lib/worktree-path.mjs';
import {
  REQUIRED_SECTIONS,
  resolveReviewReportPath,
  validateReport,
} from '../scripts/lib/review-report.mjs';

const CREATE_PR_ACTIVE_TTL_MS = 30 * 60 * 1000; // 30 min — /create-pr 진행 중 마커 (shipping-guard 정합)
const ESCAPE_HATCH_PATTERNS = [/^hotfix\//, /^hotfix-/];

export function isEscapeHatchBranch(branch) {
  if (!branch) return false;
  return ESCAPE_HATCH_PATTERNS.some((p) => p.test(branch));
}

/**
 * 파일 mtime freshness 검사. 부재 / stat 실패 → false. (shipping-guard 와 동형이나
 * hook 간 import 금지(R-CM-006)라 로컬 정의 — 8줄, 공유 lib 도입은 과설계.)
 */
export function isFresh(absPath, ttlMs) {
  if (!existsSync(absPath)) return false;
  try {
    return Date.now() - statSync(absPath).mtime.getTime() <= ttlMs;
  } catch {
    return false;
  }
}

/**
 * worktree 의 unmerged commit 수 (origin/main 우선, main fallback). 실패 → 0 (fail-open).
 */
export function countUnmergedCommits(worktreePath, _safeGit = safeGit) {
  for (const base of ['origin/main', 'main']) {
    const out = _safeGit(`rev-list --count ${base}..HEAD`, worktreePath, { timeout: 3000 });
    if (out !== null && /^\d+$/.test(out.trim())) return parseInt(out.trim(), 10);
  }
  return 0;
}

/**
 * worktree 의 uncommitted 변경 수 (tracked 수정 + untracked, ignored 제외). 실패 → 0.
 * `.tmp/` 는 ignored 이므로 REVIEW.md 작성은 여기에 잡히지 않는다.
 */
export function countUncommittedChanges(worktreePath, _safeGit = safeGit) {
  const out = _safeGit('status --porcelain --untracked-files=all', worktreePath, { timeout: 3000 });
  if (out === null || !out.trim()) return 0;
  return out.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * worktree 의 현재 HEAD full sha. 실패 → null.
 */
export function headSha(worktreePath, _safeGit = safeGit) {
  const out = _safeGit('rev-parse HEAD', worktreePath, { timeout: 3000 });
  return out && /^[0-9a-f]{7,40}$/i.test(out.trim()) ? out.trim() : null;
}

/**
 * `.session-owner` 사이드카 첫 줄(session_id). 부재/실패 → null (R-CM-036).
 * 경로 SSOT 는 worktree-plan-path.mjs#worktreeOwnerPath (shipping-guard 와 공유).
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
 * 본 Stop 세션이 worktree 를 소유하는지 판정 (R-CM-036 2-Layer).
 * shipping-guard.classifyOwnership 와 동일 의미 — hook 간 import 금지라 lib 공유로 재구현.
 * @returns {'owned'|'other'|'orphan'}
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
  if (owner && sessionId) return owner === sessionId ? 'owned' : 'other';
  return 'orphan';
}

/**
 * worktree 의 REVIEW.md 본문을 읽는다. 부재/실패 → null.
 */
export function readReport(worktreePath, branch, _existsSync = existsSync, _readFileSync = readFileSync) {
  const path = resolveReviewReportPath(worktreePath, branch);
  try {
    if (!_existsSync(path)) return null;
    return _readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Stop hook 핵심 판정.
 * @returns {{ block: boolean, candidates: Array, not_owned: Array, reason: string }}
 */
export function evaluate(projectDir, opts = {}) {
  const _isFresh = opts._isFresh || isFresh;
  const _safeGit = opts._safeGit || safeGit;
  const _countUnmerged = opts._countUnmerged || ((p) => countUnmergedCommits(p, _safeGit));
  const _countUncommitted = opts._countUncommitted || ((p) => countUncommittedChanges(p, _safeGit));
  const _headSha = opts._headSha || ((p) => headSha(p, _safeGit));
  const _readReport = opts._readReport || ((p, b) => readReport(p, b));
  const _classifyOwnership =
    opts._classifyOwnership ||
    ((wtPath, branch) => classifyOwnership(wtPath, branch, { sessionId: opts.sessionId, cwd: opts.cwd }));

  // /create-pr 진행 중 → 통과
  const activeFlag = join(projectDir, '.tmp', 'create-pr-active');
  if (_isFresh(activeFlag, CREATE_PR_ACTIVE_TTL_MS)) {
    return { block: false, candidates: [], not_owned: [], reason: 'create-pr-active 신선' };
  }

  const wtOut = _safeGit('worktree list --porcelain', projectDir, { timeout: 3000 });
  if (wtOut === null) {
    return { block: false, candidates: [], not_owned: [], reason: 'worktree list 실패' };
  }

  const worktrees = parseWorktreeList(wtOut);
  const candidates = [];
  const not_owned = [];

  for (const wt of worktrees) {
    if (!wt.branch || wt.branch === 'main') continue;
    if (isEscapeHatchBranch(wt.branch)) continue;
    if (wt.path === projectDir) continue;

    const unmerged = _countUnmerged(wt.path);
    if (unmerged === 0) continue; // commit 된 작업 없음 — 본 gate 무관

    const uncommitted = _countUncommitted(wt.path);
    if (uncommitted > 0) continue; // 먼저 commit (worktree-shipping-guard 담당)

    const ownership = _classifyOwnership(wt.path, wt.branch);
    if (ownership !== 'owned') {
      not_owned.push({ path: wt.path, branch: wt.branch, unmerged, ownership });
      continue;
    }

    const content = _readReport(wt.path, wt.branch);
    const verdict = validateReport(content, { headSha: _headSha(wt.path) });
    if (verdict.ok) continue;

    candidates.push({
      path: wt.path,
      branch: wt.branch,
      unmerged,
      present: verdict.present,
      missing: verdict.missing,
      stale: verdict.stale,
      reportPath: resolveReviewReportPath(wt.path, wt.branch),
    });
  }

  if (candidates.length === 0) {
    return { block: false, candidates: [], not_owned, reason: 'all reviewed' };
  }
  return { block: true, candidates, not_owned, reason: `${candidates.length} worktree(s) need REVIEW.md` };
}

function relativizePath(absPath, projectDir) {
  return absPath.startsWith(projectDir) ? absPath.slice(projectDir.length + 1) : absPath;
}

function sectionTitle(key) {
  const s = REQUIRED_SECTIONS.find((x) => x.key === key);
  return s ? s.title : key;
}

export function buildBlockMessage(projectDir, candidates) {
  const lines = [
    '[worktree-review-report-guard] Stop 차단: worktree 작업 완료 — 사람이 리뷰할 REVIEW.md 가 필요합니다.',
    '',
    '사용자 정책 (R-CM-030 Worktree Review Report Gate): worktree 에서 commit 한 작업은 최종 응답 전,',
    '사람이 머지 여부를 판단할 수 있는 구조화 레포트(REVIEW.md)를 반드시 출력해야 합니다.',
    'pre-ship-review-guard 의 마커 검사만으로는 본문 출력이 보장되지 않으므로, 본 gate 가 REVIEW.md 본문을 검증합니다.',
    '',
    '대상 worktree:',
  ];
  for (const c of candidates) {
    const rel = relativizePath(c.path, projectDir);
    let why;
    if (!c.present) why = 'REVIEW.md 부재';
    else if (c.missing.length) why = `미작성 섹션: ${c.missing.map(sectionTitle).join(', ')}`;
    else if (c.stale) why = 'REVIEW.md 가 현재 HEAD 보다 오래됨 (새 commit 이후 갱신 필요)';
    else why = '미완성';
    lines.push(`  - ${rel} (branch=${c.branch}, unmerged=${c.unmerged}) — ${why}`);
    lines.push(`      REVIEW: ${relativizePath(c.reportPath, projectDir)}`);
  }
  lines.push('');
  lines.push('進め方:');
  lines.push('  1. 各 worktree の REVIEW.md に次の9セクションを記述（trivial 변경도 헤더는 유지・본문 축약可）:');
  lines.push('       Summary/概要(作業内容) · Why/なぜ · Changed Files/変更ファイル · How/作業方法 ·');
  lines.push('       Impact/影響範囲 · Trade-offs/トレードオフ · Remaining Work/残作業 ·');
  lines.push('       File Structure/フォルダー構造 · Review Requests/レビュー依頼(確認してほしい項目)');
  lines.push('     雛形生成 (任意): node .claude/scripts/mark-worktree-reviewed.mjs <branch> --scaffold');
  lines.push('  2. 記述後、現在 HEAD で stamp + 検証:');
  for (const c of candidates) {
    lines.push(`       node .claude/scripts/mark-worktree-reviewed.mjs ${c.branch}`);
  }
  lines.push('  3. REVIEW.md の要点をチャットにも提示し、ユーザーに「進行 / 停止 / 修正必要」を確認:');
  lines.push('       - Claude Code: AskUserQuestion / Codex・Gemini: 同等の3択を明示確認');
  lines.push('  4. 「進行」承認後にのみ /create-pr ship-worktree → squash merge → cleanup へ進む。');
  lines.push('');
  lines.push('注: REVIEW.md は `.tmp/` 配下(gitignore)で、tracked diff / uncommitted 状態に影響しません。');
  lines.push('hotfix/* worktree は本 gate 免除。緊急時は ECC_DISABLED_HOOKS=worktree-review-report-guard。');
  return lines.join('\n');
}

/**
 * 타 세션/orphan worktree 가 미완료(report 부재)여도 차단하지 않는다 — stderr 알림(silent drop 차단).
 */
export function emitNotOwnedNotice(notOwned, write = (m) => process.stderr.write(m)) {
  if (!Array.isArray(notOwned) || notOwned.length === 0) return;
  const lines = [
    '[worktree-review-report-guard] passthrough — 본 세션 소유가 아닌 worktree (차단 안 함, R-CM-036):',
  ];
  for (const c of notOwned) {
    const tag = c.ownership === 'other' ? '타 세션 소유' : 'orphan';
    lines.push(`  - branch=${c.branch}, unmerged=${c.unmerged} [${tag}] (path=${c.path})`);
  }
  write(`${lines.join('\n')}\n`);
}

export async function run(data) {
  try {
    if (isUserAbort(data) || isContextLimitStop(data)) return HookOutput.passthrough();
    const projectDir = resolveProjectDir(data);
    const verdict = evaluate(projectDir, { sessionId: data?.session_id, cwd: data?.cwd });
    emitNotOwnedNotice(verdict.not_owned);
    if (!verdict.block) return HookOutput.passthrough();
    return HookOutput.block(buildBlockMessage(projectDir, verdict.candidates));
  } catch {
    return HookOutput.passthrough();
  }
}

// CLI entry (import 시 미실행 — node:test 가 안전하게 export 만 import).
if (import.meta.url === `file://${process.argv[1]}`) {
  safeHookMainWithProfile('worktree-review-report-guard', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
