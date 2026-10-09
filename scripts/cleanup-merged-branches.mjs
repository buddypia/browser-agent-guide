#!/usr/bin/env node
/**
 * cleanup-merged-branches.mjs
 *
 * Scans local branches (excluding protected branches), checks if their changes
 * have been fully merged into origin/main (via git merge-base, GitHub PR state
 * MERGED with matching HEAD commit, or git merge-tree), and deletes merged
 * branches cleanly and idempotently.
 *
 * Usage:
 *   node scripts/cleanup-merged-branches.mjs [--dry-run]
 *   make clean.branches
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PROTECTED_BRANCHES = new Set(['main', 'master', 'HEAD', 'develop', 'release']);

/**
 * Validates whether a branch name is safe to manipulate.
 * Rejects protected branches, names starting with flags, or invalid ref characters.
 */
export function isSafeBranchName(branch) {
  if (!branch || typeof branch !== 'string') return false;
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith('-') || trimmed.startsWith('/') || trimmed.endsWith('/')) return false;
  if (trimmed.includes('..') || trimmed.includes('@{') || /[\s~^:?*[\\]/.test(trimmed)) return false;
  if (PROTECTED_BRANCHES.has(trimmed)) return false;
  return true;
}

/**
 * Pure merge decision logic.
 *
 * Evaluates in order of cost and safety:
 * 1. Direct ancestor / fast-forward into origin/main (O(1) local commit graph).
 * 2. GitHub PR merged with matching HEAD commit SHA (prevents deleting branches with unmerged new commits).
 * 3. Tree-identical match (squash-merged into origin/main with no subsequent diff).
 *
 * @param {object} params
 * @param {boolean} params.isAncestor - Whether branch commit is an ancestor of origin/main
 * @param {string|null} params.mainTree - Tree SHA of origin/main
 * @param {string|null} params.mergedTree - Tree SHA resulting from merge-tree
 * @param {string|null} params.branchHeadSha - Current HEAD commit SHA of the branch
 * @param {Array<{ number: number, state: string, headRefOid: string }>} [params.prList] - PRs associated with branch
 * @returns {{ merged: boolean, reason?: string }}
 */
export function judgeBranchMerged({ isAncestor, mainTree, mergedTree, branchHeadSha, prList = [] }) {
  if (isAncestor) {
    return { merged: true, reason: 'fast-forward / ancestor of origin/main' };
  }

  if (Array.isArray(prList) && branchHeadSha) {
    const matchingPr = prList.find((p) => p.state === 'MERGED' && p.headRefOid === branchHeadSha);
    if (matchingPr) {
      return { merged: true, reason: `PR #${matchingPr.number} was merged at matching HEAD ${branchHeadSha.slice(0, 7)}` };
    }
  }

  if (mainTree && mergedTree && mergedTree === mainTree) {
    return { merged: true, reason: 'tree-identical (squash-merged into origin/main)' };
  }

  return { merged: false };
}

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, ...opts }).trim();
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
    .filter((b) => isSafeBranchName(b));
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

/**
 * Bulk-fetch recent PRs in a single query to eliminate O(N) network calls and rate limiting.
 * Returns a Map of headRefName -> Array of PR info objects.
 */
export function fetchPrCache() {
  const prMap = new Map();
  const prJson = sh('gh', ['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'number,state,headRefOid,headRefName']);
  if (!prJson) return prMap;

  try {
    const prs = JSON.parse(prJson);
    if (Array.isArray(prs)) {
      for (const pr of prs) {
        if (!pr.headRefName) continue;
        if (!prMap.has(pr.headRefName)) {
          prMap.set(pr.headRefName, []);
        }
        prMap.get(pr.headRefName).push(pr);
      }
    }
  } catch {}
  return prMap;
}

/**
 * Retrieves PRs for a branch. Checks bulk cache first, and falls back to a targeted query
 * if the branch was not found in the recent PR list.
 */
export function getBranchPrs(branch, prCache, runFn = sh) {
  if (prCache && prCache.has(branch)) {
    return prCache.get(branch);
  }
  const prJson = runFn('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '5', '--json', 'number,state,headRefOid,headRefName']);
  if (!prJson) return [];
  try {
    const list = JSON.parse(prJson);
    if (Array.isArray(list)) {
      if (prCache) prCache.set(branch, list);
      return list;
    }
  } catch {}
  return [];
}

/**
 * Safely deletes a remote branch if it exists and matches the expected commit SHA.
 */
function deleteRemoteBranchSafely(branch, expectedSha) {
  if (!isSafeBranchName(branch)) return;

  // Verify remote ref existence and compare SHA if available
  const remoteSha = sh('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (!remoteSha) {
    // Already absent on remote or not tracked
    return;
  }

  if (expectedSha && remoteSha !== expectedSha) {
    console.warn(`[cleanup-branches] Remote branch origin/${branch} moved to ${remoteSha.slice(0, 7)} (different from local ${expectedSha.slice(0, 7)}). Skipping remote deletion.`);
    return;
  }

  const pushRes = spawnSync('git', ['push', 'origin', '--delete', '--', branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = (pushRes.stderr || '').trim();
  if (pushRes.status === 0) {
    console.log(`[cleanup-branches] DELETED remote branch: origin/${branch}`);
  } else if (/remote ref does not exist/i.test(stderr)) {
    // Already absent on remote - benign idempotent no-op
  } else {
    console.warn(`[cleanup-branches] Note: Could not delete remote origin/${branch}: ${stderr}`);
  }
}

export function main(dryRun = false) {
  // Ensure remote origin/main is fetched (graceful fallback if offline)
  sh('git', ['fetch', '-q', 'origin', 'main']);
  const mainTree = sh('git', ['rev-parse', '--verify', '--quiet', 'origin/main^{tree}']);

  const branches = getLocalBranches();
  if (branches.length === 0) {
    console.log('[cleanup-branches] No feature branches to clean up.');
    return;
  }

  const activeWorktrees = getActiveWorktreeBranches();
  const prCache = fetchPrCache();
  let deletedCount = 0;

  for (const branch of branches) {
    if (!isSafeBranchName(branch)) continue;

    if (activeWorktrees.has(branch)) {
      console.log(`[cleanup-branches] SKIP: ${branch} is currently active in a worktree.`);
      continue;
    }

    const branchHeadSha = sh('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (!branchHeadSha) continue;

    // 1. Fast ancestor check (fastest local check)
    const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', '--', branch, 'origin/main']).status === 0;

    // 2. PR check (bulk cache with single-branch fallback)
    const branchPrs = getBranchPrs(branch, prCache);

    // 3. Tree check (compute only if ancestor and PR checks do not conclude)
    // NOTE: git merge-tree takes refs directly; '--' causes parse option stop and usage error 129
    let mergedTree = null;
    if (!isAncestor && (!branchPrs.length || !branchPrs.some((p) => p.state === 'MERGED' && p.headRefOid === branchHeadSha)) && mainTree) {
      mergedTree = sh('git', ['merge-tree', '--write-tree', 'origin/main', `refs/heads/${branch}`]);
    }

    const { merged, reason } = judgeBranchMerged({ isAncestor, mainTree, mergedTree, branchHeadSha, prList: branchPrs });
    if (!merged) {
      console.log(`[cleanup-branches] KEEP: ${branch} is not fully merged into origin/main.`);
      continue;
    }

    if (dryRun) {
      console.log(`[cleanup-branches] (dry-run) WOULD DELETE: ${branch} (${reason})`);
      deletedCount++;
    } else {
      const res = spawnSync('git', ['branch', '-D', '--', branch], { encoding: 'utf8' });
      if (res.status === 0) {
        console.log(`[cleanup-branches] DELETED: ${branch} (${reason})`);
        deletedCount++;
        deleteRemoteBranchSafely(branch, branchHeadSha);
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
