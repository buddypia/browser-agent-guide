#!/usr/bin/env node

/**
 * worktree-policy-guard.mjs - PreToolUse Edit|Write Hook
 *
 * main 브랜치 직접 작업을 Tier 기반 화이트리스트로 차단한다.
 *
 * 정책 SSOT: .claude/config/worktree-policy.json
 *
 * 동작:
 *   - branch != main → passthrough (worktree 안에서 작업 시 자동 통과)
 *   - hotfix/* / hotfix-* branch → passthrough (escape hatch)
 *   - main + Tier 1 (allowed) → passthrough
 *   - main + Tier 2 (worktree smoke test 권고) → allowWithWarning
 *   - main + Tier 3 (그 외) → deny
 *   - error 또는 정책 파일 부재 → passthrough (자기 차단 회피, R-CM-006 Rule 2)
 *
 * Reference 패턴: destructive-git-guard.mjs
 */

import { join, relative, isAbsolute } from 'path';
import {
  readStdin,
  output,
  safeHookMainWithProfile,
  safeGit,
  safeReadJson,
  resolveProjectDir,
} from '../scripts/lib/utils.mjs';
import { HookOutput } from '../scripts/lib/hook-output.mjs';
import { extractApplyPatchFilePaths } from '../scripts/lib/apply-patch-paths.mjs';

/**
 * glob 패턴 → RegExp 변환 (minimatch 의존성 회피).
 *   `**`  → `.*`           (임의 경로 세그먼트)
 *   `*`   → `[^/]+`        (단일 세그먼트 와일드카드)
 *   기타 정규식 메타문자는 이스케이프.
 */
export function matchesGlob(relPath, pattern) {
  // `*` 도 정규식 메타문자이므로 함께 escape 후 변환 순서:
  //   1. 정규식 메타문자 ( `*` 포함 ) escape → `*` → `\*`
  //   2. `\*\*` → `@@GLOBSTAR@@` (임의 경로 매칭 holder)
  //   3. `\*` → `[^/]+` (단일 세그먼트)
  //   4. `@@GLOBSTAR@@` → `.*`
  const regStr = pattern
    .replace(/[.+^${}()|[\]\\*]/g, '\\$&')
    .replace(/\\\*\\\*/g, '@@GLOBSTAR@@')
    .replace(/\\\*/g, '[^/]+')
    .replace(/@@GLOBSTAR@@/g, '.*');
  return new RegExp(`^${regStr}$`).test(relPath);
}

export function classifyTier(relPath, policy) {
  const tier1Patterns = policy?.tiers?.tier1_main_allowed?.patterns ?? [];
  if (tier1Patterns.some((p) => matchesGlob(relPath, p))) return 1;

  const tier2Patterns = policy?.tiers?.tier2_worktree_code_main_verify?.patterns ?? [];
  if (tier2Patterns.some((p) => matchesGlob(relPath, p))) return 2;

  return 3;
}

/**
 * Edit/Write/MultiEdit 의 file_path 추출 + 정규화.
 *   - 상대 경로 → projectDir 와 join (절대 경로 보장)
 *   - 빈 string / 미지원 tool → 빈 배열
 *   - NotebookEdit / Read 등 다른 도구 → 빈 배열 (의도적 미적용 — `.ipynb` 파일은 본 hook 검증 외)
 */
export function extractFilePaths(toolName, toolInput, projectDir = '') {
  if (!toolInput) return [];
  // Codex 는 편집 시 항상 tool_name="apply_patch" + tool_input.command (패치 본문) 전송.
  if (toolName === 'apply_patch') {
    return extractApplyPatchFilePaths(toolInput.command, projectDir);
  }
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return [];
  const raw = toolInput.file_path;
  if (!raw || typeof raw !== 'string') return [];
  const abs = isAbsolute(raw) ? raw : (projectDir ? join(projectDir, raw) : raw);
  return [abs];
}

/**
 * 정책 객체가 사용 가능한 형태인지 검증.
 *   - tiers 부재 / 두 패턴 배열 모두 부재 → unusable (run() 에서 fail-open passthrough)
 *   - corrupt JSON 이 빈 객체 `{}` 로 파싱된 경우 자기 차단 사고 회피용
 */
export function isPolicyUsable(policy) {
  if (!policy || !policy.tiers) return false;
  const t1 = policy.tiers.tier1_main_allowed?.patterns;
  const t2 = policy.tiers.tier2_worktree_code_main_verify?.patterns;
  return Array.isArray(t1) || Array.isArray(t2);
}

/**
 * 파일이 .worktrees/ 하위인지 판정.
 *
 * cwd-based branch detection (`git branch --show-current` from main repo cwd) 의
 * 한계 — main repo cwd 에서 hook 이 실행되어 branch="main" 으로 인식되지만
 * 실제 편집 대상 파일은 별도 worktree 안 (`.worktrees/<name>/...`) 에 있는 경우,
 * worktree 의 실제 branch 는 main 이 아니므로 본 hook 차단 대상이 아니다.
 *
 * 본 helper 는 file-path-based 추가 검출 — relPath 가 `.worktrees/` 로 시작하면
 * 정의상 worktree 내 파일로 간주하여 tier 판정 skip + passthrough 처리한다.
 *
 * @param {string} relPath - projectDir 기준 정규화된 상대 경로
 * @returns {boolean}
 */
export function isWorktreeRelPath(relPath) {
  return typeof relPath === 'string' && relPath.startsWith('.worktrees/');
}

export function isEscapeHatch(branch, policy) {
  const patterns = policy?.escape_hatch?.branch_patterns ?? [];
  return patterns.some((p) => matchesGlob(branch, p));
}

function buildDenyMessage(relPath) {
  return (
    `[Worktree Policy] main 브랜치 직접 편집 차단: ${relPath}\n\n` +
    `이 파일은 worktree 에서 작업해야 합니다.\n` +
    `  → worktree 생성 (표준 진입점, fetch + ff + add origin/main 기준):\n` +
    `      make wt.new BR=feature/<task>\n` +
    `      # 또는: node .claude/scripts/worktree-new.mjs --branch feature/<task>\n` +
    `  → 비상구: hotfix/* branch 에서는 모든 차단 면제\n` +
    `정책 SSOT: .claude/config/worktree-policy.json`
  );
}

/**
 * Orchestrator 호환 진입점.
 */
export async function run(data) {
  try {
    const toolName = data?.tool_name || '';
    if (!['Edit', 'Write', 'MultiEdit', 'apply_patch'].includes(toolName)) {
      return HookOutput.passthrough();
    }

    const projectDir = resolveProjectDir(data);
    const branch = safeGit('branch --show-current', projectDir, { timeout: 2000 });
    if (!branch) return HookOutput.passthrough();
    if (branch !== 'main') return HookOutput.passthrough();

    const policy = safeReadJson(
      join(projectDir, '.claude/config/worktree-policy.json'),
      null
    );
    if (!isPolicyUsable(policy)) return HookOutput.passthrough();

    if (isEscapeHatch(branch, policy)) return HookOutput.passthrough();

    const filePaths = extractFilePaths(toolName, data.tool_input, projectDir);
    if (filePaths.length === 0) return HookOutput.passthrough();

    for (const filePath of filePaths) {
      const relPath = relative(projectDir, filePath).replace(/\\/g, '/');
      // 외부 path (project root 밖, 예: /tmp/foo, /var/...) 면제.
      // 사용자 보고 "shell 멈춤" root cause F4 — relPath 가 `..` 으로 시작하면 정의상
      // 프로젝트 외부이므로 worktree 정책 적용 대상이 아니다 (false-positive 차단).
      if (relPath.startsWith('..')) continue;
      // .worktrees/ 하위 파일은 정의상 별도 worktree 의 branch (main 아님).
      // hook 의 cwd-based branch 검출은 main repo 만 보므로 worktree 내 작업이
      // main 으로 오판되는 함정 회피. file-path-based detection 으로 보강.
      if (isWorktreeRelPath(relPath)) continue;
      const tier = classifyTier(relPath, policy);
      if (tier === 1) continue;
      // tier === 3 (tier 2 has been abolished)
      return HookOutput.deny(buildDenyMessage(relPath));
    }

    return HookOutput.passthrough();
  } catch (_) {
    return HookOutput.passthrough();
  }
}

// Standalone fallback (settings.json 직접 호출 시)
if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMainWithProfile('worktree-policy-guard', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
