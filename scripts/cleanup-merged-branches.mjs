#!/usr/bin/env node
/**
 * cleanup-merged-branches.mjs
 *
 * Scans local branches (excluding main/master), checks if their changes
 * have been fully merged into origin/main (via git merge-base, git merge-tree,
 * or GitHub PR state MERGED with matching HEAD commit), and deletes merged
 * branches cleanly.
 *
 * Usage:
 *   node scripts/cleanup-merged-branches.mjs [--dry-run]
 *   make clean.branches
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Pure merge decision logic.
 *
 * Checks:
 * 1. Direct ancestor / fast-forward into origin/main.
 * 2. Tree-identical match (squash-merged with no later changes).
 * 3. GitHub PR merged with matching HEAD commit SHA (protects against new local commits).
 */
export function judgeBranchMerged({ isAncestor, mainTree, mergedTree, branchHeadSha, prList }) {
  if (isAncestor) {
    return { merged: true, reason: 'fast-forward / ancestor of origin/main' };
  }

  if (mainTree && mergedTree && mergedTree === mainTree) {
    return { merged: true, reason: 'tree-identical (squash-merged into origin/main)' };
  }

  if (Array.isArray(prList) && branchHeadSha) {
    const matchingPr = prList.find((p) => p.state === 'MERGED' && p.headRefOid === branchHeadSha);
    if (matchingPr) {
      return { merged: true, reason: `PR #${matchingPr.number} was merged at matching HEAD ${branchHeadSha.slice(0, 7)}` };
    }
  }

  return { merged: false };
}

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
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

export function main(dryRun = false) {
  // Ensure remote origin/main is fresh
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

    const branchHeadSha = sh('git', ['rev-parse', branch]);
    const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', branch, 'origin/main']).status === 0;
    const mergedTree = mainTree ? sh('git', ['merge-tree', '--write-tree', 'origin/main', branch]) : null;

    let prList = [];
    const prJson = sh('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,headRefOid']);
    if (prJson) {
      try {
        prList = JSON.parse(prJson);
      } catch {}
    }

    const { merged, reason } = judgeBranchMerged({ isAncestor, mainTree, mergedTree, branchHeadSha, prList });
    if (!merged) {
      console.log(`[cleanup-branches] KEEP: ${branch} is not fully merged into origin/main.`);
      continue;
    }

    if (dryRun) {
      console.log(`[cleanup-branches] (dry-run) WOULD DELETE: ${branch} (${reason})`);
      deletedCount++;
    } else {
      const res = spawnSync('git', ['branch', '-D', branch], { encoding: 'utf8' });
      if (res.status === 0) {
        console.log(`[cleanup-branches] DELETED: ${branch} (${reason})`);
        deletedCount++;

        // Only delete remote branch if remote ref exists and matches local HEAD
        const remoteSha = sh('git', ['rev-parse', `refs/remotes/origin/${branch}`]);
        if (remoteSha && remoteSha === branchHeadSha) {
          spawnSync('git', ['push', 'origin', '--delete', branch], { stdio: 'ignore' });
        }
      } else {
        console.error(`[cleanup-branches] FAILED to delete ${branch}: ${res.stderr?.trim()}`);
      }
    }
  }

  if (dryRun) {
    console.log(`[cleanup-branches] Dry-run complete. ${deletedCount} branch(es) would be deleted.`);
  } else {
    console.log(`[cleanup-branches] Done. ${deletedCount} merged branch(es) cleaned up.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.includes('--dry-run'));
}
