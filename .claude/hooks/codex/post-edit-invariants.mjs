#!/usr/bin/env node

/**
 * codex/post-edit-invariants.mjs — Codex CLI PostToolUse(apply_patch|Edit|Write|MultiEdit) 어댑터
 *
 * 본체 .claude/hooks/post-edit-invariants.mjs 의 run(data) 를 위임.
 * 본체의 standalone main 이 stdin 을 같이 읽지 않도록 __HOOK_ORCHESTRATOR__ 를 import 전에 세운다.
 *
 * 등록 위치: .codex/hooks.json#hooks.PostToolUse (matcher `^(apply_patch|Edit|Write|MultiEdit)$`).
 */

import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

globalThis.__HOOK_ORCHESTRATOR__ = true;
const { run } = await import('../post-edit-invariants.mjs');

runAdapter(run, { cli: 'codex' });
