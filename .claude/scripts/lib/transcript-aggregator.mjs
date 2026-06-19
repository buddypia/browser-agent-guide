/**
 * transcript-aggregator.mjs — Observatory transcript listing + read
 *
 * .brief2dev/runs/<run_id>/transcript/*.jsonl 을 read-only 로 노출하여
 * brief2dev-webui.mjs 가 채팅 이력을 큰 화면으로 보여줄 수 있게 한다.
 *
 * R-CM-035 invariant: write 호출 없음 (read-only aggregator).
 * R-CM-006 fail-open: 어떤 파일/디렉터리 오류도 silent skip.
 * Boundary (R-CM-028): 관점 1 (brief2dev 자체) 전용 — scaffold target 미배포.
 */

import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
// Raw 디렉터리 fallback (사용자 결정 2026-05-20): transcript-extractor 는
// SessionEnd hook 에서만 갱신하므로 진행 중 세션의 jsonl 은 transcript/ 미반영.
// listTranscripts / readTranscript 가 raw 를 union read 하여 live append 도 surface.
// R-CM-035 invariant 유지 — raw 는 Claude Code 가 write, webui 는 read-only.
import {
  resolveRawProjectsDir,
  readActiveRun,
} from '../migrate-orphan-transcripts.mjs';
import { getArchivesRoot } from './layout-resolver.mjs';

// noise entry types — Claude Code 가 jsonl 에 기록하지만 채팅 흐름 외 메타 데이터.
// last-prompt / permission-mode / attachment / file-history-snapshot 등이
// 사용자 채팅 화면에 표시되면 "내용 없는 빈 말풍선" 으로 보이므로 정규화 단계에서 제거.
const NOISE_ENTRY_TYPES = new Set([
  'file-history-snapshot',
  'last-prompt',
  'permission-mode',
  'attachment',
]);

// active run 관련성 sniff — jsonl 이 *brief2dev-orchestrator 스킬로 시작한* 세션인지 식별.
//
// 2026-05-27 v3 (사용자 결정): "brief2dev-orchestrator 로 시작한 대화만 남겨라".
// 이전 정책의 false-positive 패턴:
//   - 세션이 `/goal` / `/clear` 같은 다른 슬래시로 시작 + args 안에 nested
//     `<command-name>/brief2dev-orchestrator</command-name>` 인용 (예: 본 fix 의
//     /goal 호출이 자체 args 에 brief2dev-orchestrator 텍스트 포함)
//   - assistant turn 의 tool_result 본문에 다른 jsonl 의 raw 인용 (attachment)
//   - sub-skill 단독 직접 호출 (사용자 의도와 무관 — orchestrator 가 spawn 한 결과 아닌
//     직접 business-analyzer 호출 등은 "orchestrator 로 시작" 정의에 해당하지 않음)
//
// 새 정책 (session-start signal): 첫 N user turn 중 *어느 한* text block 의 *첫*
// `<command-name>` 정규식 매치가 'brief2dev-orchestrator' 일 때만 인정. 또는 첫 N
// assistant turn 의 *첫* `Skill` tool_use 의 skill 이 'brief2dev-orchestrator'.
//
// "첫 매치" 가 핵심 — args 안의 nested 인용은 outer `<command-name>` 매치 이후이므로
// 자연스럽게 제외된다. sub-skill (business-analyzer 등) Skill tool_use 는 orchestrator
// boot 이후 spawn 되어 같은 jsonl 안에 등장하지만, "시작" signal 로는 인정하지 않는다.
//
// 회귀 테스트: tests/unit/transcript-aggregator.test.mjs.
const TARGET_SKILL_CANON = 'brief2dev-orchestrator';

// user turn text block 의 *첫* command-name 매치 추출용 (global flag 없음 — 첫 매치만)
const FIRST_COMMAND_NAME_RE = /<command-name>\s*\/?([a-zA-Z][a-zA-Z0-9_-]*)\s*<\/command-name>/i;

// session-start signal 탐색 범위 — Claude Code 의 슬래시 스킬 호출은 보통 첫 3 user
// turn 안에 등장 (turn#1 = local-command-caveat, turn#2 = /clear, turn#3 = /skill 패턴).
// 안전망으로 약간 여유 (3).
const MAX_USER_TURNS_CHECK = 3;
const MAX_ASSISTANT_TURNS_CHECK = 3;
// 안전망: 첫 100 jsonl line 안에서 첫 3 user turn 발견 못 하면 포기 (event loop 보호).
const MAX_SNIFF_LINES = 200;

// SessionEnd hook 은 동기 호출이므로 multi-MB jsonl 전체 read 시 event loop 점유.
// brief2dev 키워드는 세션 초반 (스킬 호출 / orchestrator boot) 에 집중되므로
// head 1 MB 만 읽고 sniff 한다. 임계값 미달 시에도 false — 보수적으로 skip.
const MAX_SNIFF_BYTES = 1024 * 1024;

// Idle 세션 sentinel runId — 사용자 결정 2026-05-25 (Observatory 시대 동작 복원).
// active.json status='idle' (run_id=null, started_at=null) 상태에서 사용자가
// brief2dev-orchestrator 슬래시 스킬을 호출하여 첫 메시지부터 대화 중인 경우,
// webui 의 endpoint pattern (`/api/sessions/<runId>/...`) 이 runId 필수라 surface
// 불가능. 본 sentinel runId 로 main worktree raw jsonl most-recent (brief2dev
// sniff 통과) 1 개를 fallback surface 한다.
//
// 회귀 (Observatory 시대 webui/observatory/app.js:522 의 `const idle = !s.run_id...`
// pattern 이 Loom rename 시 webui/loom/app.js:367-368 의 `if (!runId) continue` 로
// 사라짐). Layer 2 보강 — transcript-aggregator 의 active.started_at 게이트도
// 우회하여 첫 메시지부터 live append 반영.
export const IDLE_SENTINEL_RUN_ID = '_idle_main';

// sniff head 읽기 — size ≤ MAX_SNIFF_BYTES 면 전체, 초과 시 head 만 partial read
// (SessionEnd 동기 호출의 event loop 점유 회피). 실패 시 null.
function readSniffHead(jsonlPath) {
  try {
    const size = statSync(jsonlPath).size;
    if (size <= MAX_SNIFF_BYTES) {
      return readFileSync(jsonlPath, 'utf-8');
    }
    const fd = openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(MAX_SNIFF_BYTES);
      const n = readSync(fd, buf, 0, MAX_SNIFF_BYTES, 0);
      return buf.slice(0, n).toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// user turn 의 첫 text block 안 *첫* <command-name> 매치가 TARGET_SKILL_CANON 인지.
// block[1+] (attachment) 의 외부 jsonl raw 인용 false-positive 회피 — 첫 text block 만.
function userTurnStartsWithTarget(message) {
  const content = message.content;
  let firstText = null;
  if (typeof content === 'string') firstText = content;
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        firstText = b.text;
        break;
      }
    }
  }
  if (firstText === null) return false;
  const m = FIRST_COMMAND_NAME_RE.exec(firstText);
  return !!(m && m[1] === TARGET_SKILL_CANON);
}

// assistant turn 의 *첫* Skill tool_use 의 skill 이 TARGET_SKILL_CANON 인지.
// (orchestrator 이외 스킬이 먼저 spawn 됐으면 "orchestrator 로 시작" 아님)
function assistantTurnStartsWithTarget(message) {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    if (!b || b.type !== 'tool_use' || b.name !== 'Skill') continue;
    const sk = b.input && (b.input.skill || b.input.skill_name);
    return sk === TARGET_SKILL_CANON;
  }
  return false;
}

// jsonl 한 line 을 trim + JSON.parse. 빈 line / 파싱 실패 시 null.
function parseJsonlLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// user/assistant turn entry 의 시작 signal 체크 + counts mutate. turn 아니면 false.
function checkTurnSignal(entry, counts) {
  if (!entry || typeof entry !== 'object') return false;
  const type = entry.type;
  if (type !== 'user' && type !== 'assistant') return false;
  const message = entry.message;
  if (!message || typeof message !== 'object') return false;
  if (type === 'user') {
    if (counts.user >= MAX_USER_TURNS_CHECK) return false;
    counts.user++;
    return userTurnStartsWithTarget(message);
  }
  if (counts.assistant >= MAX_ASSISTANT_TURNS_CHECK) return false;
  counts.assistant++;
  return assistantTurnStartsWithTarget(message);
}

// sniff head 의 첫 N user/assistant turn 에서 brief2dev-orchestrator 시작 signal 탐색.
function detectStartSignal(raw) {
  const counts = { user: 0, assistant: 0 };
  let lineCount = 0;
  for (const line of raw.split('\n')) {
    lineCount++;
    if (lineCount > MAX_SNIFF_LINES) break;
    if (counts.user >= MAX_USER_TURNS_CHECK && counts.assistant >= MAX_ASSISTANT_TURNS_CHECK) break;
    if (checkTurnSignal(parseJsonlLine(line), counts)) return true;
  }
  return false;
}

/**
 * jsonl 이 brief2dev-orchestrator 스킬로 *시작한* 세션인지 sniff.
 *
 * 통과 조건 (둘 중 하나):
 *  (a) 첫 MAX_USER_TURNS_CHECK user turn 중 어느 한 turn 의 *첫 text block*
 *      안의 *첫* `<command-name>...</command-name>` 매치가 'brief2dev-orchestrator'
 *  (b) 첫 MAX_ASSISTANT_TURNS_CHECK assistant turn 중 어느 한 turn 의 *첫*
 *      `Skill` tool_use 의 skill 이 'brief2dev-orchestrator'
 *
 * "첫 text block" 으로 제한하는 이유: Claude Code 의 슬래시 스킬 호출은 항상
 * single text block 으로 기록된다 (88baf9d9 / b12d2939 실 raw 확인). multi-block
 * user turn 의 block[1+] 는 attachment / image / paste 라서 외부 jsonl 의 raw
 * 인용으로 `<command-name>/brief2dev-orchestrator</command-name>` 텍스트가 들어올
 * 수 있다 (false-positive 회피).
 *
 * 거부되는 false-positive 케이스:
 *  - `/goal` / `/clear` 등 다른 슬래시 명령으로 시작 + args 안에 nested
 *    `<command-name>/brief2dev-orchestrator</command-name>` 인용
 *  - user turn 의 block[1+] (attachment) 에 다른 jsonl raw 인용
 *  - assistant tool_result 본문에 다른 jsonl 의 raw 인용 (attachment)
 *  - sub-skill (business-analyzer 등) 단독 직접 호출
 *
 * transcript-extractor (SessionEnd 복사 전) + quarantine + migrate-orphan + idle
 * fallback + listTranscripts 모두에서 재사용.
 *
 * @param {string} jsonlPath
 * @param {object} [opts] - **@deprecated v3 (2026-05-27) 폐기. 이전 정책의 threshold
 *   인터페이스 호환을 위해 시그니처만 유지. 내부적으로 완전히 무시되며, 다음 변경
 *   사이클에 caller (transcript-extractor.mjs:47 등) 정리 후 제거 예정.**
 * @returns {boolean} brief2dev-orchestrator 로 시작했으면 true.
 *   파일 부재/읽기 실패/시작 signal 부재 시 false.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- @deprecated opts, 다음 사이클 caller 정리 후 제거
export function isJsonlBriefDevRelated(jsonlPath, opts = {}) {
  if (typeof jsonlPath !== 'string' || jsonlPath.length === 0) return false;
  if (!existsSync(jsonlPath)) return false;
  const raw = readSniffHead(jsonlPath);
  if (raw === null) return false;
  return detectStartSignal(raw);
}

/**
 * Raw Claude Code 디렉터리 (`~/.claude/projects/<encoded>/*.jsonl`) 에서 active
 * run started_at 이후 mtime + sniff 통과 jsonl 을 수집한다. 진행 중 세션의 live
 * append 도 surface 하기 위한 fallback (사용자 결정 2026-05-20).
 *
 * @param {string} projectRoot - main project root (raw 디렉터리 encoding 기준)
 * @returns {Array<{session_id, size, modified_at}>} active run 시작 이후 sniff 통과 jsonl
 */
// fs.statSync wrapper — error 시 null. readTranscript 의 transcript/ vs raw
// mtime 비교에서 둘 다 존재 여부 + race 조건 (파일 삭제) 안전 흡수.
function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Idle 상태 fallback — active.started_at 부재 시 (사용자가 brief2dev-orchestrator
 * 슬래시 스킬 호출 직후 첫 대화 중) main worktree raw jsonl 의 brief2dev sniff
 * 통과 + 가장 최근 mtime 상위 N 개를 surface.
 *
 * collectRawJsonls 와의 차이: active.started_at cutoff 부재 (idle 시 전체 raw
 * 중에서 mtime 상위 N). collectRawJsonls 는 active run started_at 이후 + 임계값
 * 통과 N 개 모두 반환. 두 함수의 의도가 직교라 분리.
 *
 * 사용자 결정 2026-05-26: N=1 → N=5 확장. 슬래시 wrapper sniff 가 AI 디버깅
 * 인용 (다른 jsonl 의 슬래시 호출이 본 세션 attachment 로 기록) 같은 정황적
 * brief2dev 세션도 매치하기 때문에, 사용자가 list 에서 진짜 invocation 세션을
 * 골라 클릭할 수 있도록 Observatory 시대 list+클릭 UX 복원.
 *
 * @param {string} projectRoot - main project root (raw 디렉터리 encoding 기준)
 * @param {object} [opts]
 * @param {string} [opts.rawDir] - 테스트 sandbox 가 가짜 raw dir 지정 가능
 * @param {number} [opts.limit=5] - 반환 최대 entry 수 (mtime desc)
 * @returns {Array<{session_id, size, modified_at, is_current}>} 0..limit 개
 */
// jsonl 디렉터리 스캔 공통 코어 — readdir + name filter (`[a-zA-Z0-9_-]+.jsonl`) +
// statSync + isFile + sniff (brief2dev-orchestrator 시작 세션만). mtimeMs 포함
// entry[] 반환 (caller 가 정렬/strip 결정). 디렉터리 부재 또는 readdir 실패 시 [].
// extraFilter(stat) 로 mtime cutoff 등 추가 조건 주입.
function scanJsonlDir(dir, { extraFilter = null } = {}) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!/^[a-zA-Z0-9_-]+\.jsonl$/.test(name)) continue;
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      if (extraFilter && !extraFilter(stat)) continue;
      if (!isJsonlBriefDevRelated(full)) continue;
      out.push({
        session_id: name.replace(/\.jsonl$/, ''),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        modified_at: stat.mtime.toISOString(),
        is_current: false,
      });
    } catch {
      continue;
    }
  }
  return out;
}

// entry 에서 내부 비교용 mtimeMs 제거 (caller API surface 유지).
function stripMtimeMs(entry) {
  return {
    session_id: entry.session_id,
    size: entry.size,
    modified_at: entry.modified_at,
    is_current: entry.is_current,
  };
}

export function collectIdleRawJsonl(projectRoot, opts = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return [];
  const rawDir = opts && typeof opts.rawDir === 'string'
    ? opts.rawDir
    : resolveRawProjectsDir(projectRoot);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 5;
  const candidates = scanJsonlDir(rawDir);
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = candidates.slice(0, limit);
  // 가장 최근만 is_current=true (UI 의 default 선택)
  top[0].is_current = true;
  return top.map(stripMtimeMs);
}

export function collectRawJsonls(projectRoot, opts = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return [];
  const active = readActiveRun(projectRoot);
  if (!active || !active.started_at) return [];
  const cutoffMs = Date.parse(active.started_at);
  if (!Number.isFinite(cutoffMs)) return [];
  // opts.rawDir override — 테스트 sandbox 가 가짜 raw dir 을 지정 가능. 부재 시
  // production default (~/.claude/projects/<encoded>).
  const rawDir = opts && typeof opts.rawDir === 'string'
    ? opts.rawDir
    : resolveRawProjectsDir(projectRoot);
  // active run started_at 이후 (cutoff) + sniff 통과 jsonl 만.
  return scanJsonlDir(rawDir, { extraFilter: (stat) => stat.mtimeMs >= cutoffMs })
    .map(stripMtimeMs);
}

/**
 * 특정 run 의 transcript 파일 목록을 반환한다.
 *
 * mtime desc 정렬 후 첫 항목 (= 가장 최근에 append 된 jsonl) 을 `is_current: true`
 * 로 마킹한다. Claude Code 가 active session 의 jsonl 에 지속 append 하므로
 * mtime 가장 최근 = "지금 진행 중인 세션" 으로 간주한다.
 *
 * `opts.projectRoot` 가 제공되면 raw 디렉터리도 union 수집 (transcript-extractor
 * SessionEnd 갱신 대기 없이 live append 도 surface). session_id 충돌 시 mtime 더
 * 최근 우선 (raw 가 항상 newest).
 *
 * @param {string} worktreePath - multi-session-discovery 가 제공한 session.worktree_path
 * @param {string} runId
 * @param {object} [opts]
 * @param {boolean} [opts.onlyCurrent=false] - true 시 가장 최근 mtime 1 entry 만 반환
 * @param {string} [opts.projectRoot] - raw 디렉터리 encoding 기준 main project root.
 *   부재 시 raw 수집 SKIP (기존 caller 회귀 0).
 * @returns {{ok: true, files: Array<{session_id: string, size: number, modified_at: string, is_current: boolean}>} | {ok: false, reason: string}}
 */
export function listTranscripts(worktreePath, runId, opts = {}) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    return { ok: false, reason: 'invalid worktreePath' };
  }
  // Defense-in-depth: runId 도 path traversal 방어 (caller 가 검증 우회 시 차단).
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    return { ok: false, reason: 'invalid runId' };
  }
  const onlyCurrent = opts && opts.onlyCurrent === true;
  const projectRoot = opts && typeof opts.projectRoot === 'string' ? opts.projectRoot : null;

  // Idle 세션 sentinel — active.json 이 idle (run_id=null) 상태에서 사용자가
  // brief2dev-orchestrator 호출 직후 첫 대화 중일 때 main worktree raw jsonl
  // most-recent (brief2dev sniff 통과) N 개를 fallback surface.
  if (runId === IDLE_SENTINEL_RUN_ID) return listIdleTranscripts(projectRoot, opts);

  const dir = join(resolve(worktreePath), '.brief2dev', 'runs', runId, 'transcript');

  const filesBySession = new Map();
  // 1) transcript/ (SessionEnd 복사본) — sniff 재적용 (사용자 결정 2026-05-20):
  // 이전 정책 (sniff 패턴 2/3 인정) 때 들어와 있던 노이즈 jsonl 도 새 sniff (Skill
  // tool_use 만) 통과 못하면 hide. 이미 들어와 있는 비-orchestrator 세션 자동 정리.
  for (const entry of scanJsonlDir(dir)) {
    const stripped = stripMtimeMs(entry);
    filesBySession.set(stripped.session_id, stripped);
  }
  // 2) Raw 디렉터리 fallback — projectRoot 지정 시. session_id 충돌 시 mtime
  // 더 최근 우선 (raw 가 live append → 거의 항상 newest).
  if (projectRoot) mergeRawFallback(filesBySession, projectRoot, opts);
  return { ok: true, files: finalizeFileList(filesBySession, onlyCurrent) };
}

// raw 디렉터리 entry 를 filesBySession 에 union — session_id 충돌 시 mtime 더 최근 우선.
function mergeRawFallback(filesBySession, projectRoot, opts) {
  const rawDir = opts && typeof opts.rawDir === 'string' ? opts.rawDir : undefined;
  for (const rawEntry of collectRawJsonls(projectRoot, rawDir ? { rawDir } : {})) {
    const existing = filesBySession.get(rawEntry.session_id);
    if (!existing || rawEntry.modified_at > existing.modified_at) {
      filesBySession.set(rawEntry.session_id, rawEntry);
    }
  }
}

// Map values → mtime desc 정렬 + 첫 항목 is_current=true + onlyCurrent 시 1개만.
function finalizeFileList(filesBySession, onlyCurrent) {
  const files = Array.from(filesBySession.values());
  files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  if (files.length > 0) files[0].is_current = true;
  return onlyCurrent && files.length > 0 ? [files[0]] : files;
}

// idle sentinel runId — main worktree raw jsonl most-recent N 개 fallback surface.
function listIdleTranscripts(projectRoot, opts) {
  if (!projectRoot) return { ok: true, files: [] };
  const rawDir = opts && typeof opts.rawDir === 'string' ? opts.rawDir : undefined;
  return { ok: true, files: collectIdleRawJsonl(projectRoot, rawDir ? { rawDir } : {}) };
}

// businessOnly 모드에서 user message 본문 안에 inline 으로 박혀있는 메타 wrapper
// 태그들. Claude Code 슬래시 스킬 호출 (`/<skill>`) 시 user turn 의 첫 text
// block 에 wrapper 형태로 동봉되며, 비즈니스 대화가 아니다.
//
// 2026-05-20 v3: `command-args` 는 wrapper 만 제거하고 *본문 보존* (사용자 명시
// — 슬래시 스킬 호출 시 args 안의 텍스트가 인간의 실제 첫 입력이기 때문).
// 나머지 wrapper 는 본문 포함 strip 유지.
// 2026-05-20 v4 (사용자 명시): `local-command-caveat` 추가 — Claude Code 가 도구
// 결과 caveat 을 user turn 안에 inline 으로 동봉. 비즈니스 대화 아님.
const BUSINESS_META_TAGS_FULL_STRIP = [
  'command-message',
  'command-name',
  'command-stdout',
  'local-command-stdout',
  'local-command-caveat',
  'system-reminder',
  'user-prompt-submit-hook',
];

const BUSINESS_META_TAG_PATTERNS = BUSINESS_META_TAGS_FULL_STRIP.flatMap((tag) => [
  // <tag>...</tag> — non-greedy, dotall, 다중 라인.
  new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'),
  // <tag/> or <tag> standalone (closing 없음) — 회복 후 다음 패스에서 strip.
  new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'),
]);

// command-args 본문 보존 패턴 — wrapper 만 unwrap (사용자 입력 surface).
// `<command-args>슬라이드를 AI로...</command-args>` → `슬라이드를 AI로...`
const COMMAND_ARGS_UNWRAP_PATTERN = /<command-args\b[^>]*>([\s\S]*?)<\/command-args>/gi;
// closing 없는 변형 — 그냥 tag 만 strip (안전 fallback)
const COMMAND_ARGS_STRAY_TAG = /<\/?command-args\b[^>]*\/?>/gi;

// Claude Code 가 슬래시 스킬 호출 직후 user turn 에 동봉하는 SKILL.md template
// inject. "Base directory for this skill: <path>" 라인부터 turn 끝까지 전부
// 스킬 prompt 본문 (Pre-flight Checklist / Model Routing Policy 등). 인간 메시지
// 아니므로 전체 drop.
//
// 2026-05-20 v3 (사용자 명시): 이전엔 라인 1개만 strip → 뒤따라오는 SKILL.md
// 본문 ("# brief2dev Orchestrator", "Pre-flight Checklist" 등) 이 user turn 으로
// 노출. 신 패턴: 첫 매치 이후 모든 텍스트 제거.
const SKILL_BASE_DIR_PATTERN = /[ \t]*Base directory for this skill:[\s\S]*$/m;

/**
 * businessOnly 모드용 user text 정제. wrapper 태그 7종 + skill bootstrap 라인을
 * inline 제거 후 trim. 빈 문자열 반환은 caller 가 block drop 판정.
 *
 * @param {string} text - 원본 text 블록
 * @returns {string} 정제 후 텍스트 (전체가 메타였다면 빈 문자열).
 */
export function stripBusinessMetaText(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  // 1) command-args unwrap (본문 보존 — 사용자 슬래시 스킬 호출 시 args 내용 =
  // 인간의 실제 첫 입력). 사용자 결정 2026-05-20.
  out = out.replace(COMMAND_ARGS_UNWRAP_PATTERN, '$1');
  out = out.replace(COMMAND_ARGS_STRAY_TAG, '');
  // 2) SKILL.md template inject: "Base directory for this skill:" 부터 끝까지 drop
  // (이전엔 라인 1개만 — SKILL.md 본문이 user turn 으로 노출되는 버그). 사용자
  // 결정 2026-05-20 v3.
  out = out.replace(SKILL_BASE_DIR_PATTERN, '');
  // 3) 나머지 6 wrapper 본문 포함 full strip (command-message / command-name /
  // command-stdout / local-command-stdout / system-reminder / user-prompt-submit-hook)
  for (const re of BUSINESS_META_TAG_PATTERNS) {
    out = out.replace(re, '');
  }
  return out.trim();
}

/**
 * 특정 transcript jsonl 을 파싱하여 정규화된 turn 배열로 반환.
 *
 * `opts.projectRoot` 가 제공되고 transcript/ 안 해당 session 부재 또는 raw 가
 * 더 newest 인 경우 raw 디렉터리에서 fallback read (live append 반영).
 *
 * @param {string} worktreePath
 * @param {string} runId
 * @param {string} sessionId - 안전 문자 (`[a-zA-Z0-9_-]+`) 만 허용
 * @param {object} [opts]
 * @param {boolean} [opts.businessOnly=false] - true 시 tool_use / tool_result /
 *   thinking 블록 drop + user text 안 메타 wrapper strip. 인간 가독성 대화만 보존.
 * @param {string} [opts.projectRoot] - raw 디렉터리 encoding 기준 main project root.
 *   부재 시 raw fallback 미수행 (기존 동작 유지).
 * @returns {{ok: true, turns: Array<object>, session_id: string} | {ok: false, reason: string}}
 */
export function readTranscript(worktreePath, runId, sessionId, opts = {}) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    return { ok: false, reason: 'invalid worktreePath' };
  }
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    return { ok: false, reason: 'invalid runId' };
  }
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return { ok: false, reason: 'invalid sessionId' };
  }

  const path = resolveTranscriptPath(worktreePath, runId, sessionId, opts);
  if (!path) return { ok: false, reason: 'not found' };

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { ok: false, reason: 'read failed' };
  }
  return { ok: true, session_id: sessionId, turns: parseTranscriptLines(raw, opts) };
}

// transcript/ 복사본 + raw 디렉터리 중 mtime 더 최근 path 선택. raw fallback 은
// projectRoot 지정 시에만. 둘 다 부재 시 null.
function resolveTranscriptPath(worktreePath, runId, sessionId, opts) {
  const projectRoot = opts && typeof opts.projectRoot === 'string' ? opts.projectRoot : null;
  const transcriptPath = join(
    resolve(worktreePath),
    '.brief2dev', 'runs', runId, 'transcript', `${sessionId}.jsonl`,
  );
  const transcriptStat = existsSync(transcriptPath) ? safeStat(transcriptPath) : null;
  let rawStat = null;
  let rawPath = null;
  if (projectRoot) {
    const rawDirBase = opts && typeof opts.rawDir === 'string'
      ? opts.rawDir
      : resolveRawProjectsDir(projectRoot);
    rawPath = join(rawDirBase, `${sessionId}.jsonl`);
    if (existsSync(rawPath)) rawStat = safeStat(rawPath);
  }
  if (transcriptStat && rawStat) {
    return rawStat.mtimeMs > transcriptStat.mtimeMs ? rawPath : transcriptPath;
  }
  if (transcriptStat) return transcriptPath;
  if (rawStat) return rawPath;
  return null;
}

// jsonl raw → 정규화 turn[]. 빈 line / 파싱 실패 / 빈 content turn 은 drop.
// readTranscript + readArchiveTranscript 공유.
function parseTranscriptLines(raw, opts) {
  const turns = [];
  for (const line of raw.split('\n')) {
    const entry = parseJsonlLine(line);
    if (!entry) continue;
    const turn = normalizeEntry(entry, opts);
    // 빈 content turn 제외 (모든 블록이 빈 text 로 stripped). system/summary/other
    // kind 도 content 비면 timestamp 메타만으로는 노이즈.
    if (!turn || !turn.content || turn.content.length === 0) continue;
    turns.push(turn);
  }
  return turns;
}

// archive slug 검증 + archivesRoot 하위 resolve (path traversal 방어). 실패 시 {ok:false}.
function resolveArchiveRoot(archiveSlug) {
  if (typeof archiveSlug !== 'string' || archiveSlug.length === 0) {
    return { ok: false, reason: 'invalid archiveSlug' };
  }
  if (archiveSlug.includes('/') || archiveSlug.includes('\\') || archiveSlug.includes('..')) {
    return { ok: false, reason: 'invalid archiveSlug' };
  }
  const archivesRoot = resolve(getArchivesRoot());
  const archiveRoot = resolve(getArchivesRoot(), archiveSlug);
  if (!archiveRoot.startsWith(archivesRoot + sep)) {
    return { ok: false, reason: 'invalid archiveSlug' };
  }
  return { ok: true, root: archiveRoot };
}

/**
 * 봉인된 archive 내부 transcript/ 디렉토리의 jsonl 목록.
 * `.brief2dev/archives/<slug>/transcript/<sessionId>.jsonl` 패턴을 사용한다 —
 * archive-and-reset.mjs 의 directArchive / saga-manager 의 autoArchiveCanonical
 * 이 runs/<runId>/transcript/ 를 그대로 snapshot 한 결과물.
 *
 * @param {string} archiveSlug - `.brief2dev/archives/<slug>/` 단일 디렉토리 세그먼트
 * @returns {{ok: true, files: Array<{session_id, size, modified_at, is_current}>} | {ok: false, reason: string}}
 */
export function listArchiveTranscripts(archiveSlug) {
  const resolved = resolveArchiveRoot(archiveSlug);
  if (!resolved.ok) return resolved;
  const dir = join(resolved.root, 'transcript');
  const files = scanJsonlDir(dir).map(stripMtimeMs);
  files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  if (files.length > 0) files[0].is_current = true;
  return { ok: true, files };
}

/**
 * 봉인된 archive transcript jsonl 한 개를 readTranscript 와 동일한 normalize
 * (BUSINESS_META wrapper strip / SKILL.md bootstrap drop / tool block 분류) 로
 * turn 배열 반환. raw fallback 없음 — archive snapshot 은 immutable.
 *
 * @param {string} archiveSlug
 * @param {string} sessionId
 * @param {object} [opts] - readTranscript 와 동일 (businessOnly 등)
 * @returns {{ok: true, turns, session_id} | {ok: false, reason}}
 */
export function readArchiveTranscript(archiveSlug, sessionId, opts = {}) {
  const resolved = resolveArchiveRoot(archiveSlug);
  if (!resolved.ok) return resolved;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return { ok: false, reason: 'invalid sessionId' };
  }
  const path = join(resolved.root, 'transcript', `${sessionId}.jsonl`);
  if (!existsSync(path)) return { ok: false, reason: 'not found' };
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { ok: false, reason: 'read failed' };
  }
  return { ok: true, session_id: sessionId, turns: parseTranscriptLines(raw, opts) };
}

// entry 메타 (timestamp/uuid) 추출 — 여러 필드명 fallback.
function entryMeta(entry) {
  return {
    timestamp: entry.timestamp || entry.created_at || null,
    uuid: entry.uuid || null,
  };
}

// user/assistant message turn 빌드. role 은 message.role 우선, 없으면 entry type.
function buildMessageTurn(entry, type, meta, opts) {
  const message = entry.message || {};
  const role = message.role || type;
  return {
    kind: role === 'user' ? 'user' : 'assistant',
    timestamp: meta.timestamp,
    uuid: meta.uuid,
    content: extractContent(message.content, opts),
  };
}

// system entry 의 content — entry.content / entry.message.content fallback.
function systemContent(entry, opts) {
  return extractContent(entry.content ?? entry.message?.content ?? '', opts);
}

/**
 * Claude Code 의 transcript JSONL entry 를 화면용 turn 으로 정규화.
 *
 * Claude Code 일반 형식:
 *   { type: 'user' | 'assistant' | 'system' | 'summary',
 *     message: { role, content: string | Array<{type, ...}> },
 *     timestamp, uuid, ... }
 */
function normalizeEntry(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const type = entry.type || entry.role || 'unknown';
  // Claude Code 가 jsonl 에 기록하는 메타 entry 는 채팅 흐름이 아님 → skip.
  if (NOISE_ENTRY_TYPES.has(type)) return null;
  const meta = entryMeta(entry);

  if (type === 'user' || type === 'assistant') {
    return buildMessageTurn(entry, type, meta, opts);
  }
  if (type === 'system') {
    return { kind: 'system', timestamp: meta.timestamp, uuid: meta.uuid, content: systemContent(entry, opts) };
  }
  if (type === 'summary') {
    return {
      kind: 'summary',
      timestamp: meta.timestamp,
      uuid: meta.uuid,
      content: [{ kind: 'text', text: String(entry.summary || '') }],
    };
  }
  return { kind: 'other', type, timestamp: meta.timestamp, uuid: meta.uuid, content: [] };
}

// tool_result block 빌드 — content string/array 정규화. 빈 text 시 null (noise drop).
function buildToolResultBlock(item) {
  let text = '';
  if (typeof item.content === 'string') text = item.content;
  else if (Array.isArray(item.content)) {
    text = item.content
      .filter(c => c?.type === 'text' && typeof c.text === 'string')
      .map(c => c.text).join('\n');
  }
  if (text.trim() === '') return null;
  return {
    kind: 'tool_result',
    tool_use_id: item.tool_use_id ?? null,
    is_error: item.is_error === true,
    text,
  };
}

// text block — businessOnly 시 메타 wrapper strip. 빈 text 는 null (noise drop).
function extractTextBlock(item, businessOnly) {
  if (typeof item.text !== 'string') return null;
  const text = businessOnly ? stripBusinessMetaText(item.text) : item.text;
  return text.trim() === '' ? null : { kind: 'text', text };
}

// tool_use block — name/input/id 정규화.
function extractToolUseBlock(item) {
  return {
    kind: 'tool_use',
    name: typeof item.name === 'string' ? item.name : 'unknown',
    input: item.input ?? {},
    id: item.id ?? null,
  };
}

// thinking block — Claude Code 는 본문을 redact (빈 문자열) 하므로 빈 block 은 UI 노이즈라 skip.
function extractThinkingBlock(item, businessOnly) {
  if (typeof item.thinking !== 'string') return null;
  if (businessOnly || item.thinking.trim() === '') return null;
  return { kind: 'thinking', text: item.thinking };
}

// content array 의 한 block → 화면용 block or null. businessOnly 시 tool_use /
// tool_result / thinking drop + text 안 메타 wrapper strip. 빈 text/thinking 도 null.
function extractBlock(item, businessOnly) {
  if (item.type === 'text') return extractTextBlock(item, businessOnly);
  if (item.type === 'tool_use') return businessOnly ? null : extractToolUseBlock(item);
  if (item.type === 'tool_result') return businessOnly ? null : buildToolResultBlock(item);
  if (item.type === 'thinking') return extractThinkingBlock(item, businessOnly);
  return null;
}

/**
 * Claude Code message.content (string | array of blocks) 를 화면 친화 배열로 정규화.
 * 지원 block: text / tool_use / tool_result / thinking.
 *
 * @param {string | Array} content
 * @param {object} [opts]
 * @param {boolean} [opts.businessOnly=false] - true 시 tool_use / tool_result /
 *   thinking 블록 drop + text 블록 안 메타 wrapper (`<command-message>` 등) +
 *   "Base directory for this skill: ..." bootstrap 라인 strip.
 */
function extractContent(content, opts = {}) {
  const businessOnly = opts && opts.businessOnly === true;
  if (typeof content === 'string') {
    const text = businessOnly ? stripBusinessMetaText(content) : content;
    return text.trim() ? [{ kind: 'text', text }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = extractBlock(item, businessOnly);
    if (block) blocks.push(block);
  }
  return blocks;
}
