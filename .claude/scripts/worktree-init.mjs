#!/usr/bin/env node
/**
 * worktree-init.mjs — linked worktree local setup helper
 *
 * Purpose: normalize repo-local hook config, inject per-worktree Git env for
 * local AI CLIs, and create the standard PLAN.md when missing.
 *
 * Usage:
 *   node .claude/scripts/worktree-init.mjs
 *   node .claude/scripts/worktree-init.mjs --worktree <path>
 *   node .claude/scripts/worktree-init.mjs --dry-run
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureWorktreePlan } from './lib/worktree-plan-template.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function getOpt(name) {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] || null;
}

const worktreeArg = getOpt('--worktree');
const WORKTREE = resolve(worktreeArg || process.cwd());

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

function info(msg) {
  console.log(msg);
}

function resolveMainWorktreeRoot(cwd) {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!commonDir) return null;
    return dirname(resolve(cwd, commonDir));
  } catch {
    return null;
  }
}

function readGitConfig(cwd, key) {
  try {
    return execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function normalizeHooksPath(cwd) {
  const current = readGitConfig(cwd, 'core.hooksPath');
  if (current === '.husky') {
    info('[worktree-init] core.hooksPath already relative: .husky (no-op)');
    return;
  }

  if (DRY_RUN) {
    info(`[worktree-init] (dry-run) core.hooksPath update: ${current || '(unset)'} -> .husky`);
    return;
  }

  execFileSync('git', ['config', 'core.hooksPath', '.husky'], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  info(`[worktree-init] core.hooksPath update: ${current || '(unset)'} -> .husky`);
}

const mainRoot = resolveMainWorktreeRoot(WORKTREE);
if (!mainRoot) {
  fail(1, `[worktree-init] could not resolve git common dir. cwd=${WORKTREE}`);
}

normalizeHooksPath(WORKTREE);

function ensurePlanIfApplicable() {
  if (DRY_RUN) return;
  try {
    const result = ensureWorktreePlan(WORKTREE);
    if (result.created) {
      info(`[worktree-init] PLAN.md created: ${relative(WORKTREE, result.path)}`);
    } else {
      info(`[worktree-init] PLAN.md already exists: ${relative(WORKTREE, result.path)}`);
    }
  } catch (e) {
    info(`[worktree-init] PLAN.md setup skipped: ${e.message}`);
  }
}

const MAIN_LOG_LINES = 5;

function showMainRecentCommits() {
  if (DRY_RUN) return;
  try {
    const log = execFileSync('git', ['log', '--oneline', `-${MAIN_LOG_LINES}`, 'origin/main'], {
      cwd: WORKTREE,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (log) {
      const indented = log.split('\n').map((l) => `  ${l}`).join('\n');
      info(`[worktree-init] recent origin/main commits:\n${indented}`);
    }
  } catch {
    // origin/main may not exist yet; setup should still succeed.
  }
}

function readGitDir(worktreePath) {
  const dotGitPath = join(worktreePath, '.git');
  let gitDir = join(mainRoot, '.git');
  try {
    const gitContent = readFileSync(dotGitPath, 'utf-8').trim();
    if (gitContent.startsWith('gitdir:')) {
      gitDir = gitContent.slice('gitdir:'.length).trim();
    }
  } catch {
    // Main worktrees usually have a .git directory, not a gitdir file.
  }
  return gitDir;
}

function injectGitEnv(worktreePath) {
  if (DRY_RUN) return;
  try {
    const gitDir = readGitDir(worktreePath);

    const settingsLocalPath = join(worktreePath, '.claude', 'settings.local.json');
    let existing = {};
    if (existsSync(settingsLocalPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsLocalPath, 'utf-8'));
      } catch {
        // ignore malformed machine-local config
      }
    }

    const merged = {
      ...existing,
      env: {
        ...(existing.env || {}),
        GIT_WORK_TREE: worktreePath,
        GIT_DIR: gitDir,
      },
    };

    mkdirSync(dirname(settingsLocalPath), { recursive: true });
    writeFileSync(settingsLocalPath, JSON.stringify(merged, null, 2) + '\n');
    info(`[worktree-init] Claude env injected: ${relative(worktreePath, settingsLocalPath)}`);

    const codexConfigPath = join(worktreePath, '.codex', 'config.toml');
    let codexContent = '';
    if (existsSync(codexConfigPath)) {
      codexContent = readFileSync(codexConfigPath, 'utf-8');
    }

    const envBlockPattern = /^\[env\]\s*$/m;
    const worktreeLine = `GIT_WORK_TREE = "${worktreePath}"`;
    const gitDirLine = `GIT_DIR = "${gitDir}"`;

    if (envBlockPattern.test(codexContent)) {
      let lines = codexContent.split('\n');
      let envIdx = lines.findIndex((line) => line.trim() === '[env]');
      let wtIdx = lines.findIndex((line, i) => i > envIdx && line.trim().startsWith('GIT_WORK_TREE'));
      if (wtIdx !== -1) lines.splice(wtIdx, 1);
      envIdx = lines.findIndex((line) => line.trim() === '[env]');
      let dirIdx = lines.findIndex((line, i) => i > envIdx && line.trim().startsWith('GIT_DIR'));
      if (dirIdx !== -1) lines.splice(dirIdx, 1);
      envIdx = lines.findIndex((line) => line.trim() === '[env]');
      lines.splice(envIdx + 1, 0, worktreeLine, gitDirLine);
      codexContent = lines.join('\n');
    } else {
      if (codexContent && !codexContent.endsWith('\n')) {
        codexContent += '\n';
      }
      codexContent += `\n[env]\n${worktreeLine}\n${gitDirLine}\n`;
    }

    mkdirSync(dirname(codexConfigPath), { recursive: true });
    writeFileSync(codexConfigPath, codexContent);
    info(`[worktree-init] Codex env injected: ${relative(worktreePath, codexConfigPath)}`);

    const agentsConfigPath = join(worktreePath, '.agents', 'config.json');
    let agentsExisting = {};
    if (existsSync(agentsConfigPath)) {
      try {
        agentsExisting = JSON.parse(readFileSync(agentsConfigPath, 'utf-8'));
      } catch {
        // ignore malformed machine-local config
      }
    }

    const agentsMerged = {
      ...agentsExisting,
      env: {
        ...(agentsExisting.env || {}),
        GIT_WORK_TREE: worktreePath,
        GIT_DIR: gitDir,
      },
    };

    mkdirSync(dirname(agentsConfigPath), { recursive: true });
    writeFileSync(agentsConfigPath, JSON.stringify(agentsMerged, null, 2) + '\n');
    info(`[worktree-init] Antigravity env injected: ${relative(worktreePath, agentsConfigPath)}`);
  } catch (e) {
    info(`[worktree-init] env injection skipped: ${e.message}`);
  }
}

injectGitEnv(WORKTREE);
ensurePlanIfApplicable();
showMainRecentCommits();
process.exit(0);
