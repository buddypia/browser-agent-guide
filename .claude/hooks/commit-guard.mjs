#!/usr/bin/env node

/**
 * commit-guard.mjs - PreToolUse Bash Hook
 *
 * AI 의 git commit / branch 생성 / amend 를 main 직접 작업으로부터 보호한다.
 *
 * 정책 (멀티 터미널 동시 작업 환경 보호):
 *   - main 직접 commit       → 차단 (worktree 안에서만 commit 허용)
 *   - git commit --amend     → 항상 차단 (push 충돌 + 멀티 터미널 history rewrite 위험)
 *   - 브랜치 생성             → 항상 차단 (worktree add 사용 강제)
 *   - worktree commit        → 허용
 *   - git commit --dry-run   → 허용 (검증용)
 *
 * 예외:
 *   - .tmp/create-pr-active 파일 존재 시 commit + branch create 허용 (단 amend 는 항상 차단)
 *
 * 차단 대상:
 *   - git commit (main 브랜치에서)
 *   - git commit --amend (모든 브랜치)
 *   - git checkout -b/-B (새 브랜치 생성)
 *   - git switch -c / -C / --create / --force-create (새 브랜치 생성)
 *   - git branch <name> (새 브랜치 생성)
 *
 * 허용 예외:
 *   - git commit --dry-run (실제 commit 이 아닌 검증용)
 *   - git commit (worktree 브랜치에서)
 *   - git checkout <existing-branch> (브랜치 전환, 생성이 아님)
 *   - git switch <existing-branch> (브랜치 전환, 생성이 아님)
 *   - git branch --list / -a / -v / --show-current / -d / -D (조회/삭제)
 *
 * 설계 (테스트 가능성):
 *   - isGitCommit / isGitAmend / isGitBranchCreate: 순수 함수, 명령 문자열 검사만
 *   - decide({ command, branch, isCreatePrActive }): 순수 함수, 정책 결정 SSOT
 *   - run(data): I/O (브랜치 검출, state 파일 확인) 후 decide() 호출
 */

import {
  readStdin,
  output,
  resolveProjectDir,
  safeHookMainWithProfile,
  safeGit,
} from '../scripts/lib/utils.mjs';
import { HookOutput } from '../scripts/lib/hook-output.mjs';
import { anchoredPattern } from '../scripts/lib/hook-anchors.mjs';
import { existsSync } from 'fs';
import { join } from 'path';

const PROJECT_DIR = resolveProjectDir();
const STATE_FILE = join(PROJECT_DIR, '.tmp', 'create-pr-active');

// --- Pattern constants ---
// anchor (명령 시작 / chain operator / newline 직후만 매칭) 는 hook-anchors.mjs SSOT.
// 단순 word boundary `\b` 는 진단 코드 / heredoc / grep / echo 안의 "git commit"
// string 까지 false-positive 매칭 (사용자 보고 "shell 멈춤" root cause F3, PR #493).
const GIT_COMMIT_PATTERN = anchoredPattern('git\\s+commit\\b', 'i');
const GIT_AMEND_PATTERN = anchoredPattern('git\\s+commit\\b.*\\B--amend\\b', 'i');
const GIT_CHECKOUT_NEWBRANCH_PATTERN = anchoredPattern('git\\s+checkout\\s+(-b|-B|--orphan)\\b');
const GIT_SWITCH_CREATE_PATTERN = anchoredPattern(
  'git\\s+switch\\s+.*(-c|--create|-C|--force-create)\\b',
  'i',
);
const GIT_BRANCH_PATTERN = anchoredPattern('git\\s+branch\\b', 'i');

/**
 * git commit 명령 검출. amend 도 commit 으로 간주 (별도 isGitAmend 로 구분).
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isGitCommit(command) {
  if (!command || typeof command !== 'string') return false;
  if (!GIT_COMMIT_PATTERN.test(command)) return false;
  // git commit --dry-run 은 검증용 (실제 commit 아님) → 허용
  if (/--dry-run\b/i.test(command)) return false;
  return true;
}

/**
 * git commit --amend 검출.
 *
 * amend 는 멀티 터미널 환경에서 다음 위험을 만든다:
 *   - 이미 push 된 commit 을 amend 시 force push 강제 (R-CM-008 Rule 3 위반)
 *   - 다른 worktree 가 같은 브랜치를 push 하려 할 때 충돌
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isGitAmend(command) {
  if (!command || typeof command !== 'string') return false;
  // git commit ... --amend 형태만 매칭 (다른 명령에 우연히 --amend 가 있어도 무시).
  // anchor 적용 — quoted 안 "git commit --amend" false-positive 차단.
  return GIT_AMEND_PATTERN.test(command);
}

/**
 * git branch 생성 명령 검출.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isGitBranchCreate(command) {
  if (!command || typeof command !== 'string') return false;

  // git checkout -b/-B <branch> (새 브랜치 생성, -B는 force create). anchor 적용.
  if (GIT_CHECKOUT_NEWBRANCH_PATTERN.test(command)) return true;

  // git switch -c / --create / -C / --force-create (새 브랜치 생성). anchor 적용.
  if (GIT_SWITCH_CREATE_PATTERN.test(command)) return true;

  // git branch <name> (새 브랜치 생성). anchor 적용.
  // 제외: git branch -d/-D (삭제), --list, -a, -v, --show-current, -r, --merged 등 조회/관리 플래그
  if (GIT_BRANCH_PATTERN.test(command)) {
    // 조회/삭제/관리 전용 플래그가 있으면 → 브랜치 생성이 아님
    if (
      /\bgit\s+branch\s+(-d\b|-D\b|--delete\b|--list\b|-a\b|--all\b|-v\b|--verbose\b|--show-current\b|-r\b|--remote\b|--merged\b|--no-merged\b|--contains\b|--sort\b|--column\b|--no-column\b|--format\b|-m\b|-M\b|--move\b|--copy\b|-c\b|-C\b)/i.test(
        command,
      )
    ) {
      return false;
    }
    // 플래그 없이 인수가 있는 경우 → 브랜치 생성 (예: git branch my-feature)
    // `git branch` 단독 (인수 없음) = 브랜치 목록 조회 → 허용
    const stripped = command.replace(/\bgit\s+branch\b/i, '').trim();
    if (stripped.length > 0) return true;
  }

  return false;
}

/**
 * 정책 결정 SSOT. 순수 함수.
 *
 * 결정 우선순위:
 *   1. amend         → 항상 deny (create-pr active 도 우회 불가, 보안 일관성)
 *   2. create-pr     → passthrough (commit + branch create 허용)
 *   3. branch create → 항상 deny
 *   4. main + commit → deny (worktree commit 허용)
 *   5. 그 외          → passthrough
 *
 * @param {{ command: string, branch: string, isCreatePrActive: boolean }} ctx
 * @returns {{ action: 'deny' | 'passthrough', kind?: 'amend' | 'branch_create' | 'main_commit' }}
 */
export function decide({ command, branch, isCreatePrActive, isWorktree }) {
  if (isGitAmend(command)) {
    return { action: 'deny', kind: 'amend' };
  }
  if (isCreatePrActive || isWorktree) {
    return { action: 'passthrough' };
  }
  if (isGitBranchCreate(command)) {
    return { action: 'deny', kind: 'branch_create' };
  }
  if (isGitCommit(command) && branch === 'main') {
    return { action: 'deny', kind: 'main_commit' };
  }
  return { action: 'passthrough' };
}

function buildDenyMessage(kind) {
  if (kind === 'amend') {
    return (
      `[Commit Guard] git commit --amend 가 차단되었습니다.\n\n` +
      `amend 는 멀티 터미널 환경에서 다음 위험을 만듭니다:\n` +
      `  - 이미 push 된 commit 을 amend 시 force push 강제 (R-CM-008 Rule 3 위반)\n` +
      `  - 다른 worktree 가 같은 브랜치를 push 하려 할 때 충돌\n\n` +
      `대안:\n` +
      `  - 메시지 수정만 필요: git reset --soft HEAD~1 && git commit -m "<new msg>"\n` +
      `  - 새 변경 추가: 새 commit 으로 정정 (R-CM-008 Rule 1: 새 commit 권장)\n`
    );
  }
  if (kind === 'branch_create') {
    return (
      `[Branch Guard] 브랜치 생성이 차단되었습니다.\n\n` +
      `브랜치 생성은 worktree 와 짝지어야 멀티 터미널 충돌을 방지할 수 있습니다.\n\n` +
      `대안 (표준 진입점 — fetch + ff main + worktree add origin/main 기준):\n` +
      `  make wt.new BR=feature/<task>\n` +
      `  # 또는: node .claude/scripts/worktree-new.mjs --branch feature/<task>\n` +
      `또는 /create-pr 스킬 — feature 브랜치 + PR + squash merge 자동 처리.\n`
    );
  }
  // main_commit
  return (
    `[Commit Guard] main 브랜치 직접 commit 이 차단되었습니다.\n\n` +
    `이 정책은 멀티 터미널 동시 작업의 코드 경합 차단이 목적입니다.\n` +
    `worktree 브랜치 안에서는 commit 이 허용됩니다.\n\n` +
    `대안 (표준 진입점 — fetch + ff main + worktree add origin/main 기준):\n` +
    `  make wt.new BR=feature/<task>\n` +
    `  # 또는: node .claude/scripts/worktree-new.mjs --branch feature/<task>\n\n` +
    `[권장] AI 호출 시 'git -C <worktree-path>' 명시 — chained 'cd && git' 은 hook 평가 시점 cwd 가 main 으로 인식되어 차단됩니다.\n` +
    `  git -C .worktrees/feature/<task> add <files>\n` +
    `  git -C .worktrees/feature/<task> commit -m "<msg>"\n\n` +
    `[대안 — 사용자 직접] cd 후 git commit (사용자 shell 에서):\n` +
    `  cd .worktrees/feature/<task>\n` +
    `  git commit -m "<msg>"\n\n` +
    `또는 /create-pr 스킬 — 자동 처리.\n`
  );
}

/**
 * Orchestrator 호환 진입점.
 */
export async function run(data) {
  try {
    const toolName = data.tool_name || '';
    if (toolName !== 'Bash' && toolName !== 'run_shell_command') {
      return HookOutput.passthrough();
    }

    const command = data.tool_input?.command || '';

    // 빠른 path: 관련 명령이 아니면 즉시 통과 (브랜치 검출 비용 회피)
    // amend 는 isGitCommit 의 부분집합이므로 isGitCommit 만 체크해도 충분.
    if (!isGitCommit(command) && !isGitBranchCreate(command)) {
      return HookOutput.passthrough();
    }

    const projectDir = resolveProjectDir(data);
    const branch = safeGit('branch --show-current', projectDir, { timeout: 2000 }) || '';
    const isCreatePrActive = existsSync(STATE_FILE);
    // cwd-based worktree detection (destructive-git-guard L109과 일관).
    // hook이 worktree 안에서 실행되면 branch != main 이지만, 이 변수로
    // decide() 의 worktree-passthrough 분기가 명시적으로 활성화된다.
    const isWorktree = process.cwd().includes('/.worktrees/');

    const result = decide({ command, branch, isCreatePrActive, isWorktree });

    if (result.action === 'deny') {
      return HookOutput.deny(buildDenyMessage(result.kind));
    }
    return HookOutput.passthrough();
  } catch (_) {
    return HookOutput.passthrough();
  }
}

// Standalone fallback (settings.json 직접 호출 시)
if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMainWithProfile('commit-guard', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
