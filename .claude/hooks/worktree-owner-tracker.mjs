#!/usr/bin/env node

/**
 * worktree-owner-tracker.mjs — PostToolUse Bash Hook (CLI-agnostic)
 *
 * worktree 생성 명령(`make wt.new` / `worktree-new.mjs` / `git worktree add`) 성공 직후
 * 현재 세션 ID 를 `.tmp/worktree-<safeBranch>/.session-owner` 사이드카에 기록한다.
 * worktree 마다 소유 세션을 누적 추적 (per-worktree 1 사이드카).
 *
 * 정책 SSOT: R-CM-036 (worktree-session-ownership.md).
 *
 * Why: worktree-session-owner-guard 가 "내 세션이 만든 worktree" 만 편집/커밋 허용하려면
 * 생성 시점에 소유 세션을 남겨야 한다. session_id 는 env var 가 아니라 hook stdin JSON
 * 으로만 전달되므로(공식 문서) shell 스크립트가 아닌 PostToolUse hook 만이 기록 가능.
 *
 * Multi-CLI: `session_id` 는 Claude Code 뿐 아니라 Codex (PostToolUse 공통 필드,
 * https://developers.openai.com/codex/hooks) 와 Antigravity/Gemini
 * (https://geminicli.com/docs/hooks/reference/) hook payload 에도 존재한다. 따라서
 * `run(data)` 를 export 하여 `.claude/hooks/{codex,antigravity}/worktree-owner-tracker.mjs`
 * 어댑터가 CLI payload 정규화 후 위임한다 (가드와 동일한 어댑터 패턴 — MULTI-CLI.md).
 *
 * 동작: 비-worktree-생성 / session_id 부재 / branch 미해석 / 명령 실패 / worktree 미발견
 *       → no-op. tracker 는 절대 도구 호출을 BLOCK 하지 않는다 (safeHookMain).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readStdin, output, safeHookMain, safeGit, resolveProjectDir } from '../scripts/lib/utils.mjs';
import { worktreeOwnerPath, parseWorktreeList } from '../scripts/lib/worktree-plan-path.mjs';

const WORKTREE_CREATE_RE = /(?:\bwt\.new\b|worktree-new\.(?:mjs|sh)|\bgit\s+worktree\s+add\b)/;

/**
 * worktree 생성 명령에서 branch 명을 추출.
 *   1) `make wt.new BR=<x>` / `BRANCH=<x>` / `--branch <x>` (worktree-new.mjs)
 *   2) `worktree-new.sh <x>` (positional, flag 제외)
 *   3) `git worktree add <path> -b <x>` (신규 branch)
 *   4) `git worktree add <path> <x>` (기존 branch attach)
 * 미해석 → null (guard 가 fail-open skip — 오차단 없음).
 */
export function parseBranchFromCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const mBr = cmd.match(/\bBR=([^\s'"]+)/);
  if (mBr) return mBr[1];
  const mEnv = cmd.match(/\bBRANCH=([^\s'"]+)/);
  if (mEnv) return mEnv[1];
  const mFlag = cmd.match(/--branch\s+([^\s'"]+)/);
  if (mFlag) return mFlag[1];
  const mPos = cmd.match(/worktree-new\.sh\s+(?!-)([^\s'"]+)/);
  if (mPos) return mPos[1];
  const mNew = cmd.match(/\bgit\s+worktree\s+add\s+\S+\s+-b\s+([^\s'"]+)/);
  if (mNew) return mNew[1];
  const mAttach = cmd.match(/\bgit\s+worktree\s+add\s+(?!-)\S+\s+(?!-)([^\s'"]+)/);
  if (mAttach) return mAttach[1];
  return null;
}

/**
 * 세션 소유권 사이드카 기록 로직 (CLI-agnostic, 부수효과만 — 항상 passthrough).
 *
 * Claude Code standalone (아래 safeHookMain) + Codex/Antigravity 어댑터가 공유한다.
 * 어댑터는 `cli-adapter-utils.mjs#runAdapter` 로 CLI payload 를 Claude 형식
 * (`{ tool_name, tool_input, session_id, tool_response, cwd }`) 으로 정규화한 뒤 위임한다.
 *
 * @param {object} data - 정규화된 hook payload
 * @returns {Promise<object>} 항상 {} (passthrough — tracker 는 절대 BLOCK 하지 않음)
 */
export async function run(data) {
  if (!data || data.tool_name !== 'Bash') return {};

  const cmd = data.tool_input?.command;
  if (!cmd || typeof cmd !== 'string' || !WORKTREE_CREATE_RE.test(cmd)) return {};

  const resp = data.tool_response;
  if (resp && typeof resp.exit_code === 'number' && resp.exit_code !== 0) return {};

  const sessionId = data.session_id;
  if (!sessionId || typeof sessionId !== 'string') return {};

  const branch = parseBranchFromCommand(cmd);
  if (!branch) {
    // worktree 생성 명령은 매칭됐으나 branch 미추출 (custom wrapper / 비표준 형식).
    // 사이드카 미기록 → Layer 2 미동작 (Layer 1 cwd-confinement 가 PRIMARY 보호).
    // 디버깅 가시성 (DEBT-184): DEBUG_WORKTREE_OWNER 시에만 stderr (평소 noise 0).
    if (process.env.DEBUG_WORKTREE_OWNER) {
      console.error(`[worktree-owner-tracker] branch 미추출 → 사이드카 skip: ${cmd.slice(0, 80)}`);
    }
    return {};
  }

  const projectDir = resolveProjectDir(data);
  const wtOut = safeGit('worktree list --porcelain', projectDir, { timeout: 3000 });
  if (wtOut === null) return {};

  const wt = parseWorktreeList(wtOut).find((e) => e.branch === branch);
  if (!wt) return {};

  try {
    const sidecar = worktreeOwnerPath(wt.path, branch);
    if (!existsSync(dirname(sidecar))) mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, `${sessionId}\n`);
  } catch {
    // silent — 기록 실패해도 도구 호출 차단 금지 (guard 가 fail-open skip)
  }
  return {};
}

// standalone 진입점 (Claude Code 직접 실행). __HOOK_ORCHESTRATOR__ 는 orchestrated 통합
// 예약 플래그로, Codex/Antigravity 어댑터의 import 시점에는 설정되지 않는다 → 이 블록은
// 어댑터 import 부수효과로도 발동한다 (기존 guard 어댑터 commit-guard 등과 동일 구조).
// 그래도 무해: (1) tracker 는 항상 passthrough({}) 라 stdout 충돌 없음 (2) 사이드카 write 는
// 멱등(동일 session_id 덮어쓰기) (3) 빈 payload 로 퇴화해도 run() 첫 가드에서 no-op.
if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMain(async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
