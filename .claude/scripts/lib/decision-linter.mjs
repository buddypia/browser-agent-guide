#!/usr/bin/env node
/**
 * decision-linter.mjs (PADR-013)
 *
 * Decision Exchange Protocol 의 control-plane 파일을 다음 stage 가 소비하기 전에 검증한다.
 * schema 통과 (schema-loader) 위에, multi-llm 검증(debate 6vs8 + reflection 9/10)이
 * "진짜 난소"로 지목한 interpretation contract — 사용자 자유조합 결정을 다음 stage AI 가
 * 유일하게 해석하기 위한 정합 — 을 검사한다.
 *
 * stale / 순서경합 / 미응답혼입은 schema 만으로는 못 잡는다 (schema 는 단일 파일 구조만 보장).
 * 그 gap 을 본 linter 가 sequence(단조) / expires_at(stale) / status(answered) / payload(정합) 로 막는다.
 *
 * 사용:
 *   import { lintDecision, SUPPORTED_SCHEMA_MAJOR } from './lib/decision-linter.mjs';
 *   const { ok, errors, warnings } = lintDecision(decision, {
 *     expectedCorrelationId: 'BR2D-2026-001',
 *     expectedStageId: 'concept_divergence',
 *     lastSequence: 3,
 *     now: '2026-05-31T11:00:00+09:00', // 주입 가능 (테스트 결정성)
 *     requireAnswered: true,
 *   });
 *
 * CLI:
 *   node .claude/scripts/lib/decision-linter.mjs <decision.json>
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { validate } from './schema-loader.mjs';

export const SUPPORTED_SCHEMA_MAJOR = 1;

const err = (code, message, detail) => (detail === undefined ? { code, message } : { code, message, detail });
const warn = (code, message) => ({ code, message });

/** now 입력을 Date 로 정규화. 잘못된 입력은 null (stale 검사 skip). */
function resolveNow(now) {
  if (now instanceof Date) return Number.isNaN(now.getTime()) ? null : now;
  if (typeof now === 'string') {
    const d = new Date(now);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (now == null) return new Date();
  return null;
}

/** ISO 문자열을 Date 로. 파싱 실패 시 null. */
function parseDate(s) {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const eq = (a, b) => String(a).trim() === String(b).trim();

// --- 개별 검사 (각각 {errors, warnings}) — lintDecision 이 순회 ---

function checkVersion(decision) {
  const major = parseInt(String(decision.schema_version).split('.')[0], 10);
  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    return { errors: [err('VERSION_INCOMPATIBLE', `schema_version major=${major} 는 지원 major=${SUPPORTED_SCHEMA_MAJOR} 와 비호환`)] };
  }
  return {};
}

function checkCorrelation(decision, ctx) {
  if (ctx.expectedCorrelationId == null) return {};
  if (eq(decision.correlation_id, ctx.expectedCorrelationId)) return {};
  return { errors: [err('CORRELATION_MISMATCH', `correlation_id='${decision.correlation_id}' 가 기대값 '${ctx.expectedCorrelationId}' 와 불일치`)] };
}

function checkStage(decision, ctx) {
  if (ctx.expectedStageId == null) return {};
  if (eq(decision.stage_id, ctx.expectedStageId)) return {};
  return { errors: [err('STAGE_MISMATCH', `stage_id='${decision.stage_id}' 가 기대값 '${ctx.expectedStageId}' 와 불일치`)] };
}

function checkSequence(decision, ctx) {
  if (typeof ctx.lastSequence !== 'number') return {};
  if (decision.sequence > ctx.lastSequence) return {};
  return { errors: [err('SEQUENCE_NOT_MONOTONIC', `sequence=${decision.sequence} 가 직전 sequence=${ctx.lastSequence} 이하 (역전/중복/stale)`)] };
}

function checkStale(decision, ctx) {
  const nowDate = resolveNow(ctx.now);
  if (!nowDate) {
    // now 가 명시 주입됐는데 파싱 불가면 stale 검사를 silently skip 하지 않고 경고 발행.
    // 안전 검사의 fail-open 은 위험 방향이므로 사용자가 인지하도록 surface (code-review M3).
    if (ctx.now != null) {
      return { warnings: [warn('STALE_CHECK_INDETERMINATE', `now='${ctx.now}' 가 파싱 불가 — stale 검사를 수행할 수 없음`)] };
    }
    return {};
  }
  let expiry = parseDate(decision.expires_at);
  if (!expiry && typeof decision.ttl_sec === 'number') {
    const created = parseDate(decision.created_at);
    if (created) expiry = new Date(created.getTime() + decision.ttl_sec * 1000);
  }
  if (expiry && nowDate.getTime() > expiry.getTime()) {
    return { errors: [err('STALE', `decision 이 만료됨 (expiry=${expiry.toISOString()}, now=${nowDate.toISOString()})`)] };
  }
  return {};
}

function checkStatus(decision, ctx) {
  const requireAnswered = ctx.requireAnswered !== false; // default true
  if (requireAnswered && decision.status !== 'answered') {
    return { errors: [err('STATUS_NOT_ANSWERED', `status='${decision.status}' — 다음 stage 소비는 'answered' 만 허용`)] };
  }
  return {};
}

function checkProvenance(decision) {
  if (decision.status === 'answered' && decision.provenance?.source === 'ai_candidate') {
    return { warnings: [warn('PROVENANCE_SUSPICIOUS', "status='answered' 인데 provenance.source='ai_candidate' — 사용자 응답 반영 확인 필요")] };
  }
  return {};
}

function unknownOptionErrors(decision, sel) {
  if (sel.length === 0) return [];
  const optionIds = new Set((decision.request?.options || []).map((o) => o && o.id));
  return sel
    .filter((id) => !optionIds.has(id))
    .map((id) => err('OPTION_UNKNOWN', `selected_option_ids 의 '${id}' 가 request.options 에 없음`));
}

function answeredPayloadErrors(decision, resp) {
  const sel = Array.isArray(resp.selected_option_ids) ? resp.selected_option_ids : [];
  const free = typeof resp.freeform_notes === 'string' ? resp.freeform_notes.trim() : '';
  const errors = [];
  if (sel.length === 0 && free.length === 0) {
    errors.push(err('RESPONSE_EMPTY', 'answered 인데 selected_option_ids 와 freeform_notes 가 모두 비어있음'));
  }
  errors.push(...unknownOptionErrors(decision, sel));
  if (free.length > 0 && decision.request?.allow_freeform === false) {
    errors.push(err('FREEFORM_NOT_ALLOWED', 'freeform_notes 가 있으나 request.allow_freeform=false'));
  }
  return errors;
}

function checkOptionUniqueness(decision) {
  const opts = decision.request?.options || [];
  const seen = new Set();
  const dups = new Set();
  for (const o of opts) {
    const id = o && o.id;
    if (id == null) continue;
    if (seen.has(id)) dups.add(id);
    seen.add(id);
  }
  if (dups.size === 0) return {};
  return { errors: [...dups].map((id) => err('OPTION_DUPLICATE', `request.options 에 중복 id '${id}' (유일 해석 보장 깨짐)`)) };
}

function checkPayload(decision) {
  if (decision.status !== 'answered') return {};
  const resp = decision.response;
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) {
    return { errors: [err('RESPONSE_MISSING', "status='answered' 인데 response 부재")] };
  }
  return { errors: answeredPayloadErrors(decision, resp) };
}

// 응답 불가 요청 차단: 옵션 0개 + allow_freeform=false 면 사용자가 답할 수단이 없다.
// schema 는 kind=divergence 에서 options minItems:0 을 허용하므로, 이 degenerate 조합은
// 의미 검증 단계에서 막는다 (kind=decision 은 schema 가 options≥2 강제라 자연 비해당).
function checkRequestAnswerable(decision) {
  const req = decision.request || {};
  const opts = Array.isArray(req.options) ? req.options : [];
  if (opts.length === 0 && req.allow_freeform === false) {
    return {
      errors: [
        err('REQUEST_UNANSWERABLE', '옵션 0개 + allow_freeform=false — 사용자가 응답할 수단이 없는 요청'),
      ],
    };
  }
  return {};
}

const SEMANTIC_CHECKS = [
  checkVersion,
  checkCorrelation,
  checkStage,
  checkSequence,
  checkStale,
  checkStatus,
  checkProvenance,
  checkOptionUniqueness,
  checkRequestAnswerable,
  checkPayload,
];

/**
 * Decision 객체를 검증한다.
 * @returns {{ ok: boolean, errors: Array<{code:string,message:string,detail?:unknown}>, warnings: Array<{code:string,message:string}> }}
 */
export function lintDecision(decision, context = {}) {
  // A) empty/null/undefined guard — 함수가 throw 하지 않고 명시적 에러 반환
  if (decision == null || typeof decision !== 'object' || Array.isArray(decision)) {
    return { ok: false, errors: [err('NOT_OBJECT', 'decision 이 객체가 아닙니다 (null/undefined/array/primitive)')], warnings: [] };
  }

  // 1) schema 통과 — 실패 시 의미 검증은 무의미하므로 early return
  const { ok: schemaOk, errors: schemaErrors } = validate('decision', decision);
  if (!schemaOk) {
    return { ok: false, errors: [err('SCHEMA_INVALID', 'decision schema 위반', schemaErrors)], warnings: [] };
  }

  const errors = [];
  const warnings = [];
  for (const check of SEMANTIC_CHECKS) {
    const r = check(decision, context);
    if (r.errors) errors.push(...r.errors);
    if (r.warnings) warnings.push(...r.warnings);
  }
  return { ok: errors.length === 0, errors, warnings };
}

// CLI 모드: node decision-linter.mjs <decision.json>
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const [, , dataPath] = process.argv;
  if (!dataPath) {
    console.error('usage: decision-linter.mjs <decision.json>');
    process.exit(2);
  }
  let data;
  try {
    data = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (e) {
    console.error(`FAIL  파일 읽기/파싱 실패: ${e.message}`);
    process.exit(2);
  }
  const { ok, errors, warnings } = lintDecision(data);
  if (ok) {
    console.log(`PASS  ${dataPath}`);
    if (warnings.length) console.log(JSON.stringify(warnings, null, 2));
    process.exit(0);
  }
  console.log(`FAIL  ${dataPath}`);
  console.log(JSON.stringify({ errors, warnings }, null, 2));
  process.exit(1);
}
