#!/usr/bin/env node

/**
 * codex/worktree-review-report-guard.mjs — Codex CLI Stop hook 어댑터
 *
 * 본체 .claude/hooks/worktree-review-report-guard.mjs 의 run(data) 를 위임.
 * Codex 의 Stop 이벤트 stdin 도 Claude 호환 schema 가정 + normalize.
 * 본체의 main 가드는 `import.meta.url === file://argv[1]` 이라 import 시 미실행 (어댑터 안전).
 *
 * 등록 위치: .codex/hooks.json#hooks.Stop.
 */

import { run as runWorktreeReviewReportGuard } from '../worktree-review-report-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runWorktreeReviewReportGuard, { cli: 'codex' });
