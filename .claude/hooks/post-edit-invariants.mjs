#!/usr/bin/env node

/**
 * post-edit-invariants.mjs — PostToolUse(Edit|Write|MultiEdit|apply_patch): re-check what an edit can break
 *
 * harness2 (Google Research) 의 원칙: 에이전트가 계속 건너뛰는 규칙은 always-on 산문을 늘리지 말고
 * tool loop 안에서 기계적으로 막는다. 편집 직후, 편집된 경로가 영향을 줄 수 있는 검사만 돌려서
 * 위반이 있으면 {decision:'block', reason} 으로 이유를 모델에게 즉시 돌려준다 (편집 자체는 이미 끝남).
 *   - AGENTS.md / CLAUDE.md / .agents/skills/** / hook 파일 → scripts/check-harness.mjs
 *   - sync pair 의 한쪽 (slug 사본, recipe/agent 동사 allow-list) → scripts/check-sync-pairs.mjs
 *   - .claude/hooks/** · .claude/scripts/** → .claude/scripts/check-hook-refs.mjs (hook 은 import 실패 시 fail-OPEN)
 * 검사는 편집된 파일을 담은 checkout 기준 (worktree 는 그 자체가 root). 이 프로젝트가 아닌 checkout 은 건너뛴다.
 *
 * 등록 위치: .claude/settings.json#hooks.PostToolUse (matcher `Edit|Write|MultiEdit`),
 *           .codex/hooks.json#hooks.PostToolUse (codex/post-edit-invariants.mjs 어댑터 경유).
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { readStdin, output, safeHookMainWithProfile } from '../scripts/lib/utils.mjs';
import { HookOutput } from '../scripts/lib/hook-output.mjs';
import { extractApplyPatchFilePaths } from '../scripts/lib/apply-patch-paths.mjs';
import { isHarnessPath, validateHarness } from '../../scripts/check-harness.mjs';
import { checkSyncPairs } from '../../scripts/check-sync-pairs.mjs';
import { collectProblems } from '../scripts/check-hook-refs.mjs';

const MARKER = 'scripts/check-harness.mjs';

/** 편집 대상 파일의 절대 경로 배열. */
export function editedPaths(data) {
  const toolName = data?.tool_name || '';
  const input = data?.tool_input || {};
  const cwd = data?.cwd || process.cwd();
  if (toolName === 'apply_patch') return extractApplyPatchFilePaths(input.command, cwd);
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return [];
  const raw = input.file_path;
  if (!raw || typeof raw !== 'string') return [];
  return [isAbsolute(raw) ? raw : join(cwd, raw)];
}

/** 파일을 담은 checkout root (`.git` 이 디렉터리든 worktree 의 파일이든). */
export function checkoutRoot(file) {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function hookRefProblems(root) {
  const dirs = [join(root, '.claude/hooks'), join(root, '.claude/scripts')];
  return collectProblems(dirs, root).map((p) => `check-hook-refs: ${p} (a hook with a broken import fails OPEN)`);
}

export async function run(data) {
  try {
    const byRoot = new Map();
    for (const file of editedPaths(data)) {
      const root = checkoutRoot(file);
      if (!root || !existsSync(join(root, MARKER))) continue;
      if (!byRoot.has(root)) byRoot.set(root, new Set());
      byRoot.get(root).add(relative(root, file).replace(/\\/g, '/'));
    }

    const problems = [];
    let harness = false;
    for (const [root, rels] of byRoot) {
      const touched = [...rels];
      if (touched.some(isHarnessPath)) {
        const { errors } = validateHarness(root);
        if (errors.length) harness = true;
        problems.push(...errors);
      }
      problems.push(...checkSyncPairs(root, { touched }));
      if (touched.some((r) => r.startsWith('.claude/hooks/') || r.startsWith('.claude/scripts/'))) {
        problems.push(...hookRefProblems(root));
      }
    }
    if (problems.length === 0) return HookOutput.passthrough();

    return HookOutput.block(
      [
        'post-edit-invariants: this edit left the repo inconsistent. Fix it before moving on:',
        ...problems.map((p) => `- ${p}`),
        ...(harness ? ['Harness rules: .agents/skills/harness-rules/SKILL.md'] : []),
      ].join('\n')
    );
  } catch (_) {
    return HookOutput.passthrough();
  }
}

// Standalone fallback (settings.json 직접 호출 시)
if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMainWithProfile('post-edit-invariants', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
