#!/usr/bin/env node

/**
 * codex/worktree-owner-tracker.mjs — Codex CLI PostToolUse(shell) 어댑터
 *
 * 본체 .claude/hooks/worktree-owner-tracker.mjs 의 run(data) 를 그대로 활용.
 * Codex stdin payload 를 Claude Code 형식으로 정규화한 후 위임 — worktree 생성 명령
 * 성공 직후 Codex session_id 를 `.session-owner` 사이드카에 기록한다.
 *
 * Why (R-CM-036 멀티-CLI 한계 해소): `session_id` 는 Claude Code 전용이 아니라 Codex
 * PostToolUse payload 공통 필드 ("Current Codex session id" — 공식 문서
 * https://developers.openai.com/codex/hooks). 따라서 Codex 세션도 owner 사이드카를
 * 남길 수 있어 Layer 2 (session_id 사이드카) 가 Codex 에서도 동작한다.
 *
 * 등록 위치: .codex/hooks.json (`#hooks.PostToolUse`,
 *   matcher `^(Bash|shell|run_shell|run_shell_command|exec_command)$`).
 * 정책 SSOT: R-CM-036 (worktree-session-ownership.md). 매핑 SSOT: MULTI-CLI.md.
 * audit I2 제외: .claude/hooks/codex/ 서브디렉토리는 listInDir(single-level) 가 스캔하지 않음.
 */

import { run as runOwnerTracker } from '../worktree-owner-tracker.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runOwnerTracker, { cli: 'codex' });
