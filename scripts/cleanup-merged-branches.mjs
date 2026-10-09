#!/usr/bin/env node
/**
 * cleanup-merged-branches.mjs
 *
 * Scans local branches (excluding main/master), checks if their changes
 * have been fully merged into origin/main (via git merge-base, git merge-tree,
 * or GitHub PR state MERGED), and deletes merged branches cleanly.
 *
 * Usage:
 *   node scripts/cleanup-merged-branches.mjs [--dry-run]
 *   make clean.branches
 */

import { execFileSync, spawnSync } from 'node:child_process';

const DRY_RUN = process.argv.includes('--dry-run');

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts }).status === 0;
}

function getLocalBranches() {
  const out = sh('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  if (!out) return [];
  return out
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b && b !== 'main' && b !== 'master');
}

function getActiveWorktreeBranches() {
  const out = sh('git', ['worktree', 'list', '--porcelain']);
  if (!out) return new Set();
  const branches = new Set();
  for (const line of out.split('\n')) {
    if (line.startsWith('branch refs/heads/')) {
      branches.add(line.slice('branch refs/heads/'.length).trim());
    }
  }
  return branches;
}

function isBranchMerged(branch, mainTree) {
  // 1. Fast-forward / direct ancestor
  const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', branch, 'origin/main']).status === 0;
  if (isAncestor) {
    return { merged: true, reason: 'fast-forward / ancestor of origin/main' };
  }

  // 2. Squash-merged tree match (no subsequent changes to touched files)
  if (mainTree) {
    const mergedTree = sh('git', ['merge-tree', '--write-tree', 'origin/main', branch]);
    if (mergedTree && mergedTree === mainTree) {
      return { merged: true, reason: 'tree-identical (squash-merged into origin/main)' };
    }
  }

  // 3. GitHub PR state check via gh CLI
  const prJson = sh('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state']);
  if (prJson) {
    try {
      const prs = JSON.parse(prJson);
      const mergedPr = prs.find((p) => p.state === 'MERGED');
      if (mergedPr) {
        return { merged: true, reason: `PR #${mergedPr.number} was merged` };
      }
    } catch {}
  }

  return { merged: false };
}

function main() {
  // Fetch latest remote refs first
  sh('git', ['fetch', '-q', 'origin', 'main']);
  const mainTree = sh('git', ['rev-parse', 'origin/main^{tree}']);

  const branches = getLocalBranches();
  if (branches.length === 0) {
    console.log('[cleanup-branches] No feature branches to clean up.');
    return;
  }

  const activeWorktrees = getActiveWorktreeBranches();
  let deletedCount = 0;

  for (const branch of branches) {
    if (activeWorktrees.has(branch)) {
      console.log(`[cleanup-branches] SKIP: ${branch} is currently active in a worktree.`);
      continue;
    }

    const { merged, reason } = isBranchMerged(branch, mainTree);
    if (!merged) {
      console.log(`[cleanup-branches] KEEP: ${branch} is not fully merged into origin/main.`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`[cleanup-branches] (dry-run) WOULD DELETE: ${branch} (${reason})`);
      deletedCount++;
    } else {
      const res = spawnSync('git', ['branch', '-D', branch], { encoding: 'utf8' });
      if (res.status === 0) {
        console.log(`[cleanup-branches] DELETED: ${branch} (${reason})`);
        deletedCount++;
        // Best-effort remote branch deletion if remote branch still lingers
        spawnSync('git', ['push', 'origin', '--delete', branch], { stdio: 'ignore' });
      } else {
        console.error(`[cleanup-branches] FAILED to delete ${branch}: ${res.stderr?.trim()}`);
      }
    }
  }

  if (DRY_RUN) {
    console.log(`[cleanup-branches] Dry-run complete. ${deletedCount} branch(es) would be deleted.`);
  } else {
    console.log(`[cleanup-branches] Done. ${deletedCount} merged branch(es) cleaned up.`);
  }
}

main();
