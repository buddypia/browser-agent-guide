// Shared cross-worktree scratchpad & verification cache (`<mainRoot>/.tmp/agent-scratchpad/`).
//
// Multiple AI sessions (Claude Code, Codex, Antigravity) work in parallel git worktrees
// under `.worktrees/<branch>`. Without shared state, every worktree repeats identical
// `node --check` spawns, unit/tooling test suites on untouched subsystems, full `check:fast`
// runs between pre-commit and `make ship`, `claude -p` headless reviews on the same commit,
// and `npm ci` installs.
//
// This module resolves the shared main worktree's `.tmp/agent-scratchpad/` directory
// (overrideable via `BAG_AGENT_SCRATCHPAD_DIR` for isolated tests) and provides atomic,
// content-addressed caches that any worktree can safely read and update concurrently.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const mainRootMemo = new Map();

const DEFAULT_CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_GATE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_REVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_JS_SYNTAX_HASHES = 2500;
const MAX_DIGESTS_PER_CHECK = 32;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Resolve the primary worktree root (parent of the shared `.git` directory).
 * Falls back to `resolve(cwd)` when not inside a git repository.
 */
export function resolveMainRoot(cwd = process.cwd()) {
  const key = resolve(cwd);
  if (mainRootMemo.has(key)) return mainRootMemo.get(key);
  let root = key;
  try {
    const commonDirRaw = git(key, ['rev-parse', '--git-common-dir']);
    if (commonDirRaw) {
      const commonDir = isAbsolute(commonDirRaw)
        ? resolve(commonDirRaw)
        : resolve(key, commonDirRaw);
      root = dirname(commonDir);
    }
  } catch {
    root = key;
  }
  mainRootMemo.set(key, root);
  return root;
}

/**
 * Resolve the shared scratchpad directory (`<mainRoot>/.tmp/agent-scratchpad`).
 * Honours `BAG_AGENT_SCRATCHPAD_DIR` for isolated tests or custom overrides.
 */
export function resolveScratchpadDir(cwd = process.cwd()) {
  const override = process.env.BAG_AGENT_SCRATCHPAD_DIR?.trim();
  if (override) return resolve(override);
  return join(resolveMainRoot(cwd), '.tmp', 'agent-scratchpad');
}

export function isScratchpadDisabled() {
  return process.env.BAG_DISABLE_SCRATCHPAD === '1';
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256File(absPath) {
  try {
    const stat = lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      return `symlink:${readlinkSync(absPath)}`;
    }
    if (!stat.isFile()) return null;
    const buf = readFileSync(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compute a deterministic SHA-256 digest over a set of root-relative file paths
 * and their current contents. Sorted and deduplicated so input order does not matter.
 */
export function computeFilesDigest(rootDir, relPaths, extraSalt = '') {
  const unique = [...new Set(relPaths.map((p) => p.replace(/\\/g, '/')))].sort();
  const hash = createHash('sha256');
  if (extraSalt) hash.update(`salt:${extraSalt}\n`);
  for (const rel of unique) {
    const abs = join(rootDir, rel);
    const fileHash = sha256File(abs);
    hash.update(`${rel}:${fileHash ?? '<missing>'}\n`);
  }
  return hash.digest('hex');
}

/**
 * Compute a composite state key for the current worktree (`HEAD` SHA, base SHA,
 * and content digests of any dirty/untracked files).
 */
export function computeWorktreeStateKey(cwd = process.cwd(), { baseRef = 'origin/main' } = {}) {
  let headSha = 'NO_HEAD';
  let treeSha = 'NO_TREE';
  let baseSha = 'NO_BASE';
  let statusRaw = '';
  try {
    headSha = git(cwd, ['rev-parse', 'HEAD']);
    treeSha = git(cwd, ['rev-parse', 'HEAD^{tree}']);
  } catch {
    /* unborn or non-git */
  }
  try {
    baseSha = git(cwd, ['rev-parse', '--verify', baseRef]);
  } catch {
    baseSha = headSha;
  }
  try {
    statusRaw = execFileSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    statusRaw = '';
  }

  const dirtyHash = createHash('sha256');
  const lines = statusRaw.split('\n').filter(Boolean);
  for (const line of lines) {
    const rawPath = line.slice(3).trim();
    const relPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop().trim() : rawPath;
    const unquoted = relPath.replace(/^"|"$/g, '');
    const fileDigest = sha256File(join(cwd, unquoted));
    dirtyHash.update(`${line}:${fileDigest ?? '<missing>'}\n`);
  }
  const statusDigest = lines.length === 0 ? 'clean' : dirtyHash.digest('hex');
  const treeKey = sha256Text(`v1|head:${headSha}|tree:${treeSha}|base:${baseSha}|dirty:${statusDigest}`);
  return {
    headSha,
    treeSha,
    baseSha,
    isClean: lines.length === 0,
    dirtyCount: lines.length,
    statusDigest,
    treeKey,
  };
}

function sanitizeKey(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export function readScratchJson(scratchDir, relPath) {
  if (!scratchDir || isScratchpadDisabled()) return null;
  const target = join(scratchDir, relPath);
  try {
    if (!existsSync(target)) return null;
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

export function writeScratchJson(scratchDir, relPath, data) {
  if (!scratchDir || isScratchpadDisabled()) return false;
  const target = join(scratchDir, relPath);
  const dir = dirname(target);
  const tmp = `${target}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(data) + '\n', 'utf8');
    renameSync(tmp, target);
    return true;
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore cleanup error */
    }
    return false;
  }
}

// ─── 1. JS Syntax Cache (`js-syntax-v1.json`) ───────────────────────────────

const JS_SYNTAX_FILE = 'js-syntax-v1.json';

export function filterUncachedJsFiles(rootDir, relFiles, scratchDir = resolveScratchpadDir(rootDir)) {
  const cachedDoc = readScratchJson(scratchDir, JS_SYNTAX_FILE);
  const hashes = (cachedDoc && typeof cachedDoc.hashes === 'object' && cachedDoc.hashes) || {};
  const uncached = [];
  let cachedCount = 0;

  for (const rel of relFiles) {
    const abs = join(rootDir, rel);
    const sha256 = sha256File(abs);
    if (sha256 && hashes[sha256]) {
      cachedCount++;
    } else {
      uncached.push({ rel, abs, sha256 });
    }
  }
  return { uncached, cachedCount };
}

export function recordJsSyntaxPassed( passedSha256List, scratchDir = resolveScratchpadDir()) {
  if (!passedSha256List || passedSha256List.length === 0) return;
  const current = readScratchJson(scratchDir, JS_SYNTAX_FILE);
  const hashes = { ...((current && typeof current.hashes === 'object' && current.hashes) || {}) };
  const now = Date.now();
  for (const sha of passedSha256List) {
    if (sha) hashes[sha] = now;
  }
  const keys = Object.keys(hashes);
  if (keys.length > MAX_JS_SYNTAX_HASHES) {
    keys
      .sort((a, b) => (hashes[a] || 0) - (hashes[b] || 0))
      .slice(0, keys.length - MAX_JS_SYNTAX_HASHES)
      .forEach((k) => delete hashes[k]);
  }
  writeScratchJson(scratchDir, JS_SYNTAX_FILE, { version: 1, hashes });
}

// ─── 2. Per-Check / Per-Test Pass Cache (`check-cache-v1/<check>.json`) ────

function checkCacheRelPath(checkName) {
  return join('check-cache-v1', `${sanitizeKey(checkName)}.json`);
}

export function readCheckCache(
  scratchDir,
  checkName,
  inputDigest,
  { ttlMs = DEFAULT_CHECK_TTL_MS } = {},
) {
  if (!inputDigest) return null;
  const doc = readScratchJson(scratchDir, checkCacheRelPath(checkName));
  const entry = doc?.entries?.[inputDigest];
  if (!entry || typeof entry.passedAt !== 'number') return null;
  if (Date.now() - entry.passedAt > ttlMs) return null;
  return entry;
}

export function writeCheckCache(scratchDir, checkName, inputDigest, meta = {}) {
  if (!inputDigest) return false;
  const rel = checkCacheRelPath(checkName);
  const doc = readScratchJson(scratchDir, rel);
  const entries = { ...((doc && typeof doc.entries === 'object' && doc.entries) || {}) };
  entries[inputDigest] = {
    passedAt: Date.now(),
    ...meta,
  };
  const keys = Object.keys(entries);
  if (keys.length > MAX_DIGESTS_PER_CHECK) {
    keys
      .sort((a, b) => (entries[a]?.passedAt || 0) - (entries[b]?.passedAt || 0))
      .slice(0, keys.length - MAX_DIGESTS_PER_CHECK)
      .forEach((k) => delete entries[k]);
  }
  return writeScratchJson(scratchDir, rel, { version: 1, checkName, entries });
}

// ─── 3. Full Verification Gate Stamp (`gate-stamps-v1/<gate>-<treeKey>.json`) ─

function gateStampRelPath(gateName, treeKey) {
  const gateHash = sha256Text(String(gateName)).slice(0, 16);
  return join('gate-stamps-v1', `gate-${gateHash}-${sanitizeKey(treeKey)}.json`);
}

export function readGateStamp(
  scratchDir,
  gateName,
  treeKey,
  { ttlMs = DEFAULT_GATE_TTL_MS } = {},
) {
  if (!treeKey) return null;
  const doc = readScratchJson(scratchDir, gateStampRelPath(gateName, treeKey));
  if (!doc || typeof doc.passedAt !== 'number') return null;
  if (Date.now() - doc.passedAt > ttlMs) return null;
  return doc;
}

export function writeGateStamp(scratchDir, gateName, treeKey, meta = {}) {
  if (!treeKey) return false;
  return writeScratchJson(scratchDir, gateStampRelPath(gateName, treeKey), {
    version: 1,
    gateName,
    treeKey,
    passedAt: Date.now(),
    ...meta,
  });
}

// ─── 4. Headless AI Review Cache (`ai-reviews-v1/<headSha>-<baseSha>.json`) ─

function aiReviewRelPath(headSha, baseSha) {
  return join('ai-reviews-v1', `${sanitizeKey(headSha)}-${sanitizeKey(baseSha || 'main')}.json`);
}

export function readAiReviewCache(
  scratchDir,
  headSha,
  baseSha,
  { ttlMs = DEFAULT_REVIEW_TTL_MS } = {},
) {
  if (!headSha) return null;
  const doc = readScratchJson(scratchDir, aiReviewRelPath(headSha, baseSha));
  if (!doc || typeof doc.cachedAt !== 'number' || !doc.review) return null;
  if (Date.now() - doc.cachedAt > ttlMs) return null;
  return doc.review;
}

export function writeAiReviewCache(scratchDir, headSha, baseSha, review) {
  if (!headSha || !review) return false;
  return writeScratchJson(scratchDir, aiReviewRelPath(headSha, baseSha), {
    version: 1,
    headSha,
    baseSha: baseSha || 'main',
    cachedAt: Date.now(),
    review,
  });
}

// ─── 5. Shared `node_modules` Linker Across Worktrees ──────────────────────

/**
 * Link `<wtProjectDir>/node_modules` -> `<mainProjectDir>/node_modules` when both
 * have byte-identical `package-lock.json` and `<mainProjectDir>/node_modules` exists.
 *
 * If lockfiles differ (e.g. a branch modified dependencies) and `<wtProjectDir>/node_modules`
 * is currently a symlink, unlinks the symlink before falling back to `npm ci` so the
 * shared main `node_modules` is never mutated.
 */
export function canShareNodeModules(wtProjectDir, mainProjectDir, { existsFn = existsSync, sha256Fn = sha256File } = {}) {
  if (!wtProjectDir || !mainProjectDir) return false;
  const wtResolved = resolve(wtProjectDir);
  const mainResolved = resolve(mainProjectDir);
  if (wtResolved === mainResolved) return false;

  const mainModules = join(mainResolved, 'node_modules');
  const wtLock = join(wtResolved, 'package-lock.json');
  const mainLock = join(mainResolved, 'package-lock.json');
  if (!existsFn(mainModules) || !existsFn(wtLock) || !existsFn(mainLock)) return false;

  const wtHash = sha256Fn(wtLock);
  const mainHash = sha256Fn(mainLock);
  return Boolean(wtHash && mainHash && wtHash === mainHash);
}

export function linkSharedNodeModules(wtProjectDir, mainProjectDir) {
  const wtModules = join(resolve(wtProjectDir), 'node_modules');
  const mainModules = join(resolve(mainProjectDir), 'node_modules');
  try {
    const st = lstatSync(wtModules);
    if (st.isSymbolicLink()) {
      if (resolve(dirname(wtModules), readlinkSync(wtModules)) === mainModules) {
        return { linked: true, target: mainModules, reused: true };
      }
      unlinkSync(wtModules);
    } else {
      return { linked: false, reason: 'real_dir_exists' };
    }
  } catch {
    /* wtModules does not exist yet */
  }
  symlinkSync(mainModules, wtModules, 'dir');
  return { linked: true, target: mainModules, reused: false };
}

export function unlinkIfSymlinkNodeModules(wtProjectDir) {
  const wtModules = join(resolve(wtProjectDir), 'node_modules');
  try {
    if (lstatSync(wtModules).isSymbolicLink()) {
      rmSync(wtModules);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
