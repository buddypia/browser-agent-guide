/**
 * session-summarizer.mjs — 세션 요약 생성 순수 함수
 *
 * 세션 종료 시 요약을 생성하여 .brief2dev/session-history/에 저장.
 * 다음 세션의 session-start.mjs가 이를 읽어 컨텍스트를 복원.
 *
 * 설계 원칙:
 *   - 순수 함수 (부작용 = 파일 쓰기만)
 *   - active-run.json(Saga)과 독립 운영
 *   - 최대 7개 유지 (오래된 것 자동 삭제)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { resolveSystemFile, resolveSessionHistoryDir } from './layout-resolver.mjs';

const MAX_HISTORY = 7;

/**
 * 세션 요약 객체를 생성한다.
 * @param {string} projectDir - 프로젝트 루트
 * @param {string} sessionId - 세션 ID
 * @param {object} [options] - 추가 옵션
 * @returns {object} session-summary.schema.json 준수 객체
 */
export function buildSessionSummary(projectDir, sessionId, options = {}) {
  const now = new Date();

  // Pipeline state 읽기
  let pipelineState = { status: 'idle', current_stage: null, stages_completed: [] };
  try {
    const sagaPath = resolveSystemFile('active-run.json', projectDir);
    if (existsSync(sagaPath)) {
      const saga = JSON.parse(readFileSync(sagaPath, 'utf-8'));
      pipelineState = {
        status: saga.status || 'idle',
        current_stage: saga.current_stage || saga.currentStage || null,
        stages_completed: Object.entries(saga.stages || {})
          .filter(([, v]) => v.status === 'completed')
          .map(([k]) => k),
      };
    }
  } catch { /* saga 읽기 실패 무시 */ }

  const result = {
    session_id: sessionId || `session-${now.toISOString().replace(/[:.]/g, '-')}`,
    ended_at: now.toISOString(),
    duration_minutes: options.duration_minutes || null,
    pipeline_state: pipelineState,
    wisdom_health: options.wisdom_health || { overall_trend: 'stable', files_declining: [] },
    session_context: options.session_context || '',
    transcript_summary: options.transcript_summary || null,
    detected_patterns: [],
  };

  // 트랜스크립트 경로가 제공되면 파싱하여 통합
  if (options.transcript_path) {
    try {
      const transcriptData = extractFromTranscript(options.transcript_path);
      if (transcriptData) {
        result.transcript_summary = transcriptData;
      }
    } catch { /* 트랜스크립트 파싱 실패 무시 */ }
  }

  // 워크플로우 패턴 감지
  try {
    const patterns = detectWorkflowPatterns(projectDir, result.transcript_summary);
    if (patterns.length > 0) {
      result.detected_patterns = patterns;
    }
  } catch { /* 패턴 감지 실패 무시 */ }

  return result;
}

/**
 * 세션 요약을 .brief2dev/session-history/에 저장한다.
 * @param {string} projectDir
 * @param {object} summary - buildSessionSummary()의 반환값
 */
export function saveSessionSummary(projectDir, summary) {
  const historyDir = resolveSessionHistoryDir(projectDir);
  if (!existsSync(historyDir)) {
    mkdirSync(historyDir, { recursive: true });
  }

  const fileName = `${summary.ended_at.replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(historyDir, fileName), JSON.stringify(summary, null, 2));

  // 최대 7개 유지 — 오래된 파일 삭제
  pruneHistory(historyDir);
}

/**
 * session-history 디렉토리에서 MAX_HISTORY 초과 파일 삭제
 */
function pruneHistory(historyDir) {
  try {
    const files = readdirSync(historyDir)
      .filter(f => f.endsWith('.json'))
      .sort(); // 타임스탬프 기반이므로 사전순 = 시간순

    while (files.length > MAX_HISTORY) {
      const oldest = files.shift();
      try { unlinkSync(join(historyDir, oldest)); } catch { /* 삭제 실패 무시 */ }
    }
  } catch { /* ignore */ }
}

// 실제 사용자 의도가 아닌 메타 라인(슬래시 커맨드 출력 / system-reminder 등) 필터.
// prefix 뒤 [->\s] anchor 로 exact 태그만 매칭 — <local-commands>(복수) 같은 일반 입력 오탐 차단.
const TRANSCRIPT_META_PREFIX =
  /^<\/?(local-command|command-name|command-message|command-args|command-stdout|system-reminder|user-prompt-submit-hook)[->\s]/;

// 사용자 텍스트(프롬프트) 추출 — string 또는 text 블록 배열. 메타 라인(슬래시 커맨드 등) 제외.
function pushUserIntent(content, summary) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text || '')
      .join(' ');
  }
  text = text.trim();
  if (text && text.length < 500 && !TRANSCRIPT_META_PREFIX.test(text)) {
    summary.user_intents.push(text.slice(0, 200));
  }
}

// assistant tool_use 블록 → 도구 통계 / 수정 파일 / 스킬
function countToolUse(block, summary) {
  const tool = block.name || 'unknown';
  summary.tool_usage[tool] = (summary.tool_usage[tool] || 0) + 1;
  const input = block.input || {};
  if ((tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') && input.file_path) {
    if (!summary.modified_files.includes(input.file_path)) summary.modified_files.push(input.file_path);
  }
  if (tool === 'Skill') {
    const skill = input.skill || input.name;
    if (skill && !summary.executed_skills.includes(skill)) summary.executed_skills.push(skill);
  }
}

// user tool_result 블록 → guard violation(DENY/BLOCK) 감지.
// 휴리스틱(근사 진단값) — hook deny 출력의 구조화 신호(permissionDecision":"deny")가 1순위,
// DENY/BLOCK 단어는 보조. tool_result content 에 해당 단어가 데이터로 섞이면 소폭 과대 카운트
// 가능하나, 세션 복원에 표시되는 진단 지표라 blocking 영향 없음.
function countGuardViolation(block, summary) {
  const c =
    typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .filter((b) => b && b.type === 'text')
            .map((b) => b.text || '')
            .join(' ')
        : '';
  if (c.includes('permissionDecision":"deny"') || /\bDENY\b/.test(c) || /\bBLOCK(ED)?\b/.test(c)) {
    summary.guard_violations++;
  }
}

// user/assistant message.content 에서 tool_use / tool_result / 사용자 텍스트를 누적한다.
// 실제 Claude Code transcript schema: entry.type ∈ {user,assistant,system,attachment,...},
// 대화 메시지는 entry.message.{role,content}. content 는 string(사용자 프롬프트) 또는
// 블록 배열([{type:'text'|'tool_use'|'tool_result', ...}]). (R-CM-024 검증 2026-06-03:
// 구 파서는 role==='human' / type==='tool_use' / tool_name 를 기대했으나 실제 포맷과 불일치 →
// total_turns 만 채우고 나머지 100% 빈값이던 버그를 본 파서로 정정.)
function accumulateEntry(entry, summary) {
  const type = entry?.type;
  if (type !== 'user' && type !== 'assistant') return; // attachment/system/mode/snapshot 등 제외
  summary.total_turns++;

  const content = entry.message?.content;
  if (type === 'user') pushUserIntent(content, summary);

  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use') countToolUse(block, summary);
    else if (block.type === 'tool_result') countGuardViolation(block, summary);
  }
}

/**
 * JSONL 트랜스크립트 파일을 파싱하여 풍부한 세션 컨텍스트를 생성한다.
 * @param {string} transcriptPath - JSONL 트랜스크립트 파일 경로
 * @returns {object|null} TranscriptSummary
 */
export function extractFromTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) return null;

  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    const summary = {
      user_intents: [],
      tool_usage: {},
      modified_files: [],
      executed_skills: [],
      guard_violations: 0,
      pipeline_progress: [],
      total_turns: 0,
    };

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // 개별 라인 파싱 실패 무시
      }
      accumulateEntry(entry, summary);
    }

    // 최근 5개 사용자 의도만 유지
    summary.user_intents = summary.user_intents.slice(-5);
    // 수정 파일은 최근 20개만
    summary.modified_files = summary.modified_files.slice(-20);

    return summary;
  } catch {
    return null;
  }
}

/**
 * 현재 세션의 tool_usage/executed_skills를 이전 N개 세션과 비교하여 반복 패턴 감지.
 * @param {string} projectDir
 * @param {object} currentSummary - 현재 세션의 transcript_summary
 * @param {number} [lookback=5] - 비교할 이전 세션 수
 * @returns {Array<object>} 감지된 패턴 목록
 */
export function detectWorkflowPatterns(projectDir, currentSummary, lookback = 5) {
  const patterns = [];
  if (!currentSummary) return patterns;

  const historyDir = resolveSessionHistoryDir(projectDir);
  if (!existsSync(historyDir)) return patterns;

  let previousSummaries;
  try {
    const files = readdirSync(historyDir)
      .filter(f => f.endsWith('.json'))
      .sort();
    previousSummaries = files.slice(-(lookback + 1), -1).map(f => {
      try { return JSON.parse(readFileSync(join(historyDir, f), 'utf-8')); }
      catch { return null; }
    }).filter(Boolean);
  } catch { return patterns; }

  const currentSkills = currentSummary.executed_skills || [];
  if (currentSkills.length < 3) return patterns;

  for (const prev of previousSummaries) {
    const prevSkills = prev.transcript_summary?.executed_skills || [];
    const overlap = currentSkills.filter(s => prevSkills.includes(s));
    if (overlap.length >= 3) {
      patterns.push({
        type: 'repeated-workflow',
        session_id: prev.session_id,
        overlapping_skills: overlap,
        overlap_count: overlap.length,
      });
    }
  }

  // tool_usage 패턴 비교
  const currentTools = currentSummary.tool_usage || {};
  for (const prev of previousSummaries) {
    const prevTools = prev.transcript_summary?.tool_usage || {};
    const commonTools = Object.keys(currentTools).filter(t => prevTools[t]);
    if (commonTools.length >= 5) {
      patterns.push({
        type: 'repeated-tool-pattern',
        session_id: prev.session_id,
        common_tools: commonTools,
        common_count: commonTools.length,
      });
    }
  }

  return patterns;
}

/**
 * 가장 최근 세션 요약을 로드한다.
 * @param {string} projectDir
 * @returns {object|null}
 */
export function loadLatestSummary(projectDir) {
  const historyDir = resolveSessionHistoryDir(projectDir);
  if (!existsSync(historyDir)) return null;

  try {
    const files = readdirSync(historyDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    if (files.length === 0) return null;

    const latest = files[files.length - 1];
    return JSON.parse(readFileSync(join(historyDir, latest), 'utf-8'));
  } catch {
    return null;
  }
}
