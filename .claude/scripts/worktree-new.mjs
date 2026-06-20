#!/usr/bin/env node
/**
 * worktree-new.mjs — Worktree freshness enforcement standard entry point (Layer 1).
 *
 * 목적: 새 worktree 가 항상 최신 `origin/<base>` 기준으로 시작되도록 강제. raw
 * `git worktree add ... -b ...` 가 stale local main 위에서 분기하는 함정을 차단한다.
 * Claude Code / Codex / Gemini CLI 모두 같은 진입점을 사용 (CLI agnostic).
 *
 * 흐름:
 *   1) `git fetch origin <base>` (network 실패 → fail-loud + hint)
 *   2) main worktree 이고 base 가 origin/<base> 의 FF 가능 → `git merge --ff-only` 시도
 *      (이미 동일하거나 ahead 면 SKIP). non-FF → STOP + 수동 reconcile 안내.
 *   3) `git worktree add <path> -b <branch> origin/<base>` (이미 같은 path/branch
 *      가 등록되어 있고 동일하면 멱등 SKIP; 다른 branch/path 충돌은 STOP)
 *   4) `node .claude/scripts/worktree-init.mjs --worktree <path>` chain
 *      (local CLI env + PLAN.md)
 *   5) JSON 보고: { ok, branch, base, base_sha, worktree_path, plan_path,
 *                   actions: [...], warnings: [...] }
 *
 * 사용:
 *   node .claude/scripts/worktree-new.mjs --branch feature/<task>
 *   node .claude/scripts/worktree-new.mjs --branch fix/<bug> --base main
 *   node .claude/scripts/worktree-new.mjs --branch feature/<task> --dry-run
 *
 * exit code:
 *   0 — 성공 (생성 또는 멱등 SKIP)
 *   1 — git 실패 (fetch / non-FF / 충돌)
 *   2 — 사용자/인자 오류
 *
 * 본 스크립트는 R-CM-008 Rule 4-6 + worktree freshness 요구사항의 단일 진입점이다.
 * 직접 `git worktree add` 호출을 대체한다. 가이드 문서 (CLAUDE.md / commit-guard /
 * worktree-policy-guard) 가 본 스크립트를 가리킨다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

const KNOWN_BRANCH_PREFIXES = ['feature', 'fix', 'hotfix', 'chore', 'refactor', 'docs', 'test'];

/* ============================================================
 * CLI parsing
 * ============================================================ */

function parseArgs(argv) {
  const args = { branch: null, base: 'main', dryRun: false, path: null, json: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--branch' || a === '-b') args.branch = argv[++i] || null;
    else if (a === '--base') args.base = argv[++i] || 'main';
    else if (a === '--path' || a === '-p') args.path = argv[++i] || null;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-json') args.json = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  return args;
}

const HELP = `worktree-new.mjs — Worktree freshness enforcement standard entry point

Usage:
  node .claude/scripts/worktree-new.mjs --branch <name> [--base main] [--path <dir>] [--dry-run]

Options:
  --branch, -b <name>   브랜치명 (필수). feature/<task> / fix/<bug> 형식 권장.
  --base <name>         원격 base 브랜치 (default: main). fetch + worktree base.
  --path, -p <dir>      worktree 경로 (default: .worktrees/<branch>).
  --dry-run             실행하지 않고 계획만 출력.
  --no-json             보고 JSON 대신 사람-읽기 텍스트만 stderr 로.
  --help, -h            본 메시지 출력.

흐름: fetch origin <base> → ff main (가능 시) → git worktree add origin/<base>
기준 → worktree-init.mjs chain.
`;

/* ============================================================
 * Helpers (injectable for tests)
 * ============================================================ */

export function defaultGitFn(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 60_000,
  });
}

export function defaultNodeFn(args, opts = {}) {
  return execFileSync(process.execPath, args, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 60_000,
  });
}

export function defaultExistsFn(p) {
  return existsSync(p);
}

/* ============================================================
 * Core
 * ============================================================ */

/**
 * Resolve main worktree root (where `.git` directory lives, not a worktree dir).
 */
export function resolveMainRoot(cwd, gitFn = defaultGitFn) {
  try {
    const commonDir = gitFn(['rev-parse', '--git-common-dir'], { cwd }).trim();
    if (!commonDir) return null;
    const absoluteCommonDir = resolve(cwd, commonDir);
    return dirname(absoluteCommonDir);
  } catch {
    return null;
  }
}

/**
 * Whether the given cwd is the main worktree (not a linked worktree).
 */
export function isMainWorktree(cwd, gitFn = defaultGitFn) {
  const mainRoot = resolveMainRoot(cwd, gitFn);
  if (!mainRoot) return false;
  try {
    return realpathSync(cwd) === realpathSync(mainRoot);
  } catch {
    return mainRoot === cwd;
  }
}

/**
 * Parse `git worktree list --porcelain` into a list of entries.
 * Returns: [{ path, branch, head }]
 */
export function listWorktrees(cwd, gitFn = defaultGitFn) {
  let out;
  try {
    out = gitFn(['worktree', 'list', '--porcelain'], { cwd });
  } catch {
    return [];
  }
  const entries = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (line.startsWith('HEAD ') && cur) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && cur) {
      const ref = line.slice('branch '.length);
      cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === '' && cur) {
      entries.push(cur);
      cur = null;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/**
 * Whether a local branch exists.
 */
export function localBranchExists(branch, cwd, gitFn = defaultGitFn) {
  try {
    gitFn(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether ref `a` is an ancestor of ref `b` (a → b is FF possible).
 */
export function isAncestor(a, b, cwd, gitFn = defaultGitFn) {
  try {
    gitFn(['merge-base', '--is-ancestor', a, b], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize a branch name into a path-safe segment list.
 *   feature/foo → .worktrees/feature/foo
 */
export function defaultWorktreePath(branch) {
  return join('.worktrees', branch);
}

/**
 * Validate branch name shape (very minimal — git ref rules are more permissive).
 */
export function validateBranch(branch) {
  if (!branch || typeof branch !== 'string') return 'branch is required';
  if (branch.includes('..') || branch.includes(' ') || branch.startsWith('-')) {
    return `invalid branch: "${branch}"`;
  }
  const first = branch.split('/')[0];
  if (!KNOWN_BRANCH_PREFIXES.includes(first)) {
    return `branch should start with one of ${KNOWN_BRANCH_PREFIXES.join('|')}/ (got "${first}/")`;
  }
  return null;
}

/* ============================================================
 * Main orchestrator (testable)
 * ============================================================ */

export function runWorktreeNew(opts) {
  const {
    branch,
    base = 'main',
    path: explicitPath = null,
    dryRun = false,
    cwd = REPO_ROOT,
    gitFn = defaultGitFn,
    nodeFn = defaultNodeFn,
    existsFn = defaultExistsFn,
  } = opts;

  const result = {
    ok: false,
    branch,
    base,
    base_sha: null,
    worktree_path: null,
    plan_path: null,
    actions: [],
    warnings: [],
    errors: [],
    dry_run: dryRun,
  };

  const branchErr = validateBranch(branch);
  if (branchErr) {
    result.errors.push(branchErr);
    return result;
  }

  const wtPathRel = explicitPath || defaultWorktreePath(branch);
  const wtPathAbs = resolve(cwd, wtPathRel);
  result.worktree_path = wtPathAbs;

  // Step 1: fetch origin <base>
  result.actions.push(`fetch origin ${base}`);
  if (!dryRun) {
    try {
      gitFn(['fetch', 'origin', base], { cwd, timeout: 60_000 });
    } catch (e) {
      result.errors.push(
        `fetch origin ${base} failed: ${(e.stderr || e.message || '').toString().trim()}`,
      );
      result.errors.push('hint: 네트워크 / origin 설정 확인 후 재시도. (git remote -v)');
      return result;
    }
  }

  // Resolve origin/<base> SHA for reporting + base for worktree add
  if (!dryRun) {
    try {
      result.base_sha = gitFn(['rev-parse', `origin/${base}`], { cwd }).trim();
    } catch (e) {
      result.errors.push(`rev-parse origin/${base} failed: ${(e.message || '').trim()}`);
      return result;
    }
  }

  // Step 2: FF main if we're in main worktree
  if (isMainWorktree(cwd, gitFn)) {
    let currentBranch = '';
    try {
      currentBranch = gitFn(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).trim();
    } catch {
      // ignore
    }
    if (currentBranch === base) {
      if (!dryRun) {
        const localAhead = parseInt(
          (() => {
            try {
              return gitFn(['rev-list', '--count', `origin/${base}..HEAD`], { cwd }).trim();
            } catch {
              return '0';
            }
          })() || '0',
          10,
        );
        const localBehind = parseInt(
          (() => {
            try {
              return gitFn(['rev-list', '--count', `HEAD..origin/${base}`], { cwd }).trim();
            } catch {
              return '0';
            }
          })() || '0',
          10,
        );
        if (localBehind === 0) {
          result.actions.push(`local ${base} is up-to-date with origin/${base} (no ff needed)`);
        } else if (localAhead === 0) {
          try {
            gitFn(['merge', '--ff-only', `origin/${base}`], { cwd });
            result.actions.push(`fast-forwarded local ${base} by ${localBehind} commits`);
          } catch (e) {
            result.errors.push(
              `fast-forward local ${base} failed: ${(e.stderr || e.message || '').toString().trim()}`,
            );
            return result;
          }
        } else {
          // local has unique commits — divergent. STOP (do not silently rebase).
          result.errors.push(
            `local ${base} diverged from origin/${base} (ahead ${localAhead}, behind ${localBehind}). ` +
              `silent rebase 위험 회피를 위해 STOP. 수동 reconcile 후 재시도하세요.`,
          );
          result.errors.push(
            `hint (worktree freshness recovery — rebase/merge 는 destructive-git-guard 차단 + main 직접 흐름이라 비권장): ` +
              `1) git format-patch origin/${base}..HEAD -o .tmp/git-backup/ (로컬 unique commits patch 백업) ` +
              `2) git reset --hard origin/${base} (사용자 직접 실행 — destructive-git-guard 가 AI 차단) ` +
              `3) make wt.new BR=feature/<task> 재시도 (diverge 해소 후 성공) ` +
              `4) worktree 안에서 git am <main>/.tmp/git-backup/*.patch (원본 author/message/timestamp 보존) ` +
              `5) /create-pr ship-worktree.`,
          );
          return result;
        }
      } else {
        result.actions.push(`(dry-run) would attempt ff-only merge of origin/${base} into ${base}`);
      }
    } else {
      result.warnings.push(
        `current branch is "${currentBranch}" (not ${base}); skipped ff of local ${base}. ` +
          `worktree 자체는 origin/${base} 기준으로 생성됩니다.`,
      );
    }
  } else {
    result.warnings.push(
      'invoked from a linked worktree (not main); skipped ff of local main. ' +
        `worktree 는 origin/${base} 기준으로 생성됩니다.`,
    );
  }

  // Step 3: git worktree add
  const existingWorktrees = listWorktrees(cwd, gitFn);
  const matchingWtForPath = existingWorktrees.find(
    (w) => resolve(w.path) === resolve(wtPathAbs),
  );
  const matchingWtForBranch = existingWorktrees.find((w) => w.branch === branch);

  if (matchingWtForPath && matchingWtForPath.branch === branch) {
    // 멱등: 동일 path + 동일 branch — 이미 등록된 worktree, skip add 그대로 init 으로.
    result.warnings.push(
      `worktree already registered at ${wtPathRel} on branch ${branch} (skipped add — idempotent).`,
    );
    result.actions.push('skip git worktree add (idempotent)');
  } else if (matchingWtForPath) {
    result.errors.push(
      `path ${wtPathRel} 가 다른 branch (${matchingWtForPath.branch}) worktree 로 등록되어 있습니다. ` +
        `먼저 git worktree remove ${wtPathRel} 후 재시도.`,
    );
    return result;
  } else if (matchingWtForBranch) {
    result.errors.push(
      `branch ${branch} 는 이미 다른 worktree (${matchingWtForBranch.path}) 에 체크아웃되어 있습니다. ` +
        `같은 branch 는 1 worktree 만 허용 — 다른 path 사용 또는 기존 worktree 정리.`,
    );
    return result;
  } else if (localBranchExists(branch, cwd, gitFn)) {
    // 이미 로컬 branch 가 존재 — origin/<base> 와의 FF 가능성 확인 후 add.
    if (!isAncestor(`origin/${base}`, branch, cwd, gitFn)) {
      result.warnings.push(
        `local branch "${branch}" 가 이미 존재하고 origin/${base} 의 후손이 아닙니다. ` +
          `기존 branch 그대로 worktree 추가 (base 강제 안 함) — stale 가능성 있음.`,
      );
    }
    result.actions.push(`git worktree add ${wtPathRel} (existing branch ${branch})`);
    if (!dryRun) {
      try {
        gitFn(['worktree', 'add', wtPathAbs, branch], { cwd, timeout: 60_000 });
      } catch (e) {
        result.errors.push(
          `git worktree add failed: ${(e.stderr || e.message || '').toString().trim()}`,
        );
        return result;
      }
    }
  } else {
    result.actions.push(
      `git worktree add ${wtPathRel} -b ${branch} origin/${base}`,
    );
    if (!dryRun) {
      try {
        gitFn(['worktree', 'add', wtPathAbs, '-b', branch, `origin/${base}`], {
          cwd,
          timeout: 60_000,
        });
      } catch (e) {
        result.errors.push(
          `git worktree add failed: ${(e.stderr || e.message || '').toString().trim()}`,
        );
        return result;
      }
    }
  }

  // Step 4: worktree-init.mjs chain
  // Use the checkout that owns this script for companion scripts.
  const initScript = join(REPO_ROOT, '.claude/scripts/worktree-init.mjs');
  if (!existsFn(initScript)) {
    result.warnings.push(
      `worktree-init.mjs not found at ${initScript} — skipped local env + PLAN.md setup.`,
    );
  } else {
    result.actions.push(`node worktree-init.mjs --worktree ${wtPathRel}`);
    if (!dryRun) {
      try {
        const out = nodeFn([initScript, '--worktree', wtPathAbs], { cwd, timeout: 30_000 });
        // worktree-init prints PLAN.md path on creation — parse for reporting.
        const planMatch = out.match(/PLAN\.md (?:자동 생성|이미 존재[^:]*): (.+)/);
        if (planMatch) {
          result.plan_path = resolve(wtPathAbs, planMatch[1].trim());
        }
      } catch (e) {
        result.errors.push(
          `worktree-init.mjs failed: ${(e.stderr || e.message || '').toString().trim()}`,
        );
        return result;
      }
    }
  }

  result.ok = true;
  return result;
}

/* ============================================================
 * CLI entry
 * ============================================================ */

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === __filename;
}

if (isMain()) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(HELP);
    process.exit(2);
  }

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!args.branch) {
    console.error('--branch <name> is required.');
    console.error(HELP);
    process.exit(2);
  }

  // Always operate from main worktree root so .worktrees/ 하위가 일관된다.
  // (worktree 안에서 호출해도 main repo 의 .worktrees/<branch> 로 생성됨)
  const invocationCwd = process.cwd();
  const mainRoot = resolveMainRoot(invocationCwd) || invocationCwd;

  const result = runWorktreeNew({
    branch: args.branch,
    base: args.base,
    path: args.path,
    dryRun: args.dryRun,
    cwd: mainRoot,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const a of result.actions) console.error(`[worktree-new] ${a}`);
    for (const w of result.warnings) console.error(`[worktree-new][warn] ${w}`);
    for (const e of result.errors) console.error(`[worktree-new][error] ${e}`);
    if (result.ok) {
      console.error(
        `[worktree-new] OK — worktree at ${result.worktree_path} (base ${result.base_sha || 'origin/' + result.base}).`,
      );
    }
  }

  process.exit(result.ok ? 0 : 1);
}
