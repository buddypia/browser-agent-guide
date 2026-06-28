#!/usr/bin/env node

/**
 * antigravity/worktree-shipping-guard.mjs — Antigravity CLI Stop hook adapter.
 *
 * The domain logic lives in .claude/hooks/worktree-shipping-guard.mjs.
 * This adapter only normalizes Antigravity/Gemini-shaped hook stdin into the
 * Claude-shaped payload expected by the shared hook.
 */

import { run as runWorktreeShippingGuard } from '../worktree-shipping-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runWorktreeShippingGuard, { cli: 'antigravity' });
