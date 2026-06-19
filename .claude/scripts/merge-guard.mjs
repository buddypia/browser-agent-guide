#!/usr/bin/env node

/**
 * Merge Guard - PreToolUse Hook (Bash matcher)
 *
 * `git merge` 실행 전에 staged changes 유무를 확인하여,
 * 커밋되지 않은 변경이 merge로 파괴되는 것을 방지합니다.
 *
 * 시나리오:
 *   1. 사용자가 파일을 stage (git add)
 *   2. git commit 실패 (pre-commit hook 거부 등)
 *   3. AI가 git merge 실행 → staging area 파괴!
 *
 * 이 Hook이 3을 저지합니다:
 *   - Bash 커맨드에 "git merge"가 포함되면 발동
 *   - git diff --cached로 staged changes 확인
 *   - staged changes가 있으면 deny
 *
 * 의존성: 없음 (self-contained)
 * @matcher Bash
 */

import { resolveProjectDir, readStdin, output, safeHookMain, safeGit } from './lib/utils.mjs';
import { HookOutput } from './lib/hook-output.mjs';

// stdin/output 은 lib/utils.mjs 에서 import 됨

// ── Core logic ──

/**
 * 커맨드가 git merge를 포함하는지 확인
 * "git merge", "git merge origin/main" 등에 매칭
 * "git merge --abort"는 안전하므로 제외
 */
function isGitMerge(command) {
  if (!command) return false;
  if (/git\s+merge\s+--abort/.test(command)) return false;
  return /git\s+merge\b/.test(command);
}

/**
 * --ff-only merge는 staging area를 파괴하지 않으므로 항상 안전.
 * merge commit을 생성하지 않고 HEAD만 전진시킨다.
 * staging과 충돌하면 git 자체가 거부하므로 guard가 개입할 필요 없음.
 */
function isFfOnlyMerge(command) {
  if (!command) return false;
  return /\bgit\s+merge\s+--ff-only\b/.test(command);
}

/**
 * staged changes 유무를 확인
 * @returns {string|null} staged 파일 목록 (없으면 null)
 */
function getStagedChanges(cwd) {
  return safeGit('diff --cached --name-only', cwd, { timeout: 5000 }) || null;
}

async function main() {
  try {
    const data = await readStdin();
    const toolInput = data.tool_input || {};
    const command = toolInput.command || '';
    const cwd = resolveProjectDir(data);

    // git merge 커맨드가 아니면 무조건 통과
    if (!isGitMerge(command)) {
      return output(HookOutput.passthrough());
    }

    // --ff-only merge는 staging area를 파괴하지 않으므로 무조건 허용
    // HEAD 전진만 수행하며, 충돌 시 git 자체가 거부함
    if (isFfOnlyMerge(command)) {
      return output(HookOutput.passthrough());
    }

    // staged changes 확인
    const staged = getStagedChanges(cwd);

    if (staged) {
      const fileCount = staged.split('\n').length;
      const fileList = staged.split('\n').slice(0, 5).join(', ');
      const suffix = fileCount > 5 ? ` 외 ${fileCount - 5}건` : '';

      return output(HookOutput.deny(
        [
          `MERGE BLOCKED: staged changes ${fileCount}건 검출 (${fileList}${suffix})`,
          '',
          'git merge는 staging area를 파괴합니다.',
          '먼저 git commit으로 변경 내용을 커밋하세요.',
          '',
          '커밋 실패 시: 원인을 해결한 후 다시 커밋하세요.',
          'merge를 먼저 실행하면 staged 변경이 소실됩니다.',
        ].join('\n')
      ));
    }

    // staged changes 없음 → merge 허용
    return output(HookOutput.passthrough());
  } catch (_) {
    // NOTE: console.error 사용 금지 — stderr 출력이 Claude Code에 "hook error"로 표시됨
    return output(HookOutput.passthrough());
  }
}

safeHookMain(main);
