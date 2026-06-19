/**
 * pipeline-rules.mjs - Pipeline Stage Data Flow 규칙 SSOT
 *
 * pipeline-rules.mjs의 역할:
 *   파이프라인 스테이지 간 데이터 플로우 규칙 (handoff 정합성, 역방향 의존 금지 등)
 *
 * 규칙:
 *   Rule 1 → forward-only              : 후속 스테이지가 이전 스테이지 산출물만 참조 가능
 *   Rule 2 → handoff-required           : 스테이지 전환 시 handoff JSON 필수
 *   Rule 3 → budget-constraint          : infra 비용이 제약 조건 범위 내
 *   Rule 4 → platform-stack-align       : platform-decision과 stack-config 플랫폼 일치
 *   Rule 5 → three-alternatives         : stack-selector에서 각 레이어 3안 이상 비교
 *   Rule 6 → evidence-confidence-ceiling: evidence grade에 따른 confidence 상한 강제
 *   Rule 7 → constraint-propagation     : 규제/가격/GTM 제약이 MVP Must에 전파되었는지 검증
 *   Rule 8 → principle-architecture-align: product principles가 스택/인프라 결정에 반영되었는지 검증
 *   Rule 9 → tech-feasibility-check     : 선택된 스택 조합의 알려진 호환성 문제 감지
 */

import { STAGE_MAP, loadStageJson, loadHandoffJson, getPipelineMode } from './pipeline-config.mjs';
import { shouldSkipRegulation } from './pipeline-constraints-lib.mjs';

// ═══════════════════════════════════════════════════════════════
// 스테이지 순서 유틸리티
// ═══════════════════════════════════════════════════════════════

/**
 * 스테이지 ID에서 순서 번호를 반환한다.
 *
 * @param {string} stageId
 * @returns {number} 1~8 또는 0 (미발견)
 */
export function getStageOrder(stageId) {
  return STAGE_MAP.get(stageId)?.order || 0;
}

/**
 * 두 스테이지 간의 순서 관계를 판별한다.
 *
 * @param {string} fromStageId - 소스 스테이지
 * @param {string} toStageId - 타겟 스테이지
 * @returns {'forward' | 'backward' | 'same' | 'unknown'}
 */
export function classifyDirection(fromStageId, toStageId) {
  const fromOrder = getStageOrder(fromStageId);
  const toOrder = getStageOrder(toStageId);
  if (fromOrder === 0 || toOrder === 0) return 'unknown';
  if (fromOrder < toOrder) return 'forward';
  if (fromOrder > toOrder) return 'backward';
  return 'same';
}

// ═══════════════════════════════════════════════════════════════
// 구조적 참조 추출 (Rule 1 false positive 방지)
// ═══════════════════════════════════════════════════════════════

/** 설명/description을 제외하고 참조 의미를 가진 필드 값만 추출 */
const STRUCTURAL_KEYS = new Set([
  '$ref', 'source', 'input', 'depends_on', 'references',
  'input_file', 'output_file', 'source_file', 'ref',
  'stack_config_ref', 'infra_config_ref',
]);

const DESCRIPTION_KEYS = new Set([
  'description', 'summary', 'rationale', 'note', 'notes',
  'explanation', 'reason', 'comment', 'comments',
]);

// 사용자 가이드/Stuck Protocol 서브트리는 Forward-Only 규칙에서 제외된다.
// 이 서브트리들은 설계상 "다음 스테이지에서 생성될 파일"을 안내하므로
// 데이터 의존성이 아닌 UX guidance다. (mvp-scoper Step 9.5, CLAUDE.md Stuck Protocol)
const GUIDANCE_SUBTREES = new Set([
  'interpretation',           // Step 9.5 So-What Interpretation (모든 스테이지)
  'recommended_actions',      // Stuck Protocol 추천 액션
  'next_steps',               // 일반 next-step guidance
  'ai_estimations',           // AI 추정 사항 (후속 스테이지 안내 포함 가능)
  'next_actions',             // 2026-05-21: decision_gate.next_actions / decision_readiness.next_actions 등 의도적 다음 스테이지 안내 (pipeline-validator.mjs decision_gate.next_actions 1-5개 검증 — action-list soft cap). Forward-only 룰 false positive 차단 (예: "Stage 4 platform-selector 진행 / output: PLATFORM-DECISION.md" 같은 정상 가이드 문장이 산출물 의존성으로 오인됨).
]);

/**
 * JSON 객체에서 구조적 참조 필드의 값만 추출한다.
 * description, summary 등 자유 텍스트 필드 및
 * interpretation/recommended_actions 등 사용자 가이드 서브트리는 제외.
 *
 * @param {object} data
 * @returns {string} 구조적 필드 값들의 연결 문자열
 */
function extractStructuralRefs(data) {
  const refs = [];

  function walk(obj, parentKey, inGuidance) {
    if (inGuidance) return;
    if (typeof obj === 'string') {
      // 부모 키가 설명 필드가 아니고, 파일명 패턴(.json, .md)을 포함하면 수집
      if (!DESCRIPTION_KEYS.has(parentKey) && /\.(json|md)$/i.test(obj)) {
        refs.push(obj);
      }
      // 구조적 참조 키의 값은 무조건 수집
      if (STRUCTURAL_KEYS.has(parentKey)) {
        refs.push(obj);
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach(item => walk(item, parentKey, inGuidance));
      return;
    }
    if (obj && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        const entering = inGuidance || GUIDANCE_SUBTREES.has(key);
        walk(value, key, entering);
      }
    }
  }

  walk(data, '', false);
  return refs.join(' ');
}

// ═══════════════════════════════════════════════════════════════
// 데이터 플로우 규칙 검증
// ═══════════════════════════════════════════════════════════════

/**
 * [Rule 1] Forward-Only: 현재 스테이지가 이후 스테이지의 산출물을 참조하는지 검사.
 *
 * @param {string} currentStageId - 현재 작업 중인 스테이지
 * @param {string} referencedFile - 참조하려는 파일 경로
 * @returns {{ ruleId: string, severity: 'DENY'|'WARN', message: string, fix: string } | null}
 */
export function checkForwardOnly(currentStageId, referencedFile) {
  const currentOrder = getStageOrder(currentStageId);
  if (currentOrder === 0) return null;

  const normalized = referencedFile.replace(/\\/g, '/');

  for (const [stageId, info] of STAGE_MAP) {
    const refOrder = info.order;
    if (refOrder <= currentOrder) continue;

    const matchFiles = [info.mdFile, info.jsonFile, info.handoffFile].filter(Boolean);
    const isReferencing = matchFiles.some(f => normalized.includes(f));

    if (isReferencing) {
      return {
        ruleId: 'forward-only',
        severity: 'DENY',
        message: `Stage ${currentOrder} (${currentStageId})에서 Stage ${refOrder} (${stageId})의 산출물을 참조할 수 없습니다.`,
        fix: `이전 스테이지의 산출물만 참조하세요. Stage ${currentOrder} 이하의 데이터만 사용 가능합니다.`,
      };
    }
  }

  return null;
}

/**
 * [Rule 2] Handoff Required: 스테이지 전환 시 handoff JSON이 존재하는지 검사.
 *
 * @param {string} completedStageId - 완료된 스테이지
 * @returns {{ ruleId: string, severity: 'DENY'|'WARN', message: string, fix: string } | null}
 */
export function checkHandoffRequired(completedStageId) {
  const stage = STAGE_MAP.get(completedStageId);
  if (!stage?.handoffFile) return null;

  const handoff = loadHandoffJson(completedStageId);
  if (!handoff) {
    return {
      ruleId: 'handoff-required',
      severity: 'WARN',
      message: `Stage ${stage.order} (${completedStageId}) 완료 후 handoff 파일이 없습니다.`,
      fix: `.brief2dev/handoff/${stage.handoffFile}을 생성하세요. confidence, assumptions, open_questions 필드가 필수입니다.`, // @layout-resolver-allow
    };
  }

  const missingFields = [];
  if (handoff.confidence === undefined) missingFields.push('confidence');
  if (!handoff.assumptions) missingFields.push('assumptions');
  if (!handoff.open_questions) missingFields.push('open_questions');

  if (missingFields.length > 0) {
    return {
      ruleId: 'handoff-required',
      severity: 'WARN',
      message: `${completedStageId} handoff에 필수 필드가 누락되었습니다: ${missingFields.join(', ')}`,
      fix: `.brief2dev/handoff/${stage.handoffFile}에 누락된 필드를 추가하세요.`, // @layout-resolver-allow
    };
  }

  return null;
}

/**
 * [Rule 3] Budget Constraint: infra 비용이 제약 조건 범위 내인지 검사.
 *
 * @returns {{ ruleId: string, severity: 'DENY'|'WARN', message: string, fix: string } | null}
 */
export function checkBudgetConstraint() {
  const businessContext = loadStageJson('intake');
  const infraConfig = loadStageJson('infra_design');
  if (!businessContext || !infraConfig) return null;

  const budgetLimit = businessContext.constraints?.budget
    || businessContext.constraints?.budget_monthly
    || businessContext.budget?.monthly_limit;
  const estimatedCost = infraConfig.cost_estimation?.monthly_total
    || infraConfig.estimated_monthly_cost;

  if (budgetLimit && estimatedCost && estimatedCost > budgetLimit) {
    return {
      ruleId: 'budget-constraint',
      severity: 'DENY',
      message: `인프라 비용($${estimatedCost}/월)이 예산 제한($${budgetLimit}/월)을 초과합니다.`,
      fix: `infra-designer에서 비용을 $${budgetLimit}/월 이내로 조정하세요. 무료 티어 활용을 검토하세요.`,
    };
  }

  return null;
}

/**
 * [Rule 4] Platform-Stack Alignment: platform-decision과 stack-config의 플랫폼이 일치하는지 검사.
 *
 * @returns {{ ruleId: string, severity: 'DENY'|'WARN', message: string, fix: string } | null}
 */
export function checkPlatformStackAlignment() {
  const platformDecision = loadStageJson('platform_decision');
  const stackConfig = loadStageJson('stack_selection');
  if (!platformDecision || !stackConfig) return null;

  const decidedPlatform = platformDecision.selected_platform || platformDecision.platform;
  const stackPlatform = stackConfig.platform || stackConfig.target_platform;

  if (decidedPlatform && stackPlatform && decidedPlatform !== stackPlatform) {
    return {
      ruleId: 'platform-stack-align',
      severity: 'DENY',
      message: `플랫폼 불일치: platform-decision="${decidedPlatform}", stack-config="${stackPlatform}"`,
      fix: `stack-selector를 재실행하여 platform-decision(${decidedPlatform})에 맞는 스택을 선정하세요.`,
    };
  }

  return null;
}

/**
 * [Rule 5] Three Alternatives: stack-selector에서 각 레이어별 3안 이상 비교했는지 검사.
 *
 * @returns {{ ruleId: string, severity: 'DENY'|'WARN', message: string, fix: string } | null}
 */
export function checkThreeAlternatives() {
  const stackConfig = loadStageJson('stack_selection');
  if (!stackConfig) return null;

  const layers = ['frontend', 'backend', 'database', 'auth'];
  const violations = [];

  for (const layer of layers) {
    const alternatives = stackConfig.alternatives?.[layer]
      || stackConfig.evaluation?.[layer]?.candidates;
    if (Array.isArray(alternatives) && alternatives.length < 3) {
      violations.push(`${layer} (${alternatives.length}안)`);
    }
  }

  if (violations.length > 0) {
    return {
      ruleId: 'three-alternatives',
      severity: 'WARN',
      message: `3안 미만 비교 레이어: ${violations.join(', ')}`,
      fix: `CLAUDE.md 설계 원칙: "기술 선정 시 반드시 3안 이상을 ATAM Lite로 비교"`,
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// Rule 6~9: 의미적 정합성 검증 (Semantic Cross-Stage Validation)
//
// Rule 1~5는 구조적 검증 (파일 존재, 키 존재, 수치 비교).
// Rule 6~9는 의미적 검증 (데이터 간 논리적 일관성).
// E2E 테스트에서 발견된 4가지 근본 문제를 방지한다.
// ═══════════════════════════════════════════════════════════════

/**
 * Evidence Grade → Confidence 상한 매핑
 *
 * 근본 원인: Evidence Grade C(AI 추정 위주)인데 confidence 0.85를 보고할 수 있었음.
 * 이는 "자신감"과 "근거"가 분리되어 있어 AI가 근거 없이 높은 자신감을 주장할 수 있었기 때문.
 */
export const EVIDENCE_CONFIDENCE_CEILING = {
  A: 1.0,   // T1(직접 데이터) 포함 → 상한 없음
  B: 0.85,  // T2(검증된 외부 데이터) 위주 → 최대 0.85
  C: 0.65,  // T3(AI 추정) 위주 → 최대 0.65
  D: 0.40,  // 근거 없음 → 최대 0.40
};

/**
 * [Rule 6] Evidence-Confidence Ceiling: evidence grade에 따라 confidence 상한을 강제한다.
 *
 * 위반 시: DENY — confidence를 evidence grade 상한 이하로 낮춰야 함.
 *
 * @returns {Array<{ ruleId: string, severity: string, message: string, fix: string }>}
 */
export function checkEvidenceConfidenceCeiling() {
  const violations = [];

  for (const [stageId, stageInfo] of STAGE_MAP) {
    const handoff = loadHandoffJson(stageId);
    if (!handoff) continue;

    const grade = handoff.evidence_grade;
    const score = handoff.confidence?.score;
    if (!grade || score == null) continue;

    const ceiling = EVIDENCE_CONFIDENCE_CEILING[grade];
    if (ceiling == null) continue;

    if (score > ceiling) {
      violations.push({
        ruleId: 'evidence-confidence-ceiling',
        severity: 'DENY',
        message: `Stage ${stageInfo.order} (${stageId}): evidence_grade="${grade}"인데 confidence=${score}. 상한은 ${ceiling}.`,
        fix: `confidence를 ${ceiling} 이하로 조정하거나, evidence를 T1/T2 데이터로 보강하여 grade를 올리세요.`,
      });
    }
  }

  return violations;
}

/**
 * [Rule 7] Constraint Propagation: 규제/가격/GTM 요구사항이 MVP Must에 전파되었는지 검증한다.
 *
 * 근본 원인: Stage 1에서 regulatory 제약을 명시했지만 Stage 3 Must에 반영되지 않았음.
 * handoff의 assumption carry-forward만으로는 "제약→기능" 전파를 강제할 수 없었음.
 *
 * 검증 대상 3가지 전파 경로:
 *   (a) market-research.regulatory_landscape.required_features → mvp-scope.features.must
 *   (b) mvp-scope.pricing_hypothesis.mvp_impact.features_required_by_pricing → features.must|should
 *   (c) mvp-scope.gtm_hypothesis.mvp_features_required → features.must|should
 *
 * @returns {Array<{ ruleId: string, severity: string, message: string, fix: string }>}
 */
export function checkConstraintPropagation() {
  const violations = [];
  const mvpScope = loadStageJson('mvp_scoping');
  const marketResearch = loadStageJson('market_research');
  if (!mvpScope) return violations;

  // Must + Should 기능 이름을 모두 수집 (정규화: 소문자, F-XXX 제거)
  const allFeatureNames = [];
  for (const tier of ['must', 'should']) {
    const features = mvpScope.features?.[tier] || [];
    for (const f of features) {
      const name = (f.name || '').toLowerCase().replace(/^f-\d+:\s*/, '');
      const desc = (f.description || '').toLowerCase();
      allFeatureNames.push(name + ' ' + desc);
    }
  }
  const featureText = allFeatureNames.join(' | ');

  // (a) 규제 → Must 전파 — Mode-aware (pipeline-constraints-lib SSOT)
  const mode = getPipelineMode();
  if (marketResearch?.regulatory_landscape?.applicable_regulations) {
    for (const reg of marketResearch.regulatory_landscape.applicable_regulations) {
      if (shouldSkipRegulation(mode, reg)) continue;
      const requiredFeatures = reg.mvp_impact?.required_features || [];
      for (const reqFeat of requiredFeatures) {
        const normalized = reqFeat.toLowerCase();
        // 핵심 키워드로 매칭 (3단어 이상 연속 매칭)
        const keywords = normalized.split(/\s+/).filter(w => w.length > 1);
        const matched = keywords.filter(kw => featureText.includes(kw)).length;
        if (matched < Math.min(2, keywords.length)) {
          violations.push({
            ruleId: 'constraint-propagation',
            severity: 'WARN',
            message: `규제→Must 갭: "${reqFeat}"가 ${reg.regulation} 준수에 필요하지만 features.must에 없음.`,
            fix: `mvp-scope.json의 features.must에 규제 준수 기능을 추가하세요.`,
          });
        }
      }
    }
  }

  // (b) 가격 → Must/Should 전파
  const pricingFeatures = mvpScope.pricing_hypothesis?.mvp_impact?.features_required_by_pricing || [];
  for (const pf of pricingFeatures) {
    const normalized = (typeof pf === 'string' ? pf : pf.feature || '').toLowerCase();
    // F-XXX 참조는 이미 features에 포함된 것으로 간주
    if (/^f-\d+/.test(normalized)) continue;
    const keywords = normalized.split(/\s+/).filter(w => w.length > 1);
    const matched = keywords.filter(kw => featureText.includes(kw)).length;
    if (matched < Math.min(2, keywords.length)) {
      violations.push({
        ruleId: 'constraint-propagation',
        severity: 'WARN',
        message: `가격→Must 갭: "${pf}"가 pricing_hypothesis에서 요구되지만 features.must에 없음.`,
        fix: `해당 기능을 features.must 또는 features.should에 추가하세요.`,
      });
    }
  }

  // (c) GTM → Must/Should 전파
  // maps_to_feature_id가 실제 features.must의 id와 일치하면 매핑 완료로 간주 (pipeline-validator.mjs와 동일 규칙).
  const mustIds = new Set((mvpScope.features?.must || []).map(f => f.id).filter(Boolean));
  const gtmFeatures = mvpScope.gtm_hypothesis?.mvp_features_required || [];
  for (const gf of gtmFeatures) {
    const featureName = (gf.feature || '').toLowerCase();
    // F-XXX 참조는 이미 features에 포함된 것으로 간주
    if (/^f-\d+/.test(featureName)) continue;
    // maps_to_feature_id가 실제 must feature id와 매칭되면 명시적 매핑으로 통과
    if (gf.maps_to_feature_id && mustIds.has(gf.maps_to_feature_id)) continue;
    const keywords = featureName.split(/\s+/).filter(w => w.length > 1);
    const matched = keywords.filter(kw => featureText.includes(kw)).length;
    if (matched < Math.min(2, keywords.length)) {
      violations.push({
        ruleId: 'constraint-propagation',
        severity: 'WARN',
        message: `GTM→Must 갭: "${gf.feature}" (${gf.maps_to_feature_id || '?'})가 gtm_hypothesis에서 요구되지만 features.must에 없음.`,
        fix: `해당 기능을 features.must에 추가하거나 maps_to_feature_id로 기존 기능에 매핑하세요.`,
      });
    }
  }

  return violations;
}

/**
 * [Rule 8] Principle-Architecture Alignment: product principles가 스택/인프라에 반영되었는지 검증한다.
 *
 * 근본 원인: Stage 1에서 "Offline-first over Real-time sync"를 선언했지만
 * Stage 5-6에서 offline 전략을 구체화하지 않았음.
 *
 * 검증 로직: principle.affects 필드의 키워드 → 대응 Stage 산출물에서 관련 내용 존재 확인.
 *
 * @returns {Array<{ ruleId: string, severity: string, message: string, fix: string }>}
 */
export function checkPrincipleArchitectureAlignment() {
  const violations = [];
  const businessContext = loadStageJson('intake');
  const stackConfig = loadStageJson('stack_selection');
  const infraConfig = loadStageJson('infra_design');
  if (!businessContext?.business?.product_principles) return violations;

  const stackText = JSON.stringify(stackConfig || {}).toLowerCase();
  const infraText = JSON.stringify(infraConfig || {}).toLowerCase();
  const combinedText = stackText + ' ' + infraText;

  // 원칙 키워드 → 스택/인프라에서 확인해야 할 시그널 매핑
  const PRINCIPLE_SIGNALS = {
    'offline': ['offline', 'local_db', 'local', 'isar', 'drift', 'sqlite', 'hive', 'sync'],
    'cost': ['free', 'budget', 'cost', 'pricing', 'tier'],
    'speed': ['time_to_market', 'rapid', 'fast', 'mvp'],
    'security': ['encryption', 'auth', 'ssl', 'tls', 'security'],
    'privacy': ['privacy', 'gdpr', 'pipa', 'anonymi', 'data_minimization'],
    'simplicity': ['simple', 'minimal', 'lean', 'solo'],
    'scalab': ['scale', 'horizontal', 'vertical', 'auto_scaling'],
    'performance': ['performance', 'latency', 'cache', 'cdn'],
  };

  for (const principle of businessContext.business.product_principles) {
    const principleKey = (principle.principle || '').toLowerCase();
    const affects = principle.affects || [];

    // affects에 stack.* 또는 nfr.* 키워드가 있는 경우만 검증
    const stackAffects = affects.filter(a =>
      a.startsWith('stack.') || a.startsWith('nfr.') || a.startsWith('design.')
    );
    if (stackAffects.length === 0) continue;

    // 원칙 키워드로 시그널 매칭
    let signalFound = false;
    for (const [keyword, signals] of Object.entries(PRINCIPLE_SIGNALS)) {
      if (principleKey.includes(keyword)) {
        signalFound = signals.some(s => combinedText.includes(s));
        if (!signalFound) {
          violations.push({
            ruleId: 'principle-architecture-align',
            severity: 'WARN',
            message: `원칙 "${principle.principle} over ${principle.over}" (affects: ${stackAffects.join(', ')})가 선언되었지만 stack/infra 산출물에 대응하는 구현 시그널이 없음.`,
            fix: `stack-config 또는 infra-config에 이 원칙을 반영하는 구체적 기술 결정을 추가하세요. 예: "Offline-first" → 로컬 DB 선택, 동기화 전략 명시.`,
          });
        }
        break;
      }
    }
  }

  return violations;
}

/**
 * [Rule 9] Tech Feasibility Check: 선택된 스택 조합의 알려진 호환성 문제를 감지한다.
 *
 * 근본 원인: Supabase Auth + 카카오 OAuth의 네이티브 미지원,
 * flutter_background_geolocation의 상용 라이선스 비용 등이 검증되지 않았음.
 *
 * 접근: 알려진 비호환/주의 패턴의 데이터베이스를 유지하고 스택 조합과 대조.
 * 이 데이터베이스는 완전하지 않으므로 severity는 WARN.
 *
 * @returns {Array<{ ruleId: string, severity: string, message: string, fix: string }>}
 */
export function checkTechFeasibility() {
  const violations = [];
  const stackConfig = loadStageJson('stack_selection');
  const infraConfig = loadStageJson('infra_design');
  const businessContext = loadStageJson('intake');
  if (!stackConfig) return violations;

  const stackText = JSON.stringify(stackConfig).toLowerCase();
  const infraText = JSON.stringify(infraConfig || {}).toLowerCase();
  const businessText = JSON.stringify(businessContext || {}).toLowerCase();

  // 알려진 호환성 주의 패턴
  const KNOWN_ISSUES = [
    {
      condition: () => stackText.includes('supabase') && stackText.includes('auth') && businessText.includes('카카오'),
      message: 'Supabase Auth는 카카오 OAuth를 네이티브 지원하지 않음. Custom OIDC provider 설정 또는 카카오 REST API 직접 연동 필요.',
      fix: 'Supabase Custom OAuth Provider 설정을 infra-config에 명시하거나, 카카오 SDK 직접 연동 + Supabase Auth custom token 방식을 검토하세요.',
    },
    {
      condition: () => stackText.includes('flutter_background_geolocation'),
      message: 'flutter_background_geolocation 패키지는 상용 라이선스가 유료 ($300 one-time). 무료는 디버그 빌드만. 비용 추정에 반영 필요.',
      fix: 'infra-config.cost_estimation에 라이선스 비용을 추가하거나, 무료 대안(geolocator + flutter_foreground_task)을 검토하세요.',
    },
    {
      condition: () => stackText.includes('flutter') && (businessText.includes('gps') || businessText.includes('백그라운드') || businessText.includes('background')),
      message: 'Apple App Store는 백그라운드 위치 접근 앱에 대해 엄격한 심사 기준을 적용함. 위치 사용 정당화 문구(NSLocationAlwaysUsageDescription)가 불충분하면 리젝 가능.',
      fix: '앱 심사 가이드라인(Apple Human Interface Guidelines - Location)을 확인하고, 위치 사용 정당화 문구를 SPEC에 미리 준비하세요.',
    },
    {
      condition: () => stackText.includes('isar') && !stackText.includes('drift'),
      message: 'Isar DB의 개발 활성도가 감소 추세. 장기 유지보수 리스크 존재.',
      fix: 'Drift(SQLite 기반, 활발한 유지보수)를 대안으로 검토하세요. 또는 Isar 채택 시 마이그레이션 플랜을 수립하세요.',
    },
    {
      condition: () => stackText.includes('supabase') && stackText.includes('postgis') && infraText.includes('free'),
      message: 'Supabase 무료 티어에서 PostGIS 확장 사용 가능 여부를 확인 필요. 일부 확장은 Pro 플랜에서만 활성화됨.',
      fix: 'Supabase Dashboard에서 PostGIS 확장을 활성화할 수 있는지 실제 확인하세요. 불가하면 GPS 좌표를 일반 float 컬럼으로 저장하는 대안을 검토.',
    },
    {
      condition: () => stackText.includes('flutter_local_notifications') && businessText.includes('예방접종') && businessText.includes('알림'),
      message: '수개월 후 예방접종 알림은 로컬 알림만으로 불안정함. OS가 앱을 종료하면 스케줄된 알림이 사라질 수 있음.',
      fix: '서버 사이드 푸시(Supabase Edge Functions + FCM 스케줄러)를 병행 설계하세요. 로컬 알림은 앱 활성 시 보조 수단으로만 사용.',
    },
  ];

  for (const issue of KNOWN_ISSUES) {
    try {
      if (issue.condition()) {
        violations.push({
          ruleId: 'tech-feasibility-check',
          severity: 'WARN',
          message: issue.message,
          fix: issue.fix,
        });
      }
    } catch {
      // condition 평가 실패 시 스킵 (fail-safe)
    }
  }

  return violations;
}

// ═══════════════════════════════════════════════════════════════
// 종합 검증
// ═══════════════════════════════════════════════════════════════

/**
 * 모든 파이프라인 규칙을 종합 검증한다.
 *
 * @param {string} [currentStageId] - 현재 작업 중인 스테이지 (선택)
 * @returns {Array<{ ruleId: string, severity: string, message: string, fix: string }>}
 */
export function validateAllRules(currentStageId) {
  const violations = [];

  // Rule 1: Forward-only (JSON 데이터 내 전방 참조 검사)
  // 각 스테이지의 JSON 산출물이 후속 스테이지의 파일명을 구조적 필드에서 참조하는지 검사
  // 주의: JSON.stringify 전체 매칭은 설명 텍스트의 false positive 리스크가 있으므로
  //       $ref, source, input, depends_on 등 구조적 필드만 검사
  for (const [stageId, stageInfo] of STAGE_MAP) {
    const data = loadStageJson(stageId);
    if (!data) continue;

    // 구조적 참조 필드만 추출 (설명/description 텍스트 제외)
    const structuralFields = extractStructuralRefs(data);
    if (!structuralFields) continue;

    for (const [laterStageId, laterInfo] of STAGE_MAP) {
      if (laterInfo.order <= stageInfo.order) continue;
      const laterFiles = [laterInfo.jsonFile, laterInfo.mdFile].filter(Boolean);
      for (const file of laterFiles) {
        if (structuralFields.includes(file)) {
          const v = checkForwardOnly(stageId, file);
          if (v) {
            // 구조적 참조의 전방 위반은 WARN으로 다운그레이드
            // (실제 데이터 의존은 L1 boundary guard가 차단)
            v.severity = 'WARN';
            violations.push(v);
          }
        }
      }
    }
  }

  // Rule 2: 완료된 스테이지들의 handoff 확인
  for (const [stageId] of STAGE_MAP) {
    if (currentStageId && getStageOrder(stageId) >= getStageOrder(currentStageId)) break;
    const v = checkHandoffRequired(stageId);
    if (v) violations.push(v);
  }

  // Rule 3: 예산 범위
  const v3 = checkBudgetConstraint();
  if (v3) violations.push(v3);

  // Rule 4: 플랫폼-스택 정합성
  const v4 = checkPlatformStackAlignment();
  if (v4) violations.push(v4);

  // Rule 5: 3안 비교
  const v5 = checkThreeAlternatives();
  if (v5) violations.push(v5);

  // Rule 6: Evidence-Confidence 상한 (의미적 검증)
  const v6 = checkEvidenceConfidenceCeiling();
  violations.push(...v6);

  // Rule 7: 제약 전파 (규제/가격/GTM → Must)
  const v7 = checkConstraintPropagation();
  violations.push(...v7);

  // Rule 8: 원칙-아키텍처 정합성
  const v8 = checkPrincipleArchitectureAlignment();
  violations.push(...v8);

  // Rule 9: 기술 호환성 검증
  const v9 = checkTechFeasibility();
  violations.push(...v9);

  return violations;
}
