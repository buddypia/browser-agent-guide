#!/usr/bin/env node

/**
 * destructive-git-guard.mjs - PreToolUse Bash Hook
 *
 * Claude Code의 Bash 툴에서 파괴적인 git 명령을 차단합니다.
 *
 * 방어 체계에서의 역할:
 * ┌──────────────────────────────────────────────────────────────┐
 * │ L1: settings.json deny 규칙 → defaultMode 설정에 의존       │
 * │ L2: 이 Hook                  → PreToolUse에서 명령 파싱 차단 │
 * │ L3: .git/hooks/              → git native 레벨에서 차단      │
 * └──────────────────────────────────────────────────────────────┘
 *
 * L1(deny)이 bypassPermissions 등으로 무력화되더라도,
 * 이 Hook(L2)이 독립적으로 파괴적인 명령을 차단합니다.
 *
 * 차단 대상 (working tree 파괴 명령만):
 * - git reset --hard/--merge/--keep (working tree 파괴)
 * - git checkout . / git checkout -- <file> (working tree 파괴)
 * - git restore . / glob / <dir>/ / :magic / pathspec 부재 (working tree 광역 파괴)
 * - git clean -f/-d (untracked 파일 삭제)
 * - git stash clear (모든 stash 스냅샷 일괄 삭제 — 복구 불가)
 * - git push --force / -f (리모트 히스토리 파괴)
 * - git rebase (히스토리 변경)
 *
 * 허용 (inherently safe — working tree 보존):
 * - git reset --soft (HEAD만 이동)
 * - git reset HEAD <files> / git reset HEAD -- <files> (unstage, index만 수정)
 * - git reset (bare, --mixed) (전체 unstage, index만 수정)
 * - git restore --staged (unstage, index만 수정)
 * - git restore <명시적 파일> (bounded blast radius — stash drop(단일) 선례와 동형, 사용자 결정 2026-06-16)
 * - git stash push/save/drop/apply/pop/list/show/branch / 인수 없는 git stash (clear 외 모든 stash 허용)
 * - git checkout <branch-name> (브랜치 전환)
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { readStdin, output, safeHookMainWithProfile } from '../scripts/lib/utils.mjs';
import { HookOutput } from '../scripts/lib/hook-output.mjs';
// heredoc body 제거 — `cat <<EOF\ngit stash clear\nEOF` 같은 데이터 컨텍스트의 destructive
// string 이 newline anchor (`\n` chain operator 인식) 로 false-positive 차단되는 문제 해결.
// lib SSOT — pre-ship-review-guard 도 같은 lib 사용 (cross-hook circular execution 회피).
import { stripHeredocBodies } from '../scripts/lib/heredoc-strip.mjs';
import { anchoredPattern } from '../scripts/lib/hook-anchors.mjs';

/**
 * 파괴적인 git 명령 패턴 정의
 * 각 패턴은 { regex, description, allowIf? } 형식
 */
const DESTRUCTIVE_PATTERNS = [
  {
    // git reset --hard (HEAD + index + working tree 전부 리셋 = 데이터 파괴)
    // git reset --merge, --keep (working tree 조건부 변경 = 위험)
    //
    // 허용 (working tree 보존, inherently safe):
    //   --soft             → HEAD만 이동
    //   --mixed (기본)     → index만 리셋, working tree 보존
    //   HEAD <files>       → 특정 파일 unstage (index만 수정)
    //   HEAD -- <files>    → 위와 동일 (-- 구분자)
    //   (bare)             → 전체 unstage (index만 수정)
    //
    // 판별 기준: --hard/--merge/--keep 플래그 존재 여부만으로 결정.
    // 플래그 없는 git reset은 mixed 모드이며 working tree를 건드리지 않으므로 안전.
    regex: anchoredPattern('git\\s+reset\\s+--(hard|merge|keep)\\b', 'i'),
    description: 'git reset --hard/--merge/--keep은 작업 중인 변경사항을 삭제합니다',
    allowIf: null,
  },
  {
    // git checkout . 또는 git checkout -- <path>
    // 허용: git checkout <branch>, git checkout -b <branch>
    regex: anchoredPattern('git\\s+checkout\\s+(\\.|\\-\\-\\s)', 'i'),
    description: 'git checkout ./-- 은 작업 중인 변경사항을 삭제합니다',
    allowIf: null,
  },
  // git restore 는 DESTRUCTIVE_PATTERNS 에서 제거됨 (사용자 결정 2026-06-16).
  //   regex 기반 검사는 `git -C x restore .` 같은 global option 우회에 구조적으로 취약
  //   (regex 가 git↔restore 인접을 요구). tokenizer 기반 classifyRestore() 가 전담하여
  //   checkDestructiveGit() 에서 별도 호출된다 — blast-radius scoped 허용/차단.
  {
    // git clean -f, -fd, -fx 등
    regex: anchoredPattern('git\\s+clean\\s+.*-[fdxX]', 'i'),
    description: 'git clean은 untracked 파일을 영구적으로 삭제합니다',
    allowIf: null,
  },
  {
    // git stash clear (모든 stash entry 일괄 삭제 — reflog 없이 복구 불가).
    //
    // 사용자 결정 2026-05-18: stash 정책을 clear-only 로 완화.
    // push/save/drop/apply/pop/list/show/branch 및 인수 없는 git stash 는
    // 모두 허용한다 (멀티 터미널 untracked 손실 우려보다 stash 활용성 우선).
    // clear 만 차단 — 단일 drop 과 달리 전체 일괄 삭제라 실수 시 피해 범위가 크다.
    //
    // 미매칭 (안전 명령 통과):
    //   git stash push / save / drop / apply / pop / list / show / branch
    //   인수 없는 git stash (= 암묵적 push)
    regex: anchoredPattern('git\\s+stash\\s+clear\\b', 'i'),
    description: 'git stash clear는 모든 stash 스냅샷을 일괄 삭제합니다 (복구 불가)',
    allowIf: null,
  },
  {
    // git push --force, git push -f
    regex: anchoredPattern('git\\s+push\\s+.*(-f\\b|--force\\b)', 'i'),
    description: 'git push --force는 리모트 저장소의 히스토리를 파괴합니다',
    allowIf: null,
  },
  {
    // git rebase
    regex: anchoredPattern('git\\s+rebase\\b', 'i'),
    description: 'git rebase 는 커밋 히스토리를 변경합니다',
    allowIf: null,
  },
];

// ── create-pr Safe Command Allowlist ──
//
// create-pr 플로우 진행 중 (.tmp/create-pr-active 존재 시)
// 아래 패턴만 추가 허용. 그 외 파괴적 명령은 플래그 유무와 무관하게 차단.
//
// 안전성 근거:
//   git merge --ff-only:  HEAD 전진만 수행. 히스토리 변경 불가. 충돌 시 git 거부.
//   git worktree remove:  격리된 worktree 디렉토리만 삭제.
//
// 제거된 항목:
//   git reset HEAD -- <path>: DESTRUCTIVE_PATTERNS 자체가 --hard/--merge/--keep만
//   차단하므로 unstage는 플래그 없이도 항상 허용됨. (v2.1)
//
// 플래그 누수 시 영향:
//   위 2개 명령은 데이터 파괴가 불가능하므로 보안 영향 없음.
const CREATE_PR_SAFE_PATTERNS = [
  /\bgit\s+merge\s+--ff-only\b/i,
  /\bgit\s+worktree\s+remove\b/i,
];

const CREATE_PR_ACTIVE_TTL_MS = 30 * 60 * 1000;

const WORKTREE_SHIPPING_BRANCH_PREFIXES = [
  'feature',
  'fix',
  'chore',
  'docs',
  'refactor',
  'test',
  'perf',
  'ci',
  'build',
  'style',
  'hotfix',
  'release',
];

function isCreatePrSafeCommand(command) {
  return CREATE_PR_SAFE_PATTERNS.some(p => p.test(command));
}

function isFreshCreatePrFlag(flagPath, now = Date.now()) {
  try {
    if (!existsSync(flagPath)) return false;
    const ageMs = now - statSync(flagPath).mtimeMs;
    return ageMs <= CREATE_PR_ACTIVE_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * `git commit -m <body>` 의 메시지 본문을 검사 대상에서 제외한다.
 *
 * Problem: regex 가 `\bgit\s+reset\s+--hard\b` 로 매칭하므로 commit 메시지 본문에
 * 들어간 `git reset --hard` 같은 텍스트도 false-positive 차단. 본 함수는 `-m` 인자의
 * 따옴표/heredoc 본문만 strip 하여 false-positive 를 차단한다.
 *
 * 처리하는 3 변형 (Bash 표준 -m 사용 양식):
 *   -m "$(cat <<'EOF' ... EOF)"   — heredoc inside command substitution
 *   -m '...'                        — single-quoted literal
 *   -m "..."                        — double-quoted literal
 *
 * 다른 quoted context (예: `echo "git reset --hard"`) 는 의도적으로 strip 하지 않는다.
 * 안전 측 — `-m` 가 아닌 임의 string literal 은 destructive 명령을 정당화하는 의도가
 * 명확하지 않으므로 차단 유지.
 *
 * @param {string} command
 * @returns {string} stripped command
 */
export function stripCommitMessageBody(command) {
  let result = command;
  result = result.replace(
    /-m\s+"\$\(cat\s+<<\s*['"]?(\w+)['"]?\s*[\r\n][\s\S]*?[\r\n]\1\s*\)"/g,
    '-m ""'
  );
  result = result.replace(/-m\s+'(?:[^'\\]|\\.)*'/g, "-m ''");
  result = result.replace(/-m\s+"(?:[^"\\]|\\.)*"/g, '-m ""');
  return result;
}

function shellishTokens(commandSegment) {
  const tokens = [];
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (const match of commandSegment.matchAll(tokenPattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/**
 * `git merge --ff-only <target>` 형태에서 merge target 을 추출한다.
 * `git -C <path> merge --ff-only ...` 같은 git global option 도 허용한다.
 *
 * @param {string} command
 * @returns {string|null}
 */
export function extractFastForwardMergeTarget(command) {
  if (!command || typeof command !== 'string') return null;

  const inspectable = stripCommitMessageBody(stripHeredocBodies(command));
  const commandSegments = inspectable.split(/[\n;&|]+/);

  for (const segment of commandSegments) {
    const args = shellishTokens(segment);
    const gitIndex = args.findIndex(arg => arg === 'git');
    if (gitIndex < 0) continue;

    let mergeIndex = -1;
    for (let i = gitIndex + 1; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === 'merge') {
        mergeIndex = i;
        break;
      }
      if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') {
        i += 1;
        continue;
      }
      if (
        arg.startsWith('-C') ||
        arg.startsWith('-c') ||
        arg.startsWith('--git-dir=') ||
        arg.startsWith('--work-tree=') ||
        arg === '--no-pager' ||
        arg === '--literal-pathspecs' ||
        arg === '--no-optional-locks'
      ) {
        continue;
      }
    }

    if (mergeIndex < 0) continue;

    const mergeArgs = args.slice(mergeIndex + 1);
    if (!mergeArgs.includes('--ff-only')) continue;

    const target = mergeArgs.find(arg => arg !== '--ff-only' && arg !== '--no-edit' && !arg.startsWith('-'));
    if (target) return target;
  }

  return null;
}

function normalizeBranchTarget(target) {
  return target
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^[^/]+\/(?=(feature|fix|chore|docs|refactor|test|perf|ci|build|style|hotfix|release)\/)/, '');
}

/**
 * create-pr 외부에서 worktree 브랜치를 main 으로 직접 fast-forward merge 하는
 * shipping 우회를 탐지한다. `origin/main` freshness sync 는 허용되어야 하므로
 * GitHub Flow 계열 branch prefix 만 차단한다.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isDirectWorktreeShippingMerge(command) {
  const target = extractFastForwardMergeTarget(command);
  if (!target) return false;

  const normalized = normalizeBranchTarget(target);
  return WORKTREE_SHIPPING_BRANCH_PREFIXES.some(prefix => normalized.startsWith(`${prefix}/`));
}

/**
 * 단일 pathspec 이 국소(bounded)인지 판정한다.
 * 구체적 파일 경로만 true. cwd 재귀(.)/glob/magic/디렉토리는 false.
 *
 * @param {string} p
 * @returns {boolean}
 */
function isBoundedPathspec(p) {
  if (!p) return false;
  const u = p.replace(/\\(.)/g, '$1'); // shell 백슬래시 이스케이프 해제 (\. → . , \* → *)
  // glob(* ? [ ]) / brace({ }) / 변수·치환($ `) — expand 결과가 정적으로 미지(예: {.,x} → . 포함).
  if (/[*?[\]{}$`]/.test(u)) return false;
  if (u.startsWith(':')) return false; // magic pathspec (:/ , :(top) 등 repo-root 광역)
  if (u.startsWith('~')) return false; // home 확장 (광역 가능)
  if (u.endsWith('/')) return false; // 명시적 디렉토리 (재귀)
  // path segment 가 . 또는 .. 이면 cwd/상위/디렉토리로 normalize 됨 → 광역 (foo/.. , ./. , ../x , .).
  // 파일명 내부 dot(index.ts)은 segment 가 아니므로 영향 없음.
  if (u.split('/').some(seg => seg === '.' || seg === '..')) return false;
  return true; // 구체적 파일 경로
}

/**
 * `restore` subcommand 인자에서 pathspec 을 추출하고 모두 bounded 인지 판정한다.
 *
 * @param {string[]} args - 'restore' 뒤의 토큰들
 * @returns {boolean}
 */
function isBoundedRestoreArgs(args) {
  // 별도 값을 갖는 옵션 (다음 토큰을 값으로 소비)
  const VALUE_OPTS = new Set(['--source', '-s']);
  let sawDashDash = false;
  const pathspecs = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!sawDashDash && a === '--') {
      sawDashDash = true;
      continue;
    }
    if (!sawDashDash && a.startsWith('-')) {
      // pathspec 을 외부 파일/stdin 에서 읽는 옵션은 내용을 정적 검사할 수 없으므로 보수적 차단.
      if (a === '--pathspec-from-file' || a.startsWith('--pathspec-from-file=')) return false;
      if (VALUE_OPTS.has(a)) {
        i += 1; // 옵션 값 소비 (예: --source HEAD)
        continue;
      }
      continue; // --staged / --worktree / -W / -p 등 값 없는 플래그
    }
    pathspecs.push(a);
  }

  if (pathspecs.length === 0) return false; // pathspec 부재 → 의도 불명, 차단
  return pathspecs.every(isBoundedPathspec);
}

/**
 * 명령 segment 가 shell command substitution / parameter expansion 을 포함하는지.
 * 포함 시 restore 의 실제 blast radius 를 정적으로 알 수 없다 (치환 내용 = 미지).
 *
 * @param {string} s
 * @returns {boolean}
 */
function hasShellSubstitution(s) {
  return /\$[({]/.test(s) || s.includes('`');
}

/**
 * git global option 들을 건너뛰고 restore subcommand 토큰 인덱스를 찾는다.
 * `git -C <path> restore`, `git --no-pager restore` 등 global option 우회를 닫는다
 * (regex 기반 검사는 git↔restore 인접을 요구해 이 우회에 구조적으로 취약).
 *
 * @param {string[]} tokens
 * @returns {number} restore 인덱스, 없으면 -1
 */
function findRestoreIndex(tokens) {
  const gitIndex = tokens.findIndex(t => t === 'git');
  if (gitIndex < 0) return -1;
  for (let i = gitIndex + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === 'restore') return i;
    // 별도 값을 갖는 global option → 값 토큰 소비
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree') {
      i += 1;
      continue;
    }
    if (t.startsWith('-')) continue; // 값 없는 global flag (--no-pager / --literal-pathspecs / -C glued 등)
    return -1; // restore 가 아닌 다른 subcommand
  }
  return -1;
}

/**
 * restore 인자가 unstage-only (--staged 이며 --worktree 없음) 인지.
 * unstage-only 는 working tree 를 건드리지 않으므로 pathspec 범위와 무관하게 안전.
 *
 * @param {string[]} args - 'restore' 뒤의 토큰들
 * @returns {boolean}
 */
function isUnstageOnly(args) {
  let staged = false;
  let worktree = false;
  for (const a of args) {
    if (a === '--') break; // 이후는 pathspec
    if (a === '--staged') staged = true;
    if (a === '--worktree') worktree = true;
  }
  return staged && !worktree;
}

/**
 * `git restore` 호출을 분류한다: 'block' | 'allow' | 'none'.
 *
 * 정책 (사용자 결정 2026-06-16 — blast-radius scoped 완화): stash drop(단일) 허용 /
 * clear(전체) 차단 선례와 동형. 명시적 파일 대상 restore 는 허용하고, working tree
 * 전체/디렉토리/glob/치환/광역 pathspec 을 한 번에 날리는 대형 blast radius 만 차단한다.
 *
 * regex 가 아닌 tokenizer 기반이라 global option 우회(`git -C x restore .`)를 닫는다.
 * command substitution(`$(...)`, backtick) 이 restore segment 에 있으면 치환 내용을
 * 정적으로 알 수 없으므로 보수적으로 차단한다 (--pathspec-from-file 차단과 동일 정신).
 * backslash 이스케이프(`\.`)는 isBoundedPathspec 가 unescape 후 판정한다.
 *
 * Known limitation: 후행 슬래시 없는 디렉토리명(`git restore src`)은 정적으로
 * 파일/디렉토리 구분 불가하여 bounded 로 판정된다 (FS stat 회피 — R-CM-006 fail-open).
 * 주 위협 `git restore .` 광역 삭제는 차단된다.
 *
 * 차단 가드 맥락이므로 파싱 모호 시 'block' 쪽으로 conservative.
 *
 * @param {string} command
 * @returns {'block'|'allow'|'none'}
 */
export function classifyRestore(command) {
  if (!command || typeof command !== 'string') return 'none';

  const inspectable = stripCommitMessageBody(stripHeredocBodies(command));
  const segments = inspectable.split(/[\n;&|]+/);

  let sawRestore = false;
  for (const segment of segments) {
    // restore 를 언급하는 segment 에 shell 치환이 있으면 blast radius 미지 → 차단.
    // (치환이 inner `git restore .` 를 숨기거나 pathspec 을 동적 생성하는 우회 차단)
    if (hasShellSubstitution(segment) && /\brestore\b/i.test(segment)) {
      return 'block';
    }

    const tokens = shellishTokens(segment);
    const restoreIndex = findRestoreIndex(tokens);
    if (restoreIndex < 0) continue;

    sawRestore = true;
    const args = tokens.slice(restoreIndex + 1);
    if (isUnstageOnly(args)) continue; // --staged (working tree 미접촉) → 허용
    if (isBoundedRestoreArgs(args)) continue; // 명시적 파일 → 허용
    return 'block'; // 대형 blast radius
  }

  return sawRestore ? 'allow' : 'none';
}

/**
 * 명령에서 파괴적인 git 패턴을 검사합니다
 * @param {string} command - Bash 명령
 * @returns {{ blocked: boolean, description?: string, matched?: string }}
 */
export function checkDestructiveGit(command) {
  if (!command || typeof command !== 'string') {
    return { blocked: false };
  }

  const inspectable = stripCommitMessageBody(stripHeredocBodies(command));

  if (isDirectWorktreeShippingMerge(command)) {
    return {
      blocked: true,
      kind: 'worktree-shipping',
      description: 'worktree branch fast-forward merge는 create-pr ship-worktree 경로로만 수행해야 합니다',
      matched: extractFastForwardMergeTarget(command),
    };
  }

  // git restore 는 tokenizer 기반 classifyRestore 가 전담 (global option 우회 차단).
  // 'allow'/'none' 이면 통과 (단, 다른 destructive 패턴 검사는 계속 — 예: restore && reset --hard).
  if (classifyRestore(command) === 'block') {
    return {
      blocked: true,
      description:
        'git restore . / glob / 디렉토리 / 치환 / 광역 pathspec 은 working tree 변경을 광역 삭제합니다 (명시적 단일 파일 restore 는 허용)',
      matched: 'git restore',
    };
  }

  // 여러 줄 또는 && / ; / | 로 연결된 복합 명령도 검사
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    const match = inspectable.match(pattern.regex);
    if (match) {
      // allowIf 조건 확인
      if (pattern.allowIf && pattern.allowIf(command)) {
        continue;
      }
      return {
        blocked: true,
        description: pattern.description,
        matched: match[0],
      };
    }
  }

  return { blocked: false };
}

/**
 * Orchestrator 호환 진입점.
 */
export async function run(data) {
  try {
    const toolName = data.tool_name || '';
    if (toolName !== 'Bash') {
      return HookOutput.passthrough();
    }

    const command = data.tool_input?.command || '';

    // create-pr 플로우 진행 중: 안전 명령만 허용, 나머지는 일반 검사로 진행
    const projectDir = process.env.CLAUDE_PROJECT_DIR || '';
    const activeFlag = join(projectDir, '.tmp', 'create-pr-active');
    if (isFreshCreatePrFlag(activeFlag) && isCreatePrSafeCommand(command)) {
      return HookOutput.passthrough();
    }

    const result = checkDestructiveGit(command);

    if (result.blocked) {
      if (result.kind === 'worktree-shipping') {
        return HookOutput.deny(
          `[Destructive Git Guard] 직접 worktree branch fast-forward merge가 차단되었습니다.\n\n` +
          `차단된 merge target: ${result.matched}\n` +
          `이유: ${result.description}\n\n` +
          `worktree shipping은 사용자 확인 후 PR 경로로만 진행하세요.`
        );
      }

      return HookOutput.deny(
        `[Destructive Git Guard] 파괴적인 git 명령이 감지되어 차단합니다.\n\n` +
        `차단된 명령: ${result.matched}\n` +
        `이유: ${result.description}\n\n` +
        `이 명령은 커밋되지 않은 작업을 영구적으로 삭제할 수 있습니다.\n` +
        `사용자에게 먼저 확인을 받은 후 진행해 주세요.`
      );
    }

    return HookOutput.passthrough();
  } catch {
    return HookOutput.passthrough();
  }
}

// Standalone fallback (settings.json 직접 호출 시)
if (!globalThis.__HOOK_ORCHESTRATOR__) {
  safeHookMainWithProfile('destructive-git-guard', async () => {
    const data = await readStdin();
    return output(await run(data));
  });
}
