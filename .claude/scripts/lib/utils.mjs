/**
 * Common Utilities Module
 *
 * Hook 스크립트가 공유하는 유틸리티 함수.
 * stdin 읽기, stdout 출력, 안전 체크 등.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { isHookEnabled } from './hook-flags.mjs';

// ═══════════════════════════════════════════════════════════════
// 안전한 JSON 파일 읽기 (중앙화)
//
// existsSync + readFileSync + JSON.parse + try/catch 패턴이
// 82회 이상 반복되던 것을 단일 함수로 통합.
// ═══════════════════════════════════════════════════════════════

/**
 * JSON 파일을 안전하게 읽어 파싱한다.
 *
 * 파일 미존재, 읽기 오류, JSON 파싱 오류 시 defaultValue를 반환한다.
 * throw하지 않으므로 모든 호출부에서 try/catch가 불필요하다.
 *
 * @param {string} filePath - 절대 경로
 * @param {*} [defaultValue=null] - 실패 시 반환할 기본값
 * @returns {object|*} 파싱된 JSON 객체 또는 defaultValue
 */
export function safeReadJson(filePath, defaultValue = null) {
  try {
    if (!existsSync(filePath)) return defaultValue;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return defaultValue;
  }
}

/**
 * handoff.confidence 가 object {score, level, ...} 또는 number (legacy) 양식 둘 다
 * 지원하는 score 추출 helper. finite 숫자가 아니면 null 반환.
 *
 * R-CM-026 정합: handoff (skill detail) SSOT 의 confidence 표현이 다양한 양식을
 * 가질 수 있는 boundary 함수. saga-manager.syncStageFromHandoff +
 * stage-output-aggregator.mergeHandoffConfidence 두 진입점에서 공유.
 *
 * @param {*} conf - handoff.confidence 값 (object|number|undefined|null)
 * @returns {number|null} finite score 또는 null
 */
export function extractConfidenceScore(conf) {
  const raw =
    typeof conf === 'object' && conf !== null
      ? conf.score
      : typeof conf === 'number'
        ? conf
        : null;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

// ═══════════════════════════════════════════════════════════════
// 원자적 파일 쓰기 (중앙화)
//
// 6곳에서 중복되던 tmp+rename 패턴을 단일 함수로 통합.
// 모든 상태 관리 모듈(state.mjs, saga-manager.mjs 등)이 이 함수를 사용.
// ═══════════════════════════════════════════════════════════════

/**
 * JSON 데이터를 파일에 원자적으로 쓴다 (tmp + rename 패턴).
 *
 * POSIX에서 같은 파일시스템 내 rename은 원자적이므로,
 * 대상 파일과 같은 디렉토리에 tmp 파일을 생성하여 크로스파티션 문제를 방지한다.
 *
 * @param {string} filePath - 대상 파일 절대 경로
 * @param {object|string} data - JSON 직렬화할 객체 또는 이미 직렬화된 문자열
 * @param {object} [options]
 * @param {boolean} [options.ensureDir=true] - 디렉토리 자동 생성 여부
 * @param {number} [options.indent=2] - JSON.stringify indent (data가 문자열이면 무시)
 * @returns {boolean} 성공 여부
 */
export function atomicWriteJson(filePath, data, options = {}) {
  const { ensureDir = true, indent = 2 } = options;
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tmpPath = join(dir, `.${base}.${randomBytes(4).toString('hex')}.tmp`);

  try {
    if (ensureDir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, indent);
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);
    return true;
  } catch {
    // 임시 파일 정리 시도
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Git 유틸리티 (중앙화)
// ═══════════════════════════════════════════════════════════════

/** git repo 여부 캐시 (프로세스 생명주기 내 불변) */
const _gitRepoCache = new Map();

/**
 * 지정 디렉토리가 git 저장소인지 확인한다.
 * 결과를 캐싱하여 동일 프로세스 내 반복 fork를 방지.
 *
 * @param {string} cwd - 확인할 디렉토리
 * @returns {boolean}
 */
export function isGitRepo(cwd) {
  if (_gitRepoCache.has(cwd)) return _gitRepoCache.get(cwd);
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    _gitRepoCache.set(cwd, true);
    return true;
  } catch {
    _gitRepoCache.set(cwd, false);
    return false;
  }
}

/**
 * 셸 명령어를 안전하게 실행한다 (중앙화).
 *
 * - stdio를 항상 파이프하여 stderr가 부모 프로세스(Claude Code)로 누출되지 않음
 * - 실패 시 null 반환 (throw 안 함)
 * - 모든 hook 스크립트는 이 함수를 사용해야 함
 *
 * @param {string} cmd - 실행할 명령어
 * @param {string} cwd - 작업 디렉토리
 * @param {object} [options]
 * @param {number} [options.timeout=10000] - 타임아웃(ms)
 * @returns {string|null} stdout (trimmed) 또는 null
 */
export function safeExec(cmd, cwd, options = {}) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: options.timeout ?? 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * git 명령어를 안전하게 실행한다.
 * git 저장소가 아니면 즉시 null 반환 (fork 없이).
 *
 * @param {string} gitArgs - git 서브커맨드 + 인자 (예: "status --porcelain")
 * @param {string} cwd - 작업 디렉토리
 * @param {object} [options]
 * @param {number} [options.timeout=10000] - 타임아웃(ms)
 * @returns {string|null}
 */
export function safeGit(gitArgs, cwd, options = {}) {
  if (!isGitRepo(cwd)) return null;
  return safeExec(`git ${gitArgs}`, cwd, options);
}

/**
 * 프로젝트 루트 디렉토리를 해석한다. (Worktree-aware)
 * 우선순위: CLAUDE_PROJECT_DIR > hookData.cwd > process.cwd()
 * Worktree 내부에서 실행된 경우 (.worktrees/...) 원본 프로젝트 루트로 resolve 한다.
 *
 * @param {object} [hookData] - Hook stdin 데이터 (data.cwd를 포함할 수 있음)
 * @returns {string} 프로젝트 루트의 절대 경로
 */
export function resolveProjectDir(hookData) {
  let dir = process.env.CLAUDE_PROJECT_DIR || hookData?.cwd || process.cwd();
  const wtIndex = dir.indexOf('/.worktrees/');
  if (wtIndex !== -1) {
    dir = dir.substring(0, wtIndex);
  }
  return dir;
}

/**
 * stdin에서 JSON 데이터 읽기
 * Claude Code Hooks는 stdin으로 이벤트 데이터를 전달.
 *
 * @returns {Promise<object>}
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * stdout으로 JSON 결과 출력
 * Hook 결과는 반드시 stdout JSON으로 전달.
 *
 * @param {object} data - 출력할 데이터
 */
export function output(data) {
  console.log(JSON.stringify(data));
}

/**
 * Context Limit에 의한 Stop 감지
 * Context가 가득 찬 경우 절대 블록하지 않는다 (deadlock 방지)
 *
 * Claude Code Hooks에서는 Stop 입력의 메타데이터로 판단.
 */
export function isContextLimitStop(data) {
  const reason = (data.stop_reason || data.stopReason || '').toLowerCase();
  const endTurnReason = (data.end_turn_reason || data.endTurnReason || '').toLowerCase();

  const patterns = [
    'context_limit',
    'context_window',
    'context_exceeded',
    'context_full',
    'max_context',
    'token_limit',
    'max_tokens',
    'conversation_too_long',
    'input_too_long',
  ];

  return patterns.some((p) => reason.includes(p) || endTurnReason.includes(p));
}

/**
 * 사용자 취소 감지
 */
export function isUserAbort(data) {
  if (data.user_requested || data.userRequested) return true;

  const reason = (data.stop_reason || data.stopReason || '').toLowerCase();
  const exact = ['aborted', 'abort', 'cancel', 'interrupt'];
  const sub = ['user_cancel', 'user_interrupt', 'ctrl_c', 'manual_stop'];

  return exact.some((p) => reason === p) || sub.some((p) => reason.includes(p));
}

/**
 * Markdown Plan 파일 체크박스 파싱
 * - [ ] = 미완료, - [x] 또는 - [X] = 완료
 * 코드 블록(```) 내부 무시
 *
 * @param {string} planFilePath
 * @returns {{ total: number, completed: number, uncheckedItems: string[] } | null}
 */
export function parsePlanProgress(planFilePath) {
  if (!existsSync(planFilePath)) return null;

  try {
    const content = readFileSync(planFilePath, 'utf-8');
    const lines = content.split('\n');
    let inCodeBlock = false;
    let total = 0;
    let completed = 0;
    const uncheckedItems = [];

    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      const match = line.match(/^(\s*)- \[([ xX])\]\s+(.+)/);
      if (match) {
        total++;
        if (match[2].toLowerCase() === 'x') {
          completed++;
        } else {
          uncheckedItems.push(match[3].trim());
        }
      }
    }

    return { total, completed, uncheckedItems };
  } catch {
    return null;
  }
}

/**
 * 파이프라인 산출물의 progress를 실제 파일 존재 여부와 교차 검증.
 * 파일이 존재하지만 status가 "pending"인 항목을 불일치로 감지.
 *
 * Stop Hook에서 진행률 갱신 누락을 감지하는 데 사용.
 *
 * @param {string} projectDir - 프로젝트 루트 디렉토리
 * @param {string} contextRelPath - 산출물 JSON 상대 경로
 * @returns {{ mismatches: number, details: Array<{stage: string, status: string, existingCount: number}> }}
 */
export function validatePipelineProgress(projectDir, contextRelPath) {
  const contextPath = join(projectDir, contextRelPath);
  if (!existsSync(contextPath)) return { mismatches: 0, details: [] };

  try {
    const context = JSON.parse(readFileSync(contextPath, 'utf-8'));
    const progressDetails = context?.progress?.details;
    if (!progressDetails || typeof progressDetails !== 'object') {
      return { mismatches: 0, details: [] };
    }

    const mismatches = [];

    for (const [stage, info] of Object.entries(progressDetails)) {
      if (typeof info !== 'object' || !info) continue;
      if (info.status === 'completed') continue;
      const files = info.files;
      if (!Array.isArray(files) || files.length === 0) continue;

      const existingCount = files.filter((f) => existsSync(join(projectDir, f))).length;

      if (existingCount > 0 && info.status !== 'completed') {
        mismatches.push({
          stage,
          status: info.status || 'pending',
          existingCount,
          totalFiles: files.length,
        });
      }
    }

    return { mismatches: mismatches.length, details: mismatches };
  } catch {
    return { mismatches: 0, details: [] };
  }
}


/**
 * Claude Code Task 시스템에서 미완료 작업 카운트
 *
 * Claude Code의 Task 파일은 ~/.claude/tasks/{sessionId}/에 저장.
 */
export function countIncompleteTasks(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return 0;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) return 0;

  const taskDir = join(homedir(), '.claude', 'tasks', sessionId);
  if (!existsSync(taskDir)) return 0;

  let count = 0;
  try {
    const files = readdirSync(taskDir).filter((f) => f.endsWith('.json') && f !== '.lock');
    for (const file of files) {
      try {
        const content = readFileSync(join(taskDir, file), 'utf-8');
        const task = JSON.parse(content);
        if (task.status === 'pending' || task.status === 'in_progress') count++;
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* skip */
  }
  return count;
}

/**
 * Hook main 함수 안전 래퍼
 *
 * Node.js 22의 unhandled rejection 방지를 위한 필수 래퍼.
 * 1. 예외 시 deadlock 방지 (빈 JSON 출력으로 passthrough)
 * 2. stderr 출력 없이 빈 JSON(passthrough) 출력
 * 3. stdout 파이프 파손도 안전하게 처리
 *
 * 사용법:
 *   import { safeHookMain } from './lib/utils.mjs';
 *   safeHookMain(main);
 *
 * @param {() => Promise<void>} fn - async main 함수
 */
export function safeHookMain(fn) {
  fn().catch((err) => {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      console.error('[Fail-Loud in Test] Hook execution failed:', err);
      process.exit(1);
    }
    // NOTE: console.error 사용 금지 — stderr 출력이 Claude Code에 "hook error"로 표시됨
    try { console.log('{}'); } catch { /* stdout 파이프 파손 시 무시 */ }
  });
}

/**
 * Hook Profile 기반 안전 래퍼
 *
 * safeHookMain + isHookEnabled 체크를 결합.
 * hookId가 현재 프로파일에서 비활성이면 즉시 passthrough (빈 JSON).
 *
 * 사용법:
 *   import { safeHookMainWithProfile } from './lib/utils.mjs';
 *   safeHookMainWithProfile('coverage-threshold-guard', main);
 *
 * @param {string} hookId - 훅 식별자
 * @param {() => Promise<void>} fn - async main 함수
 */
export function safeHookMainWithProfile(hookId, fn) {
  if (!isHookEnabled(hookId)) {
    try { console.log('{}'); } catch { /* stdout 파이프 파손 시 무시 */ }
    return;
  }
  safeHookMain(fn);
}
