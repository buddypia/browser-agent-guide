#!/usr/bin/env node

/**
 * worktree-session-owner-guard.mjs - PreToolUse Edit|Write|MultiEdit|Bash Hook
 *
 * 멀티세션 환경에서 AI 세션이 **자기 세션이 만든 worktree 의 파일만** 편집·커밋하도록
 * 강제한다. 대상 파일/커밋이 속한 worktree 의 `.session-owner` 사이드카가 현재 세션
 * (`data.session_id`) 과 불일치하면 deny.
 *
 * 정책 SSOT: R-CM-036 (worktree-session-ownership.md).
 * 사이드카 기록: worktree-owner-tracker.mjs (PostToolUse Bash).
 *
 * 2-Layer 방어 (R-CM-036):
 *   Layer 1 — cwd-confinement (결정론적·orphan-proof·session_id 무관, PRIMARY):
 *     대상 worktree ≠ cwd 의 worktree → deny. 사이드카 불필요 → orphan 구멍 없음.
 *     cwd 가 main repo(worktree 밖)인데 대상이 worktree → deny (cd 안 하고 침범 = 사고 패턴).
 *   Layer 2 — session_id 사이드카 (SECONDARY, 같은 worktree path 내 다른 세션 방어):
 *     `.session-owner` 존재 & ≠ 현재 session_id → deny.
 *
 * 동작 (carve-out 은 전부 fail-open passthrough — 오차단 0 우선):
 *   - tool 이 Edit|Write|MultiEdit|Bash 아님 → passthrough
 *   - 대상이 .worktrees/ 하위 아님 (main repo 파일) → passthrough (worktree-policy-guard 영역)
 *   - Bash 가 `git commit` 아님 / `--dry-run` → passthrough
 *   - Layer 1: cwd worktree ≠ 대상 worktree → **deny** (session_id 무관 — orphan 도 차단)
 *   - Layer 2: 같은 worktree 인데 사이드카 owner ≠ session_id → **deny**
 *   - error → passthrough (R-CM-006 Rule 2 fail-open)
 *
 * Reference 패턴: worktree-policy-guard.mjs
 */

import { join, relative, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  readStdin,
  output,
  safeHookMainWithProfile,
  resolveProjectDir,
} from '../scripts/lib/utils.mjs';
import { worktreeOwnerPath } from '../scripts/lib/worktree-plan-path.mjs';
import { HookOutput } from '../scripts/lib/hook-output.mjs';
// worktree 루트 판정 = 단일 SSOT (R-CM-037). 세션축 무관 순수함수.
// 테스트는 worktree-path.mjs 에서 직접 import (re-export 의존 제거 — DEBT-183).
import { resolveWorktreeRoot } from '../scripts/lib/worktree-path.mjs';
import { extractApplyPatchFilePaths } from '../scripts/lib/apply-patch-paths.mjs';

/**
 * worktree 의 `.session-owner` 첫 줄(session_id). 부재/실패/빈 파일 → null.
 */
export function readSessionOwner(worktreeRoot) {
  try {
    const id = readFileSync(worktreeOwnerPath(worktreeRoot), 'utf-8').split('\n')[0].trim();
    return id || null;
  } catch {
    return null;
  }
}

function toAbs(raw, baseDir) {
  if (!raw || typeof raw !== 'string') return null;
  return isAbsolute(raw) ? raw : (baseDir ? join(baseDir, raw) : raw);
}

/**
 * Edit|Write|MultiEdit 대상 파일 abs 경로 (단일).
 */
export function editTargetPath(toolName, toolInput, baseDir) {
  // Codex 는 편집 시 tool_name="apply_patch" + tool_input.command (패치 본문) 전송.
  // 다중 파일 패치: worktree 소속 경로를 우선 선택 — innocent main 파일이 패치 앞에
  // 와도 cross-worktree 침범(worktree-resident 파일)을 검출하도록 (단일 path 검사의
  // ordering 우회 방지). worktree 소속 경로 부재 시 첫 경로(main repo 파일 → 상위에서 passthrough).
  if (toolName === 'apply_patch') {
    const paths = extractApplyPatchFilePaths(toolInput?.command, baseDir);
    return paths.find((p) => resolveWorktreeRoot(p)) || paths[0] || null;
  }
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return null;
  return toAbs(toolInput?.file_path, baseDir);
}

/**
 * Bash 명령이 worktree 를 변경하는 `git commit` 이면 대상 worktree 의 기준 경로 반환.
 *   - `git -C <path> ... commit`  → <path>
 *   - 그 외 `git commit`          → data.cwd (현재 cwd 의 worktree)
 *   - commit 아님 / `--dry-run`   → null (대상 없음)
 */
export function commitTargetBase(cmd, cwd, baseDir) {
  if (!cmd || typeof cmd !== 'string') return null;
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(cmd)) return null;
  if (/\bcommit\b[\s\S]*--dry-run/.test(cmd)) return null;
  const mC = cmd.match(/\bgit\s+-C\s+([^\s'"]+)/);
  if (mC) return toAbs(mC[1], baseDir);
  return cwd || null;
}

export async function run(data) {
  try {
    const toolName = data?.tool_name || '';
    if (!['Edit', 'Write', 'MultiEdit', 'apply_patch', 'Bash'].includes(toolName)) {
      return HookOutput.passthrough();
    }

    const sessionId = data?.session_id; // Layer 1 은 없어도 동작 (결정론적)

    const projectDir = resolveProjectDir(data);
    const baseDir = data?.cwd || projectDir;
    let targetAbs = null;
    if (toolName === 'Bash') {
      targetAbs = commitTargetBase(data.tool_input?.command, data.cwd, baseDir);
    } else {
      targetAbs = editTargetPath(toolName, data.tool_input, baseDir);
    }
    if (!targetAbs) return HookOutput.passthrough();

    const wtRoot = resolveWorktreeRoot(targetAbs);
    if (!wtRoot) return HookOutput.passthrough(); // main repo 파일 / 비-worktree

    const relRoot = relative(projectDir, wtRoot).replace(/\\/g, '/') || wtRoot;
    const action = toolName === 'Bash' ? 'commit' : 'edit';

    // ── Layer 1: cross-worktree confinement (cwd 가 *다른* worktree 일 때만 deny) ──
    // Some CLI sessions run Edit/Bash from main(PROJECT_DIR) while targeting
    // their owned worktree. That is allowed and checked by Layer 2. Only a cwd
    // inside a different worktree is treated as cross-worktree access.
    const cwdWt = resolveWorktreeRoot(data?.cwd || '');
    if (cwdWt !== null && cwdWt !== wtRoot) {
      return HookOutput.deny(
        `[Session Owner Guard] cross-worktree ${action} 차단: ${relRoot}\n\n` +
          `현재 cwd 는 다른 worktree (${relative(projectDir, cwdWt).replace(/\\/g, '/')}) 인데 ` +
          `대상은 worktree ${relRoot} 입니다.\n` +
          `각 세션은 자기 worktree 의 파일만 편집·커밋할 수 있습니다 (R-CM-036 Layer 1).\n` +
          `  → 본인 worktree 에서 작업하거나, 정상 ship 흐름(gh pr create → gh pr merge)을 사용하세요.`
      );
    }

    // ── Layer 2: session_id 사이드카 (같은 worktree path 내 다른 세션 방어) ──
    if (sessionId && typeof sessionId === 'string') {
      const owner = readSessionOwner(wtRoot);
      if (owner && owner !== sessionId) {
        return HookOutput.deny(
          `[Session Owner Guard] 타 세션 소유 worktree ${action} 차단: ${relRoot}\n\n` +
            `이 worktree 는 다른 세션(owner=${owner.slice(0, 12)}…)이 생성했습니다.\n` +
            `현재 세션(${sessionId.slice(0, 12)}…)은 자기 세션이 만든 worktree 만 편집·커밋할 수 있습니다 (R-CM-036 Layer 2).\n` +
            `  → 본인 worktree 에서 작업하거나, 해당 worktree 를 만든 세션에 위임하세요.`
        );
      }
    }
    return HookOutput.passthrough();
  } catch {
    return HookOutput.passthrough();
  }
}

if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMainWithProfile('worktree-session-owner-guard', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
