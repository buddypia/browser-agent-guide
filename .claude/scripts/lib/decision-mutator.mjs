/**
 * decision-mutator.mjs — Loom WebUI 의 decision 응답 단일 mutation 진입점 (PADR-013 PoC 4/4).
 *
 * R-CM-035 개정 (사용자 결정 2026-06-01): AI 메모리 삭제(2026-05-30)에 이은 두 번째 WebUI mutation
 * 예외 — 사용자가 브라우저에서 채운 decision 응답을 `pending → answered` 로 전이한다.
 * brief2dev-webui.mjs 가 본 모듈을 직접 import 한다 (child_process 아님 → R-CM-035 Rule 3 정합).
 *
 * memory-mutator 선례와의 동형:
 *   - WebUI 서버는 직접 write 하지 않고 본 mutator 에 위임 (write 집중 + 단방향 흐름 유지).
 *   - 본 모듈은 predicate WEBUI_FILE_PATTERNS 밖이라 SSOT write 가 허용된다.
 *   - Origin(localhost) 가드는 서버 라우트(handleDecisionAnswer)가 담당.
 *
 * memory-mutator 와의 의도적 divergence (race 안전장치):
 *   - memory-mutator 는 `assertNoRunningPipeline` (running 이면 409) — 메모리 삭제는 run 진행 중
 *     하면 안 되는 cleanup 이라서다. **decision-answer 는 정반대** — decision 이 pending 인 것은
 *     run 이 사용자 입력을 기다리며 멈춰있기 때문이다. running-block 을 걸면 사용자가 영영 응답
 *     못 한다. 그래서 running guard 를 쓰지 않는다.
 *   - 대신 race 안전은 (a) state machine (pending → answered 만), (b) atomic rename overwrite,
 *     (c) lint(requireAnswered) 재검증으로 담보한다.
 *   - **TOCTOU 한계 (정직 명시)**: 두 브라우저 탭이 동시에 같은 pending 을 응답하면 둘 다 pending
 *     을 읽고 둘 다 answered 를 쓸 수 있다 (last-write-wins, 손상은 없음). 순차 케이스는 state
 *     machine 이 막는다(2번째는 already_answered). 단일 사용자 로컬 대시보드 가정상 동시 입력
 *     위험은 낮아 file lock 은 over-engineering (atomic-fs 의 설계 주석과 동일 판단).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomicSync, appendJsonlAtomicSync } from './atomic-fs.mjs';
import { lintDecision } from './decision-linter.mjs';
import { resolveSessionDecisionsDir } from './decision-session-path.mjs';

export class DecisionMutationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DecisionMutationError';
    this.code = code;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function hasTraversal(s) {
  return s.includes('/') || s.includes('\\') || s.includes('..');
}

/** now 입력(Date|ISO string|undefined)을 ISO8601 문자열로. 잘못된 값은 throw (answered_at 무결성). */
function toIso(now) {
  if (now == null) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) {
    throw new DecisionMutationError(`잘못된 now 값: ${String(now)}`, 'bad_request');
  }
  return d.toISOString();
}

/**
 * 사용자 응답 입력을 schema(response: additionalProperties:false) 허용 키 + 타입으로 정규화한다.
 * 미허용 키 drop + 타입 강제 — 잡음 필드가 lint SCHEMA_INVALID 를 유발하지 않도록 writer 가 선청소.
 *
 * @returns {{ response: object, hasFreeform: boolean }}
 */
function sanitizeResponse(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const response = {};

  if (Array.isArray(src.selected_option_ids)) {
    response.selected_option_ids = src.selected_option_ids.filter((x) => typeof x === 'string');
  }
  // trim 된 값을 SSOT 에 저장한다 (hasFreeform 판정과 일관 + echoback interpretDecision 도 read 시 trim).
  // 앞뒤 padding 만 제거 — 내부 줄바꿈/포맷은 보존.
  const free = typeof src.freeform_notes === 'string' ? src.freeform_notes.trim() : '';
  if (free.length > 0) response.freeform_notes = free;
  if (Array.isArray(src.constraints)) {
    response.constraints = src.constraints.filter((x) => typeof x === 'string');
  }

  return { response, hasFreeform: free.length > 0 };
}

/**
 * decision-NNNN.json 을 읽고 pending 상태인지 검증한다 (state machine 입구 가드).
 * answer 의 정당한 source 는 pending 뿐 — answered/rejected/기타 상태는 거부한다.
 *
 * @returns {{ path: string, data: object }}
 * @throws {DecisionMutationError} not_found | already_answered | rejected_cannot_answer | invalid_state
 */
function loadPendingDecision(decisionsDir, sequence) {
  const fileName = `decision-${String(sequence).padStart(4, '0')}.json`;
  const path = join(decisionsDir, fileName);

  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new DecisionMutationError(`decision 파일을 찾을 수 없습니다 (seq=${sequence})`, 'not_found');
  }

  const status = data && data.status;
  if (status === 'answered') {
    throw new DecisionMutationError(`이미 응답된 decision 입니다 (seq=${sequence})`, 'already_answered');
  }
  if (status === 'rejected') {
    throw new DecisionMutationError(
      `거부된 decision 은 재응답할 수 없습니다 (seq=${sequence}) — AI 가 새 요청을 발행합니다`,
      'rejected_cannot_answer',
    );
  }
  if (status !== 'pending') {
    throw new DecisionMutationError(`pending 상태만 응답 가능 (현재='${status}')`, 'invalid_state');
  }

  return { path, data };
}

/** answerDecision 입력 검증 (worktreePath / runId path-traversal / sequence). 위반 시 throw. */
function validateAnswerInput(worktreePath, runId, sequence) {
  if (!isNonEmptyString(worktreePath)) {
    throw new DecisionMutationError('worktreePath 가 필요합니다', 'bad_request');
  }
  if (!isNonEmptyString(runId)) {
    throw new DecisionMutationError('runId 가 필요합니다', 'bad_request');
  }
  if (hasTraversal(runId)) {
    throw new DecisionMutationError(`잘못된 runId (path traversal): ${runId}`, 'invalid_id');
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new DecisionMutationError(`sequence 는 0 이상 정수여야 합니다: ${sequence}`, 'bad_request');
  }
}

/**
 * 사용자 decision 응답을 기록한다 (pending → answered). file fallback 의 WebUI-side 정당한 writer.
 *
 * 흐름:
 *   1. 입력 검증 (worktreePath / runId path-traversal / sequence)
 *   2. decision-NNNN.json 로드 + state machine 가드 (pending 만 허용)
 *   3. response 정규화 (schema 허용 키)
 *   4. status='answered' + provenance flip(user_selection|user_freeform) + answered response 조립
 *   5. lint(requireAnswered:true) — RESPONSE_EMPTY / OPTION_UNKNOWN / FREEFORM_NOT_ALLOWED 등 검증
 *   6. atomic rename overwrite write
 *   7. _audit.jsonl best-effort append (실패해도 answer 자체는 성공 — audit_logged 로 surface)
 *
 * @param {object} params
 * @param {string} params.worktreePath - 세션 worktree 루트 (cross-worktree: 서버 PROJECT_DIR 아님).
 *   **신뢰 계약**: `resolveSession`(multi-session-discovery) 가 발견한 세션 경로만 전달한다 — 사용자
 *   입력을 직접 넘기지 않는다. 절대 경로(슬래시 포함)라 runId 식 segment traversal 검사는 부적용;
 *   경로 신뢰성은 호출자(WebUI 서버 핸들러)가 discovered-session 으로 보장한다.
 * @param {string} params.runId
 * @param {number} params.sequence
 * @param {object} params.response - { selected_option_ids?, freeform_notes?, constraints? }
 * @param {Date|string} [params.now] - answered_at 기준 시각 (테스트 결정성)
 * @returns {{ ok: true, run_id: string, sequence: number, status: 'answered', source: string, path: string, audit_logged: boolean }}
 * @throws {DecisionMutationError} bad_request | invalid_id | not_found | already_answered | rejected_cannot_answer | invalid_state | validation_failed
 */
export function answerDecision({ worktreePath, runId, sequence, response, now } = {}) {
  validateAnswerInput(worktreePath, runId, sequence);

  const answeredAt = toIso(now);
  const decisionsDir = resolveSessionDecisionsDir(worktreePath, runId);
  const { path, data } = loadPendingDecision(decisionsDir, sequence);

  const { response: cleanResponse, hasFreeform } = sanitizeResponse(response);
  const source = hasFreeform ? 'user_freeform' : 'user_selection';
  const requestedBy = data.provenance && data.provenance.model_id ? data.provenance.model_id : null;

  data.status = 'answered';
  data.response = cleanResponse;
  // provenance flip: ai_candidate → 사용자 출처. linter PROVENANCE_SUSPICIOUS(answered+ai_candidate) 회피.
  // 원 요청자 model_id 는 audit 의 requested_by 로 보존(provenance 는 answer 출처만 깨끗하게 기술).
  data.provenance = { source, generated_at: answeredAt };

  const { ok, errors } = lintDecision(data, { requireAnswered: true, now: answeredAt });
  if (!ok) {
    throw new DecisionMutationError(
      `응답이 유효하지 않습니다 — ${JSON.stringify(errors)}`,
      'validation_failed',
    );
  }

  writeJsonAtomicSync(path, data);

  let auditLogged = true;
  try {
    appendJsonlAtomicSync(join(decisionsDir, '_audit.jsonl'), {
      ts: answeredAt,
      action: 'answer',
      run_id: runId,
      sequence,
      source,
      selected_count: Array.isArray(cleanResponse.selected_option_ids)
        ? cleanResponse.selected_option_ids.length
        : 0,
      has_freeform: hasFreeform,
      requested_by: requestedBy,
    });
  } catch {
    // audit 은 secondary — answer 자체(SSOT 전이)는 이미 성공. 실패를 surface 하되 op 는 실패시키지 않음.
    auditLogged = false;
  }

  return { ok: true, run_id: runId, sequence, status: 'answered', source, path, audit_logged: auditLogged };
}
