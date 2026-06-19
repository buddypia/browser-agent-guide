#!/usr/bin/env node

/**
 * trunk-start-warning.mjs - SessionStart Hook
 *
 * main 브랜치에서 AI 세션 진입 시 worktree 안내를 컨텍스트로 주입한다.
 *
 * R-CM-006 Rule 1 정합: SessionStart 는 side-effect-only 이벤트이므로
 * 세션 흐름 자체를 차단할 수 없다 (Claude Code Hooks spec —
 * https://code.claude.com/docs/en/hooks). 따라서 본 hook 은 deny/block 이 아닌
 * additionalContext 주입만 수행한다.
 *
 * 실제 destructive 차단 (main 직접 commit / 새 branch 생성 / force push) 은
 * commit-guard / branch-create-guard / destructive-git-guard 가 PreToolUse 시점에서 담당한다.
 *
 * 본 hook 은 advisory(안내) 전용이라 선택 사항이다 — 매 main 세션 컨텍스트 주입 비용이
 * 가치보다 크다고 판단되면 hook-registry 에서 제거해도 실제 차단(위 guard 들)에는 영향이 없다.
 *
 * 우회 조건 (경고 미주입):
 *   - 환경변수 `ALLOW_MAIN_SESSION=1` 설정 시
 *   - 현재 브랜치가 main 이 아닐 때 (hotfix/* 등 자동 면제)
 */

import {
  readStdin,
  output,
  safeHookMainWithProfile,
  safeGit,
  resolveProjectDir,
} from '../scripts/lib/utils.mjs';
import { HookOutput } from '../scripts/lib/hook-output.mjs';

export async function run(data) {
  try {
    const projectDir = resolveProjectDir(data);
    const branch = safeGit('branch --show-current', projectDir, { timeout: 2000 });

    if (!branch) return HookOutput.passthrough();
    if (branch !== 'main') return HookOutput.passthrough();

    // Bypass check
    if (process.env.ALLOW_MAIN_SESSION === '1' || process.env.ALLOW_MAIN_SESSION === 'true') {
      return HookOutput.passthrough();
    }

    const warningMessage =
      `[Trunk Warning] main 브랜치에서 AI 세션이 진행 중입니다.\n\n` +
      `AI 작업은 격리된 Git worktree 에서 진행하는 것이 표준입니다.\n` +
      `main 직접 commit / 새 branch 생성 / force push 는 별도 guard 에서 차단됩니다.\n\n` +
      `→ worktree 생성:\n` +
      `    make wt.new BR=feature/<task>\n\n` +
      `→ 본 경고 미주입 (read-only 탐색 등):\n` +
      `    ALLOW_MAIN_SESSION=1 환경변수 설정 시 본 안내 미표시`;

    return HookOutput.context(warningMessage, 'SessionStart');
  } catch (_) {
    return HookOutput.passthrough();
  }
}

if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMainWithProfile('trunk-start-warning', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
