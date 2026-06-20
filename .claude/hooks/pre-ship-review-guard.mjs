#!/usr/bin/env node

/**
 * pre-ship-review-guard.mjs - PreToolUse Bash Hook
 *
 * `gh pr merge` 호출 직전에 Pre-Ship Human Review Panel
 * 컨펌 마커가 신선한지 검증. 부재 시 deny + 패널 의무 안내.
 *
 * 정책: AGENTS.md "Conventions & gotchas" ship-flow + docs/retros/retro-2026-06-20-orphaned-ship-gate.md
 * (R-CM-030 worktree-auto-ship.md 는 brief2dev 제거로 삭제 — ship 진입점이 ops.mjs ship-* → gh pr merge 로 이동).
 *
 * 동작:
 *   - tool_name != Bash → passthrough
 *   - command 가 `gh pr merge` 패턴 아님 → passthrough
 *   - 마커 (.tmp/pre-ship-review-confirmed-<branch>) 신선 (10분) → passthrough (allow)
 *   - 마커 부재/stale → deny + AI 에게 Human Review Panel + 사용자 컨펌 + 마커 생성 안내
 *   - error → passthrough (R-CM-006 Rule 2 fail-open)
 *
 * 마커 생성 책임:
 *   AI 가 7섹션 Human Review Panel + 사용자 "진행" 컨펌 받은 직후
 *   `node .claude/scripts/mark-pre-ship-confirmed.mjs <branch> --quality <label>` 실행.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  readStdin,
  output,
  safeHookMainWithProfile,
  resolveProjectDir,
} from '../scripts/lib/utils.mjs';
import { HookOutput } from '../scripts/lib/hook-output.mjs';
import { VALID_QUALITY_LABELS } from '../scripts/lib/quality-gate-labels.mjs';

const MARKER_TTL_MS = 10 * 60 * 1000; // 10분 — 사용자 컨펌 후 ship 호출까지 충분
import { CMD_ANCHOR_SRC } from '../scripts/lib/hook-anchors.mjs';

// 현재 ship 진입점 `gh pr merge` 만 매칭 (create-pr/ops.mjs 제거 후 재포인트, 2026-06-20).
// `merge` 만 — `gh pr create` 는 가역(PR close 가능)이라 제외하고, 불가역(main 머지)인 merge
// 만 게이트한다. `gh pr view/list/checks/diff/comment/edit/...` read-only 서브커맨드는
// false-block 금지: anchor (명령 시작 / chain operator / newline 직후) + `merge\b` 로 분리해
// quoted string / grep / echo 안의 "gh pr merge" 까지 false-positive 매칭하던 회귀를 차단
// (과거 ops.mjs `\bops\.mjs\b` false-positive, PR #493). anchor SSOT = hook-anchors.mjs.
// ⚠️ COUPLING (orphaned-guard-trigger 재발 주의): 본 패턴은 ship 진입점 커맨드 문자열
//    (`gh pr merge`) 에 결합돼 있다. ship 이 새 skill/커맨드로 이동하면 이 트리거는 error
//    가 아니라 *조용히* passthrough 로 죽는다 — 바로 ops.mjs 제거 때 실제 발생한 실패 모드.
//    이 패턴을 바꾸는 사람은 ship 진입점을 함께 확인하라. dead-trigger 자동 감지는
//    docs/retros/retro-2026-06-20-orphaned-ship-gate.md 의 ## Next.
const SHIP_PATTERN = new RegExp(CMD_ANCHOR_SRC + 'gh\\s+pr\\s+merge\\b');
const WORKTREE_ARG = /--worktree[\s=]+["']?([^"'\s]+)["']?/;
// chain operator: && / || / ; — 명령 chain 만 검출. standalone pipe `|` 는 제외
// (output filtering — `cmd 2>&1 | tail` — marker touch (file write) 와 무관).
// `&` background 도 제외 — ship 호출은 foreground 의도라 background 사용은 비정상.
// chain 만 검출하는 이유: marker touch + ship 호출이 같은 chain 안에 있으면 hook 평가
// 시점 marker 미반영 위험 — pipe 는 stdout transfer 라 marker file write 와 무관.
const CHAIN_PATTERN = /&&|\|\||;/;

// Bash heredoc body 제거 — `<<EOF...EOF` 안 텍스트는 *데이터* 이지 *호출 컨텍스트* 가
// 아니므로 SHIP_PATTERN / CHAIN_PATTERN 검사 대상에서 제외해야 한다.
// lib SSOT — destructive-git-guard 등 다른 hook 도 동일 lib 직접 import.
import { stripHeredocBodies } from '../scripts/lib/heredoc-strip.mjs';

export function isShipCommand(command) {
  return typeof command === 'string' && SHIP_PATTERN.test(stripHeredocBodies(command));
}

export function isChainedCommand(command) {
  return typeof command === 'string' && CHAIN_PATTERN.test(stripHeredocBodies(command));
}

// SSOT: branch parsing + escape 변형 정규화 + 마커 경로는 worktree-plan-path.mjs.
// 본 hook 은 marker key 산출에 같은 정규화 결과를 사용해야 worktree-shipping-guard +
// mark-pre-ship-confirmed.mjs (CLI) 와 일관된 branch 식별자 + 마커 경로가 보장된다.
import {
  safeBranchKey,
  inferBranchFromWorktreePath,
  preShipMarkerPath,
} from '../scripts/lib/worktree-plan-path.mjs';
import { resolveWorktreeRoot } from '../scripts/lib/worktree-path.mjs';

export { safeBranchKey, inferBranchFromWorktreePath };

export function extractBranch(command) {
  const m = command.match(WORKTREE_ARG);
  if (!m) return null; // --worktree 인자 없음 (gh pr merge 등) → cwd 추정으로 fallback
  return inferBranchFromWorktreePath(m[1]);
}

// gh pr merge 는 `--worktree` 인자가 없으므로 cwd (worktree 경로) 에서 branch 추정.
// resolveWorktreeRoot 로 KNOWN_BRANCH_PREFIXES 정규화 후 inferBranchFromWorktreePath →
// `.worktrees/fix/foo/sub` 같은 하위 cwd / single-segment branch 모두 정확히 처리.
// cwd 가 worktree 밖(main root 등)이면 null → staged 마커로 처리 (기존 ship-feature 모드와 동일).
export function inferBranchFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const root = resolveWorktreeRoot(cwd);
  return root ? inferBranchFromWorktreePath(root) : null;
}

export const markerPath = preShipMarkerPath;

export function isFresh(absPath, ttlMs) {
  if (!existsSync(absPath)) return false;
  try {
    return Date.now() - statSync(absPath).mtime.getTime() <= ttlMs;
  } catch {
    return false;
  }
}

// Quality Gate label enum SSOT: `scripts/lib/quality-gate-labels.mjs` (import 위).
// mark-pre-ship-confirmed.mjs (발행자) + 본 hook (검증자) 가 같은 Set 인스턴스 공유 →
// 새 라벨 추가 시 양쪽 동시 반영 (R-CM-024 회귀 차단).
// 회고 #1 회귀 차단: marker 파일에 quality_gate 라벨 영속화 → hook 검증 → silent skip 차단.

/**
 * marker 파일에서 quality_gate 라벨 추출. JSON parse + enum 검증.
 *
 * Fail-open 정책 (R-CM-006 Rule 2): ENOENT (부재) 만 null 반환. readFileSync 의
 * I/O 오류 (EACCES / ENFILE 등) 는 throw — caller (run()) 의 외부 try/catch 가
 * 잡아 passthrough 반환. invalid JSON / enum 외 / empty 는 의도된 deny 사유.
 *
 * @param {string} absPath
 * @returns {string|null} 유효 label 또는 null (부재 / empty / invalid JSON / enum 외)
 * @throws I/O 오류 (호출자 fail-open 처리 의무)
 */
export function readMarkerQualityLabel(absPath) {
  if (!existsSync(absPath)) return null; // ENOENT — 정상 부재
  const content = readFileSync(absPath, 'utf-8').trim(); // I/O 오류 시 throw → 외부 catch passthrough
  if (!content) return null; // empty marker (legacy) — deny 의도
  try {
    const parsed = JSON.parse(content);
    const label = parsed?.quality_gate;
    return typeof label === 'string' && VALID_QUALITY_LABELS.has(label) ? label : null;
  } catch {
    return null; // invalid JSON — deny 의도
  }
}

/**
 * helper script (mark-pre-ship-confirmed.mjs) 의 적절한 절대 경로 산출.
 *
 * Why: helper 자체가 새 feature branch 의 PR 진행 중일 수 있어 main 에는 아직 없고
 * worktree 안에만 존재할 수 있음. 그 시나리오에서 deny 메시지가 main 경로만 안내하면
 * AI 가 "Cannot find module" 에러를 만남 (2026-05-15 세션 실측). main → worktree
 * 순서로 fs.existsSync 검사 후 가장 적절한 경로 반환.
 *
 * Fail-soft: fs 접근 실패 시 main 경로 default (helper 없으면 fallback 명령 안내가 별도로 존재).
 *
 * Export 사유 (test coverage): real-fs 단위 테스트 (mkdtempSync 격리) 로 4 분기
 * (main 존재 / 2-seg worktree / 1-seg worktree / fallback) 직접 검증.
 */
export function resolveHelperPath(projectDir, cwd) {
  const HELPER_REL = '.claude/scripts/mark-pre-ship-confirmed.mjs';
  const mainPath = join(projectDir, HELPER_REL);
  try {
    if (existsSync(mainPath)) return mainPath;
  } catch {
    return mainPath;
  }
  // main 부재 → cwd 가 worktree 안이면 worktree 경로 시도.
  // worktree path 컨벤션 2가지 모두 지원:
  //   - 2 segment: .worktrees/feature/foo (GitHub Flow prefix/name)
  //   - 1 segment: .worktrees/hotfix-123 (single-segment branch)
  if (cwd && cwd.includes('/.worktrees/')) {
    const idx = cwd.indexOf('/.worktrees/');
    const after = cwd.substring(idx + '/.worktrees/'.length);
    const segments = after.split('/').filter(Boolean);
    // 2 segment 우선 시도 (GitHub Flow)
    for (const len of [2, 1]) {
      if (segments.length >= len) {
        const worktreeRoot =
          cwd.substring(0, idx) + '/.worktrees/' + segments.slice(0, len).join('/');
        const wtPath = join(worktreeRoot, HELPER_REL);
        try {
          if (existsSync(wtPath)) return wtPath;
        } catch {
          // fall-through to next len or main default
        }
      }
    }
  }
  return mainPath;
}

function buildDenyMessage(branch, safeKey, projectDir, cwd, chained, reason = 'marker_absent') {
  const helperPath = resolveHelperPath(projectDir, cwd);
  const header =
    reason === 'quality_label_missing'
      ? '[pre-ship-review-guard] ship 호출 차단: marker 의 quality_gate 라벨 부재/무효'
      : '[pre-ship-review-guard] ship 호출 차단: Pre-Ship Human Review Panel 미컨펌';
  const lines = [
    header,
    '',
    ...(reason === 'quality_label_missing'
      ? [
          'R-CM-030 Rule 8 Pre-Ship Quality Gate: marker 파일에 quality_gate 라벨 영속화 필수.',
          'silent skip 차단 (회고 #1 — 당시 명칭 simplify agent 누락 누적 2회. 2026-05-27 사용자 결정으로 /simplify 완전 폐기 + simplifit 스킬 deprecate 후 /code-review 단일 진입점).',
          '',
          'helper CLI 의 --quality <label> 인자 누락 시 발생합니다.',
          '  label 종류:',
          '    agent_go         — /code-review --fix + code-reviewer agent 둘 다 Go',
          '    self_review_pass — agent 호출 실패/skip 시 자가 점검 통과 (Panel Decisions 사유 명시)',
          '    trivial_skip     — R-CM-030 Rule 10 trivial (≤2 파일 + ≤20 LOC + non-substantive)',
          '',
          '재시도:',
          `  node ${helperPath} ${branch || '--staged'} --quality <label>`,
          '',
        ]
      : []),
    ...(chained
      ? [
          '⚠️ chained command 감지 (&& / || / ;). hook 은 명령 *시작 시점* 에 평가하므로,',
          '   같은 chain 안 marker touch 가 실행돼도 hook 평가에 반영되지 않습니다.',
          '   → marker 생성 (touch 또는 mark-pre-ship-confirmed.mjs CLI) 과 ship 호출을',
          '   **별도 Bash call 로 분리** 후 재시도하세요.',
          '',
        ]
      : []),
    // marker_absent 시: Human Review Panel + 마커 생성 절차 안내 (정상 신규 진입)
    // quality_label_missing 시: 위 quality_label_missing 섹션 만으로 충분 — touch fallback /
    //   `--quality` 없는 helper 명령어 노출은 무한 deny 루프 회피용 차단 (HIGH #1)
    ...(reason !== 'quality_label_missing'
      ? [
          'AGENTS.md ship-flow 에 따라 `gh pr merge` (불가역 main 머지) 호출 직전에는',
          '사람이 merge 여부를 판단할 수 있는 7섹션 의사결정 브리프를 먼저 제공해야 합니다.',
          '단독 질문("ship으로 PR을 머지하겠습니까?")만으로는 컨펌을 받은 것으로 보지 않습니다.',
          '',
          '진행 절차:',
          '  1. 7섹션 Human Review Panel 작성 후 사용자에게 제공:',
          '     - Summary: 무엇을 왜 수정했는지 3-5줄로 요약',
          '     - Evidence: commit 수, triple-dot diff stat, 테스트/품질 게이트 실행 결과',
          '     - Changed Files: path / NEW·EDIT·DELETE / LOC / 역할 / 수정 이유 표',
          '     - File Structure: 수정된 파일의 디렉터리 트리와 책임 경계',
          '     - Impact: 다음 세션/사용자/CI/hook/문서/데이터 SSOT에 생기는 변화',
          '     - Decisions & Trade-offs: 사용자 결정, AI default, 대안, 선택 이유, 품질 판정',
          '     - Risks, Follow-up & Rollback: 주의사항, 우려, 향후 액션, deferred 항목, 롤백',
          '     권장 수집 명령:',
          '       git log --oneline origin/main..HEAD',
          '       git diff origin/main...HEAD --stat',
          '       git diff origin/main...HEAD --name-status',
          '       git diff origin/main...HEAD --numstat',
          '  2. 사용자 컨펌 받기:',
          '     - Claude Code native: AskUserQuestion 으로 "진행" / "멈춤" / "수정 필요" 선택',
          '     - Codex/Gemini/file mode: Decision Exchange 또는 일반 채팅으로 같은 3선택 확인',
          '  3. "진행" 선택 시 다음 마커 생성 (10분 freshness):',
          `     node ${helperPath} ${branch || '--staged'} --quality <label>`,
          `     (cwd 어디서 호출해도 main root 의 .tmp/ 에 마커 생성. helper 경로는 fs 검사로 자동 선택)`,
          `     label 종류: agent_go / self_review_pass / trivial_skip (helper --help 또는 본 PR Decisions 섹션 참조)`,
          '  4. 그 다음 `gh pr merge` 재실행 (worktree 안에서 실행하면 branch 자동 추정)',
          '',
        ]
      : []),
    branch
      ? `대상 branch: ${branch}`
      : '주의: cwd 가 worktree 밖이거나 branch 추정 실패 (branch=staged 처리) — gh pr merge 는 worktree 안에서 실행 권장',
    '',
    `marker key: ${safeKey}`,
    'trivial 변경 (≤3 파일 / ≤50 LOC / 코드 무영향) 도 7섹션 헤더는 유지 — 내용만 축약.',
    '한계: 본 hook 은 마커 존재 + label 검증만. AI 가 패널 없이 마커 생성 후 호출 시 우회 가능.',
    '       → 사용자 retroactive 발견 시 ship-review 우회로 보고.',
  ];
  return lines.join('\n');
}

export async function run(data) {
  try {
    if (data?.tool_name !== 'Bash') return HookOutput.passthrough();
    const command = data?.tool_input?.command || '';
    // strip 1회 후 두 패턴 직접 검사 (isShipCommand + isChainedCommand 중복 strip 회피).
    const stripped = stripHeredocBodies(command);
    if (!SHIP_PATTERN.test(stripped)) return HookOutput.passthrough();

    const projectDir = resolveProjectDir(data);
    // gh pr merge 는 --worktree 인자가 없어 extractBranch=null → cwd(worktree 경로) 에서 추정.
    const branch = extractBranch(command) || inferBranchFromCwd(data?.cwd);
    const safeKey = safeBranchKey(branch);
    const path = markerPath(projectDir, branch);

    const chained = CHAIN_PATTERN.test(stripped);
    if (isFresh(path, MARKER_TTL_MS)) {
      // marker 신선 + 라벨 검증 (회고 #1 회귀 차단)
      const label = readMarkerQualityLabel(path);
      if (label) return HookOutput.passthrough();
      return HookOutput.deny(
        buildDenyMessage(
          branch,
          safeKey,
          projectDir,
          data?.cwd,
          chained,
          'quality_label_missing',
        ),
      );
    }
    return HookOutput.deny(
      buildDenyMessage(branch, safeKey, projectDir, data?.cwd, chained),
    );
  } catch {
    return HookOutput.passthrough();
  }
}

if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMainWithProfile('pre-ship-review-guard', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
