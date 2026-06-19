#!/usr/bin/env node

/**
 * codex/worktree-session-owner-guard.mjs — Codex CLI PreToolUse 어댑터
 *
 * 본체 .claude/hooks/worktree-session-owner-guard.mjs 의 run(data) 를 그대로 활용.
 * Codex stdin payload 를 Claude Code 형식으로 정규화한 후 위임.
 *
 * 등록 위치: .codex/hooks.json (`#hooks.PreToolUse`,
 *   matcher `^(apply_patch|Edit|Write|MultiEdit|Bash|shell|run_shell|run_shell_command|exec_command)$`).
 * 정책 SSOT: R-CM-036 (worktree-session-ownership.md).
 * audit I2 제외: .claude/hooks/codex/ 서브디렉토리는 listInDir(single-level) 가 스캔하지 않음 — MULTI-CLI.md 문서화.
 */

import { run as runSessionOwnerGuard } from '../worktree-session-owner-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runSessionOwnerGuard, { cli: 'codex' });
