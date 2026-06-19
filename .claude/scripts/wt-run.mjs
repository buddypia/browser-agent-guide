#!/usr/bin/env node
/**
 * wt-run.mjs — Redirect command execution to the active worktree.
 *
 * 이 스크립트는 AI 세션 중 CWD가 메인 저장소로 리셋되었을 때,
 * 자동으로 활성화된 worktree를 찾아 그 안에서 검증/체크 명령어를 실행시킵니다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

function parseArgs(args) {
  let worktree = null;
  const cmdArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--worktree' || arg === '-w') {
      worktree = args[++i] || null;
    } else {
      cmdArgs.push(arg);
    }
  }

  return { worktree, cmdArgs };
}

function resolveActiveWorktree(explicitWt) {
  if (explicitWt) {
    return resolve(REPO_ROOT, explicitWt);
  }

  // 1. CONTEXT.json에서 활성 worktree 검출
  const ctxPath = join(REPO_ROOT, 'CONTEXT.json');
  if (existsSync(ctxPath)) {
    try {
      const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8'));
      if (ctx.execution?.worktree?.worktree_path) {
        return resolve(REPO_ROOT, ctx.execution.worktree.worktree_path);
      }
    } catch {
      // ignore
    }
  }

  // 2. git worktree list에서 .worktrees/ 하위 worktree 검출
  try {
    const stdout = execSync('git worktree list --porcelain', { cwd: REPO_ROOT, encoding: 'utf-8' });
    const lines = stdout.split('\n');
    const wtPaths = [];
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const p = line.slice('worktree '.length).trim();
        // check if it is under .worktrees/
        if (p.includes('/.worktrees/')) {
          wtPaths.push(p);
        }
      }
    }

    if (wtPaths.length === 1) {
      return wtPaths[0];
    } else if (wtPaths.length > 1) {
      console.warn(`[wt-run] 경고: 여러 개의 활성 worktree가 발견되었습니다. 첫 번째(${wtPaths[0]})를 사용합니다.`);
      return wtPaths[0];
    }
  } catch {
    // ignore
  }

  return null;
}

const { worktree: explicitWt, cmdArgs } = parseArgs(process.argv.slice(2));

if (cmdArgs.length === 0) {
  console.error('❌ wt-run: 실행할 명령어가 필요합니다. 예) node .claude/scripts/wt-run.mjs npm run test');
  process.exit(2);
}

const targetCwd = resolveActiveWorktree(explicitWt) || REPO_ROOT;

if (targetCwd === REPO_ROOT) {
  console.warn(`[wt-run] 경고: 활성화된 worktree를 찾을 수 없습니다. 메인 저장소 루트(${targetCwd})에서 실행합니다.`);
} else {
  console.log(`[wt-run] CWD 리다이렉션: ${targetCwd}`);
}

const cmdString = cmdArgs.join(' ');
console.log(`[wt-run] 실행 명령어: ${cmdString}`);

const child = spawnSync(cmdString, {
  cwd: targetCwd,
  stdio: 'inherit',
  shell: true,
});

process.exit(child.status ?? 0);
