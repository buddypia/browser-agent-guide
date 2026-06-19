#!/usr/bin/env node

/**
 * codex/commit-guard.mjs — Codex CLI PreToolUse(shell) 어댑터
 *
 * 본체 .claude/hooks/commit-guard.mjs 의 run(data) 를 그대로 활용.
 * Codex stdin payload 를 Claude Code 형식으로 정규화한 후 위임.
 *
 * 등록 위치: .codex/hooks.json (`#hooks.PreToolUse`, matcher `^(Bash|shell|run_shell|run_shell_command|exec_command)$`).
 * audit I2 제외: .claude/hooks/codex/ 서브디렉토리는 listInDir(single-level) 가 스캔하지 않음 — MULTI-CLI.md 문서화.
 */

import { run as runCommitGuard } from '../commit-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runCommitGuard, { cli: 'codex' });
