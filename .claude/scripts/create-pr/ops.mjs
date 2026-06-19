#!/usr/bin/env node

/**
 * ops.mjs — create-pr 통합 실행 엔진 (8 명령, GitHub Flow, v2 응답 계약)
 *
 * 명령:
 *   Mode A (Staged 격리):  init / isolate / commit / ship-feature / finalize
 *   Mode B (Worktree):    verify-plan / ship-worktree / cleanup-worktree
 *
 * 출력 계약 (v2): stdout JSON 1줄
 *   성공: { ok: true,  mode, command, ... }                   (exit 0)
 *   실패: { ok: false, mode, command, error, hint?, details? } (exit 1)
 *
 *   sync_status 값: synced | fetch_failed | stash_failed | ff_failed | synced_with_stash_conflict
 *
 * Config: .claude/skills/create-pr/config.json
 *   { github_account, base_branch, enforce_ssh_remote? }  (base_branch 기본 main)
 *
 * 철칙: unstaged/untracked 파일은 실행 전후로 정확히 동일해야 한다.
 *   - worktree 격리: 원본 HEAD 불변
 *   - stash-based sync: main pull 시 원본 변경을 stash push/pop
 *
 * 보안: 모든 외부 명령은 execFileSync 배열 인자 → shell 미경유.
 *
 * 훅 연동: cmdInit이 .tmp/create-pr-active 플래그 생성 →
 *   commit-guard.mjs / destructive-git-guard.mjs 가 allowlist 모드 전환.
 *   cmdFinalize / cmdCleanupWorktree 종료 시 플래그 자동 제거.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { basename, join, resolve, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorktreePlanPath } from '../lib/worktree-plan-path.mjs';
import { getActiveRunPath, getPipelineDataRoot, getRunsRoot } from '../lib/layout-resolver.mjs';

// ═ Paths + Config ═
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Project root 산출. 다중 worktree 환경에서 AI 가 worktree 내부에서 ops.mjs 를
 * 직접 호출해도 main worktree root 회복하도록 보장.
 *
 * 우선순위:
 *   1. `process.env.CLAUDE_PROJECT_DIR` — 명시 override (테스트 / 사용자 지정).
 *   2. `git rev-parse --git-common-dir` 부모 — 모든 worktree 가 동일 main root 회귀.
 *      `.git` 디렉토리는 main worktree 안에 본체가 있고, 다른 worktree 들은
 *      `.git` 파일로 main 의 common-dir 를 가리킨다. 부모 = main worktree root.
 *   3. `__dirname` 기반 fallback — worktree 안에서 호출 시 worktree 루트로 떨어지는
 *      함정이 있어 마지막 fallback (이전 동작 호환성용 — git 외부 실행 환경).
 *
 * 회귀: tests/unit/create-pr-ops.test.mjs `resolveProjectRoot` describe block.
 */
export function resolveProjectRoot(cwd = process.cwd()) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // 빈 stdout 또는 '.' 만으로는 부모 추론이 의미 없다 — silent worktree-root
    // fallback 함정이 재현되므로 명시적으로 fallback 으로 보내고 stderr 흔적을 남긴다.
    if (commonDir && commonDir !== '.' && commonDir !== '') {
      return dirname(resolve(cwd, commonDir));
    }
    process.stderr.write(
      `[ops.mjs] resolveProjectRoot: git common-dir empty (cwd=${cwd}), falling back to __dirname-based path.\n`,
    );
  } catch {
    // git 외부 / git 미설치 — __dirname fallback 으로
  }
  return resolve(__dirname, '..', '..', '..');
}

const PROJECT_DIR = resolveProjectRoot();
const STATE_DIR = join(PROJECT_DIR, '.tmp', 'create-pr');
const ACTIVE_FLAG = join(PROJECT_DIR, '.tmp', 'create-pr-active');
const WT_DIR = join(STATE_DIR, 'wt');
const PATCH_FILE = join(STATE_DIR, 'patch');
const BRANCH_FILE = join(STATE_DIR, 'branch');
const MSG_FILE = join(STATE_DIR, 'msg');
const BODY_FILE = join(STATE_DIR, 'body');
const CONFIG_PATH = join(PROJECT_DIR, '.claude', 'skills', 'create-pr', 'config.json');

const CFG = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) : {};
const BASE_BRANCH = CFG.base_branch || 'main';
const GH_ACCOUNT = CFG.github_account || null;
const ENFORCE_SSH = CFG.enforce_ssh_remote === true;

// v2.1: 30s → 30min. ship-feature 는 MERGEABLE_TIMEOUT_MS=5min 동안 polling 하므로
// 30s threshold 는 활발히 동작 중인 ship-feature 직후 다른 명령이 flag 를 stale 로
// 판단하여 동시 진입 보호를 우회하는 사고를 유발한다. 30min 은 단일 사용자 CLI 의
// 합리적 사이클 상한.
// export: 회귀 테스트가 import 하여 헬퍼 복제 없이 검증.
export const ACTIVE_FLAG_STALE_MS = 30 * 60 * 1000;
const MERGEABLE_TIMEOUT_MS = 300_000;
const MERGEABLE_POLL_MS = 5_000;

// ═ Shell ═
// 네트워크 transient 에러 패턴 — 포트 차단/핫스팟 불안정 시 gh·git 호출의 *일시적* 실패.
// 논리 에러("already exists" / merge conflict / auth)는 포함하지 않는다 — 재시도해도 같은 결과.
// export: 회귀 테스트가 헬퍼 복제 없이 직접 검증.
const TRANSIENT_ERROR_PATTERNS = [
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENETUNREACH/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /timed out/i,
  // /timeout/i 는 의도적 제외 — GitHub API 422 검증 에러("...timeout: 0" 등)를 false-transient
  // 로 오재시도. 실제 timeout 은 /timed out/·ETIMEDOUT·/TLS handshake/·아래 Go http client 로 커버.
  /Client\.Timeout exceeded/i,
  /TLS handshake/i,
  /connection reset/i,
  /reset by peer/i,
  /connection closed/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /banner exchange/i,
  /kex_exchange_identification/i,
  /Could not read from remote repository/i,
  /Connection refused/i,
];

export function isTransient(err) {
  const msg = String(err && err.message ? err.message : err == null ? '' : err);
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(msg));
}

function defaultSleepSeconds(sec) {
  if (!(sec > 0)) return;
  try {
    execFileSync('sleep', [String(sec)], { stdio: 'ignore' });
  } catch {
    /* sleep 실패는 무시 — 재시도 진행 (delay 0 으로 강등) */
  }
}

// transient 네트워크 에러만 재시도. 논리 에러는 즉시 throw (재시도 무의미).
// opts.sleep 주입으로 테스트는 실제 대기 없이 검증.
export function retryTransient(fn, opts = {}) {
  const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? opts.attempts : 3;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleepSeconds;
  const baseDelaySec = Number.isFinite(opts.baseDelaySec) ? opts.baseDelaySec : 2;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= attempts || !isTransient(e)) throw e;
      sleep(Math.min(baseDelaySec * attempt, 8)); // 2s → 4s → 6s (상한 8s)
    }
  }
  throw lastErr;
}

function execOnce(cmd, opts = {}) {
  try {
    const r = execFileSync(cmd[0], cmd.slice(1), {
      cwd: opts.cwd || PROJECT_DIR,
      encoding: opts.raw ? 'buffer' : 'utf-8',
      timeout: opts.timeout ?? 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env || process.env,
      maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
    });
    return opts.raw ? r : (typeof r === 'string' ? r : r.toString('utf-8')).trim();
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim();
    throw new Error(`${cmd[0]} failed: ${stderr || e.message}`);
  }
}

// opts.retry > 1 일 때만 transient 재시도 (네트워크 호출 — gh / git fetch·push).
// 로컬 호출(git status / rev-parse / make q.check)은 retry 미지정 → 즉시 fail-fast.
function exec(cmd, opts = {}) {
  if (opts.retry && opts.retry > 1) {
    return retryTransient(() => execOnce(cmd, opts), { attempts: opts.retry, sleep: opts.sleep });
  }
  return execOnce(cmd, opts);
}

const git = (args, opts = {}) => exec(['git', ...args], opts);

let cachedToken = null;
function ghToken() {
  if (cachedToken) return cachedToken;
  if (!GH_ACCOUNT) {
    const err = new Error('config.github_account 미설정');
    err.details = { hint: `config: ${CONFIG_PATH}` };
    throw err;
  }
  // gh()의 env 구성 단계에서 eager 호출되어 exec 의 retry scope 밖이므로 직접 retryTransient.
  // (gh auth token 은 로컬 키링 조회라 보통 네트워크 무관이나, 첫 gh() 호출 transient 갭 차단.)
  cachedToken = retryTransient(() => exec(['gh', 'auth', 'token', '-u', GH_ACCOUNT]), { attempts: 3 });
  return cachedToken;
}

const gh = (args, opts = {}) => exec(['gh', ...args], {
  timeout: 60_000,
  retry: 3, // 모든 gh 호출은 api.github.com transient(TLS handshake timeout 등) 재시도. opts.retry 로 override.
  ...opts,
  env: { ...process.env, GH_TOKEN: ghToken(), GH_HOST: 'github.com' },
});

function resolveRepo() {
  const url = git(['remote', 'get-url', 'origin']);
  const m = url.match(/[:/]([^:/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin URL 파싱 실패: ${url}`);
  return m[1];
}

/**
 * `--worktree <p>` 인자를 PROJECT_DIR 기준 절대경로로 정규화한다.
 * 절대경로 입력은 그대로 반환 (false-prepend 회피).
 * 회귀 차단: tests/unit/create-pr-ops.test.mjs
 */
export function resolveWorktreeAbsPath(wtPath) {
  if (!wtPath) return wtPath;
  return isAbsolute(wtPath) ? wtPath : join(PROJECT_DIR, wtPath);
}

/**
 * `git worktree list --porcelain` 출력에서 worktree 절대 경로 목록을 추출.
 * Pure parser — 테스트 가능.
 *
 * 입력 예시:
 *   worktree /a/main
 *   HEAD abc...
 *   branch refs/heads/main
 *
 *   worktree /a/main/.worktrees/feature/foo
 *   HEAD def...
 *   branch refs/heads/feature/foo
 *
 * 정확 매칭 (`^worktree (.+)$`) 으로 향후 git 의 다른 `worktree`-시작 prefix
 * 확장 (예: hypothetical `worktree-config-file ...`) 과 충돌하지 않도록 보호.
 * 빈 path 는 capture group 결과로 자동 제외.
 *
 * @param {string} porcelainOutput
 * @returns {string[]}
 */
const WORKTREE_LINE_RE = /^worktree (.+)$/;

export function parseWorktreePaths(porcelainOutput) {
  if (!porcelainOutput) return [];
  const paths = [];
  for (const line of porcelainOutput.split(/\r?\n/)) {
    const match = WORKTREE_LINE_RE.exec(line);
    if (match) {
      // `.trim()` 은 trailing whitespace 방어용 — git porcelain 은 trailing space
      // 가 없는 것이 정상이지만, capture group 이 빨아들이는 경우 대비 (no-op 동등).
      const path = match[1].trim();
      if (path) paths.push(path);
    }
  }
  return paths;
}

/**
 * `git status --porcelain` 출력을 dirty/clean 으로 분류한다. Pure parser — 테스트 가능.
 *
 * Untracked 파일 (`?? path`) 은 의도적으로 제외 — 사용자의 ad-hoc 작업물이지 머지 결과와
 * 충돌하는 변경이 아니다. 머지 결과 ff 를 막는 것은 tracked file 의 unstaged/staged 변경.
 *
 * @param {string} porcelain - `git status --porcelain` 의 stdout
 * @returns {{status: 'clean'|'dirty', dirty_paths?: string[]}}
 */
export function parsePorcelainStatus(porcelain) {
  if (!porcelain || !porcelain.trim()) return { status: 'clean' };
  const dirty_paths = porcelain
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('??'))
    .map((line) => {
      const rest = line.slice(3).trim();
      // ff merge 영향은 rename 의 new path 측이므로 그것만 dirty_paths 에 보고.
      const arrow = rest.indexOf(' -> ');
      return arrow >= 0 ? rest.slice(arrow + 4).trim() : rest;
    })
    .filter(Boolean);
  return dirty_paths.length > 0 ? { status: 'dirty', dirty_paths } : { status: 'clean' };
}

/**
 * 머지 성공 후 main repo (PROJECT_DIR) 의 working tree dirty 상태를 감지한다.
 * 사용자가 main repo 에서 squash merge 결과와 충돌하는 unstaged 변경을 가지고 있으면
 * `git pull --ff-only` 실패 — AI 가 해당 상태를 인지해야 명시적 reconcile 안내 가능.
 *
 * git 호출 실패는 fail-open ('unknown') — ship 결과 자체에 영향 없음.
 *
 * @returns {{status: 'clean'|'dirty'|'unknown', dirty_paths?: string[]}}
 */
export function detectPostMergeMainStatus(cwd = PROJECT_DIR) {
  try {
    const status = git(['status', '--porcelain'], { cwd, timeout: 5_000 });
    return parsePorcelainStatus(status);
  } catch {
    return { status: 'unknown' };
  }
}

// ═ Pure helpers (테스트 가능) ═

/**
 * 파일 path 배열 → markdown box-drawing 트리 문자열.
 *
 * 입력: ["a.md", "b/c.mjs", "b/d.mjs"]
 * 출력:
 *   ├── a.md
 *   └── b/
 *       ├── c.mjs
 *       └── d.mjs
 *
 * 빈 배열 → '(no files)'.  사람용 표시 — JSON 응답에 그대로 노출.
 */
export function buildFileTree(files) {
  if (!Array.isArray(files) || files.length === 0) return '(no files)';
  const sorted = [...new Set(files.filter(Boolean))].sort();
  const root = {};
  for (const path of sorted) {
    const parts = path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      if (!Object.prototype.hasOwnProperty.call(node, part)) {
        node[part] = isLeaf ? null : {};
      } else if (node[part] === null && !isLeaf) {
        // 같은 이름이 leaf + 디렉토리로 모두 등장 시 디렉토리로 승격
        node[part] = {};
      }
      if (!isLeaf) node = node[part];
    }
  }
  const lines = [];
  const render = (node, prefix) => {
    const entries = Object.entries(node);
    entries.forEach(([name, child], idx) => {
      const isLast = idx === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const suffix = child !== null ? '/' : '';
      lines.push(prefix + connector + name + suffix);
      if (child !== null) render(child, prefix + (isLast ? '    ' : '│   '));
    });
  };
  render(root, '');
  return lines.join('\n');
}

/**
 * 머지된 PR 의 변경 파일 목록 수집. gh CLI 호출.
 * 실패 시 빈 배열 (핵심 머지 결과 영향 없음 — fail-open).
 */
function collectChangedFilesViaPr(prNumber, repo) {
  try {
    const out = gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'files']);
    const data = JSON.parse(out);
    if (!Array.isArray(data?.files)) return [];
    return data.files.map(f => f?.path).filter(p => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

/**
 * `/create-pr ship-worktree` post-merge 단계에서 followup-debt-tracker.mjs 의
 * `register --pr <num> --json` 을 호출하고, 등록된 DEBT 항목들을 응답에 가시화한다.
 *
 * R-CM-010 Iron Law 정합: silent execute 후 "자동 등록됐을 것" 추정 차단 — 결과를
 * `count` + `items` 로 명시 반환하여 AI 가 사용자에게 직접 보고 가능하게 한다.
 *
 * Fail-open (R-CM-033 #10 정합): script 부재 / invalid PR / 실행 실패 / stdout
 * parse 실패 모두 `{ error, count: 0, items: [] }` 반환 (throw X) — ship-worktree
 * 메인 흐름 차단 금지.
 *
 * @param {number} prNumber
 * @returns {{ error: string | null, count: number, items: Array<object> }}
 */
export function registerFollowupDebtFromPr(prNumber) {
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    return {
      error: `followup-debt registration skipped: invalid PR number (${prNumber})`,
      count: 0,
      items: [],
    };
  }
  const scriptPath = join(PROJECT_DIR, '.claude', 'scripts', 'followup-debt-tracker.mjs');
  if (!existsSync(scriptPath)) {
    return {
      error: `followup-debt-tracker script not found at ${scriptPath} — skipped`,
      count: 0,
      items: [],
    };
  }

  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [scriptPath, 'register', '--pr', String(prNumber), '--json'],
      {
        cwd: PROJECT_DIR,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        env: process.env,
      },
    );
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim();
    const errStdout = (e.stdout || '').toString().trim();
    const detail = stderr || errStdout || e.message;
    return {
      error: `followup-debt registration skipped: ${detail}`,
      count: 0,
      items: [],
    };
  }

  try {
    const parsed = JSON.parse((stdout || '').trim());
    return {
      error: null,
      count: typeof parsed.registered === 'number' ? parsed.registered : 0,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (e) {
    return {
      error: `followup-debt stdout parse failed: ${e.message}`,
      count: 0,
      items: [],
    };
  }
}

function deleteBranchAndStashes(branch) {
  if (!branch) return;
  try {
    const list = git(['stash', 'list']).split('\n').filter(Boolean);
    const toDrop = [];
    list.forEach((line, idx) => {
      const match = line.match(/^(?:stash@\{\d+\}:\s+)?(?:On|WIP on)\s+([^\s:]+):\s*auto-checkpoint/);
      if (match && match[1] === branch) toDrop.push(idx);
    });
    toDrop.reverse().forEach(idx => {
      try { git(['stash', 'drop', `stash@{${idx}}`]); } catch {}
    });
  } catch {}
  try { git(['branch', '-D', branch]); } catch {}
}

// PLAN.md 파서: 코드 블록/HTML 주석 strip 후 미완료 + non-cancelled 추출
function stripIgnoredSections(content) {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}
/**
 * PLAN.md 의 미완료 체크박스 (`- [ ]`) 중 cancellation 마커가 없는 항목만 추출.
 *
 * 인식 마커 (negative lookahead, 부가 텍스트 허용 패턴):
 *   - `(취소됨)` / `(취소됨 — 사유)` / `(취소됨, ...)` — 한국어 취소
 *   - `(dropped)` / `(dropped — 사유)` / `(dropped, scope 외)` — 영문 lowercase
 *   - `(Dropped)` / `(Dropped — ...)` — 영문 capitalized
 *   - `(deferred)` / `(deferred — 사유)` / `(deferred, V2 로 연기)` — R-CM-033 키워드 정합
 *   - `(Deferred)` / `(Deferred — ...)` — 영문 capitalized
 *   - `~~취소선~~` — markdown strikethrough (어디든)
 *
 * 본 함수는 production 진입점 — 테스트도 본 함수를 직접 import 해야 회귀 차단된다
 * (R-CM-024 Mechanism Truthfulness — spec 재정의 시 production 변경 silently
 * passthrough 위험).
 *
 * 자기-bootstrap 한계: ops.mjs 변경은 해당 변경이 포함된 PR 이 머지된 이후의
 * ship 호출부터 적용된다 — `/create-pr ship-worktree` 가 PROJECT_DIR 기준 main
 * worktree 의 ops.mjs (resolveProjectRoot 결과) 를 사용하기 때문이다.
 */
const UNCHECKED_RE =
  /^[\s]*[-*]\s\[\s\](?!.*(?:\(취소됨[^)]*\)|\(dropped[^)]*\)|\(Dropped[^)]*\)|\(deferred[^)]*\)|\(Deferred[^)]*\)|~~)).*$/gm;
export function parseUnchecked(content) {
  return stripIgnoredSections(content).match(UNCHECKED_RE) || [];
}

// AI 컨텍스트 분기 명확화
const STAGED_CMDS = new Set(['init', 'isolate', 'commit', 'ship-feature', 'finalize']);
const WORKTREE_CMDS = new Set(['verify-plan', 'ship-worktree', 'cleanup-worktree']);
function inferMode(command) {
  if (STAGED_CMDS.has(command)) return 'staged';
  if (WORKTREE_CMDS.has(command)) return 'worktree';
  return null;
}

// 동시 실행 보호: 30초 이내 active flag = 다른 세션 진행 중
function isStaleActiveFlag(flagPath, now = Date.now(), thresholdMs = ACTIVE_FLAG_STALE_MS) {
  if (!existsSync(flagPath)) return true;
  try {
    const mtime = statSync(flagPath).mtimeMs;
    return (now - mtime) > thresholdMs;
  } catch { return true; }
}

// ═ Args ═
function parseArgs(tokens) {
  const opts = {};
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('--')) continue;
    const key = tokens[i].slice(2);
    opts[key] = (tokens[i + 1] && !tokens[i + 1].startsWith('--')) ? tokens[++i] : true;
  }
  return opts;
}
function requireArg(args, key, { type = 'string' } = {}) {
  const v = args[key];
  if (v === undefined) throw new Error(`--${key} is required`);
  if (type === 'string' && typeof v !== 'string') {
    throw new Error(`--${key} requires a value (got: ${v}). 사용법: --${key} <value>`);
  }
  return v;
}

// ═ State ═
const readBranch = () => {
  if (!existsSync(BRANCH_FILE)) throw new Error('세션 없음. isolate 먼저 실행');
  return readFileSync(BRANCH_FILE, 'utf-8').trim();
};

function autoCleanup() {
  try { if (existsSync(ACTIVE_FLAG)) rmSync(ACTIVE_FLAG); } catch {}
  if (!existsSync(STATE_DIR)) return;
  if (existsSync(WT_DIR)) {
    try { git(['worktree', 'remove', WT_DIR, '--force']); } catch {}
    try { git(['worktree', 'prune']); } catch {}
  }
  if (existsSync(BRANCH_FILE)) {
    const branch = readFileSync(BRANCH_FILE, 'utf-8').trim();
    if (branch) { try { git(['branch', '-D', branch]); } catch {} }
  }
  rmSync(STATE_DIR, { recursive: true, force: true });
}

// Pre-Ship Review 마커 라이프사이클 (R-CM-030)
// 정상 ship 성공 시 즉시 unlink, cleanup-worktree 진입 시 stale GC 로 cancelled 흐름 누적 방지.
const SHIP_REVIEW_MARKER_PREFIX = 'pre-ship-review-confirmed-';
const SHIP_REVIEW_MARKER_MAX_AGE_MS = 60 * 60 * 1000;
export function shipReviewMarkerKey(branchOrPath) {
  if (!branchOrPath) return 'staged';
  const parts = String(branchOrPath).split(/[/\\]/).filter(Boolean);
  const idx = parts.lastIndexOf('.worktrees');
  const branch = (idx >= 0 && parts.length > idx + 2)
    ? parts.slice(idx + 1, idx + 3).join('/')
    : parts.length >= 2 ? parts.slice(-2).join('/') : parts[0];
  return branch.replace(/[/\\]/g, '__');
}
function unlinkShipReviewMarker(branchOrPath) {
  const key = shipReviewMarkerKey(branchOrPath);
  const path = join(PROJECT_DIR, '.tmp', `${SHIP_REVIEW_MARKER_PREFIX}${key}`);
  try { if (existsSync(path)) rmSync(path, { force: true }); } catch {}
}
function gcStaleShipReviewMarkers(maxAgeMs = SHIP_REVIEW_MARKER_MAX_AGE_MS) {
  const dir = join(PROJECT_DIR, '.tmp');
  if (!existsSync(dir)) return;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(SHIP_REVIEW_MARKER_PREFIX)) continue;
      const p = join(dir, name);
      try {
        if (Date.now() - statSync(p).mtime.getTime() > maxAgeMs) rmSync(p, { force: true });
      } catch {}
    }
  } catch {}
}

// SSH remote 검사 (opt-in via config.enforce_ssh_remote)
function checkSshRemoteIfRequired() {
  if (!ENFORCE_SSH) return;
  const remoteUrl = git(['remote', 'get-url', 'origin']);
  const isSsh = remoteUrl.startsWith('git@') || remoteUrl.startsWith('ssh://');
  if (!isSsh) {
    const err = new Error('origin이 SSH remote가 아님');
    err.details = {
      remote_url: remoteUrl,
      hint: 'config.enforce_ssh_remote=true 인 경우 SSH alias remote 필요. git remote set-url 로 전환 후 재시도.',
    };
    throw err;
  }
}

// ═ Mode A: Staged 격리 ═

function cmdInit() {
  if (!isStaleActiveFlag(ACTIVE_FLAG)) {
    const err = new Error('다른 create-pr 세션이 진행 중입니다 (30초 이내 active flag).');
    err.details = { hint: '진행 중 세션 종료를 기다리거나 .tmp/create-pr-active 를 수동 정리 후 재시도' };
    throw err;
  }
  autoCleanup();

  // brief2dev 고유: CI Mirror Gate (60min stamp freshness)
  const CI_MIRROR_STAMP = join(PROJECT_DIR, '.tmp', 'ci-mirror-passed');
  const STAMP_FRESHNESS_MS = 60 * 60 * 1000;
  let stampValid = false;
  if (existsSync(CI_MIRROR_STAMP)) {
    try {
      if (Date.now() - statSync(CI_MIRROR_STAMP).mtime.getTime() <= STAMP_FRESHNESS_MS) {
        stampValid = true;
      }
    } catch {}
  }
  if (!stampValid) {
    try {
      execFileSync('make', ['q.ci-mirror'], {
        cwd: PROJECT_DIR, stdio: 'pipe', encoding: 'utf-8', timeout: 600_000,
      });
    } catch (e) {
      const stdout = e.stdout || '';
      const stderr = e.stderr || '';
      const err = new Error(
        `CI 미러 (make q.ci-mirror) 실패. create-pr 스킬로 자동 수정 루프를 시작하거나, ` +
        `수동 수정 후 재시도하세요.\n\n[STDOUT]\n${stdout}\n[STDERR]\n${stderr}`
      );
      err.details = { stdout, stderr };
      throw err;
    }
  }

  const branch = git(['branch', '--show-current']);
  if (branch !== BASE_BRANCH) throw new Error(`현재 브랜치가 ${BASE_BRANCH}가 아님: ${branch}`);

  const stagedFiles = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (stagedFiles.length === 0) throw new Error('staged 파일 없음');

  const secretPattern = /\.(env|key|pem|p12|keystore)$|(^|\/)credentials\.json$|service-account/;
  const secrets = stagedFiles.filter(f => secretPattern.test(f));
  if (secrets.length) {
    const err = new Error(`기밀 파일 감지: ${secrets.join(', ')}`);
    err.details = { secrets };
    throw err;
  }

  checkSshRemoteIfRequired();
  ghToken();

  const warnings = [];
  try {
    git(['fetch', 'origin', BASE_BRANCH], { timeout: 30_000, retry: 3 });
  } catch (e) {
    warnings.push(`원격 fetch 실패: ${e.message}. 최신성 미검증.`);
  }
  try {
    const localSha = git(['rev-parse', 'HEAD']);
    const remoteSha = git(['rev-parse', `origin/${BASE_BRANCH}`]);
    if (localSha !== remoteSha) {
      const ahead = parseInt(git(['rev-list', '--count', `origin/${BASE_BRANCH}..HEAD`]) || '0', 10);
      const behind = parseInt(git(['rev-list', '--count', `HEAD..origin/${BASE_BRANCH}`]) || '0', 10);
      if (ahead > 0) {
        throw new Error(
          `로컬 ${BASE_BRANCH}이 origin/${BASE_BRANCH}보다 ${ahead}커밋 앞섬. ` +
          `먼저 push/PR 처리 후 재시도. (자동 push는 의도치 않은 commit 전파 위험으로 비활성화됨)`
        );
      }
      if (behind > 0) {
        warnings.push(
          `로컬 ${BASE_BRANCH}이 origin/${BASE_BRANCH}보다 ${behind}커밋 뒤쳐짐. ` +
          `finalize가 ff-merge로 자동 동기화 예정. PR 머지 시 충돌 가능성.`
        );
      }
    }
  } catch (e) {
    if (e.message.includes('앞섬')) throw e;
    warnings.push(`최신성 비교 실패: ${e.message}`);
  }

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, '.gitignore'), '*\n');
  writeFileSync(PATCH_FILE, exec(['git', 'diff', '--cached', '--binary'], { raw: true }));
  writeFileSync(ACTIVE_FLAG, String(Date.now()));

  return { ok: true, stagedFiles, baseCommit: git(['rev-parse', 'HEAD']), warnings };
}

function cmdIsolate(args) {
  const branchName = requireArg(args, 'branch');
  if (!existsSync(PATCH_FILE)) throw new Error('init 먼저 실행');

  git(['worktree', 'add', '-b', branchName, WT_DIR, 'HEAD']);
  writeFileSync(BRANCH_FILE, branchName);
  git(['apply', '--index', PATCH_FILE], { cwd: WT_DIR });

  writeFileSync(ACTIVE_FLAG, String(Date.now()));
  return { ok: true, branch: branchName, worktreeDir: WT_DIR };
}

function cmdCommit(args) {
  const message = requireArg(args, 'message');
  const files = (typeof args.files === 'string') ? args.files.split(',') : null;
  if (!existsSync(WT_DIR)) throw new Error('worktree 없음. isolate 먼저 실행');

  writeFileSync(MSG_FILE, message);
  const cmdArgs = files
    ? ['commit', '--only', '-F', MSG_FILE, '--', ...files]
    : ['commit', '-F', MSG_FILE];
  git(cmdArgs, { cwd: WT_DIR });

  writeFileSync(ACTIVE_FLAG, String(Date.now()));
  return { ok: true, sha: git(['rev-parse', 'HEAD'], { cwd: WT_DIR }).slice(0, 7) };
}

// 멱등 PR 생성: 동일 head의 open PR 있으면 재사용 + title/body 업데이트.
// gh() 가 transient(TLS timeout 등) 재시도하므로 list 일시 실패가 빈 결과처럼 보여
// 중복 create → "already exists" 로 멈추던 함정을 차단. create "already exists" 도 재탐지로 복구.
// ghFn 주입(default gh) — 회귀 테스트가 already-exists 복구 시나리오를 stub 으로 검증
// (detectExternalSupersetRisk 의 gitFn 주입 패턴과 동일).
export function getOrCreatePr({ base, head, title, body, repo }, ghFn = gh) {
  // ship-worktree 단독 호출 시 STATE_DIR 부재 가능 (init 비의존). 멱등 mkdir.
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(BODY_FILE, body);

  const findExistingPr = () => {
    const existing = ghFn([
      'pr', 'list', '--repo', repo, '--head', head, '--state', 'open',
      '--json', 'number,url',
    ]);
    const parsed = JSON.parse(existing);
    return Array.isArray(parsed) && parsed.length > 0
      ? { prNumber: parsed[0].number, prUrl: parsed[0].url }
      : null;
  };
  const useExisting = (found) => {
    try {
      ghFn(['pr', 'edit', String(found.prNumber), '--repo', repo, '--title', title, '--body-file', BODY_FILE]);
    } catch {}
    return { prNumber: found.prNumber, prUrl: found.prUrl, existing: true };
  };

  // 1) 기존 open PR 탐지 (gh transient 재시도 포함). 탐지 자체가 persistent 실패하면
  //    create 단계의 "already exists" 분기에서 복구하므로 여기선 삼키고 진행.
  try {
    const found = findExistingPr();
    if (found) return useExisting(found);
  } catch {
    /* 탐지 실패 — create 의 already-exists 복구에 위임 */
  }

  // 2) 생성. "already exists" = 이미 PR 존재(탐지가 transient 로 놓침) → 재탐지 복구.
  try {
    const url = ghFn([
      'pr', 'create', '--repo', repo, '--base', base, '--head', head,
      '--title', title, '--body-file', BODY_FILE,
    ]);
    const prNumber = parseInt(url.match(/\/pull\/(\d+)/)?.[1] || '0', 10);
    if (!prNumber) throw new Error(`PR 번호 파싱 실패: ${url}`);
    return { prNumber, prUrl: url, existing: false };
  } catch (e) {
    if (/already exists/i.test(String(e && e.message))) {
      try {
        const recovered = findExistingPr();
        if (recovered) return useExisting(recovered);
      } catch {
        /* 재탐지도 실패 — 원본 already-exists 에러로 'PR 존재' 사실 전달 */
      }
    }
    throw e;
  }
}

// BLOCKED/BEHIND 시 false 반환 (graceful pending), 타임아웃도 false
function waitMergeable(prNumber, repo) {
  let waited = 0;
  while (waited < MERGEABLE_TIMEOUT_MS) {
    const state = gh([
      'pr', 'view', String(prNumber), '--repo', repo,
      '--json', 'mergeStateStatus', '--jq', '.mergeStateStatus',
    ]);
    if (state === 'CLEAN' || state === 'UNSTABLE') return { mergeable: true, state };
    if (state === 'BLOCKED' || state === 'BEHIND') return { mergeable: false, state };
    execFileSync('sleep', [String(MERGEABLE_POLL_MS / 1000)]);
    waited += MERGEABLE_POLL_MS;
  }
  return { mergeable: false, state: 'TIMEOUT' };
}

function createAndMergePr({ base, head, title, body, deleteBranch = null, noMerge = false, worktreeDir = null }) {
  const repo = resolveRepo();
  const { prNumber, prUrl, existing } = getOrCreatePr({ base, head, title, body, repo });

  if (noMerge) {
    return { prNumber, prUrl, merged: false, pending: true, existing };
  }

  let { mergeable, state } = waitMergeable(prNumber, repo);
  if (!mergeable && worktreeDir && (state === 'BEHIND' || state === 'DIRTY' || state === 'BLOCKED')) {
    console.log(`[create-pr] PR #${prNumber}가 머지 불가능 상태(${state})입니다. 자동 동기화 및 재시도를 시도합니다.`);
    try {
      git(['fetch', 'origin', base], { cwd: worktreeDir, timeout: 30_000, retry: 3 });
      let syncSuccess = false;
      try {
        git(['merge', '--no-edit', `origin/${base}`], { cwd: worktreeDir });
        console.log(`[create-pr] 로컬 병합 성공.`);
        syncSuccess = true;
      } catch (mergeErr) {
        console.log(`[create-pr] 로컬 병합 충돌 발생. 자동 충돌 해결 시도...`);
        const conflictingFiles = git(['diff', '--name-only', '--diff-filter=U'], { cwd: worktreeDir })
          .trim()
          .split('\n')
          .filter(Boolean);
        
        const resolved = tryAutoResolveConflicts(worktreeDir, conflictingFiles);
        if (resolved) {
          const hasMakefile = existsSync(join(worktreeDir, 'Makefile'));
          const validateCmd = hasMakefile ? 'make q.check' : (existsSync(join(worktreeDir, 'package.json')) ? 'npm test' : null);
          if (validateCmd) {
            console.log(`[create-pr] 자동 해결 완료. 검증 도구(${validateCmd})를 구동합니다...`);
            try {
              exec(validateCmd.split(' '), { cwd: worktreeDir });
              console.log(`[create-pr] 검증 통과!`);
              syncSuccess = true;
            } catch (gateErr) {
              console.error(`[create-pr] 검증 실패. 병합 취소.`);
              try { git(['merge', '--abort'], { cwd: worktreeDir }); } catch {}
            }
          } else {
            console.log(`[create-pr] 자동 해결 완료. 검증 생략.`);
            syncSuccess = true;
          }
        } else {
          try { git(['merge', '--abort'], { cwd: worktreeDir }); } catch {}
        }
      }

      if (syncSuccess) {
        git(['push', 'origin', head], { cwd: worktreeDir, timeout: 60_000, retry: 3 });
        console.log(`[create-pr] 업데이트된 브랜치 push 완료. PR 상태 재확인 중...`);
        const retryResult = waitMergeable(prNumber, repo);
        mergeable = retryResult.mergeable;
        state = retryResult.state;
      }
    } catch (syncErr) {
      console.error(`[create-pr] 자동 동기화 시도 중 에러: ${syncErr.message}`);
    }
  }

  if (!mergeable) {
    // v2.1: warning(string) → warnings(array) 통일. finalize 와 같은 형식.
    return {
      prNumber, prUrl, merged: false, pending: true, existing,
      warnings: [`PR #${prNumber} 자동 머지 유보 (mergeStateStatus=${state}). CI/리뷰 통과 후 수동 머지 또는 재시도.`],
    };
  }

  const resp = JSON.parse(gh([
    'api', '--method', 'PUT',
    '-H', 'Accept: application/vnd.github+json',
    `/repos/${repo}/pulls/${prNumber}/merge`,
    '-f', `merge_method=squash`,
  ]));
  if (!resp.merged) throw new Error(`PR #${prNumber} merge 실패`);

  if (deleteBranch) {
    try { gh(['api', '--method', 'DELETE', `/repos/${repo}/git/refs/heads/${deleteBranch}`]); } catch {}
  }

  // 머지된 파일 목록 + 트리 (실패 시 silent passthrough — 핵심 머지 결과 영향 X)
  const changed_files = collectChangedFilesViaPr(prNumber, repo);
  const changed_files_tree = buildFileTree(changed_files);
  const warnings = [];
  const followupDebt = registerFollowupDebtFromPr(prNumber);
  if (followupDebt.error) warnings.push(followupDebt.error);

  return {
    prNumber, prUrl, sha: resp.sha, merged: true, pending: false, existing,
    changed_files, changed_files_tree, warnings,
    followup_debt_registered: { count: followupDebt.count, items: followupDebt.items },
  };
}

function cmdShipFeature(args) {
  const branch = readBranch();
  const title = requireArg(args, 'title');
  const body = (typeof args.body === 'string') ? args.body : '';
  const noMerge = args['no-merge'] === true;

  git(['push', '-u', 'origin', branch], { cwd: WT_DIR, timeout: 60_000, retry: 3 });
  writeFileSync(ACTIVE_FLAG, String(Date.now()));

  const result = createAndMergePr({
    base: BASE_BRANCH, head: branch, title, body,
    deleteBranch: noMerge ? null : branch,
    noMerge,
    worktreeDir: WT_DIR,
  });

  // ship 성공 시 Pre-Ship Review 마커 정리 (R-CM-030 라이프사이클).
  // ship-feature 모드의 마커 키는 'staged'.
  if (result.merged) unlinkShipReviewMarker('staged');

  return { ok: true, ...result };
}

// finalize: fail-loud 의미론. fetch/stash/ff 실패는 ok:false (R-CM-010 정합)
function cmdFinalize() {
  const localBranch = existsSync(BRANCH_FILE) ? readFileSync(BRANCH_FILE, 'utf-8').trim() : null;
  if (existsSync(WT_DIR)) {
    try { git(['worktree', 'remove', WT_DIR, '--force']); } catch {}
    try { git(['worktree', 'prune']); } catch {}
  }
  if (localBranch) deleteBranchAndStashes(localBranch);

  const cleanupState = () => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    try { if (existsSync(ACTIVE_FLAG)) rmSync(ACTIVE_FLAG); } catch {}
  };

  try {
    git(['fetch', 'origin', BASE_BRANCH], { timeout: 60_000, retry: 3 });
  } catch (e) {
    cleanupState();
    return {
      ok: false, error: `동기화용 fetch 실패: ${e.message}`,
      hint: 'remote 확인 (git remote -v). 네트워크 복구 후 git fetch + git merge --ff-only 수동 실행.',
      worktree_cleaned: true, sync_status: 'fetch_failed', active_stash: null,
    };
  }

  const hasChanges = git(['status', '--porcelain']).trim().length > 0;
  const stashMsg = `create-pr-sync-backup-${Date.now()}`;
  let stashed = false;
  let active_stash = null;
  if (hasChanges) {
    try {
      git(['stash', 'push', '--include-untracked', '-m', stashMsg]);
      stashed = true;
      active_stash = stashMsg;
    } catch (e) {
      cleanupState();
      return {
        ok: false, error: `stash 실패: ${e.message}`,
        hint: '데이터 안전 우선 — 동기화 중단. 원본 working tree 보존됨.',
        worktree_cleaned: true, sync_status: 'stash_failed', active_stash: null,
      };
    }
  }

  let ffFailed = null;
  try {
    git(['checkout', BASE_BRANCH]);
    git(['merge', '--ff-only', `origin/${BASE_BRANCH}`]);
  } catch (e) {
    ffFailed = `${BASE_BRANCH} ff-only 실패: ${e.message}`;
  }

  let popConflict = false;
  if (stashed) {
    try {
      git(['stash', 'pop']);
      active_stash = null;
    } catch {
      popConflict = true;
    }
  }

  cleanupState();

  if (ffFailed) {
    return {
      ok: false, error: ffFailed,
      hint: '원격 main이 로컬 main의 선조가 아님 (non-fast-forward). git log + 수동 rebase 필요.',
      sync_status: 'ff_failed', active_stash,
    };
  }
  if (popConflict) {
    return {
      ok: true, sync_status: 'synced_with_stash_conflict', active_stash,
      hint: `stash pop 충돌 — 백업 유지. 수동: git stash list | grep "${stashMsg}"`,
    };
  }
  return { ok: true, sync_status: 'synced', active_stash: null };
}

// ═ Mode B: Worktree ═

/**
 * R-CM-008 Rule 9 (multi-worktree superset detection).
 *
 * 본 worktree 의 변경 파일 set 과 origin/<baseBranch> 의 최근 24h commit 들이
 * 건드린 파일 set 의 intersection 을 계산해, 다른 세션의 PR 이 본 worktree 의
 * 작업을 silently superset 으로 흡수했을 가능성을 감지한다.
 *
 * Multi-worktree 동시 진행 (Claude Code / Codex 등) 시 한 세션이 다른 세션의
 * commit 을 superset 으로 squash merge 하면 후자의 worktree 가 의미를 잃는다.
 * fetch 직후 detection → warning (block X — R-CM-031 Reversible default) 으로
 * 사용자에게 인지 기회 제공.
 *
 * fail-open: git 명령 실패 시 null 반환 (R-CM-006 Rule 2).
 *
 * @param {string} absWtPath worktree 절대 경로
 * @param {string} baseBranch 비교 기준 branch (보통 main)
 * @param {Function} [gitFn=git] git executor (default = 모듈 git wrapper). Override in tests only.
 * @returns {Array<{sha,subject,files}> | null} overlap 1+ 시 배열, 없으면 null
 */
export function detectExternalSupersetRisk(absWtPath, baseBranch, gitFn = git) {
  const splitLines = (s) => s.split('\n').map((line) => line.trim()).filter(Boolean);
  try {
    const myFiles = splitLines(
      gitFn(['diff', '--name-only', `origin/${baseBranch}..HEAD`], { cwd: absWtPath }),
    );
    if (myFiles.length === 0) return null;

    // Single `git log --name-only --format="%H %s"` 호출로 N+1 spawn 회피.
    // 출력: 각 commit block 은 빈 line 으로 구분 — "<sha> <subject>\n<file1>\n<file2>\n\n<sha2>...".
    const logOutput = gitFn(
      ['log', `origin/${baseBranch}`, '--since=24.hours.ago', '--name-only', '--format=%H %s'],
      { cwd: absWtPath },
    );
    const blocks = logOutput.split('\n\n').map((b) => b.trim()).filter(Boolean);
    if (blocks.length === 0) return null;

    const myFileSet = new Set(myFiles);
    const overlaps = [];
    for (const block of blocks) {
      const lines = splitLines(block);
      if (lines.length === 0) continue;
      const header = lines[0];
      const spaceIdx = header.indexOf(' ');
      if (spaceIdx < 0) continue;
      const sha = header.slice(0, spaceIdx);
      const subject = header.slice(spaceIdx + 1);
      const intersection = lines.slice(1).filter((f) => myFileSet.has(f));
      if (intersection.length > 0) {
        overlaps.push({
          sha: sha.slice(0, 7),
          subject: subject.length > 80 ? subject.slice(0, 80) + '…' : subject,
          files: intersection.slice(0, 5),
        });
      }
    }
    return overlaps.length > 0 ? overlaps : null;
  } catch {
    return null;
  }
}

export function tryAutoResolveConflicts(absWtPath, conflictingFiles) {
  if (!conflictingFiles || conflictingFiles.length === 0) return true;

  console.log(`[auto-resolve] 충돌 파일 감지됨: ${conflictingFiles.join(', ')}`);

  const autoResolvablePatterns = [
    /package-lock\.json$/,
    /pnpm-lock\.yaml$/,
    /yarn\.lock$/,
    /\.tmp\/worktree-.*\/PLAN\.md$/,
    /\.md$/
  ];

  const unresolvable = conflictingFiles.filter(file => {
    return !autoResolvablePatterns.some(pattern => pattern.test(file));
  });

  if (unresolvable.length > 0) {
    console.log(`[auto-resolve] 자동 해결 불가능한 파일이 있습니다: ${unresolvable.join(', ')}`);
    return false;
  }

  try {
    for (const file of conflictingFiles) {
      if (file.endsWith('package-lock.json') || file.endsWith('pnpm-lock.yaml') || file.endsWith('yarn.lock')) {
        console.log(`[auto-resolve] ${file} 충돌 해결 시도: --theirs 선택 후 패키지 재생성`);
        git(['checkout', '--theirs', file], { cwd: absWtPath });
        if (file.endsWith('package-lock.json')) {
          try { exec(['npm', 'install'], { cwd: absWtPath }); } catch {}
        } else if (file.endsWith('pnpm-lock.yaml')) {
          try { exec(['pnpm', 'install'], { cwd: absWtPath }); } catch {}
        } else if (file.endsWith('yarn.lock')) {
          try { exec(['yarn', 'install'], { cwd: absWtPath }); } catch {}
        }
        git(['add', file], { cwd: absWtPath });
      } else if (file.includes('PLAN.md') || file.endsWith('.md')) {
        console.log(`[auto-resolve] ${file} 충돌 해결 시도: --ours 선택`);
        git(['checkout', '--ours', file], { cwd: absWtPath });
        git(['add', file], { cwd: absWtPath });
      }
    }

    const remaining = git(['diff', '--name-only', '--diff-filter=U'], { cwd: absWtPath }).trim();
    if (remaining.length > 0) {
      console.log(`[auto-resolve] 미해결 충돌이 남아있습니다: ${remaining}`);
      return false;
    }

    git(['commit', '--no-edit'], { cwd: absWtPath });
    console.log(`[auto-resolve] 모든 충돌이 성공적으로 자동 해결되었으며 merge commit이 생성되었습니다.`);
    return true;
  } catch (err) {
    console.error(`[auto-resolve] 충돌 해결 중 에러 발생: ${err.message}`);
    return false;
  }
}

/**
 * `detectExternalSupersetRisk` 의 overlaps 배열을 사용자용 warning 문자열로 포매팅.
 * Helper 추출 목적: cmdShipWorktree 통합 경로 (warning 포매팅 + indentation) 단위 테스트
 * 가능화 — code-reviewer agent HIGH-2 (PR #296) 회귀 차단.
 *
 * @param {Array<{sha,subject,files}> | null} overlaps
 * @param {string} baseBranch
 * @returns {string | null} overlaps 1+ 시 warning string, 그 외 null
 */
export function formatSupersetWarning(overlaps, baseBranch) {
  if (!overlaps || overlaps.length === 0) return null;
  const lines = overlaps
    .map((o) => `  ${o.sha} ${o.subject} (${o.files.join(', ')})`)
    .join('\n');
  return `multi-worktree superset 위험: origin/${baseBranch} 의 최근 24h 머지 ${overlaps.length}건이 본 worktree 의 변경 파일을 건드렸습니다. 본 PR 이 redundant 또는 silently superset 흡수 가능성 — 변경 의도가 여전히 유효한지 확인 후 진행하세요.\n${lines}`;
}

/**
 * ship 응답의 5-소스 `mergedWarnings` 를 합성하는 순수 함수 (DEBT-15 "mergedWarnings
 * spread" 의 명시 대상). 각 소스의 null/undefined 를 방어하여 평탄 배열로 결합한다.
 * 순서: result → superset → preservation → runBundle → cleanup (사용자 노출 순서 계약).
 *
 * @param {object} p
 * @param {object} p.result            createAndMergePr 결과 (warnings 보유 가능)
 * @param {string[]} [p.supersetWarnings=[]]
 * @param {string[]} [p.preservationWarnings=[]]
 * @param {object|null} [p.runBundle=null]      warnings 보유 가능
 * @param {object|null} [p.cleanupResult=null]  warnings 보유 가능
 * @returns {string[]}
 */
export function mergeShipWarnings({
  result,
  supersetWarnings = [],
  preservationWarnings = [],
  runBundle = null,
  cleanupResult = null,
}) {
  return [
    ...(result.warnings || []),
    ...supersetWarnings,
    ...preservationWarnings,
    ...(runBundle?.warnings ?? []),
    ...(cleanupResult?.warnings ?? []),
  ];
}

/**
 * ship 응답의 `cleanup_hint` 분기만 분리한 순수 함수. cmdShipWorktree 의 가장
 * 분기 밀도 높은 sub-logic (nested ternary) 을 독립 테스트 단위로 격리한다.
 *
 * R-CM-010 Iron Law: AI 가 cleanup 자동 수행 추정 금지 — hint 로 명시.
 *   - `--no-cleanup` + merged: 후속 cleanup-worktree 실행 안내 (최우선).
 *   - 위임 cleanup 의 main 동기화 실패 (fetch/stash/ff): 그 hint 를 그대로 전달
 *     (PR 머지는 비가역 — ship 은 ok:true 유지, sync 상태만 surface).
 *   - 그 외: null.
 *
 * @param {object} p
 * @param {boolean} [p.cleanup=true]   cleanup 요청 여부 (--no-cleanup 반대)
 * @param {boolean} [p.merged=false]   PR 머지 성공 여부 (result.merged)
 * @param {string} p.wtPath            원본 worktree 인자 (미정리 hint 메시지용)
 * @param {object|null} [p.cleanupResult=null]  cmdCleanupWorktree 결과
 * @returns {string|null}
 */
export function composeCleanupHint({ cleanup = true, merged = false, wtPath, cleanupResult = null }) {
  if (!cleanup && merged) {
    return `worktree 미정리 — 후속 실행: node .claude/scripts/create-pr/ops.mjs cleanup-worktree --worktree ${wtPath}`;
  }
  const cr = cleanupResult ?? {};
  return cr.ok === false ? (cr.hint ?? null) : null;
}

/**
 * cmdShipWorktree 의 응답 조립 글루 — 5-소스 `mergedWarnings` spread + `cleanup_hint`
 * 분기 + `?? null` 필드 기본값 — 를 순수 함수로 분리. git/gh/fs 호출부와 격리하여
 * `formatSupersetWarning` 추출 선례처럼 단위 테스트 가능하게 한다 (DEBT-15 / DEBT-27).
 *
 * 동작은 cmdShipWorktree 인라인 버전과 동일하다 (pure refactor — 입력만 받아 응답 형성).
 *
 * @param {object} p
 * @param {object} p.result            createAndMergePr 결과 (warnings / merged / ...rest)
 * @param {string[]} [p.supersetWarnings=[]]      R-CM-008 Rule 9 superset 경고
 * @param {string[]} [p.preservationWarnings=[]]  run/output 보존 경고
 * @param {object|null} [p.runBundle=null]        preserveWorktreeRunOutputs 결과
 * @param {object|null} [p.cleanupResult=null]    cmdCleanupWorktree 결과
 * @param {boolean} [p.cleanedUp=false]           worktree 정리 완료 여부
 * @param {boolean} [p.cleanup=true]              cleanup 요청 여부 (--no-cleanup 반대)
 * @param {string} p.wtPath                       원본 worktree 인자 (cleanup_hint 메시지용)
 * @param {object|null} [p.postMergeMainStatus=null]  main repo dirty 상태
 * @returns {object} ship-worktree 최종 응답 객체 (ok:true 고정)
 */
export function composeShipResponse({
  result,
  supersetWarnings = [],
  preservationWarnings = [],
  runBundle = null,
  cleanupResult = null,
  cleanedUp = false,
  cleanup = true,
  wtPath,
  postMergeMainStatus = null,
}) {
  const cr = cleanupResult ?? {};
  const mergedWarnings = mergeShipWarnings({
    result,
    supersetWarnings,
    preservationWarnings,
    runBundle,
    cleanupResult,
  });
  const cleanup_hint = composeCleanupHint({
    cleanup,
    merged: result.merged,
    wtPath,
    cleanupResult,
  });

  return {
    ok: true,
    ...result,
    warnings: mergedWarnings,
    cleanedUp,
    cleanup_sync_status: cr.sync_status ?? null,
    active_stash: cr.active_stash ?? null,
    cleanup_hint,
    post_merge_main_status: postMergeMainStatus,
    run_bundle: runBundle,
  };
}

function runOutputCandidateRelPaths() {
  const pipelineRoot = getPipelineDataRoot();
  const pipelineRootName = basename(pipelineRoot);
  return [
    join(pipelineRootName, relative(pipelineRoot, dirname(getActiveRunPath()))),
    join(pipelineRootName, relative(pipelineRoot, getRunsRoot())),
    'output',
    'docs/pipeline-log',
  ];
}

function safeBundleName(value) {
  return String(value || 'worktree')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'worktree';
}

function scanTreeStats(root) {
  let files = 0;
  let bytes = 0;
  function walk(current) {
    const stat = statSync(current);
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(current)) {
      walk(join(current, entry));
    }
  }
  walk(root);
  return { files, bytes };
}

export function detectRunOutputCandidates(absWtPath) {
  return runOutputCandidateRelPaths()
    .map((relPath) => ({ relPath, absPath: join(absWtPath, relPath) }))
    .filter((candidate) => existsSync(candidate.absPath));
}

export function preserveWorktreeRunOutputs(absWtPath, branch, options = {}) {
  const candidates = detectRunOutputCandidates(absWtPath);
  const warnings = [];
  if (candidates.length === 0) {
    return {
      ok: true,
      skipped: true,
      warnings: ['보존할 run/output 후보가 없습니다.'],
      copied_paths: [],
      total_files: 0,
      total_bytes: 0,
    };
  }

  const createdAt = options.createdAt || new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const bundlePath = options.bundlePath || join(
    PROJECT_DIR,
    '.tmp',
    'run-bundles',
    `${safeBundleName(branch)}-${timestamp}`,
  );
  mkdirSync(bundlePath, { recursive: true });

  let headSha = null;
  try {
    headSha = git(['rev-parse', 'HEAD'], { cwd: absWtPath });
  } catch {
    warnings.push('worktree HEAD sha 확인 실패 — manifest.head_sha=null 로 기록.');
  }

  const copied = [];
  let totalFiles = 0;
  let totalBytes = 0;
  for (const candidate of candidates) {
    const dest = join(bundlePath, candidate.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(candidate.absPath, dest, { recursive: true, force: true });
    const stats = scanTreeStats(dest);
    totalFiles += stats.files;
    totalBytes += stats.bytes;
    copied.push({
      source: candidate.absPath,
      destination: dest,
      relative_path: candidate.relPath,
      files: stats.files,
      bytes: stats.bytes,
    });
  }

  const manifest = {
    schema_version: '1.0',
    created_at: createdAt,
    branch,
    base_branch: BASE_BRANCH,
    source_worktree: absWtPath,
    head_sha: headSha,
    copied,
    total_files: totalFiles,
    total_bytes: totalBytes,
    candidates_considered: runOutputCandidateRelPaths(),
    exclusion_rules: [
      'Only known brief2dev run/output roots are copied.',
      'node_modules, .git, and arbitrary .tmp contents are not candidate roots.',
    ],
  };
  const manifestPath = join(bundlePath, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  return {
    ok: true,
    skipped: false,
    bundle_path: bundlePath,
    manifest_path: manifestPath,
    copied_paths: copied.map((entry) => entry.relative_path),
    total_files: totalFiles,
    total_bytes: totalBytes,
    warnings,
  };
}

function cmdVerifyPlan(args) {
  const wtPath = requireArg(args, 'worktree');
  const planPath = resolveWorktreePlanPath(resolveWorktreeAbsPath(wtPath));
  if (!existsSync(planPath)) throw new Error(`PLAN.md 없음: ${planPath}`);
  const content = readFileSync(planPath, 'utf-8');
  const force = args.force === true;
  const unchecked = parseUnchecked(content);
  if (!force && unchecked.length > 0) {
    throw new Error(
      `PLAN.md에 완료되지 않은 작업이 ${unchecked.length}건 있습니다:\n${unchecked.join('\n')}\n\n` +
      `※ 우회: --force 또는 항목에 (취소됨)/(dropped)/(deferred)/~~취소선~~ 마커 추가`
    );
  }
  return {
    ok: true,
    message: unchecked.length === 0
      ? '모든 PLAN 체크박스 완료(또는 취소/무시)됨'
      : `--force 우회로 ${unchecked.length}건 미완료 항목 무시`,
    unchecked_count: unchecked.length,
  };
}

function cmdShipWorktree(args) {
  const wtPath = requireArg(args, 'worktree');
  const absWtPath = resolveWorktreeAbsPath(wtPath);
  if (!existsSync(absWtPath)) {
    // 다중 worktree 환경에서 AI 가 worktree 내부 cwd 로 ops.mjs 를 호출하면
    // 정규화가 잘못된 경우가 종종 있었다 (PROJECT_DIR fallback 함정). 명확한
    // 진단 메시지로 잘못된 path 와 함께 실제 활성 worktree 목록을 제시한다.
    let candidates = [];
    try {
      candidates = parseWorktreePaths(git(['worktree', 'list', '--porcelain']));
    } catch {
      // git 호출 실패 — 단일 메시지로 fallback
    }
    const candidateBlock = candidates.length > 0
      ? `\n활성 worktree 후보:\n  - ${candidates.join('\n  - ')}`
      : '';
    throw new Error(`Worktree 없음: ${absWtPath}${candidateBlock}`);
  }

  // PLAN.md 필수 검증 (CLAUDE.md "PLAN.md 필수" 정책. --force-plan 은 미완료 체크박스 우회용)
  // 위치: .tmp/worktree-<safeBranch>/PLAN.md (worktree-plan-path.mjs SSOT)
  const planPath = resolveWorktreePlanPath(absWtPath);
  if (!existsSync(planPath)) {
    throw new Error(`PLAN.md 파일이 존재하지 않습니다: ${planPath}. worktree 루트의 .tmp/worktree-<branch>/PLAN.md 에 작성 후 재시도하세요.`);
  }
  const forcePlan = args['force-plan'] === true;
  if (!forcePlan) {
    const unchecked = parseUnchecked(readFileSync(planPath, 'utf-8'));
    if (unchecked.length > 0) {
      throw new Error(
        `PLAN.md에 완료되지 않은 체크박스가 ${unchecked.length}건 있습니다.\n` +
        `※ 우회: --force-plan 플래그 또는 항목에 (취소됨)/(dropped)/(deferred)/~~취소선~~ 마커 추가`
      );
    }
  }

  // Worktree Commit Requirement: create-pr 는 dirty worktree 를 ship 하지 않는다.
  // Stop guard 와 같은 계약으로 tracked/untracked 변경 모두 먼저 commit 하게 한다.
  const status = git(['status', '--porcelain', '--untracked-files=all'], { cwd: absWtPath }).trim();
  if (status.length > 0) {
    const err = new Error(
      `Worktree에 커밋되지 않은 변경사항이 있습니다.\n해당 변경을 커밋한 후 다시 시도하세요.\n[상태]\n${status}`
    );
    err.details = {
      code: 'commit_required',
      dirty_status: status.split('\n'),
      hint: 'worktree 안에서 git status --short 확인 후 본인이 만든 파일만 stage/commit 하고 ship-worktree 를 다시 실행하세요.',
    };
    throw err;
  }


  // Push 전 원본 변경사항 자동 동기화 (Shift-Left Conflict Detection)
  // + R-CM-008 Rule 9: multi-worktree superset 감지 (fetch 후, merge 전)
  const supersetWarnings = [];
  try {
    git(['fetch', 'origin', BASE_BRANCH], { cwd: absWtPath, timeout: 30_000, retry: 3 });

    const overlaps = detectExternalSupersetRisk(absWtPath, BASE_BRANCH);
    const warning = formatSupersetWarning(overlaps, BASE_BRANCH);
    if (warning) supersetWarnings.push(warning);

    try {
      git(['merge', '--no-edit', `origin/${BASE_BRANCH}`], { cwd: absWtPath });
    } catch (mergeErr) {
      console.log(`[ship-worktree] 원본(${BASE_BRANCH}) 병합 중 충돌이 감지되었습니다. 자동 해결을 시도합니다.`);
      const conflictingFiles = git(['diff', '--name-only', '--diff-filter=U'], { cwd: absWtPath })
        .trim()
        .split('\n')
        .filter(Boolean);
      
      const resolved = tryAutoResolveConflicts(absWtPath, conflictingFiles);
      if (!resolved) {
        try { git(['merge', '--abort'], { cwd: absWtPath }); } catch {}
        throw mergeErr;
      }
      
      const hasMakefile = existsSync(join(absWtPath, 'Makefile'));
      const validateCmd = hasMakefile ? 'make q.check' : (existsSync(join(absWtPath, 'package.json')) ? 'npm test' : null);
      if (validateCmd) {
        console.log(`[ship-worktree] 자동 해결 완료. 검증 도구(${validateCmd})를 구동하여 최종 정합성을 검사합니다...`);
        try {
          exec(validateCmd.split(' '), { cwd: absWtPath });
          console.log(`[ship-worktree] 검증 통과! 자동 충돌 해결이 승인되었습니다.`);
        } catch (gateErr) {
          console.error(`[ship-worktree] 검증 실패: 자동 해결된 코드가 품질 게이트를 통과하지 못했습니다. 병합을 취소합니다.`);
          try { git(['merge', '--abort'], { cwd: absWtPath }); } catch {}
          throw new Error(`자동 충돌 해결 후 품질 검사(${validateCmd}) 실패: ${gateErr.message}`);
        }
      } else {
        console.log(`[ship-worktree] 자동 해결 완료. 실행할 품질 검사 도구가 없어 검증을 스킵합니다.`);
      }
    }
  } catch (e) {
    throw new Error(`원본(${BASE_BRANCH})과의 병합 중 충돌이 발생했습니다. 수동으로 충돌을 해결한 후 커밋하고 다시 시도하세요.\n에러: ${e.message}`);
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: absWtPath });
  if (!branch || branch === 'HEAD') throw new Error(`브랜치 파악 불가: ${wtPath}`);

  git(['push', '-u', 'origin', branch], { cwd: absWtPath, timeout: 60_000, retry: 3 });

  const title = requireArg(args, 'title');
  const body = (typeof args.body === 'string') ? args.body : '';
  const noMerge = args['no-merge'] === true;
  const cleanup = args['no-cleanup'] !== true;
  const preserveRun = args['preserve-run'] === true;

  const result = createAndMergePr({
    base: BASE_BRANCH, head: branch, title, body,
    deleteBranch: noMerge ? null : branch,
    noMerge,
    worktreeDir: absWtPath,
  });

  // 머지 성공 시 worktree 전체 정리 (기본값). --no-cleanup 으로 opt-out.
  // cmdCleanupWorktree 에 위임하여 worktree 제거 + 로컬 branch 삭제뿐 아니라
  // auto-checkpoint stash drop (deleteBranchAndStashes) + CONTEXT.json 정리 +
  // 로컬 main 동기화 (fetch + stash-based ff-merge) 까지 일괄 수행한다.
  // 이전에는 인라인 worktree remove/prune/branch -D 만 수행해 stash·main 동기화가
  // 누락됐고, 사용자가 cleanup-worktree 를 별도 호출해야 했다 (정리 누락 갭).
  let cleanedUp = false;
  let cleanupResult = null;
  let runBundle = null;
  const preservationWarnings = [];
  if (cleanup && result.merged) {
    const candidates = detectRunOutputCandidates(absWtPath);
    if (preserveRun) {
      runBundle = preserveWorktreeRunOutputs(absWtPath, branch);
    } else if (candidates.length > 0) {
      preservationWarnings.push(
        `cleanup 이 ${candidates.map((candidate) => candidate.relPath).join(', ')} 후보를 제거합니다. 보존하려면 ship-worktree --preserve-run 을 사용하세요.`,
      );
    }
    cleanupResult = cmdCleanupWorktree({ worktree: wtPath });
    cleanedUp = cleanupResult.worktree_cleaned === true;
  }

  // ship 성공 시 Pre-Ship Review 마커 정리 (R-CM-030 라이프사이클).
  // 위임 cleanup 시 cmdCleanupWorktree 가 이미 unlink — 여기서는 --no-cleanup
  // 경로 커버용 (멱등 — 중복 호출 안전).
  if (result.merged) unlinkShipReviewMarker(wtPath);

  // 머지 성공 직후 main repo working tree dirty 여부 보고.
  // AI 는 main 의 unstaged 변경이 머지 결과와 충돌할 수 있음을 인지하고 사용자에게
  // 명시적 reconcile (git pull --ff-only) 안내해야 한다.
  const post_merge_main_status = result.merged ? detectPostMergeMainStatus() : null;

  // 응답 조립 글루 (mergedWarnings spread + cleanup_hint 분기 + ?? null 필드 기본값)
  // 는 순수 함수 composeShipResponse 에 위임 — git/gh/fs 격리로 단위 테스트 가능
  // (DEBT-15 / DEBT-27, `tests/unit/create-pr-ship-response-compose.test.mjs`).
  return composeShipResponse({
    result,
    supersetWarnings,
    preservationWarnings,
    runBundle,
    cleanupResult,
    cleanedUp,
    cleanup,
    wtPath,
    postMergeMainStatus: post_merge_main_status,
  });
}

function cmdCleanupWorktree(args) {
  const wtPath = requireArg(args, 'worktree');
  const absWtPath = resolveWorktreeAbsPath(wtPath);
  const warnings = [];
  let active_stash = null;

  // 해당 worktree 마커 + stale (>1h) 마커 GC (R-CM-030 라이프사이클).
  // ship-worktree 가 이미 unlink 했어도 멱등 — cancelled 흐름 누적 방지가 주 목적.
  unlinkShipReviewMarker(wtPath);
  gcStaleShipReviewMarkers();

  let branch = null;
  if (existsSync(absWtPath)) {
    try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: absWtPath }); } catch {}
    try { git(['worktree', 'remove', absWtPath, '--force']); } catch {}
    try { git(['worktree', 'prune']); } catch {}
  }
  if (branch) deleteBranchAndStashes(branch);

  // CONTEXT.json 의 worktree 참조 정리 (있는 경우만)
  const ctxPath = join(PROJECT_DIR, 'CONTEXT.json');
  if (existsSync(ctxPath)) {
    try {
      const ctx = JSON.parse(readFileSync(ctxPath, 'utf-8'));
      if (ctx.execution?.worktree?.worktree_path === wtPath) {
        delete ctx.execution.worktree;
        writeFileSync(ctxPath, JSON.stringify(ctx, null, 2) + '\n');
      }
    } catch (e) {
      warnings.push(`CONTEXT.json 업데이트 실패: ${e.message}`);
    }
  }

  // Stash-based main 동기화 (finalize Part B 와 동일 의미론, fail-loud)
  try {
    git(['fetch', 'origin', BASE_BRANCH], { cwd: PROJECT_DIR, timeout: 60_000, retry: 3 });
  } catch (e) {
    return {
      ok: false, error: `${BASE_BRANCH} fetch 실패: ${e.message}`,
      hint: 'remote 확인 후 수동 동기화', sync_status: 'fetch_failed',
      worktree_cleaned: true, warnings, active_stash: null,
    };
  }

  const hasChanges = git(['status', '--porcelain'], { cwd: PROJECT_DIR }).trim().length > 0;
  const stashMsg = `worktree-sync-backup-${Date.now()}`;
  let stashed = false;
  if (hasChanges) {
    try {
      git(['stash', 'push', '--include-untracked', '-m', stashMsg], { cwd: PROJECT_DIR });
      stashed = true;
      active_stash = stashMsg;
    } catch (e) {
      return {
        ok: false, error: `stash 실패: ${e.message}`,
        hint: '데이터 안전 우선 — 동기화 중단', sync_status: 'stash_failed',
        worktree_cleaned: true, warnings, active_stash: null,
      };
    }
  }

  let ffFailed = null;
  try {
    git(['checkout', BASE_BRANCH], { cwd: PROJECT_DIR });
    git(['merge', '--ff-only', `origin/${BASE_BRANCH}`], { cwd: PROJECT_DIR });
  } catch (e) {
    ffFailed = `${BASE_BRANCH} ff-only 실패: ${e.message}`;
  }

  let popConflict = false;
  if (stashed) {
    try {
      git(['stash', 'pop'], { cwd: PROJECT_DIR });
      active_stash = null;
    } catch {
      popConflict = true;
    }
  }

  if (ffFailed) {
    return {
      ok: false, error: ffFailed,
      hint: '원격 main이 로컬 선조 아님. 수동 rebase 필요',
      sync_status: 'ff_failed', worktree_cleaned: true, warnings, active_stash,
    };
  }
  if (popConflict) {
    return {
      ok: true, sync_status: 'synced_with_stash_conflict',
      hint: `stash pop 충돌 — 백업 유지. 수동: git stash list | grep "${stashMsg}"`,
      worktree_cleaned: true, warnings, active_stash,
    };
  }
  return { ok: true, sync_status: 'synced', worktree_cleaned: true, warnings, active_stash: null };
}

// ═ Dispatch ═
const COMMANDS = {
  'init': cmdInit,
  'isolate': cmdIsolate,
  'commit': cmdCommit,
  'ship-feature': cmdShipFeature,
  'finalize': cmdFinalize,
  'verify-plan': cmdVerifyPlan,
  'ship-worktree': cmdShipWorktree,
  'cleanup-worktree': cmdCleanupWorktree,
};

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === '--help') {
    process.stdout.write(JSON.stringify({
      ok: true, mode: null, command: '--help',
      commands: Object.keys(COMMANDS),
      modes: { staged: [...STAGED_CMDS], worktree: [...WORKTREE_CMDS] },
      config: {
        github_account: GH_ACCOUNT, base_branch: BASE_BRANCH,
        enforce_ssh_remote: ENFORCE_SSH,
      },
    }) + '\n');
    process.exit(0);
  }

  const mode = inferMode(command);
  if (!COMMANDS[command]) {
    process.stdout.write(JSON.stringify({
      ok: false, mode, command,
      error: `Unknown: ${command}`, available: Object.keys(COMMANDS),
    }) + '\n');
    process.exit(1);
  }

  try {
    const result = COMMANDS[command](args);
    process.stdout.write(JSON.stringify({ mode, command, ...result }) + '\n');
    process.exit(result.ok === false ? 1 : 0);
  } catch (e) {
    process.stdout.write(JSON.stringify({
      ok: false, mode, command,
      error: e.message, ...(e.details || {}),
    }) + '\n');
    process.exit(1);
  }
}

// v2.1: import 시 main() 자동 실행 차단. 회귀 테스트가 constant 만 import 가능.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
