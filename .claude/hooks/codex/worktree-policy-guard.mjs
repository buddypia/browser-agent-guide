#!/usr/bin/env node

/**
 * codex/worktree-policy-guard.mjs — Codex CLI PreToolUse(Edit|Write|MultiEdit) 어댑터
 *
 * 본체 .claude/hooks/worktree-policy-guard.mjs 의 run(data) 를 위임.
 * Codex 가 apply_patch 도 사용할 수 있으므로 matcher 에 포함 가능.
 *
 * 등록 위치: .codex/hooks.json#hooks.PreToolUse (matcher `^(apply_patch|Edit|Write|MultiEdit)$`).
 */

import { run as runWorktreePolicyGuard } from '../worktree-policy-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runWorktreePolicyGuard, { cli: 'codex' });
