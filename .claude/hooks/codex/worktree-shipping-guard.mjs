#!/usr/bin/env node

/**
 * codex/worktree-shipping-guard.mjs — Codex CLI Stop hook 어댑터
 *
 * 본체 .claude/hooks/worktree-shipping-guard.mjs 의 run(data) 를 위임.
 * Codex 의 Stop 이벤트 stdin 도 Claude 호환 schema 가정 + normalize.
 *
 * 등록 위치: .codex/hooks.json#hooks.Stop.
 */

import { run as runWorktreeShippingGuard } from '../worktree-shipping-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runWorktreeShippingGuard, { cli: 'codex' });
