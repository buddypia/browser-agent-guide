#!/usr/bin/env node
// run-checks.mjs — run package.json scripts concurrently, print each one's output as a block, fail if any fail.
// `npm run a && npm run b && …` paid one npm start per step (≈1.5 s each when parallel sessions load the machine)
// and ran node-only checks one after another; this runs them side by side without npm in between.
//
// Parallel-worktree optimizations:
// 1. Whole-gate stamp (`gate-stamps-v1` in `<mainRoot>/.tmp/agent-scratchpad/`): if the exact
//    worktree tree state (`HEAD` + `origin/main` + dirty file hashes) already passed this check list,
//    returns in ~15ms instead of re-running 19 scripts between pre-commit and `make ship`.
// 2. Diff-aware worktree scoping: on a feature branch (not `main`, not `CI`, and without `--all`),
//    skips checks whose dependency paths have zero changes against `origin/main`.
// 3. Cross-worktree content-digest cache (`check-cache-v1` in `<mainRoot>/.tmp/agent-scratchpad/`):
//    caches each script's pass result by the SHA-256 digest of its input files so parallel AI
//    worktrees share verification results for untouched subsystems.
//
// Usage: node scripts/run-checks.mjs [--all] [--no-cache] <script> [<script> …]
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeWorktreeStateKey,
  readCheckCache,
  readGateStamp,
  resolveScratchpadDir,
  sha256File,
  writeCheckCache,
  writeGateStamp,
} from './agent-scratchpad.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith('--')));
const names = rawArgs.filter((a) => !a.startsWith('--'));

const runAll = flags.has('--all') || process.env.RUN_ALL_CHECKS === '1' || process.env.CI === 'true';
const noCache = flags.has('--no-cache') || process.env.BAG_DISABLE_SCRATCHPAD === '1';

const unknown = names.filter((n) => !scripts[n]);
if (!names.length || unknown.length) {
  console.error(
    unknown.length ? `unknown package.json script(s): ${unknown.join(', ')}` : 'usage: run-checks.mjs <script>…',
  );
  process.exit(2);
}

// Dependency scopes for each `check:fast` script.
// - `paths`: repo-relative files/directories whose contents determine the check's cache digest.
// - `diffPaths`: repo-relative files/directories that trigger running the check in a feature worktree
//   (defaults to `paths` excluding `package.json`).
// - `includeGitState`: include `HEAD` + `origin/main` + working-tree status digest in the cache key
//   (used for checks that inspect commit range / git history like `check:harness` and `glossary:staleness`).
export const CHECK_INPUT_SCOPES = {
  'check:js': {
    paths: ['background', 'content', 'sidepanel', 'options', 'offscreen', 'lib', 'scripts', 'package.json'],
  },
  'check:harness': {
    paths: [
      'AGENTS.md',
      'CLAUDE.md',
      'Makefile',
      'package.json',
      '.agents',
      '.claude',
      '.codex',
      'scripts/check-harness.mjs',
      'scripts/harness-library.mjs',
      'scripts/auto-ship.mjs',
      'docs/harness',
    ],
    diffPaths: [
      'AGENTS.md',
      'CLAUDE.md',
      'Makefile',
      'package.json',
      '.agents',
      '.claude',
      '.codex',
      'scripts/check-harness.mjs',
      'scripts/harness-library.mjs',
      'scripts/auto-ship.mjs',
      'docs/harness',
    ],
    includeGitState: true,
  },
  'check:sync': {
    paths: [
      'scripts/check-sync-pairs.mjs',
      'lib/slug.js',
      'daemon/src/slug.js',
      'options/options.js',
      'background/service-worker.js',
      'content/content-script.js',
      'daemon/src/server.js',
      'package.json',
    ],
  },
  'check:markers': {
    paths: ['scripts/check-agent-markers.mjs', 'options', 'playground', 'sidepanel', 'offscreen', 'package.json'],
    diffPaths: ['scripts/check-agent-markers.mjs', 'options', 'playground', 'sidepanel', 'offscreen'],
    fileFilter: (f) => f === 'scripts/check-agent-markers.mjs' || f === 'package.json' || f.endsWith('.html'),
  },
  'check:glossary': {
    paths: [
      'glossary',
      'scripts/glossary',
      'background',
      'content',
      'sidepanel',
      'options',
      'offscreen',
      'lib',
      'daemon/src',
      'docs',
      'README.md',
      'package.json',
    ],
  },
  'glossary:staleness': {
    paths: [
      'glossary',
      'scripts/glossary',
      'background',
      'content',
      'sidepanel',
      'options',
      'offscreen',
      'lib',
      'daemon/src',
      'package.json',
    ],
    includeGitState: true,
  },
  'test:glossary': {
    paths: ['scripts/glossary', 'test/glossary', 'package.json'],
  },
  'test:slug': {
    paths: ['lib/slug.js', 'daemon/src/slug.js', 'test/slug.test.mjs', 'package.json'],
  },
  'test:recipe': {
    paths: ['lib/recipe.js', 'lib/storage.js', 'test/recipe-merge.test.mjs', 'package.json'],
  },
  'test:prompt': {
    paths: ['lib', 'content/content-script.js', 'test/prompt.test.mjs', 'package.json'],
  },
  'test:workflow-lib': {
    paths: ['lib/workflow.js', 'lib', 'test/workflow-lib.test.mjs', 'package.json'],
  },
  'test:eg2': {
    paths: ['lib/eg2-client.js', 'lib', 'test/eg2-client.test.mjs', 'package.json'],
  },
  'test:judge': {
    paths: ['lib/judge-client.js', 'lib', 'test/judge-client.test.mjs', 'package.json'],
  },
  'test:ai-client': {
    paths: ['lib/ai-client.js', 'lib', 'test/ai-client.test.mjs', 'package.json'],
  },
  'test:agent-verbs': {
    paths: [
      'content/content-script.js',
      'background/service-worker.js',
      'lib',
      'daemon/src/server.js',
      'daemon/src/mcp.js',
      'test/agent-verbs.test.mjs',
      'package.json',
    ],
  },
  'test:ship': {
    paths: [
      'scripts/auto-ship.mjs',
      'scripts/agent-scratchpad.mjs',
      '.claude/scripts/cleanup-merged-branches.mjs',
      '.claude/scripts/lib',
      'test/auto-ship.test.mjs',
      'test/cleanup-merged-branches.test.mjs',
      'package.json',
    ],
  },
  'test:agy-hooks': {
    paths: [
      '.agents/hooks.json',
      '.claude/settings.json',
      '.claude/hooks',
      '.claude/scripts/merge-guard.mjs',
      '.claude/scripts/lib',
      'scripts/agent-worktree-guard/guard.py',
      'test/antigravity-hooks.test.mjs',
      'package.json',
    ],
  },
  'test:harness': {
    paths: [
      'scripts/check-harness.mjs',
      'scripts/harness-library.mjs',
      'scripts/check-sync-pairs.mjs',
      '.claude/hooks/post-edit-invariants.mjs',
      'test/check-harness.test.mjs',
      'test/harness-library.test.mjs',
      'AGENTS.md',
      'CLAUDE.md',
      'Makefile',
      '.agents',
      '.claude',
      '.codex',
      'docs/harness',
      'package.json',
    ],
    diffPaths: [
      'scripts/check-harness.mjs',
      'scripts/harness-library.mjs',
      'scripts/check-sync-pairs.mjs',
      '.claude/hooks/post-edit-invariants.mjs',
      'test/check-harness.test.mjs',
      'test/harness-library.test.mjs',
    ],
    includeGitState: true,
  },
  'test:pf': {
    paths: ['lib/page-feedback', 'content', 'offscreen', 'background', 'test/page-feedback', 'package.json'],
  },
};

function matchesPrefix(relPath, prefixes) {
  for (const p of prefixes) {
    if (relPath === p || relPath.startsWith(`${p}/`)) return true;
  }
  return false;
}

function getRepoFiles(cwd) {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(out.split('\n').filter(Boolean))]
      .filter((f) => existsSync(join(cwd, f)))
      .sort();
  } catch {
    return [];
  }
}

function getWorktreeChangedContext(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    execFileSync('git', ['rev-parse', '--verify', 'origin/main'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const branchDiff = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const wtDiff = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const changed = [...new Set([...branchDiff.split('\n'), ...wtDiff.split('\n'), ...untracked.split('\n')].filter(Boolean))];
    return { branch, hasOriginMain: true, changed };
  } catch {
    return { branch: 'main', hasOriginMain: false, changed: [] };
  }
}

function computeScopeDigest(cwd, repoFiles, scope, state, fileHashMemo) {
  if (!scope) return null;
  const matched = repoFiles.filter((f) => {
    if (!matchesPrefix(f, scope.paths)) return false;
    return scope.fileFilter ? scope.fileFilter(f) : true;
  });
  const hash = createHash('sha256');
  hash.update(`cmd:${scope.scriptCmd || ''}\n`);
  if (scope.includeGitState) {
    hash.update(`git:${state.headSha}:${state.baseSha}:${state.statusDigest}\n`);
  }
  for (const rel of matched) {
    let fHash = fileHashMemo.get(rel);
    if (fHash === undefined) {
      fHash = sha256File(join(cwd, rel)) ?? '<missing>';
      fileHashMemo.set(rel, fHash);
    }
    hash.update(`${rel}:${fHash}\n`);
  }
  return hash.digest('hex');
}

const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (isMain) {
  const scratchDir = resolveScratchpadDir(root);
  const state = computeWorktreeStateKey(root);
  const gateName = `run-checks:${runAll ? 'all:' : ''}${names.join(',')}`;

  if (!noCache) {
    const stamp = readGateStamp(scratchDir, gateName, state.treeKey);
    if (stamp) {
      for (const name of names) {
        console.log(`ok   ${name} (0.0s, gate-stamp cached)`);
      }
      console.log(`\nall ${names.length} passed (scratchpad gate stamp ${state.treeKey.slice(0, 12)})`);
      process.exit(0);
    }
  }

  const repoFiles = getRepoFiles(root);
  const { branch, hasOriginMain, changed } = getWorktreeChangedContext(root);
  const canDiffSkip = !runAll && hasOriginMain && branch !== 'main' && branch !== 'HEAD';
  const fileHashMemo = new Map();

  // npm puts node_modules/.bin on PATH for its scripts; keep that without starting npm.
  const env = { ...process.env, PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}` };

  function runOne(item) {
    const { name, inputDigest } = item;
    const started = Date.now();
    return new Promise((done) => {
      const child = spawn('sh', ['-c', scripts[name]], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('close', (code) =>
        done({
          name,
          code,
          out,
          inputDigest,
          secs: ((Date.now() - started) / 1000).toFixed(1),
        }),
      );
    });
  }

  const queue = [];
  const results = [];

  for (const name of names) {
    const rawScope = CHECK_INPUT_SCOPES[name];
    const scope = rawScope ? { ...rawScope, scriptCmd: scripts[name] } : null;

    if (scope && canDiffSkip) {
      const diffPrefixes = scope.diffPaths || scope.paths.filter((p) => p !== 'package.json');
      const touched = changed.some((f) => {
        if (!matchesPrefix(f, diffPrefixes) && f !== 'package.json') return false;
        return scope.fileFilter ? scope.fileFilter(f) : true;
      });
      if (!touched) {
        results.push({ name, code: 0, out: '', secs: '0.0', skipped: 'unchanged' });
        console.log(`ok   ${name} (0.0s, skipped: unchanged vs origin/main)`);
        continue;
      }
    }

    const inputDigest = scope ? computeScopeDigest(root, repoFiles, scope, state, fileHashMemo) : null;
    if (!noCache && inputDigest) {
      const hit = readCheckCache(scratchDir, name, inputDigest);
      if (hit) {
        results.push({ name, code: 0, out: '', secs: '0.0', skipped: 'cached' });
        console.log(`ok   ${name} (0.0s, scratchpad cache hit)`);
        continue;
      }
    }

    queue.push({ name, inputDigest });
  }

  if (queue.length > 0) {
    const workerCount = Math.min(queue.length, Math.max(2, Math.floor(availableParallelism() / 2)));
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const item = queue.shift();
        const r = await runOne(item);
        results.push(r);
        if (r.code === 0 && !noCache && r.inputDigest) {
          writeCheckCache(scratchDir, r.name, r.inputDigest, { branch, secs: r.secs });
        }
        // Passing steps print one line; a failing step prints its whole output so the cause is in the log.
        console.log(
          r.code === 0
            ? `ok   ${r.name} (${r.secs}s)`
            : `FAIL ${r.name} (${r.secs}s, exit ${r.code})\n${r.out.trimEnd()}\n`,
        );
      }
    });
    await Promise.all(workers);
  }

  const failed = results.filter((r) => r.code !== 0).map((r) => r.name);
  if (failed.length) {
    console.error(`\n${failed.length}/${names.length} failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  if (!noCache) {
    writeGateStamp(scratchDir, gateName, state.treeKey, { branch, count: names.length });
  }
  console.log(`\nall ${names.length} passed`);
}
