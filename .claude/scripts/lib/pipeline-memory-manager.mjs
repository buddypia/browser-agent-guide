/**
 * pipeline-memory-manager.mjs — Pipeline Memory 관리 라이브러리
 *
 * deer-flow 패턴:
 *   - 대화에서 팩트 추출 → memory.json 영속화 → 다음 세션 시스템 프롬프트에 주입
 *   - 디바운스 30초, 원자적 저장 (temp 파일 + rename)
 *   - max_facts=100, fact_confidence_threshold=0.7, max_injection_tokens=2000
 *   - 상위 15개 팩트 + user/work context를 <memory> 태그로 주입
 *
 * brief2dev 적용:
 *   - 파이프라인 컨텍스트에 최적화: 결정/가정/제약/교훈 카테고리
 *   - Wisdom 시스템과 통합 (instinct → fact 승격 경로)
 *   - stage 기반 관련성 점수 (현재 stage에 가까운 팩트 우선)
 *   - SessionStart에서 주입, SessionEnd에서 추출
 *
 * Source: deer-flow/backend/packages/harness/deerflow/agents/middlewares/memory.py
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteJson } from './utils.mjs';
import { resolveSystemFile, resolveIdeaMemoryPath } from './layout-resolver.mjs';

/**
 * R-CM-014 P3 (2026-05-06) 카테고리 분류.
 * R-CM-028 Two-Perspective Boundary 데이터 분리 적용.
 *
 * IDEA_SCOPED_CATEGORIES: 한 비즈니스 아이디어에 종속된 카테고리. idea-memory.json 에 저장.
 * SYSTEM_CATEGORIES: 사용자 메타 선호 등 cross-aidea 가치. pipeline-memory.json 에 저장.
 *
 * lesson_learned 는 현재 extractor 가 invalidated assumption 에서만 생성하며 (R-PL-001 Rule 10),
 * 모두 idea-specific (Stage N 의 가정이 그 idea 에 종속) 이므로 idea-scoped 로 분류.
 * 향후 패턴 수준 lesson 추출 메커니즘이 추가되면 별도 분류 헬퍼 도입.
 */
export const IDEA_SCOPED_CATEGORIES = new Set([
  'business_context',
  'decision',
  'assumption',
  'technical_context',
  'constraint',
  'lesson_learned',
]);

export const SYSTEM_CATEGORIES = new Set([
  'user_preference',
]);

/**
 * 카테고리가 idea-scoped 인지 판정 (R-CM-014 P3).
 * @param {string} category
 * @returns {boolean} true 이면 idea-memory.json 저장 대상
 */
export function isIdeaScopedCategory(category) {
  return IDEA_SCOPED_CATEGORIES.has(category);
}

/**
 * lesson_learned 의 패턴 vs 구체 분류 heuristic (R-CM-014 P3 Phase E, 2026-05-06).
 *
 * **보수적 정책**: 명시적 패턴 신호 부재 시 'specific' (idea-scoped) 으로 분류.
 *   false negative 를 줄여 idea-specific lesson 이 silently cross-aidea carry 되는 것을 차단.
 *
 * 패턴 신호 (cross-aidea carry 후보):
 *   - 키워드: "패턴", "원칙", "일반화", "교훈", "rule of thumb", "general principle",
 *             "anti-pattern", "best practice", "always", "never"
 *   - 명시적 prefix: "[Pattern]", "[Principle]"
 *
 * 구체 신호 (per-aidea, idea-scoped):
 *   - 키워드: "이번", "이 idea", "이 프로젝트", "Stage N" (특정 stage 번호)
 *   - 명시적 prefix: "[Invalidated@Stage..." (extractor 가 생성)
 *
 * 사용처: memory-curator 의 mark 액션, 또는 향후 lesson 카테고리 자동 라우팅 (system vs idea-memory).
 * 현재는 helper 만 제공하며, 자동 라우팅은 후속 사이클에서 검토.
 *
 * @param {string} content - lesson 본문
 * @returns {'pattern'|'specific'} 분류 결과
 */
export function classifyLesson(content) {
  if (typeof content !== 'string' || content.length === 0) return 'specific';

  // 구체 신호가 있으면 즉시 specific (구체 우선 — 보수적)
  const SPECIFIC_PATTERNS = [
    /\[Invalidated@Stage/i,
    /이번\s*(idea|아이디어|프로젝트|run)/,
    /\bStage\s*\d+\b/i,
    /이\s*(아이디어|프로젝트|run)/,
  ];
  for (const re of SPECIFIC_PATTERNS) {
    if (re.test(content)) return 'specific';
  }

  // 패턴 신호 매칭
  const PATTERN_SIGNALS = [
    /\[Pattern\]/i,
    /\[Principle\]/i,
    /(^|\W)패턴($|\W)/,
    /(^|\W)원칙($|\W)/,
    /일반화/,
    /교훈/,
    /rule\s*of\s*thumb/i,
    /general\s*principle/i,
    /anti[-\s]?pattern/i,
    /best\s*practice/i,
    /(^|\W)always\b/i,
    /(^|\W)never\b/i,
  ];
  for (const re of PATTERN_SIGNALS) {
    if (re.test(content)) return 'pattern';
  }

  // 명시적 신호 부재 → specific (보수적 default)
  return 'specific';
}

// 신선도 감쇠 헬퍼 (learnings.mjs#applyConfidenceDecay 패턴 정합 — observation 성 fact 시간 감쇠).
function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / (1000 * 60 * 60 * 24)));
}

// user_preference/decision 은 사용자 의도(intent) 반영이라 시간 감쇠 면제 — learnings 의
// user-stated 면제(learnings.mjs:186)와 정합. 나머지(assumption/constraint/business_context/
// technical_context/lesson_learned)는 observation 성이라 created_at 경과에 비례해 주입 점수 하락.
const FRESHNESS_EXEMPT_CATEGORIES = new Set(['user_preference', 'decision']);

// fact 의 신선도 감쇠 계수 (0.1~1.0). 면제 카테고리는 1.0, 나머지는 created_at 경과 비례 하락.
// created_at 부재/파싱 실패 → daysSince=0 → 1.0 (안전 default — 신규/타임스탬프 없는 fact 불이익 없음).
function computeAgeDecay(category, createdAt, now, decayDays) {
  if (FRESHNESS_EXEMPT_CATEGORIES.has(category)) return 1.0;
  return Math.max(0.1, 1 - daysSince(createdAt, now) / decayDays);
}

export const DEFAULT_CONFIG = {
  max_facts: 30,
  max_injection_tokens: 2000,
  fact_confidence_threshold: 0.8,
  top_k_injection: 10,
  // 신선도 감쇠 window (일). observation 성 fact 는 created_at 기준 N일 경과 시 주입 점수가
  // 선형 하락한다 — ageDecay = max(0.1, 1 - days/decay_days) (45일=50%, 90일+=10% floor).
  // ai-memory-catalog.json#memory_types
  // [pipeline-memory].freshness_policy.decay_days 와 정합 (catalog-freshness-parity 테스트로 강제).
  freshness_decay_days: 90,
  // P2-B (2026-05-01): category quota 도입. top_k 슬라이스 시 한 카테고리 독점 방지.
  // 17 facts 중 decision 11건이 동률 score 1.350 으로 top_k=10 슬롯 영구 점유 →
  // user_preference / business_context / technical_context 영구 starvation (9 sessions access=0) 의 구조적 해소.
  // cap 합계 (20) > top_k (10) 이므로 slack 보장. 모든 카테고리에서 최소 1건 보장.
  category_caps: {
    decision: 5,
    constraint: 3,
    assumption: 3,
    lesson_learned: 2,
    user_preference: 2,
    business_context: 3,
    technical_context: 2,
  },
};
// export 된 객체의 외부 변이 차단 (decay_days 등 기본값 오염 방지 — code-reviewer LOW).
Object.freeze(DEFAULT_CONFIG);

/**
 * Memory 파일 경로를 반환한다.
 *
 * R-CM-026 layout SSOT (system_persistent) 준수.
 * 2026-05-01: 옛 경로 (.brief2dev/pipeline-memory.json) hardcode + @layout-resolver-allow
 * 마커가 두 파일 분기를 야기 → resolveSystemFile 단일 진입점으로 통합.
 *
 * @param {string} [projectDir] - 현재 미사용 (layout-resolver 가 자체 해결). 인자는 호환용.
 * @returns {string}
 */
export function getMemoryPath(_projectDir) {
  return resolveSystemFile('pipeline-memory.json');
}

/**
 * Memory를 로드한다.
 * @param {string} projectDir
 * @returns {object} Memory 객체
 */
export function loadMemory(projectDir) {
  const path = getMemoryPath(projectDir);
  if (!existsSync(path)) {
    return {
      schema_version: '1.0',
      last_updated: new Date().toISOString(),
      ...DEFAULT_CONFIG,
      facts: [],
      user_context: { preferences: {}, work_context: {} },
    };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {
      schema_version: '1.0',
      last_updated: new Date().toISOString(),
      ...DEFAULT_CONFIG,
      facts: [],
      user_context: { preferences: {}, work_context: {} },
    };
  }
}

/**
 * Memory를 원자적으로 저장한다 (deer-flow temp+rename 패턴).
 * @param {string} projectDir
 * @param {object} memory
 */
export function saveMemory(projectDir, memory) {
  const path = getMemoryPath(projectDir);
  memory.last_updated = new Date().toISOString();
  atomicWriteJson(path, memory);
}

// ═══════════════════════════════════════════════════════════════
// R-CM-014 P3 (2026-05-06): idea-memory.json — run_scoped fact 저장소
// R-CM-028 Two-Perspective Boundary 데이터 분리 사례.
// ═══════════════════════════════════════════════════════════════

/**
 * idea-memory.json 파일 경로를 반환한다.
 * @param {string} [runId] - 특정 run_id. 미지정 시 active run.
 * @returns {string|null} 절대 경로 또는 null (idle + runId 미명시)
 */
export function getIdeaMemoryPath(runId) {
  return resolveIdeaMemoryPath(runId);
}

/**
 * idea-memory.json 을 로드한다. 부재 시 빈 default 반환.
 * @param {string} _projectDir - 호환용 (미사용)
 * @param {string} [runId] - 특정 run_id. 미지정 시 active run.
 * @returns {object} idea-memory 객체
 */
export function loadIdeaMemory(_projectDir, runId) {
  const path = getIdeaMemoryPath(runId);
  const empty = {
    schema_version: '1.0',
    last_updated: new Date().toISOString(),
    ...DEFAULT_CONFIG,
    facts: [],
    user_context: { preferences: {}, work_context: {} },
  };
  if (!path || !existsSync(path)) return empty;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return empty;
  }
}

/**
 * idea-memory.json 을 원자적으로 저장한다.
 * runId 부재 시 (idle 상태) save no-op (idea-memory 는 run-scoped 이므로 active run 없으면 저장 불가).
 *
 * @param {string} _projectDir - 호환용 (미사용)
 * @param {string} runId - 명시적 run_id (active 사용 시 getActiveRunId() 호출 후 전달)
 * @param {object} memory - idea-memory 객체
 * @returns {boolean} 저장 성공 여부
 */
export function saveIdeaMemory(_projectDir, runId, memory) {
  if (!runId) return false;
  const path = getIdeaMemoryPath(runId);
  if (!path) return false;
  memory.last_updated = new Date().toISOString();
  // 디렉터리 ensure (run 디렉터리는 startPipeline 에서 생성되지만, 마이그레이션 안전망)
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, memory);
  return true;
}

/**
 * idea-memory 에 fact 를 추가한다. source_run_id 자동 부여.
 *
 * addFact() 와 동일한 dedup/ID/cap 로직을 따르되, fact 객체에 source_run_id 를 강제 부여한다.
 *
 * @param {object} memory - loadIdeaMemory() 결과
 * @param {object} fact - { category, content, source_stage, source_skill, confidence, ... }
 * @param {string} sessionId
 * @param {string} runId - source_run_id 부여용. 부재 시 throw.
 * @returns {object} 갱신된 memory
 */
export function addIdeaFact(memory, fact, sessionId, runId) {
  if (!runId) {
    throw new Error('addIdeaFact: runId is required (idea-memory is run-scoped)');
  }
  return addFact(memory, { ...fact, source_run_id: runId }, sessionId);
}

/**
 * 새 팩트를 추가한다.
 * @param {object} memory
 * @param {object} fact - { category, content, source_stage, source_skill, confidence }
 * @param {string} sessionId
 * @returns {object} 업데이트된 memory
 */
export function addFact(memory, fact, sessionId) {
  const threshold = memory.fact_confidence_threshold || DEFAULT_CONFIG.fact_confidence_threshold;

  if ((fact.confidence || 0) < threshold) {
    return memory; // 임계값 미달 팩트 무시
  }

  // 중복 감지 (동일 content + category의 팩트가 이미 있으면 기존 것을 업데이트)
  const existing = memory.facts.find(f =>
    f.content === fact.content && f.category === fact.category && !f.superseded_by
  );

  if (existing) {
    // 중복: 새로 추가하지 않고 기존 팩트의 confidence를 상향 조정
    existing.confidence = Math.max(existing.confidence, fact.confidence || 0.7);
    existing.last_accessed = new Date().toISOString();
    return memory;
  }

  // ID 생성: 기존 facts의 최대 번호 +1 (단조 증가).
  // length 기반 ID(memory.facts.length+1)는 max_facts cap 도달 후 항상 동일 ID를 생성하는 버그가 있었음 (P11).
  const maxIdNum = memory.facts.reduce((m, f) => {
    const match = /^FACT-(\d+)$/.exec(f.id || '');
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  const nextId = `FACT-${String(maxIdNum + 1).padStart(4, '0')}`;

  memory.facts.push({
    id: nextId,
    category: fact.category || 'technical_context',
    content: fact.content,
    source_stage: fact.source_stage || null,
    source_skill: fact.source_skill || null,
    source_session: sessionId,
    source_run_id: fact.source_run_id || null,
    confidence: fact.confidence || 0.7,
    relevance_score: fact.relevance_score || 1.0,
    access_count: 0,
    created_at: new Date().toISOString(),
    last_accessed: null,
    superseded_by: null,
  });

  // max_facts 초과 시 오래된 것부터 제거 (superseded 우선).
  // P15-B (2026-04-27): markFactSuperseded API로 명시적 트리거 활성화.
  const maxFacts = memory.max_facts || DEFAULT_CONFIG.max_facts;
  if (memory.facts.length > maxFacts) {
    memory.facts.sort((a, b) => {
      if (a.superseded_by && !b.superseded_by) return -1;
      if (!a.superseded_by && b.superseded_by) return 1;
      return new Date(a.created_at) - new Date(b.created_at);
    });
    memory.facts = memory.facts.slice(-maxFacts);
  }

  return memory;
}

/**
 * 기존 팩트를 superseded 상태로 표시한다 (P15-B 신설).
 *
 * 동일 카테고리에 의미적으로 갱신된 새 팩트가 추가될 때, 옛 팩트를 명시적으로 supersede
 * 처리하여 selectFactsForInjection이 주입에서 제외하도록 한다. addFact의 자동 dedup은
 * content가 정확히 일치할 때만 동작하므로, 의미가 같지만 표현이 다른 갱신은 이 API로 처리.
 *
 * @param {object} memory - loadMemory()로 로드된 객체
 * @param {string} oldFactId - supersede될 기존 팩트 ID (예: "FACT-0042")
 * @param {string|null} [newFactId=null] - 갱신 팩트 ID. null이면 단순 deprecate (history 보존만)
 * @returns {object} 갱신된 memory (mutate + return)
 * @throws {Error} oldFactId 미존재 또는 newFactId 미존재 시
 */
export function markFactSuperseded(memory, oldFactId, newFactId = null) {
  if (!memory || !Array.isArray(memory.facts)) {
    throw new Error('markFactSuperseded: invalid memory object');
  }
  const old = memory.facts.find(f => f.id === oldFactId);
  if (!old) {
    throw new Error(`markFactSuperseded: fact ${oldFactId} not found`);
  }
  if (newFactId !== null) {
    const newFact = memory.facts.find(f => f.id === newFactId);
    if (!newFact) {
      throw new Error(`markFactSuperseded: replacement fact ${newFactId} not found`);
    }
    if (newFactId === oldFactId) {
      throw new Error(`markFactSuperseded: cannot supersede a fact with itself (${oldFactId})`);
    }
  }
  old.superseded_by = newFactId;
  old.last_accessed = new Date().toISOString();
  return memory;
}

/**
 * 주입용 팩트를 선택한다 (deer-flow top-15 패턴).
 * 현재 stage에 가까운 팩트, 높은 confidence, 높은 relevance 우선.
 *
 * @param {object} memory
 * @param {number} [currentStage] - 현재 파이프라인 스테이지
 * @returns {Array} 선택된 팩트 배열
 */
export function selectFactsForInjection(memory, currentStage, now = Date.now()) {
  const topK = memory.top_k_injection || DEFAULT_CONFIG.top_k_injection;
  const threshold = memory.fact_confidence_threshold || DEFAULT_CONFIG.fact_confidence_threshold;
  const decayDays = memory.freshness_decay_days || DEFAULT_CONFIG.freshness_decay_days;

  const activeFacts = memory.facts.filter(f =>
    !f.superseded_by && (f.confidence || 0) >= threshold
  );

  // 점수 계산: confidence * relevance * stage_proximity
  const scored = activeFacts.map(f => {
    let stageProximity = 1.0;
    if (currentStage && f.source_stage) {
      const distance = Math.abs(currentStage - f.source_stage);
      stageProximity = 1.0 / (1.0 + distance * 0.2);
    }

    // 카테고리 가중치 (decision > constraint > assumption > lesson > preference > business > technical).
    // P15-B (2026-04-27): 모든 7개 카테고리 활성. extractor가 lesson_learned (handoff invalidated assumption),
    // user_preference (business-context.json#mode), business_context (business-context.json 핵심 필드)에서 추출.
    const categoryWeight = {
      decision: 1.5,
      constraint: 1.4,
      assumption: 1.3,
      lesson_learned: 1.2,
      user_preference: 1.1,
      business_context: 1.0,
      technical_context: 0.9,
    };

    // 신선도 감쇠: observation 성 fact 는 created_at 경과일에 비례해 점수 하락 (computeAgeDecay).
    const ageDecay = computeAgeDecay(f.category, f.created_at, now, decayDays);

    const score = (f.confidence || 0.7)
      * (f.relevance_score || 1.0)
      * stageProximity
      * (categoryWeight[f.category] || 1.0)
      * ageDecay;

    return { ...f, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);

  // P2-B (2026-05-01): category quota 적용. starvation 방지.
  // 점수순 정렬 후 카테고리별 max cap 도달 시 skip → 다음 fact 시도.
  // 점수 가중치 보존하면서 한 카테고리가 모든 슬롯 독점하는 패턴 차단.
  const caps = memory.category_caps || DEFAULT_CONFIG.category_caps;
  const counts = {};
  const selected = [];
  for (const fact of scored) {
    if (selected.length >= topK) break;
    const cat = fact.category || 'technical_context';
    const cap = caps[cat] ?? Infinity;
    if ((counts[cat] || 0) >= cap) continue;
    selected.push(fact);
    counts[cat] = (counts[cat] || 0) + 1;
  }

  return selected.map(({ _score, ...fact }) => fact);
}

/**
 * 주입용 컨텍스트 문자열을 생성한다 (deer-flow <memory> 태그 패턴).
 *
 * @param {object} memory
 * @param {number} [currentStage]
 * @param {object} [options]
 * @param {boolean} [options.includeSource=false] - true 면 fact 별 source 메타 (run_id 또는 cross-aidea) 표시.
 *   R-CM-014 P3 + R-CM-028 (2026-05-06): 사용자 컨텍스트 가시화 — 주입된 fact 의 출처를 즉시 인지 가능.
 * @returns {string} 주입용 문자열
 */
export function buildInjectionContext(memory, currentStage, options = {}) {
  const includeSource = options.includeSource === true;
  const facts = selectFactsForInjection(memory, currentStage, options.now);
  if (facts.length === 0) return '';

  const grouped = {};
  for (const fact of facts) {
    const cat = fact.category || 'technical_context';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(fact);

    // access_count 증가
    const original = memory.facts.find((f) => f.id === fact.id);
    if (original) {
      original.access_count = (original.access_count || 0) + 1;
      original.last_accessed = new Date().toISOString();
    }
  }

  const categoryLabels = {
    decision: 'Decisions',
    assumption: 'Assumptions',
    constraint: 'Constraints',
    lesson_learned: 'Lessons Learned',
    user_preference: 'User Preferences',
    technical_context: 'Technical Context',
    business_context: 'Business Context',
  };

  const lines = ['<pipeline-memory>'];
  for (const [cat, catFacts] of Object.entries(grouped)) {
    lines.push(`  <${categoryLabels[cat] || cat}>`);
    for (const f of catFacts) {
      const stageInfo = f.source_stage ? ` (Stage ${f.source_stage})` : '';
      const sourceLabel = includeSource
        ? ` [source: ${f.source_run_id || 'cross-aidea'}]`
        : '';
      lines.push(`    - ${f.content}${stageInfo}${sourceLabel}`);
    }
    lines.push(`  </${categoryLabels[cat] || cat}>`);
  }
  lines.push('</pipeline-memory>');

  return lines.join('\n');
}
