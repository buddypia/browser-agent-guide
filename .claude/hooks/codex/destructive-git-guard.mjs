#!/usr/bin/env node

/**
 * codex/destructive-git-guard.mjs — Codex CLI PreToolUse(shell) 어댑터
 *
 * 본체 .claude/hooks/destructive-git-guard.mjs 의 run(data) 를 위임.
 * 등록 위치: .codex/hooks.json#hooks.PreToolUse (matcher `^(Bash|shell|run_shell|run_shell_command|exec_command)$`).
 */

import { run as runDestructiveGitGuard } from '../destructive-git-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runDestructiveGitGuard, { cli: 'codex' });
