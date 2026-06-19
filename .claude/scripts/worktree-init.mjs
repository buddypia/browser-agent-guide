#!/usr/bin/env node
/**
 * worktree-init.mjs — R-CM-030 system_persistent worktree share helper
 *
 * 목적: 현재 worktree 의 `.brief2dev/system/` 디렉토리를 main worktree 의
 *       동일 디렉토리로 향하는 symlink 로 만든다. 모든 worktree 가 단일 SSOT
 *       (system_persistent root — git common-dir 의 부모) 를 공유하도록 한다.
 *
 * 멱등성:
 *   - core.hooksPath 가 `.husky` 상대 경로가 아니면 repo-local 설정 정규화
 *   - 이미 정확한 symlink → no-op (exit 0)
 *   - 빈 디렉토리 → 안전하게 제거 후 symlink 생성
 *   - 부재 → 부모 디렉토리 생성 후 symlink
 *   - 파일이 있는 디렉토리 → STOP + 에러 (silent 데이터 손실 회피, R-CM-029 Rule 5)
 *   - 다른 symlink → STOP + 에러
 *
 * 사용:
 *   node .claude/scripts/worktree-init.mjs                  # 현재 cwd
 *   node .claude/scripts/worktree-init.mjs --worktree <path>
 *   node .claude/scripts/worktree-init.mjs --dry-run        # 검사만
 *
 * exit code:
 *   0 — symlink 정상 (생성 / 이미 존재)
 *   1 — 충돌 (수동 해결 필요) / git 외부 / main worktree 자체
 *   2 — 인자 / 사용자 오류
 *
 * AI / 사용자 안내:
 *   본 스크립트는 R-CM-031 Consequential 카테고리 (디렉토리 수정 + 데이터 lifecycle 영향) 라
 *   SessionStart guard 가 자동 호출하지 않는다. 사용자가 명시 호출.
 */

import { existsSync, lstatSync, readlinkSync, readdirSync, rmdirSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * git rev-parse --git-common-dir 으로 main worktree 루트를 산출.
 * 실패 시 null 반환 (호출자가 처리).
 */
function resolveMainWorktreeRoot(cwd) {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!commonDir) return null;
    // common-dir 은 main repo 의 .git 디렉토리 (worktree 안에서는 절대 경로,
    // main 안에서는 ".git"). 그 부모가 main worktree 루트.
    const absoluteCommonDir = resolve(cwd, commonDir);
    return dirname(absoluteCommonDir);
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
    info(`[worktree-init] core.hooksPath already relative: .husky (no-op)`);
    return;
  }

  if (DRY_RUN) {
    info(`[worktree-init] (dry-run) core.hooksPath 정규화 예정: ${current || '(unset)'} → .husky`);
    return;
  }

  execFileSync('git', ['config', 'core.hooksPath', '.husky'], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  info(`[worktree-init] core.hooksPath 정규화: ${current || '(unset)'} → .husky`);
}

const mainRoot = resolveMainWorktreeRoot(WORKTREE);
if (!mainRoot) {
  fail(1, `[worktree-init] git common-dir 해결 실패. cwd=${WORKTREE} 가 git 외부일 가능성.`);
}

normalizeHooksPath(WORKTREE);

if (mainRoot === WORKTREE) {
  info(`[worktree-init] 현재 위치(${WORKTREE}) 는 main worktree 입니다. system 디렉토리는 이미 SSOT 본체이므로 symlink 불필요. SKIP.`);
  process.exit(0);
}

// @layout-resolver-allow — 본 스크립트는 layout-resolver 의 의존성 (symlink 생성) 을
// 자체적으로 부트스트랩하는 책임. resolver 호출 시 본 worktree 의 system path 가
// 이미 main symlink 로 향해버리므로 hardcode 가 의도적.
const mainSystemDir = join(mainRoot, '.brief2dev', 'system'); // @layout-resolver-allow
const localBriefDir = join(WORKTREE, '.brief2dev'); // @layout-resolver-allow
const localSystemPath = join(localBriefDir, 'system');

// main 의 system 부재 시 정직하게 안내 (worktree-init 이 main 을 변경하지 않는다).
if (!existsSync(mainSystemDir)) {
  fail(
    1,
    `[worktree-init] main worktree 의 system 디렉토리가 없습니다: ${mainSystemDir}\n` +
      `먼저 main 에서 brief2dev 가 한번 실행되어 ${mainSystemDir} 가 만들어진 뒤 재시도하세요.\n` +
      `(또는 mkdir -p '${mainSystemDir}' 직접 생성 — 권장은 자연 생성)`,
  );
}

// 현재 상태 분류
let status; // 'absent' | 'correct_symlink' | 'wrong_symlink' | 'empty_dir' | 'non_empty_dir' | 'file'
let detail = null;

if (!existsSync(localSystemPath)) {
  // lstat 도 throw 하면 부재. 단, 깨진 symlink 도 lstat 통과 → 별도 처리.
  try {
    const st = lstatSync(localSystemPath);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(localSystemPath);
      const resolved = resolve(dirname(localSystemPath), target);
      status = resolved === mainSystemDir ? 'correct_symlink' : 'wrong_symlink';
      detail = { target, resolved };
    } else {
      // existsSync false 인데 lstat 성공 = 거의 발생 안 함. 안전한 fallback.
      status = 'absent';
    }
  } catch {
    status = 'absent';
  }
} else {
  const st = lstatSync(localSystemPath);
  if (st.isSymbolicLink()) {
    const target = readlinkSync(localSystemPath);
    const resolved = resolve(dirname(localSystemPath), target);
    status = resolved === mainSystemDir ? 'correct_symlink' : 'wrong_symlink';
    detail = { target, resolved };
  } else if (st.isDirectory()) {
    const entries = readdirSync(localSystemPath).filter((e) => !e.startsWith('.DS_'));
    status = entries.length === 0 ? 'empty_dir' : 'non_empty_dir';
    detail = { entries };
  } else {
    status = 'file';
  }
}

const relSystemFromWorktree = relative(WORKTREE, localSystemPath);
const relTargetFromLink = relative(dirname(localSystemPath), mainSystemDir);

function createSymlink() {
  if (DRY_RUN) {
    info(`[worktree-init] (dry-run) symlink 생성 예정: ${relSystemFromWorktree} → ${relTargetFromLink}`);
    return;
  }
  if (!existsSync(localBriefDir)) {
    mkdirSync(localBriefDir, { recursive: true });
  }
  // 상대 경로 symlink — worktree 가 다른 머신으로 이동해도 동작하도록 (단,
  // 같은 디렉토리 구조 가정. 절대 경로보다 견고).
  symlinkSync(relTargetFromLink, localSystemPath);
  info(`[worktree-init] 생성: ${relSystemFromWorktree} → ${relTargetFromLink}`);
}

/**
 * PLAN.md 가 없으면 표준 템플릿으로 자동 생성. 있으면 보존.
 * DRY_RUN 에서는 SKIP. 실패는 fail-open (worktree-init 의 symlink 책임은 영향 없음).
 *
 * 회귀 항목: 직전 회고 #1 "PLAN.md 위치 헷갈림" — AI 가 매 worktree 마다 mkdir
 * + Write 사이클을 반복하던 패턴을 SSOT 호출 1 회로 차단.
 */
function ensurePlanIfApplicable() {
  if (DRY_RUN) return;
  try {
    const result = ensureWorktreePlan(WORKTREE);
    if (result.created) {
      info(`[worktree-init] PLAN.md 자동 생성: ${relative(WORKTREE, result.path)}`);
    } else {
      info(`[worktree-init] PLAN.md 이미 존재 (보존): ${relative(WORKTREE, result.path)}`);
    }
  } catch (e) {
    info(`[worktree-init] PLAN.md 자동 생성 SKIP: ${e.message}`);
  }
}

const MAIN_LOG_LINES = 5;

/**
 * main 의 최근 N commit 을 표시한다. AI 가 작업 시작 시 main 의 hook/script CLI
 * 변화 (예: PR #309 `mark-pre-ship-confirmed --quality` 강제) 를 사전 인지하도록
 * 한다. fetch 는 수행하지 않는다 — 사용자가 fetch 한 시점의 main 을 보여줄 뿐.
 *
 * fail-open: git log 실패 (worktree 가 git 외부 / origin/main 부재 / 권한 부족 등)
 * 시 silent skip. worktree-init 의 symlink 책임은 영향 없음.
 */
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
      info(`[worktree-init] main 최근 ${MAIN_LOG_LINES} commit (작업 시작 전 검토 권장):\n${indented}`);
    }
  } catch {
    // origin/main 부재 / git fetch 안 됨 / 권한 부족 → silent fail-open
  }
}

function injectGitEnv(worktreePath) {
  if (DRY_RUN) return;
  try {
    const dotGitPath = join(worktreePath, '.git');
    let gitDir = join(mainRoot, '.git');
    if (existsSync(dotGitPath)) {
      const gitContent = readFileSync(dotGitPath, 'utf-8').trim();
      if (gitContent.startsWith('gitdir:')) {
        gitDir = gitContent.slice('gitdir:'.length).trim();
      }
    }

    // 1. Claude Code env injection (.claude/settings.local.json)
    const settingsLocalPath = join(worktreePath, '.claude', 'settings.local.json');
    let existing = {};
    if (existsSync(settingsLocalPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsLocalPath, 'utf-8'));
      } catch {
        // ignore
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
    info(`[worktree-init] settings.local.json 환경변수(GIT_WORK_TREE, GIT_DIR) 주입 완료: ${relative(worktreePath, settingsLocalPath)}`);

    // 2. Codex env injection (.codex/config.toml)
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
      let envIdx = lines.findIndex(line => line.trim() === '[env]');
      
      // Clean up previous values if they exist
      let wtIdx = lines.findIndex((line, i) => i > envIdx && line.trim().startsWith('GIT_WORK_TREE'));
      if (wtIdx !== -1) lines.splice(wtIdx, 1);
      
      let dirIdx = lines.findIndex((line, i) => i > envIdx && line.trim().startsWith('GIT_DIR'));
      if (dirIdx !== -1) lines.splice(dirIdx, 1);

      // Re-evaluate index and insert values right after [env]
      envIdx = lines.findIndex(line => line.trim() === '[env]');
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
    info(`[worktree-init] .codex/config.toml 환경변수 주입 완료: ${relative(worktreePath, codexConfigPath)}`);

    // 3. Antigravity CLI config injection (.agents/config.json)
    const agentsConfigPath = join(worktreePath, '.agents', 'config.json');
    let agentsExisting = {};
    if (existsSync(agentsConfigPath)) {
      try {
        agentsExisting = JSON.parse(readFileSync(agentsConfigPath, 'utf-8'));
      } catch {
        // ignore
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
    info(`[worktree-init] .agents/config.json 환경변수 주입 완료: ${relative(worktreePath, agentsConfigPath)}`);

  } catch (e) {
    info(`[worktree-init] 환경변수 주입 실패: ${e.message}`);
  }
}

/**
 * 성공 case 의 공통 종료 트리오. 새 case 추가 시 호출 누락 차단 (DRY).
 */
function finishInit() {
  injectGitEnv(WORKTREE);
  ensurePlanIfApplicable();
  showMainRecentCommits();
  process.exit(0);
}

switch (status) {
  case 'correct_symlink':
    info(`[worktree-init] 이미 정상 symlink: ${relSystemFromWorktree} → ${relTargetFromLink} (no-op)`);
    finishInit();
    break;

  case 'absent':
    createSymlink();
    finishInit();
    break;

  case 'empty_dir':
    if (DRY_RUN) {
      info(`[worktree-init] (dry-run) 빈 디렉토리 제거 후 symlink 생성 예정`);
      process.exit(0);
    }
    rmdirSync(localSystemPath);
    createSymlink();
    finishInit();
    break;

  case 'wrong_symlink':
    fail(
      1,
      `[worktree-init] CONFLICT: ${relSystemFromWorktree} 는 이미 다른 symlink 입니다.\n` +
        `  현재 target : ${detail.target} (= ${detail.resolved})\n` +
        `  필요한 target: ${relTargetFromLink} (= ${mainSystemDir})\n` +
        `해결: 의도된 link 가 맞다면 SKIP. 아니면 다음 명령으로 수동 정정:\n` +
        `  rm '${localSystemPath}' && node ${process.argv[1]} --worktree '${WORKTREE}'`,
    );
    break;

  case 'non_empty_dir':
    fail(
      1,
      `[worktree-init] CONFLICT: ${relSystemFromWorktree} 는 파일이 있는 실제 디렉토리 입니다.\n` +
        `  내용: ${detail.entries.slice(0, 5).join(', ')}${detail.entries.length > 5 ? ' ...' : ''}\n` +
        `silent 데이터 손실 방지를 위해 자동 변환하지 않습니다.\n` +
        `해결 옵션:\n` +
        `  (a) 이 worktree 의 system/ 내용이 필요 없으면 — rm -rf '${localSystemPath}' 후 재실행\n` +
        `  (b) main 의 system/ 으로 병합이 필요하면 — 수동 비교 후 main 으로 복사, 그 다음 rm -rf '${localSystemPath}' 후 재실행\n` +
        `  (c) 본 worktree 만 격리된 system 이 필요하면 — symlink 메커니즘 미사용. R-CM-030 위반이므로 권장 안 함.`,
    );
    break;

  case 'file':
    fail(
      1,
      `[worktree-init] CONFLICT: ${relSystemFromWorktree} 는 파일 입니다 (디렉토리 또는 symlink 예상).\n` +
        `해결: rm '${localSystemPath}' 후 재실행.`,
    );
    break;

  default:
    fail(2, `[worktree-init] internal: 알 수 없는 상태 — ${status}`);
}
