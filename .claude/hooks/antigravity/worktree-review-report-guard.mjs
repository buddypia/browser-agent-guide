#!/usr/bin/env node

/**
 * antigravity/worktree-review-report-guard.mjs — Antigravity CLI Stop hook adapter.
 *
 * The domain logic lives in .claude/hooks/worktree-review-report-guard.mjs.
 * This adapter only normalizes Antigravity/Gemini-shaped hook stdin into the
 * Claude-shaped payload expected by the shared hook.
 */

import { run as runWorktreeReviewReportGuard } from '../worktree-review-report-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runWorktreeReviewReportGuard, { cli: 'antigravity' });
