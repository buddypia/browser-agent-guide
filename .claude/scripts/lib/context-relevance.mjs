/**
 * context-relevance.mjs — Context Injection Relevance Helper
 *
 * SessionStart / UserPromptSubmit hook 의 컨텍스트 주입이 현재 작업과 정합하는지
 * 점수화하는 단일 진입점. learnings-injector 와 keyword-router 양쪽이 동일 함수를
 * 사용하여 "왜 이 컨텍스트가 주입됐는가"를 일관되게 결정한다.
 *
 * SSOT: .brief2dev/run/active.json#current_stage (R-CM-026 layout-resolver)
 *
 * Source: brief2dev internal (R-CM-016 Anti-Sycophancy + R-CM-021 Governance Handoff).
 *   2026-05-01 SessionStart 컨텍스트 슬림화 사이클에서 도입.
 *   기존 hook 들이 각자 다른 방식으로 stage 매칭 (또는 무시) 하던 결함을 단일 함수로 통합.
 *
 * Design Principles:
 *   - 단순 키워드 overlap (Jaccard). ML / 임베딩 미사용 (장기 운용성).
 *   - explicit relevant_stages 우선, fallback 으로 토큰 매칭.
 *   - fail-open: stage 미감지 시 score=1.0 (사용자 차단 금지).
 *   - reason 필드 반환 → AI 디버깅 가능 (`<learnings reason="...">` 출력에 그대로 노출).
 *
 * Usage:
 *   import { computeRelevance, shouldInject, getCurrentStageId } from './context-relevance.mjs';
 *   const stage = getCurrentStageId();
 *   const { score, reason } = computeRelevance(stage, { keywords: ['cost', 'budget'] });
 *   if (shouldInject(score)) inject();
 */

import { existsSync, readFileSync } from 'node:fs';
import { getActiveRunPath } from './layout-resolver.mjs';

// ═══════════════════════════════════════════════════════════════════
// Stage Token Map — brief2dev 8 스테이지의 도메인 토큰
//
// stage 추가 / 변경 시 이 표만 갱신하면 learnings + topic-map 양쪽이 자동 적응.
// 토큰은 lowercase, 길이 ≥ 3, kebab / snake / 공백 분해 후 비교.
// ═══════════════════════════════════════════════════════════════════

export const STAGE_TOKENS = {
  intake: [
    'business', 'intake', 'context', 'vision', 'model', 'idea',
    'principle', 'analysis', 'requirement',
  ],
  market_research: [
    'market', 'tam', 'sam', 'som', 'persona', 'competition', 'competitor',
    'research', 'demand', 'viability', 'pricing', 'segment',
  ],
  mvp_scoping: [
    'mvp', 'scope', 'feature', 'must', 'should', 'moscow', 'prioritize',
    'wedge', 'value', 'proposition',
  ],
  platform_decision: [
    'platform', 'web', 'mobile', 'desktop', 'native', 'flutter',
    'react', 'tauri', 'electron', 'expo',
  ],
  stack_selection: [
    'stack', 'framework', 'tech', 'adr', 'atam', 'frontend', 'backend',
    'language', 'database', 'orm', 'auth',
  ],
  infra_design: [
    'infra', 'cloud', 'aws', 'gcp', 'cost', 'budget', 'pricing',
    'deploy', 'deployment', 'region', 'latency', 'scale', 'serverless',
    'container', 'kubernetes', 'sla', 'availability',
  ],
  scaffolding: [
    'scaffold', 'project', 'boilerplate', 'codebase', 'structure',
    'init', 'template', 'generator',
  ],
  output_gate: [
    'output', 'gate', 'final', 'review', 'validate', 'audit', 'check',
  ],
};

// ═══════════════════════════════════════════════════════════════════
// Token extraction
// ═══════════════════════════════════════════════════════════════════

/**
 * 텍스트에서 토큰을 추출한다.
 *
 * 분해 규칙: 공백 / kebab / snake / 구두점 분해. 소문자, 길이 ≥ 3, 순수 숫자 제외.
 * 결정론적이고 디버그 가능. ML / stemming / lemmatization 사용하지 않음.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function extractTokens(text) {
  if (!text || typeof text !== 'string') return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\-_/.,:;()[\]{}'"`<>!?]+/u)
      .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
  );
}

// ═══════════════════════════════════════════════════════════════════
// Active stage resolver
// ═══════════════════════════════════════════════════════════════════

/**
 * 현재 active run 의 stage id 를 반환한다.
 *
 * SSOT: layout-resolver.getActiveRunPath() → .brief2dev/run/active.json (worktree_local, R-CM-026 2026-05-14)
 *
 * @returns {string|null} 예: "mvp_scoping" 또는 active run 없으면 null
 */
export function getCurrentStageId() {
  try {
    const path = getActiveRunPath();
    if (!path || !existsSync(path)) return null;
    const run = JSON.parse(readFileSync(path, 'utf-8'));
    return run?.current_stage || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Relevance computation
// ═══════════════════════════════════════════════════════════════════

/**
 * stage_id 에 대한 item 의 relevance score 를 계산한다.
 *
 * Item 형식:
 *   { relevant_stages?: string[], keywords?: string[], key?: string, text?: string }
 *
 * 우선순위:
 *   1. item.relevant_stages 명시 → stage_id ∈ relevant_stages 면 1.0, 아니면 0.0
 *   2. keywords / key / text 토큰 ∩ stage_tokens 의 Jaccard 유사도
 *   3. stage_id null 이면 fail-open (1.0)
 *
 * @param {string|null} stageId - 현재 stage. null 이면 fail-open
 * @param {object} item - { relevant_stages?, keywords?, key?, text? }
 * @returns {{ score: number, reason: string, matched: string[] }}
 */
export function computeRelevance(stageId, item) {
  if (!stageId) {
    return { score: 1.0, reason: 'no_active_stage_fail_open', matched: [] };
  }

  // 1) explicit relevant_stages 우선
  if (Array.isArray(item?.relevant_stages) && item.relevant_stages.length > 0) {
    const hit = item.relevant_stages.includes(stageId);
    return {
      score: hit ? 1.0 : 0.0,
      reason: hit
        ? `explicit_stage_match[${stageId}]`
        : `explicit_stage_miss[${stageId}_not_in_${item.relevant_stages.join('|')}]`,
      matched: hit ? [stageId] : [],
    };
  }

  // 2) token-based Jaccard
  const stageTokens = new Set(STAGE_TOKENS[stageId] || []);
  if (stageTokens.size === 0) {
    return { score: 1.0, reason: `unknown_stage_fail_open[${stageId}]`, matched: [] };
  }

  const itemText = [
    item?.key,
    item?.text,
    ...(Array.isArray(item?.keywords) ? item.keywords : []),
  ]
    .filter(Boolean)
    .join(' ');

  const itemTokens = extractTokens(itemText);
  if (itemTokens.size === 0) {
    return { score: 0.0, reason: 'no_tokens_in_item', matched: [] };
  }

  const matched = [...itemTokens].filter((t) => stageTokens.has(t));
  const union = new Set([...itemTokens, ...stageTokens]).size;
  const score = union > 0 ? matched.length / union : 0;

  return {
    score,
    reason:
      matched.length > 0
        ? `token_match[${matched.join('|')}]`
        : `no_token_overlap[stage=${stageId}]`,
    matched,
  };
}

/**
 * 주입 여부 결정.
 *
 * 임계값 0.05 = Jaccard 5% (예: 20 토큰 중 1 토큰 겹침). 매우 느슨하지만,
 * 토픽이 완전히 다르면 (governance 회고 ↔ mvp_scoping) 0 이 되어 자동 차단된다.
 *
 * @param {number} score
 * @param {number} [threshold=0.05]
 * @returns {boolean}
 */
export function shouldInject(score, threshold = 0.05) {
  return score >= threshold;
}

/**
 * 회귀 테스트 헬퍼: STAGE_TOKENS 외부 노출. 토큰 표 변경을 vitest 가 감지.
 *
 * @param {string} stageId
 * @returns {string[]}
 */
export function getStageTokens(stageId) {
  return STAGE_TOKENS[stageId] || [];
}
