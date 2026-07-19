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
 * 추가 책임 (②-deny, blocking):
 *   기본 브랜치(main)가 "다른" worktree 에 checkout 된 상태에서 `gh pr merge --delete-branch`
 *   (또는 짧은 별칭 `-d`)를 실행하면, gh 가 merge 후 로컬에서 `git checkout main` 을 시도하다가
 *   "failed to run git: 'main' is already used by worktree" 로 반드시 실패한다 → exit 0 인데도 원격
 *   브랜치가 미삭제로 남고, "failed to run git" 만 보고 AI 가 "merge 실패" 로 오인할 수 있다(실제
 *   원격 merge 는 성공). 이 조건에서는 해당 커맨드가 항상 실패하는 footgun 이므로 **deny** 로 막고
 *   (deny 의 reason 은 AI 에게 전달됨), 올바른 대체 절차(`gh pr merge --squash` 무플래그 + cleanup)를
 *   안내한다 — 이렇게 하면 혼란스러운 exit-0 출력 자체가 발생하지 않는다.
 *   (warn 이 아니라 deny 인 이유: allowWithWarning 의 reason 은 "사용자에게만" 표시되어 AI 에게 닿지
 *    않으므로 "AI 가 오인하지 않게" 라는 목적을 달성하지 못한다. deny 는 AI 에게 전달된다.)
 *   기본 브랜치가 다른 worktree 에 없으면(그 커맨드가 성공할 수 있으면) deny 하지 않는다(zero false-block).
 *   근거/설계: docs/retros/retro-2026-07-19-gh-pr-merge-delete-branch-from-worktree.md
 *
 * 의존성: 없음 (self-contained)
 * @matcher Bash
 */

import { resolve } from 'node:path';
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

// ── gh pr merge --delete-branch / -d while main is held by ANOTHER worktree (②-deny) ──

/** `gh pr merge` 커맨드인지 (git merge 와 구별) */
export function isGhPrMerge(command) {
  if (!command) return false;
  return /\bgh\s+pr\s+merge\b/.test(command);
}

/**
 * `--delete-branch` 또는 gh 의 짧은 별칭 `-d` 플래그가 있는지.
 * (C5 caveat: `--delete-branch` 만 매칭하면 `gh pr merge <n> -d` 가 조용히 우회하므로 둘 다 본다.)
 */
export function hasDeleteBranchFlag(command) {
  if (!command) return false;
  return /(--delete-branch\b|(?:^|\s)-d(?:\s|$))/.test(command);
}

/**
 * 커맨드의 선행 `cd <path> &&` 로 이동하는 경로. 없으면 원본 cwd.
 * NOTE: resolveProjectDir 는 `/.worktrees/` 를 잘라내(main root 로 접음)므로 worktree 판정에는
 *       쓰지 않는다 — 여기서는 접기 전의 원본 경로가 필요하다. tool 의 실제 cwd(hookData.cwd)를
 *       CLAUDE_PROJECT_DIR(항상 main) 보다 우선한다.
 */
export function effectiveCwd(command, hookData) {
  const m = (command || '').match(/^\s*cd\s+(?:(['"])(.+?)\1|([^\s&;|'"]+))\s*&&/);
  if (m) return m[2] || m[3];
  return hookData?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * 기본 브랜치(main/master)가 "현재 worktree 와 다른" worktree 에 checkout 되어 있는지.
 * = 이 커맨드가 실행되는 worktree 밖에서 main 이 점유되어 gh 의 post-merge `git checkout main` 이
 *   반드시 실패하는 상태 (곧 `gh pr merge --delete-branch` 가 항상 footgun 이 되는 정확한 조건).
 *   - main 을 현재 worktree 자신이 쥐고 있으면(= main checkout 에서 실행) false → deny 안 함.
 *   - main 이 어떤 worktree 에도 없으면 false → deny 안 함 (그 커맨드는 실패하지 않을 수 있으므로).
 *   판정 불가(비-repo 등)면 fail-open false → deny 안 함 (zero false-block).
 */
export function defaultBranchHeldByAnotherWorktree(command, hookData) {
  const dir = effectiveCwd(command, hookData);
  const list = safeGit('worktree list --porcelain', dir, { timeout: 3000 });
  const top = safeGit('rev-parse --show-toplevel', dir, { timeout: 3000 });
  if (!list || !top) return false;
  const cur = resolve(top.trim());
  for (const block of list.split(/\n\s*\n/)) {
    const p = block.match(/^worktree (.+)$/m);
    const b = block.match(/^branch refs\/heads\/(.+)$/m);
    if (!p || !b) continue;
    const name = b[1].trim();
    if ((name === 'main' || name === 'master') && resolve(p[1].trim()) !== cur) return true;
  }
  return false;
}

/**
 * `gh pr merge --delete-branch`/`-d` 를, main 이 다른 worktree 에 점유된 상태에서 실행 → ②-deny 대상인지.
 * 이 조건에서는 gh 의 로컬 후처리가 항상 실패하므로 정당한 용도가 0 (zero false-block).
 */
export function shouldDenyDeleteBranchFromWorktree(command, hookData) {
  return (
    isGhPrMerge(command) &&
    hasDeleteBranchFlag(command) &&
    defaultBranchHeldByAnotherWorktree(command, hookData)
  );
}

export const GH_PR_MERGE_WORKTREE_DENY_REASON = [
  '🚫 BLOCKED: worktree からの `gh pr merge --delete-branch`/`-d`（main は別 worktree で使用中）。',
  '',
  'この形はマージ後に gh がローカルで `git checkout main` を試みますが、main は別 worktree で使用中の',
  "ため \"failed to run git: fatal: 'main' is already used by worktree\" で必ず失敗します。",
  'その結果 **exit 0 でも "failed to run git" が出て、リモートブランチは未削除のまま**残り、',
  'AI が「マージ失敗」と誤認しがちです（実際のリモート merge は成功する）。だから実行前に止めます。',
  '',
  '正しい手順:',
  '  1) `--delete-branch`/`-d` を外して `gh pr merge <n> --squash` を実行する。',
  '  2) リモートブランチ削除は後続の `agent-worktree-guard cleanup --confirmed` が行う。',
  '  3) 既に "failed to run git" を見た場合は失敗と決めつけず',
  '     `gh pr view <n> --json state,mergedAt` で MERGED を確認する（retry 前に）。',
].join('\n');

async function main() {
  try {
    const data = await readStdin();
    const toolInput = data.tool_input || {};
    const command = toolInput.command || '';

    // main 이 다른 worktree 에 있는 상태의 `gh pr merge --delete-branch`/`-d` → deny (항상 실패하는
    // footgun 을 실행 전에 차단; deny 의 reason 은 AI 에게 전달되어 올바른 대체 절차로 유도한다)
    if (shouldDenyDeleteBranchFromWorktree(command, data)) {
      return output(HookOutput.deny(GH_PR_MERGE_WORKTREE_DENY_REASON));
    }

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

// Standalone fallback (settings.json 직접 호출 시). 테스트는 __HOOK_ORCHESTRATOR__ 로 main 실행을 막고
// 위의 export 된 순수 함수를 직접 검증한다.
if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMain(main);
}
