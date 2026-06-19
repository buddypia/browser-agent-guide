/**
 * pipeline-validator.mjs - brief2dev 파이프라인 검증
 *
 * brief2dev의 8-스테이지 선형 파이프라인에 특화된 검증 모듈.
 * 4가지 핵심 질문에 답한다:
 *
 *   1. 이 스테이지를 실행할 수 있는가? (전제조건 충족)
 *   2. 이 산출물은 유효한가? (구조 검증)
 *   3. 스테이지 간 정합성이 유지되는가? (교차 검증)
 *   4. 콘텐츠가 완성되었는가? (품질 검증)
 *
 * 소비자:
 *   - pipeline-boundary-guard.mjs (PreToolUse Skill)
 *   - phase-boundary-file-guard.mjs (PreToolUse Write|Edit)
 *   - pipeline-drift-guard.mjs (Stop)
 *   - output-gate 스킬 (Stage 8)
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';
import {
  STAGE_MAP, PROJECT_ROOT,
  getDataDir,
  getScaffoldDir,
  checkStageOutputs, loadStageJson, loadHandoffJson,
  loadBuildWorthinessGateHandoff,
  getRequiredInputs, getRequiredInputsForMode,
  classifyOutputFile, isStageActive, getPipelineMode,
} from './pipeline-config.mjs';
import { validateStageOutput } from './schema-validator.mjs';
import { shouldSkipRegulation, evaluateLtvCac } from './pipeline-constraints-lib.mjs';

// ═══════════════════════════════════════════════════════════════
// 상수
// ═══════════════════════════════════════════════════════════════

/** 스테이지별 필수 JSON 키 (스키마 required와 동기화) */
export const REQUIRED_KEYS = {
  'intake': ['version', 'business', 'target_users', 'constraints'],
  'market_research': [
    'version',
    'market_size',
    'personas',
    'competitors',
    'research_evidence',
    'evidence_summary',
    'deep_research_sessions',
    'deep_research_handoff',
  ],
  'mvp_scoping': ['version', 'features', 'mvp_summary', 'inherited_constraints'],
  'platform_decision': ['version', 'candidates', 'recommendation'],
  'stack_selection': ['version', 'platform', 'stack', 'research_evidence', 'evidence_summary', 'principle_compliance', 'compatibility_verification'],
  'infra_design': ['version', 'provider', 'architecture', 'cost_estimation', 'pricing_verification'],
  'output_gate': ['schema_version', 'pipeline', 'run_id', 'status', 'stages'],
};

// ─── Action-list count soft cap (SSOT — P8a 차분 2) ───
// recommended_actions / next_actions / first_14_days_actions 류 "사용자-실행 액션 리스트"의
// 권장 개수. 결정 피로 방지 의도(상한)는 유지하되 exactly-3 하한 강제를 제거 — 기본 3개 권장, 1-5개 허용.
// schema 6곳 + validator 4곳 + logical-integrity 2곳의 magic number 중복을 이 단일 SSOT 로 통합.
// recovery_options(3 복구경로) / objection_simulation(반론) 은 별도 근거이므로 본 cap 미적용.
export const ACTION_LIST_MIN = 1;
export const ACTION_LIST_MAX = 5;
export const ACTION_LIST_RECOMMENDED = 3;

/** 액션 리스트 개수 유효성 (1-5개). 배열 아님 / 하한 미달 / 상한 초과 시 false. */
export function isActionListCountValid(arr) {
  return (
    Array.isArray(arr) &&
    arr.length >= ACTION_LIST_MIN &&
    arr.length <= ACTION_LIST_MAX
  );
}

/** 액션 리스트 개수 위반 메시지 (검증 issue 용). */
export function actionListCountMessage(label) {
  return `${label}는 ${ACTION_LIST_MIN}-${ACTION_LIST_MAX}개 필요 (기본 ${ACTION_LIST_RECOMMENDED}개 권장 — 결정 피로 방지).`;
}

/** Confidence 임계값 (스테이지별) */
export const CONFIDENCE_THRESHOLDS = {
  intake:            { pass: 0.6, review: 0.3 },
  market_research:   { pass: 0.6, review: 0.3 },
  mvp_scoping:       { pass: 0.6, review: 0.3 },
  platform_decision: { pass: 0.7, review: 0.4 },
  stack_selection:   { pass: 0.8, review: 0.5 },
  infra_design:      { pass: 0.7, review: 0.4 },
  scaffolding:       { pass: 0.8, review: 0.5 },
  output_gate:       { pass: 0.9, review: 0.7 },
};

/** 콘텐츠 품질 감지 패턴 */
// PLACEHOLDER/FILL_THIS는 uppercase marker 관례이므로 case-sensitive 매칭.
// 소문자/혼합 케이스("Placeholder", "Template Placeholder Engine")는 도메인 용어이므로 제외.
const QUALITY_PATTERNS = [
  { pattern: /TODO:/i, description: 'TODO 마커' },
  { pattern: /\bPLACEHOLDER\b/, description: 'PLACEHOLDER 마커' },
  { pattern: /\bFILL_THIS\b/, description: 'FILL_THIS 마커' },
  { pattern: /\{\{\s*\w+\s*\}\}/i, description: '미확장 템플릿 변수' },
  { pattern: /__[A-Z][A-Z_]{2,}__/, description: '미확장 매직 상수' },
  { pattern: /lorem ipsum/i, description: 'Lorem Ipsum 더미 텍스트' },
];

const BUSINESS_GUIDANCE_STEP_FIELDS = [
  'id',
  'question',
  'why_it_matters',
  'answer',
  'answer_source',
  'evidence_tier',
  'decision_impact',
];

const BUSINESS_GUIDANCE_ANTI_BIAS_CHECKS = [
  'no_solution_pitch',
  'no_hypothetical_wtp',
  'past_behavior_required',
];

const BUSINESS_GUIDANCE_LOOP_FIELDS = [
  'loop_type',
  'critical_hypothesis',
  'test_design',
  'success_criteria',
  'stop_or_pivot_rule',
  'timebox',
  'artifact',
];

const BUSINESS_GUIDANCE_FORCING_KEYS = ['demand_reality', 'status_quo', 'narrowest_wedge'];
const BUSINESS_GUIDANCE_PREMISE_KEYS = ['P1_right_problem', 'P2_proxy_avoidance', 'P3_do_nothing'];

/**
 * 빈 배열이 의미적으로 "긍정 신호"인 필드 경로들.
 * 이 경로들은 빈 상태가 "문제 없음"을 나타내므로 C6에서 제외한다.
 */
const LEGIT_EMPTY_PATHS = new Set([
  // pipeline-progress.json: 빈 목록은 "모든 스테이지가 정상" 의미
  'metrics.low_confidence_stages',
  'metrics.unresolved_open_questions',
  // mvp-scope.json: Builder Mode/무료 내부 사용에서 pricing 강제 기능이 없음은 정상
  'pricing_hypothesis.mvp_impact.features_required_by_pricing',
  'pricing_hypothesis.mvp_impact.infra_requirements',
  // handoff의 open_questions: 미해결 질문 없음은 긍정 신호
  'open_questions',
]);

/** 빈 값 감지 제외 필드 */
const METADATA_FIELDS = new Set([
  'schema_version', 'generated_at', 'updated_at', 'created_at',
  'version', 'stage_order',
]);

const TEST_FILE_RE = /\.(test|spec)\.(cjs|mjs|js|jsx|ts|tsx)$/;
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage']);

function safeReadJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function safeReadText(path) {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function collectFiles(dir, predicate, limit = 250) {
  const out = [];
  function walk(current) {
    if (out.length >= limit || !existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const p = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_SCAN_DIRS.has(entry.name)) walk(p);
      } else if (entry.isFile() && predicate(p, entry.name)) {
        out.push(p);
      }
    }
  }
  walk(dir);
  return out;
}

export function resolveScaffoldCandidates(baseDir = getScaffoldDir()) {
  if (!existsSync(baseDir)) return [];
  if (
    existsSync(join(baseDir, 'project-config.json')) ||
    existsSync(join(baseDir, 'package.json')) ||
    existsSync(join(baseDir, 'CLAUDE.md'))
  ) {
    return [baseDir];
  }
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(baseDir, entry.name))
    .filter(
      (dir) =>
        existsSync(join(dir, 'project-config.json')) ||
        existsSync(join(dir, 'package.json')) ||
        existsSync(join(dir, 'CLAUDE.md')),
    );
}

const DEP_TO_FRAMEWORK_SIGNAL = [
  ['next', 'next'],
  ['@remix-run/react', 'remix'],
  ['nuxt', 'nuxt'],
  ['@sveltejs/kit', 'svelte'],
  ['electron', 'electron'],
  ['@tauri-apps/api', 'tauri'],
  ['expo', 'expo'],
];

function detectFrameworkSignals(scaffoldDir) {
  const projectConfig = safeReadJson(join(scaffoldDir, 'project-config.json'));
  const pkg = safeReadJson(join(scaffoldDir, 'package.json'));
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const signals = [projectConfig?.platform, projectConfig?.platform_id];
  for (const [dep, signal] of DEP_TO_FRAMEWORK_SIGNAL) {
    if (deps[dep]) signals.push(signal);
  }
  return signals.filter(Boolean);
}

export function checkDocumentationDrift(scaffoldDir) {
  const warnings = [];
  if (!scaffoldDir || !existsSync(scaffoldDir)) {
    return { passed: true, warnings, skipped: true };
  }

  const docFiles = ['README.md', 'ARCHITECTURE.md', 'GETTING-STARTED.md', 'CLAUDE.md']
    .map((file) => join(scaffoldDir, file))
    .filter((file) => existsSync(file));
  if (docFiles.length === 0) {
    warnings.push('Stale Documentation Audit: 핵심 문서(README/ARCHITECTURE/GETTING-STARTED/CLAUDE)가 없음.');
    return { passed: false, warnings, skipped: false };
  }

  const docsText = normalizeText(docFiles.map((file) => safeReadText(file)).join('\n'));
  const frameworkSignals = detectFrameworkSignals(scaffoldDir);
  const hasAnyFrameworkMention = frameworkSignals.some((signal) =>
    docsText.includes(String(signal).toLowerCase().replace(/^web-/, '').replace(/^mobile-/, '')),
  );
  if (frameworkSignals.length > 0 && !hasAnyFrameworkMention) {
    warnings.push(
      `Stale Documentation Audit: docs do not mention detected platform/framework (${frameworkSignals.join(', ')}).`,
    );
  }

  return { passed: warnings.length === 0, warnings, skipped: false };
}

export function checkRegressionReadiness(scaffoldDir, mvp = null) {
  const warnings = [];
  if (!scaffoldDir || !existsSync(scaffoldDir)) {
    return { passed: true, warnings, skipped: true };
  }

  const mustFeatures = mvp?.features?.must || [];
  if (mustFeatures.length === 0) {
    return { passed: true, warnings, skipped: true };
  }

  const testFiles = collectFiles(scaffoldDir, (path, name) => {
    return TEST_FILE_RE.test(name) || path.includes('/tests/') || path.includes('/e2e/');
  });
  if (testFiles.length === 0) {
    warnings.push('QA Regression Readiness: scaffold에 테스트 파일이 없음.');
    return { passed: false, warnings, skipped: false };
  }

  const testText = normalizeText(testFiles.map((file) => safeReadText(file)).join('\n'));
  if (!/\b(describe|it|test)\s*\(/.test(testText)) {
    warnings.push('QA Regression Readiness: 테스트 파일은 있으나 describe/it/test 케이스를 찾지 못함.');
  }

  for (const feature of mustFeatures) {
    const featureSignals = [feature.id, feature.name]
      .filter(Boolean)
      .map((signal) => String(signal).toLowerCase());
    if (featureSignals.length === 0) continue;
    const matched = featureSignals.some((signal) => testText.includes(signal));
    if (!matched) {
      warnings.push(
        `QA Regression Readiness: Must 기능 "${feature.name || feature.id}"에 대응하는 테스트 시그널이 없음.`,
      );
    }
  }

  return { passed: warnings.length === 0, warnings, skipped: false };
}

/**
 * GAP-3: Requirement Coverage Matrix — Stage 3 features.must (+ Stage 1 product_principles) 가
 * scaffold 산출물에 forward 매핑됐는지 추적. checkRegressionReadiness(test 차원) 를 흡수(위임)하고
 * artifact(소스/문서/route/config) 차원을 추가한다.
 *
 * 2-layer (R-CM-024 정직 분리):
 *   - 존재성 (must id/name 이 artifact/test 에 등장) = 코드강제 (결정론적 substring)
 *   - 의미 매핑 (principle 이 실제 반영됐나) = prompt-level (advisory, 경고 안 함)
 *
 * status: COVERED(artifact 매칭) / PARTIAL(test only) / UNMAPPED(어디에도 없음 → 경고)
 * fail-open: scaffoldDir 부재 / must 부재 → skipped.
 *
 * @param {string} scaffoldDir
 * @param {object|null} businessContext - Stage 1 business-context.json (product_principles advisory)
 * @param {object|null} mvp - Stage 3 mvp-scope.json (features.must)
 * @returns {{ passed: boolean, warnings: string[], coverage: object[], skipped: boolean }}
 */
export function checkRequirementCoverage(scaffoldDir, businessContext = null, mvp = null) {
  const warnings = [];
  const coverage = [];
  if (!scaffoldDir || !existsSync(scaffoldDir)) {
    return { passed: true, warnings, coverage, skipped: true };
  }

  // 테스트 차원 흡수 — checkRegressionReadiness 위임 (must 가 테스트에 신호 있는지)
  const reg = checkRegressionReadiness(scaffoldDir, mvp);
  warnings.push(...reg.warnings);

  const mustFeatures = mvp?.features?.must || [];
  if (mustFeatures.length === 0) {
    return { passed: warnings.length === 0, warnings, coverage, skipped: reg.skipped };
  }

  // artifact(비-test) vs test 텍스트 수집
  const artifactFiles = collectFiles(
    scaffoldDir,
    (path, name) => !TEST_FILE_RE.test(name) && !path.includes('/tests/') && !path.includes('/e2e/'),
  );
  const artifactText = normalizeText(artifactFiles.map((file) => safeReadText(file)).join('\n'));
  const testFiles = collectFiles(
    scaffoldDir,
    (path, name) => TEST_FILE_RE.test(name) || path.includes('/tests/') || path.includes('/e2e/'),
  );
  const testText = normalizeText(testFiles.map((file) => safeReadText(file)).join('\n'));

  const principles = businessContext?.business?.product_principles || [];
  const rows = buildCoverageRows(mustFeatures, principles, artifactText, testText);
  coverage.push(...rows.coverage);
  warnings.push(...rows.warnings);

  return { passed: warnings.length === 0, warnings, coverage, skipped: false };
}

/**
 * checkRequirementCoverage 의 coverage row + warning 산출 (복잡도 분리).
 * must: 존재성(artifact/test) 코드강제, UNMAPPED 만 경고. principle: advisory (경고 안 함).
 */
function buildCoverageRows(mustFeatures, principles, artifactText, testText) {
  const coverage = [];
  const warnings = [];
  for (const feature of mustFeatures) {
    const signals = [feature.id, feature.name].filter(Boolean).map((s) => String(s).toLowerCase());
    if (signals.length === 0) continue;
    const inArtifact = signals.some((s) => artifactText.includes(s));
    const inTest = signals.some((s) => testText.includes(s));
    const status = inArtifact ? 'COVERED' : inTest ? 'PARTIAL' : 'UNMAPPED';
    coverage.push({
      requirement_id: feature.id || feature.name,
      requirement_type: 'must',
      name: feature.name || feature.id,
      status,
    });
    if (status === 'UNMAPPED') {
      warnings.push(
        `Requirement Coverage: Must 기능 "${feature.name || feature.id}"가 scaffold 산출물(소스/문서/테스트) 어디에서도 발견되지 않음 (UNMAPPED).`,
      );
    }
  }
  for (const pr of principles) {
    const sig = pr?.principle ? String(pr.principle).toLowerCase() : null;
    if (!sig) continue;
    coverage.push({
      requirement_id: `principle:${pr.principle}`,
      requirement_type: 'principle',
      name: pr.principle,
      status: artifactText.includes(sig) ? 'COVERED' : 'ADVISORY_UNMAPPED',
    });
  }
  return { coverage, warnings };
}

export function checkOutputGateNativeProcessFusion(
  scaffoldDir = getScaffoldDir(),
  mvp = null,
  businessContext = null,
) {
  const warnings = [];
  const candidates = resolveScaffoldCandidates(scaffoldDir);
  for (const candidate of candidates) {
    warnings.push(...checkDocumentationDrift(candidate).warnings);
    // checkRequirementCoverage 가 checkRegressionReadiness(test 차원) 를 흡수 위임 + artifact 차원 추가
    warnings.push(...checkRequirementCoverage(candidate, businessContext, mvp).warnings);
  }
  return { passed: warnings.length === 0, warnings, checked: candidates.length };
}

function isDeepResearchOptedOut(env = process.env) {
  return ['off', '0', 'false'].includes(String(env.BRIEF2DEV_DEEP_RESEARCH || '').toLowerCase());
}

function hasDeepResearchCredential(env = process.env) {
  return Boolean(env.GEMINI_API_KEY || env.OPENAI_API_KEY);
}

function resolveEvidenceFilePath(filePath, projectRoot = process.env.CLAUDE_PROJECT_DIR || PROJECT_ROOT) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (isAbsolute(filePath)) return filePath;
  return resolve(projectRoot, filePath);
}

const DR_SESSION_REQUIRED_FIELDS = ['session_id', 'provider', 'query', 'status', 'output_path', 'used_in', 'ai_handoff'];

function isMissingValue(v) {
  return v === undefined || v === null || v === '';
}

function isEmptyArray(v) {
  return !Array.isArray(v) || v.length === 0;
}

function missingHandoffFields(handoff) {
  const missing = [];
  if (handoff.read_first !== true) missing.push('ai_handoff.read_first=true');
  if (isEmptyArray(handoff.decision_impact)) missing.push('ai_handoff.decision_impact[]');
  if (isEmptyArray(handoff.next_stage_instructions)) missing.push('ai_handoff.next_stage_instructions[]');
  return missing;
}

function missingDeepResearchSessionFields(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return ['session(object)'];
  }
  const missing = [];
  for (const field of DR_SESSION_REQUIRED_FIELDS) {
    if (!(field in session) || isMissingValue(session[field])) missing.push(field);
  }
  if (isEmptyArray(session.used_in)) missing.push('used_in[]');
  missing.push(...missingHandoffFields(session.ai_handoff || {}));
  return missing;
}

/**
 * Stage 2 deep-research 실행/파일/AI handoff 계약을 검증한다.
 *
 * WebSearch evidence는 빠른 사실 확인용으로 허용하지만, market-researcher의
 * 종합 판단은 deep-research Markdown 결과 파일을 canonical reference로 남겨야 한다.
 * completed 세션이 없으면 Stage 3+ 진입을 막는다. 단, 명시 opt-out 또는 API key 부재는
 * 실패 사유가 기록된 세션을 요구하고 confidence cap 경고로 낮춘다.
 *
 * @param {object} market market-research.json
 * @param {object} [options]
 * @param {string} [options.projectRoot] output_path 상대 경로 기준 루트
 * @param {object} [options.env] 환경 변수 주입(테스트용)
 * @returns {{passed: boolean, criticals: string[], warnings: string[], completed_count: number}}
 */
const DR_TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'skipped']);
const DR_FAILURE_STATUSES = new Set(['failed', 'timeout', 'skipped']);
const DR_HANDOFF_REQUIRED_FIELDS = ['canonical_files', 'ai_to_ai_summary', 'next_stage_obligations'];

function validateDeepResearchSessionFields(session, criticals) {
  const missing = missingDeepResearchSessionFields(session);
  if (missing.length > 0) {
    criticals.push(
      `deep_research_sessions.${session?.session_id || '(unknown)'} 필드 누락: ${missing.join(', ')}`,
    );
    return false;
  }
  return true;
}

function checkDeepResearchSessionFailureReason(session, criticals) {
  if (DR_FAILURE_STATUSES.has(session.status) && !session.failure_reason) {
    criticals.push(
      `deep_research_sessions.${session.session_id}: status=${session.status} 이지만 failure_reason이 없음.`,
    );
  }
}

function checkDeepResearchSessionOutputPath(session, outputPath, criticals) {
  if (!DR_TERMINAL_STATUSES.has(session.status)) return;
  if (outputPath && existsSync(outputPath)) return;
  criticals.push(
    `deep_research_sessions.${session.session_id}: status=${session.status} 이지만 output_path 파일이 없음 (${session.output_path}). 실패/스킵도 prompt와 fallback 근거를 Markdown으로 남겨야 함.`,
  );
}

function checkDeepResearchSessionCompletedContent(session, outputPath, warnings) {
  if (session.status !== 'completed' || !outputPath || !existsSync(outputPath)) return;
  const content = safeReadText(outputPath);
  if (!content.includes('Deep Research') || content.length < 200) {
    warnings.push(
      `deep_research_sessions.${session.session_id}: 결과 파일이 너무 짧거나 Deep Research 헤더가 없음 (${basename(outputPath)}).`,
    );
  }
}

function checkDeepResearchSessionResultSaved(session, warnings) {
  if (session.status === 'completed' && session.result_saved === false) {
    warnings.push(
      `deep_research_sessions.${session.session_id}: completed 상태인데 result_saved=false. state/result 동기화 확인 필요.`,
    );
  }
}

function checkDeepResearchSessionStatePath(session, projectRoot, warnings) {
  if (session.status !== 'completed' || !session.state_path) return;
  const statePath = resolveEvidenceFilePath(session.state_path, projectRoot);
  if (!statePath || !existsSync(statePath)) {
    warnings.push(
      `deep_research_sessions.${session.session_id}: state_path 파일을 찾을 수 없음 (${session.state_path}).`,
    );
  }
}

function evaluateDeepResearchSession(session, projectRoot, criticals, warnings) {
  if (!validateDeepResearchSessionFields(session, criticals)) return;
  const outputPath = resolveEvidenceFilePath(session.output_path, projectRoot);
  checkDeepResearchSessionFailureReason(session, criticals);
  checkDeepResearchSessionOutputPath(session, outputPath, criticals);
  checkDeepResearchSessionCompletedContent(session, outputPath, warnings);
  checkDeepResearchSessionResultSaved(session, warnings);
  checkDeepResearchSessionStatePath(session, projectRoot, warnings);
}

function evaluateDeepResearchCompletedCoverage(sessions, completed, env, criticals, warnings) {
  if (completed.length > 0 || sessions.length === 0) return;
  const explicitFallback = sessions.every(
    (session) => DR_FAILURE_STATUSES.has(session?.status) && session?.failure_reason,
  );
  if (isDeepResearchOptedOut(env) || !hasDeepResearchCredential(env)) {
    if (!explicitFallback) {
      criticals.push(
        'deep-research completed 세션은 없고 fallback 사유도 불완전함. WebSearch-only 진행 사유를 failure_reason에 기록해야 함.',
      );
    } else {
      warnings.push(
        'deep-research completed 세션 없음. 명시 opt-out/API key 부재 fallback으로 WebSearch-only 진행 가능하나 confidence cap을 낮춰야 함.',
      );
    }
    return;
  }
  criticals.push(
    'deep-research completed 세션 없음. API key가 있는 상태에서는 Stage 3 진입 전 deep-research poll/result 완료 및 결과 파일 저장이 필요함.',
  );
}

function isHandoffFieldEmpty(value) {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function checkDeepResearchHandoffRequiredFields(handoff, criticals) {
  for (const field of DR_HANDOFF_REQUIRED_FIELDS) {
    if (isHandoffFieldEmpty(handoff[field])) {
      criticals.push(`deep_research_handoff.${field} 누락 또는 비어있음.`);
    }
  }
}

function checkDeepResearchHandoffCanonicalFiles(handoff, terminalSessions, projectRoot, criticals) {
  if (terminalSessions.length === 0) return;
  const canonicalFiles = Array.isArray(handoff?.canonical_files) ? handoff.canonical_files : [];
  for (const file of canonicalFiles) {
    const filePath = resolveEvidenceFilePath(file, projectRoot);
    if (!filePath || !existsSync(filePath)) {
      criticals.push(`deep_research_handoff.canonical_files 파일 없음: ${file}`);
    }
  }
}

function sha256File(filePath) {
  return `sha256:${createHash('sha256').update(readFileSync(filePath)).digest('hex')}`;
}

function checkDeepResearchHandoffRawOutputs(handoff, projectRoot, criticals, warnings) {
  const rawOutputs = Array.isArray(handoff?.raw_outputs) ? handoff.raw_outputs : [];
  if (rawOutputs.length === 0) {
    warnings.push(
      'deep_research_handoff.raw_outputs 없음. 신규 run은 canonical 원문 경로와 sha256 해시를 기록해야 요약 손실 여부를 재검증할 수 있음.',
    );
    return;
  }

  const canonicalFiles = new Set(Array.isArray(handoff?.canonical_files) ? handoff.canonical_files : []);
  rawOutputs.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      criticals.push(`deep_research_handoff.raw_outputs[${index}] object 아님.`);
      return;
    }
    const sourcePath = raw.canonical_source_path;
    if (!sourcePath) {
      criticals.push(`deep_research_handoff.raw_outputs[${index}].canonical_source_path 누락.`);
      return;
    }
    if (canonicalFiles.size > 0 && !canonicalFiles.has(sourcePath)) {
      warnings.push(
        `deep_research_handoff.raw_outputs[${index}].canonical_source_path가 canonical_files[]에 없음: ${sourcePath}`,
      );
    }
    const resolved = resolveEvidenceFilePath(sourcePath, projectRoot);
    if (!resolved || !existsSync(resolved)) {
      criticals.push(`deep_research_handoff.raw_outputs[${index}] 파일 없음: ${sourcePath}`);
      return;
    }
    if (!raw.content_hash) {
      warnings.push(`deep_research_handoff.raw_outputs[${index}].content_hash 누락: ${sourcePath}`);
    } else {
      const actualHash = sha256File(resolved);
      if (actualHash !== raw.content_hash) {
        criticals.push(
          `deep_research_handoff.raw_outputs[${index}] 해시 불일치: expected=${raw.content_hash}, actual=${actualHash}`,
        );
      }
    }
    for (const field of ['generated_at', 'source_type', 'handoff_summary']) {
      if (isHandoffFieldEmpty(raw[field])) {
        warnings.push(`deep_research_handoff.raw_outputs[${index}].${field} 누락 또는 비어있음.`);
      }
    }
    if (!Array.isArray(raw.reread_triggers) || raw.reread_triggers.length === 0) {
      warnings.push(`deep_research_handoff.raw_outputs[${index}].reread_triggers 없음. 다음 stage의 원문 재독 조건을 기록해야 함.`);
    }
  });
}

function evaluateDeepResearchHandoffStructure(handoff, terminalSessions, projectRoot, criticals, warnings) {
  if (!handoff || typeof handoff !== 'object') {
    criticals.push('market-research.json#deep_research_handoff 없음. AI-to-AI 인계 요약과 canonical evidence pointer가 필요함.');
    return;
  }
  checkDeepResearchHandoffRequiredFields(handoff, criticals);
  checkDeepResearchHandoffCanonicalFiles(handoff, terminalSessions, projectRoot, criticals);
  checkDeepResearchHandoffRawOutputs(handoff, projectRoot, criticals, warnings);
}

function isDeepResearchEvidenceItem(item) {
  if (!item) return false;
  if (item.type === 'deep_research') return true;
  if (item.source_type === 'deep_research') return true;
  if (typeof item.id === 'string' && item.id.startsWith('DR-')) return true;
  if (typeof item.source_ref === 'string' && item.source_ref.includes('deep_research_sessions')) return true;
  return false;
}

function checkDeepResearchEvidenceMergePresence(market, completed, criticals) {
  if (completed.length === 0) return;
  const hasDeepResearchEvidence = Array.isArray(market.research_evidence)
    && market.research_evidence.some(isDeepResearchEvidenceItem);
  if (!hasDeepResearchEvidence) {
    criticals.push(
      'research_evidence에 deep_research 타입/참조가 없음. completed deep-research 결과를 RES/DR evidence로 병합해야 함.',
    );
  }
}

export function evaluateDeepResearchEvidence(market, options = {}) {
  const criticals = [];
  const warnings = [];
  const env = options.env || process.env;
  const projectRoot = options.projectRoot || env.CLAUDE_PROJECT_DIR || PROJECT_ROOT;

  if (!market || typeof market !== 'object') {
    return {
      passed: false,
      criticals: ['market-research.json 없음. deep-research 실행 여부를 검증할 수 없음.'],
      warnings,
      completed_count: 0,
    };
  }

  const sessions = Array.isArray(market.deep_research_sessions) ? market.deep_research_sessions : [];
  if (sessions.length === 0) {
    criticals.push(
      'market-research.json#deep_research_sessions 없음. Stage 2는 WebSearch와 별도로 deep-research start/poll/result 실행 기록과 Markdown 결과 파일을 남겨야 함.',
    );
  }

  for (const session of sessions) {
    evaluateDeepResearchSession(session, projectRoot, criticals, warnings);
  }

  const completed = sessions.filter((session) => session?.status === 'completed');
  const terminalSessions = sessions.filter((session) => DR_TERMINAL_STATUSES.has(session?.status));

  evaluateDeepResearchCompletedCoverage(sessions, completed, env, criticals, warnings);
  evaluateDeepResearchHandoffStructure(market.deep_research_handoff, terminalSessions, projectRoot, criticals, warnings);
  checkDeepResearchEvidenceMergePresence(market, completed, criticals);

  return {
    passed: criticals.length === 0,
    criticals,
    warnings,
    completed_count: completed.length,
  };
}

function unwrapBuildWorthinessGate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const gate = candidate.decision_gate || candidate.build_worthiness_gate || candidate;
  if (!gate || typeof gate !== 'object') return null;
  if (!('decision' in gate) && !('context_snapshot' in gate) && !('plain_language_conclusion' in gate)) {
    return null;
  }
  return gate;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function resolveBuildWorthinessGate(
  mvp,
  stageHandoff = null,
  dedicatedHandoff = null,
) {
  const sources = [
    {
      source: 'mvp-scope.json#decision_gate',
      canonical: true,
      gate: unwrapBuildWorthinessGate(mvp?.decision_gate ? { decision_gate: mvp.decision_gate } : null),
    },
    {
      source: 'mvp-scope.json#build_worthiness_gate',
      canonical: true,
      gate: unwrapBuildWorthinessGate(
        mvp?.build_worthiness_gate ? { build_worthiness_gate: mvp.build_worthiness_gate } : null,
      ),
    },
    {
      source: 'stage-3-handoff.json#decision_gate',
      canonical: false,
      gate: unwrapBuildWorthinessGate(stageHandoff),
    },
    {
      source: 'build-worthiness-gate.json#decision_gate',
      canonical: false,
      gate: unwrapBuildWorthinessGate(dedicatedHandoff),
    },
  ].filter((entry) => entry.gate);

  if (sources.length === 0) {
    return { gate: null, source: null, conflicts: [] };
  }

  const primary = sources.find((entry) => entry.canonical) || sources[0];
  const primarySignature = stableStringify(primary.gate);
  const conflicts = sources
    .filter((entry) => entry.source !== primary.source)
    .filter((entry) => stableStringify(entry.gate) !== primarySignature)
    .map((entry) => ({
      primary: primary.source,
      mirror: entry.source,
      message: `Build Worthiness Gate artifact mismatch: ${entry.source} differs from ${primary.source}. Canonical SSOT is mvp-scope.json#decision_gate.`,
    }));

  return { gate: primary.gate, source: primary.source, conflicts };
}

function checkGuidedSteps(guided, issues) {
  if (!Array.isArray(guided.steps) || guided.steps.length < 4) {
    issues.push('guided_validation.steps는 최소 4단계 이상 필요함.');
    return;
  }
  const hasUserAnswer = guided.steps.some((step) => step.answer_source === 'from_user');
  if (!hasUserAnswer) {
    issues.push('guided_validation.steps에 answer_source=from_user가 최소 1개 필요함. AI가 모든 결정을 대신하면 안 됨.');
  }
  guided.steps.forEach((step, index) => {
    for (const key of BUSINESS_GUIDANCE_STEP_FIELDS) {
      if (!step?.[key]) issues.push(`guided_validation.steps[${index}].${key} 누락.`);
    }
  });
}

function checkGuidedFitnessAndPrompt(guided, issues) {
  const fitness = guided.business_fitness;
  if (
    !fitness?.verdict ||
    !fitness?.plain_language_reason ||
    !fitness?.weakest_link ||
    !Array.isArray(fitness?.upgrade_path) ||
    fitness.upgrade_path.length < 1
  ) {
    issues.push(
      'guided_validation.business_fitness는 verdict/plain_language_reason/weakest_link/upgrade_path를 포함해야 함.',
    );
  }
  if (!guided.next_action_prompt || String(guided.next_action_prompt).length < 10) {
    issues.push('guided_validation.next_action_prompt 누락. 사용자가 바로 답할 다음 질문/행동이 필요함.');
  }
}

function checkDiscoveryCommitmentSignal(discovery, issues) {
  const signal = discovery.minimum_commitment_signal;
  if (!signal?.signal || !signal?.threshold || !signal?.timebox || !signal?.interpretation) {
    issues.push(
      'guided_validation.customer_discovery.minimum_commitment_signal은 signal/threshold/timebox/interpretation을 포함해야 함.',
    );
  }
}

function checkGuidedCustomerDiscoveryStructure(discovery, issues) {
  if (!Array.isArray(discovery.question_set) || discovery.question_set.length < 5) {
    issues.push('guided_validation.customer_discovery.question_set은 최소 5개 질문이 필요함.');
  }
  const checks = discovery.anti_bias_checks || {};
  for (const key of BUSINESS_GUIDANCE_ANTI_BIAS_CHECKS) {
    if (checks[key] !== true) {
      issues.push(`guided_validation.customer_discovery.anti_bias_checks.${key}=true 필요.`);
    }
  }
  if (!Array.isArray(discovery.recruiting_plan) || discovery.recruiting_plan.length < 1) {
    issues.push('guided_validation.customer_discovery.recruiting_plan 최소 1개 필요.');
  }
  checkDiscoveryCommitmentSignal(discovery, issues);
}

function checkGuidedCustomerDiscovery(guided, issues) {
  const discovery = guided.customer_discovery;
  if (!discovery) {
    issues.push(
      'guided_validation.customer_discovery 없음. 비즈니스 초심자가 가짜 긍정 인터뷰를 하지 않도록 질문 품질/모집/commitment 신호가 필요함.',
    );
    return;
  }
  checkGuidedCustomerDiscoveryStructure(discovery, issues);
}

function checkGuidedLearningLoop(guided, issues) {
  const loop = guided.first_learning_loop;
  if (BUSINESS_GUIDANCE_LOOP_FIELDS.some((key) => !loop?.[key])) {
    issues.push(
      'guided_validation.first_learning_loop는 loop_type/critical_hypothesis/test_design/success_criteria/stop_or_pivot_rule/timebox/artifact를 포함해야 함.',
    );
  }
}

function checkGuidedValidation(businessContext, issues) {
  const guided = businessContext.guided_validation;
  if (!guided) {
    issues.push(
      'business-context.json#guided_validation 없음. 비즈니스 초심자를 위한 AI 주도 질문/답변/근거/판단 루프가 필요함.',
    );
    return;
  }
  if (!guided.user_knowledge_assumption) {
    issues.push(
      'guided_validation.user_knowledge_assumption 누락. 비즈니스 지식 수준에 대한 작업 가정이 필요함.',
    );
  }
  checkGuidedSteps(guided, issues);
  checkGuidedFitnessAndPrompt(guided, issues);
  checkGuidedCustomerDiscovery(guided, issues);
  checkGuidedLearningLoop(guided, issues);
}

function checkForcingAnswers(forcing, businessContext, issues) {
  for (const key of BUSINESS_GUIDANCE_FORCING_KEYS) {
    if (!forcing[key]?.answer || !forcing[key]?.evidence_tier) {
      issues.push(`business-context.json#forcing_answers.${key} 누락 또는 불완전.`);
    }
  }
  const hasT1ForcingEvidence = Object.values(forcing).some((answer) => answer?.evidence_tier === 'T1');
  const loopType = businessContext.guided_validation?.first_learning_loop?.loop_type;
  if (!hasT1ForcingEvidence && loopType === 'mvp_build') {
    issues.push(
      'T1 직접 행동 근거가 없는데 first_learning_loop.loop_type=mvp_build. 먼저 customer_interview/mvt/pretotype/concierge/fake_door 중 하나로 핵심 가설을 검증해야 함.',
    );
  }
}

function checkDecisionContractPropagation(businessContext, issues) {
  const propagated = new Set(businessContext.decision_contract?.must_propagate || []);
  for (const key of BUSINESS_GUIDANCE_FORCING_KEYS) {
    if (!propagated.has(key)) {
      issues.push(`decision_contract.must_propagate에 ${key} 포함 필요.`);
    }
  }
}

function checkBusinessForcingAndContract(businessContext, issues) {
  const forcing = businessContext.forcing_answers || {};
  checkForcingAnswers(forcing, businessContext, issues);
  checkDecisionContractPropagation(businessContext, issues);
}

function checkBusinessPremiseChallenge(businessContext, issues) {
  const premise = businessContext.premise_challenge;
  for (const key of BUSINESS_GUIDANCE_PREMISE_KEYS) {
    if (!premise?.[key]?.premise || !premise?.[key]?.user_response) {
      issues.push(`business-context.json#premise_challenge.${key} 누락 또는 불완전.`);
    }
  }
}

function checkBusinessAlternativesAndInterpretation(businessContext, issues) {
  const alternatives = businessContext.alternatives;
  if (
    !Array.isArray(alternatives?.approaches) ||
    alternatives.approaches.length < 2 ||
    !alternatives.selected_approach_id ||
    !alternatives.recommendation
  ) {
    issues.push(
      'business-context.json#alternatives는 approaches 2개 이상, selected_approach_id, recommendation을 포함해야 함.',
    );
  }

  const interpretation = businessContext.interpretation;
  if (
    !interpretation?.summary_plain ||
    !Array.isArray(interpretation?.key_findings) ||
    interpretation.key_findings.length < 3 ||
    !isActionListCountValid(interpretation?.recommended_actions)
  ) {
    issues.push(
      'business-context.json#interpretation은 summary_plain, key_findings 3개 이상, recommended_actions 1-5개(기본 3개 권장)를 포함해야 함.',
    );
  }
}

function checkBusinessFounderSignals(businessContext, issues) {
  const founderSignals = businessContext.founder_signals;
  if (
    !founderSignals ||
    !Number.isInteger(founderSignals.count) ||
    !Array.isArray(founderSignals.detected) ||
    !founderSignals.tier ||
    !founderSignals.confidence_calibration_hint
  ) {
    issues.push(
      'business-context.json#founder_signals 누락 또는 불완전. 창업자 신호를 confidence calibration에 연결해야 함.',
    );
  }
}

// PR 2 검증층 (multi-llm 검증 반영): Unified Discovery Conversation 의 fan-out 공동화 방지.
// _discovery_ledger 가 present 일 때만 동작 (autonomous/비-guided run 은 ledger 미생성 → inert, by-design).
// escapable: unconfirmed 추측 항목은 open_questions/ai_estimations 에 disclose 하면 통과 (deadlock 없음).
function collectUnconfirmedFanoutFields(ledger) {
  const themes = Array.isArray(ledger?.themes) ? ledger.themes : [];
  return (
    themes
      .flatMap((theme) => (Array.isArray(theme?.grounding_trace) ? theme.grounding_trace : []))
      // strict boolean: schema 가 unconfirmed.type:"boolean" 강제 → schema-validated ledger 전제.
      // 미검증 raw ledger 의 문자열 "true" 는 의도적으로 제외 (schema 통과가 gate 의 선행 조건).
      .filter((trace) => trace?.unconfirmed === true && trace?.field)
      .map((trace) => trace.field)
  );
}

// per-field linkage (code-reviewer HIGH 반영): "채널 non-empty" 가 아니라 "해당 field 가 실제 disclose 되었나".
// disclosure 항목(open_questions/ai_estimations)의 직렬화 텍스트에 field 전체 경로 또는 leaf 토큰 포함 시 disclose 로 인정.
function collectDisclosureTexts(businessContext) {
  const oq = Array.isArray(businessContext.open_questions) ? businessContext.open_questions : [];
  const ae = Array.isArray(businessContext.ai_estimations) ? businessContext.ai_estimations : [];
  return [...oq, ...ae].map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
}

function isFieldDisclosed(field, disclosureTexts) {
  const leaf = field.split('.').pop();
  return disclosureTexts.some((text) => text.includes(field) || (leaf && text.includes(leaf)));
}

function checkDiscoveryLedgerGrounding(businessContext, issues) {
  const ledger = businessContext._discovery_ledger;
  if (!ledger || !Array.isArray(ledger.themes)) return;
  const unconfirmedFields = collectUnconfirmedFanoutFields(ledger);
  if (unconfirmedFields.length === 0) return;
  const disclosureTexts = collectDisclosureTexts(businessContext);
  const undisclosed = unconfirmedFields.filter((field) => !isFieldDisclosed(field, disclosureTexts));
  if (undisclosed.length === 0) return;
  const sample = undisclosed.slice(0, 3).join(', ');
  issues.push(
    `business-context.json#_discovery_ledger 에 unconfirmed:true fan-out 항목 ${undisclosed.length}개(${sample})가 해당 field 를 open_questions/ai_estimations 에 명시 disclose 하지 않음. 추측 보완은 confirm 하거나 해당 field 를 honesty 채널에 disclose 해야 함 (R-PL-001 Rule 7 / R-CM-016 Rule 9).`,
  );
}

export function evaluateBusinessGuidancePreflight(businessContext) {
  const issues = [];
  if (!businessContext) {
    issues.push('business-context.json 없음. Stage 2 진입 전 Stage 1 business-analyzer 산출물이 필요함.');
    return issues;
  }

  const mode = businessContext.mode || businessContext.business?.mode || 'production';
  if (mode === 'builder' || mode === 'learning') {
    return issues;
  }

  checkGuidedValidation(businessContext, issues);
  checkBusinessForcingAndContract(businessContext, issues);
  checkBusinessPremiseChallenge(businessContext, issues);
  checkBusinessAlternativesAndInterpretation(businessContext, issues);
  checkBusinessFounderSignals(businessContext, issues);
  checkDiscoveryLedgerGrounding(businessContext, issues);

  return issues;
}

const BUILD_GATE_ALLOWED_DECISIONS = new Set(['BUILD', 'BUILD_WITH_CAUTION', 'PIVOT', 'DEFER', 'NO_GO', 'BUILDER_OVERRIDE']);
const BUILD_GATE_BLOCK_DECISIONS = new Set(['NO_GO', 'DEFER']);
const BUILD_GATE_GREEN_DECISIONS = new Set(['BUILD', 'BUILD_WITH_CAUTION']);
const BUILD_GATE_RECOVERY_REQUIRED_DECISIONS = new Set(['NO_GO', 'PIVOT', 'DEFER']);
const BUILD_GATE_RECOVERY_FIELDS = [
  'option',
  'when_to_use',
  'action',
  'validation_method',
  'success_criteria',
  'expected_decision_after',
  'timebox',
  'output',
];

function pickEvidenceCount(gate, market, tier, summaryKey) {
  const gateValue = gate.evidence_counts?.[tier];
  if (gateValue !== undefined && gateValue !== null) return Number(gateValue);
  const marketValue = market?.evidence_summary?.[summaryKey];
  if (marketValue !== undefined && marketValue !== null) return Number(marketValue);
  return 0;
}

function pickConfidenceCap(gate) {
  if (gate.confidence_cap !== undefined && gate.confidence_cap !== null) return Number(gate.confidence_cap);
  if (gate.confidence?.cap !== undefined && gate.confidence?.cap !== null) return Number(gate.confidence.cap);
  return 1;
}

function pickViabilityScore(market) {
  const total = market?.viability_score?.total;
  if (total !== undefined && total !== null) return total;
  const flat = market?.viability_score;
  if (flat !== undefined && flat !== null) return flat;
  return null;
}

function collectBuildGateContext(gate, market) {
  const counts = {
    T1: pickEvidenceCount(gate, market, 'T1', 't1_count'),
    T2: pickEvidenceCount(gate, market, 'T2', 't2_count'),
    T3: pickEvidenceCount(gate, market, 'T3', 't3_count'),
  };
  return {
    decision: gate.decision,
    counts,
    t2Plus: counts.T1 + counts.T2,
    cap: pickConfidenceCap(gate),
    viability: pickViabilityScore(market),
    overrideConfirmed: gate.builder_override?.user_confirmed === true || gate.user_confirmed === true,
  };
}

function checkBuildGateDecisionEligibility(gate, source, ctx, issues) {
  if (!BUILD_GATE_ALLOWED_DECISIONS.has(ctx.decision)) {
    issues.push(`decision_gate.decision="${ctx.decision}"는 허용되지 않음. source=${source}`);
  }
  if (BUILD_GATE_BLOCK_DECISIONS.has(ctx.decision)) {
    issues.push(`decision=${ctx.decision} 상태에서는 Stage 4로 진행할 수 없음.`);
  }
  if (ctx.decision === 'PIVOT' && !ctx.overrideConfirmed) {
    issues.push('decision=PIVOT 상태에서는 Stage 1 또는 Stage 3 compensation이 필요함.');
  }
}

function checkBuildGateEvidenceThresholds(ctx, issues) {
  if (ctx.decision === 'BUILD' && ctx.t2Plus < 10) {
    issues.push(`decision=BUILD 이지만 T2+ evidence=${ctx.t2Plus}건 < 10건.`);
  }
  if (ctx.counts.T1 === 0 && ctx.cap > 0.70) {
    issues.push(`AI-only evidence(T1=0) confidence_cap=${ctx.cap} > 0.70.`);
  }
  if (
    typeof ctx.viability === 'number' &&
    ctx.viability < 15 &&
    BUILD_GATE_GREEN_DECISIONS.has(ctx.decision)
  ) {
    issues.push(`viability_score=${ctx.viability} < 15인데 decision=${ctx.decision}. PIVOT/DEFER/NO_GO 또는 BUILDER_OVERRIDE가 필요함.`);
  }
}

function checkBuildGateBuilderOverride(ctx, issues) {
  if (ctx.decision !== 'BUILDER_OVERRIDE') return;
  if (!ctx.overrideConfirmed) {
    issues.push('BUILDER_OVERRIDE는 사용자 명시 확인(user_confirmed=true)이 필요함.');
  }
  if (ctx.cap > 0.50) {
    issues.push(`BUILDER_OVERRIDE confidence_cap=${ctx.cap} > 0.50.`);
  }
}

const BUILD_GATE_SNAPSHOT_REQUIRED_FIELDS = [
  'problem',
  'target_user',
  'current_alternative',
  'mvp_scope',
  'primary_gtm_channel',
];

function checkBuildGatePlainLanguageConclusion(gate, issues) {
  if (!gate.plain_language_conclusion || String(gate.plain_language_conclusion).length < 10) {
    issues.push('decision_gate.plain_language_conclusion 누락.');
  }
}

function checkBuildGateSnapshotFields(snapshot, issues) {
  const missingRequired = BUILD_GATE_SNAPSHOT_REQUIRED_FIELDS.some((field) => !snapshot?.[field]);
  if (missingRequired) {
    issues.push('decision_gate.context_snapshot는 problem/target_user/current_alternative/mvp_scope/primary_gtm_channel을 모두 포함해야 함.');
  }
  if (!Array.isArray(snapshot?.source_refs) || snapshot.source_refs.length < 3) {
    issues.push('decision_gate.context_snapshot.source_refs 최소 3개 필요.');
  }
}

function checkBuildGateContextSnapshot(gate, issues) {
  checkBuildGatePlainLanguageConclusion(gate, issues);
  checkBuildGateSnapshotFields(gate.context_snapshot, issues);
}

function checkBuildGateUserDecisionBrief(gate, issues) {
  const brief = gate.user_decision_brief;
  if (
    !brief?.what_this_means ||
    !brief?.recommended_choice ||
    !brief?.why ||
    !brief?.what_would_change_the_decision
  ) {
    issues.push('decision_gate.user_decision_brief는 what_this_means/recommended_choice/why/what_would_change_the_decision을 모두 포함해야 함.');
  }
  if (!Array.isArray(gate.most_dangerous_assumptions) || gate.most_dangerous_assumptions.length < 3) {
    issues.push('decision_gate.most_dangerous_assumptions 최소 3개 필요.');
  }
  if (!isActionListCountValid(gate.next_actions)) {
    issues.push(actionListCountMessage('decision_gate.next_actions'));
  }
}

function isRecoveryOptionIncomplete(option) {
  return BUILD_GATE_RECOVERY_FIELDS.some((field) => !option[field]);
}

function checkBuildGateRecoveryOptions(gate, ctx, issues) {
  if (!BUILD_GATE_RECOVERY_REQUIRED_DECISIONS.has(ctx.decision)) return;
  const recovery = gate.recovery_options;
  if (!Array.isArray(recovery) || recovery.length !== 3) {
    issues.push('decision_gate.recovery_options는 NO_GO/PIVOT/DEFER에서 정확히 3개 필요.');
    return;
  }
  let hasGreenPath = false;
  recovery.forEach((option, index) => {
    if (isRecoveryOptionIncomplete(option)) {
      issues.push(`decision_gate.recovery_options[${index}] 필수 필드 누락.`);
    }
    if (BUILD_GATE_GREEN_DECISIONS.has(option.expected_decision_after)) {
      hasGreenPath = true;
    }
  });
  if (!hasGreenPath) {
    issues.push('decision_gate.recovery_options는 최소 1개 이상 BUILD/BUILD_WITH_CAUTION으로 돌아가는 경로를 포함해야 함.');
  }
}

export function evaluateBuildWorthinessGatePreflight(mvp, market = null, sources = {}) {
  const issues = [];
  const { gate, source, conflicts } = resolveBuildWorthinessGate(
    mvp,
    sources.stageHandoff,
    sources.dedicatedHandoff || sources.gateHandoff,
  );
  if (!gate) {
    issues.push(
      'mvp-scope.json#decision_gate 없음. Stage 4 진입 전 Build Worthiness Gate가 필요함. ' +
      'Legacy mirror(.brief2dev/handoff/build-worthiness-gate.json 또는 stage-3-handoff.json#decision_gate)도 찾지 못함.',
    );
    return issues;
  }
  for (const conflict of conflicts) {
    issues.push(conflict.message);
  }

  const ctx = collectBuildGateContext(gate, market);
  checkBuildGateDecisionEligibility(gate, source, ctx, issues);
  checkBuildGateEvidenceThresholds(ctx, issues);
  checkBuildGateBuilderOverride(ctx, issues);
  checkBuildGateContextSnapshot(gate, issues);
  checkBuildGateUserDecisionBrief(gate, issues);
  checkBuildGateRecoveryOptions(gate, ctx, issues);

  issues.push(...evaluateDecisionReadinessPreflight(mvp, market, gate));
  issues.push(...evaluateStartupMvpWorkflowPreflight(mvp));

  return issues;
}

const DECISION_READINESS_REQUIRED_KEYS = [
  'business_decision',
  'product_build_decision',
  'investment_recommendation',
  'evidence_dashboard',
  'decision_matrix',
  'go_conditions',
  'no_go_reasons',
  'gtm_plan',
  'human_decision_summary',
];
const DECISION_MATRIX_AXES = ['desirability', 'viability', 'feasibility', 'differentiation', 'gtm', 'risk'];
const NOT_FULL_GO_DECISIONS = new Set(['VALIDATION_GO', 'NO_GO', 'PIVOT', 'DEFER']);
const GATE_STOP_DECISIONS = new Set(['NO_GO', 'PIVOT', 'DEFER']);
// P8b 차분 1 — 다음-실험 관점 cross-check 용 사업결정 집합
const BUSINESS_GO_DECISIONS = new Set(['GO', 'BUILDER_OVERRIDE']);
// GTM 실험 착수와 모순되는 사업결정. DEFER 는 의도적 제외 — "결정 보류 + 검증용 GTM 실험"
// 은 정합한 검증 실험 경로(VALIDATION_GO 와 동일 정신)이므로 차단하지 않는다. NO_GO/PIVOT
// (현재 아이디어 폐기/전환) 만 실험 착수와 모순.
const GTM_GO_INCOHERENT_BUSINESS = new Set(['NO_GO', 'PIVOT']);
const GO_CONDITION_FIELDS = ['condition', 'metric', 'threshold', 'validation_method', 'timebox', 'expected_decision_after'];
const HUMAN_SUMMARY_FIELDS = ['what_we_know', 'what_we_do_not_know', 'why_not_full_go', 'recommended_next_bet', 'what_would_make_go'];

function pickReadinessEvidenceCount(readiness, gate, market, tier, summaryKey) {
  const readinessValue = readiness.evidence_counts?.[tier];
  if (readinessValue !== undefined && readinessValue !== null) return Number(readinessValue);
  const gateValue = gate?.evidence_counts?.[tier];
  if (gateValue !== undefined && gateValue !== null) return Number(gateValue);
  const marketValue = market?.evidence_summary?.[summaryKey];
  if (marketValue !== undefined && marketValue !== null) return Number(marketValue);
  return 0;
}

function collectReadinessEvidenceCounts(readiness, gate, market) {
  return {
    T1: pickReadinessEvidenceCount(readiness, gate, market, 'T1', 't1_count'),
    T2: pickReadinessEvidenceCount(readiness, gate, market, 'T2', 't2_count'),
    T3: pickReadinessEvidenceCount(readiness, gate, market, 'T3', 't3_count'),
  };
}

function checkDecisionReadinessRequiredKeys(readiness, issues) {
  for (const key of DECISION_READINESS_REQUIRED_KEYS) {
    if (!(key in readiness)) issues.push(`decision_readiness.${key} 누락.`);
  }
}

function checkDecisionReadinessAlignment(readiness, mvp, gate, counts, issues) {
  const businessDecision = readiness.business_decision;
  const productDecision = readiness.product_build_decision;
  const gateDecision = gate?.decision || mvp?.decision_gate?.decision || null;

  if (counts.T1 === 0 && businessDecision === 'GO') {
    issues.push('decision_readiness.business_decision=GO 이지만 T1 직접 사용자 행동 근거가 0건. AI-only desk research는 GO가 아니라 VALIDATION_GO/NO_GO/PIVOT/DEFER로 기록해야 함.');
  }
  if (gateDecision === 'BUILD_WITH_CAUTION' && businessDecision === 'GO') {
    issues.push('decision_gate=BUILD_WITH_CAUTION 인데 decision_readiness.business_decision=GO. 검증 부족 상태는 business GO가 아니라 VALIDATION_GO로 분리해야 함.');
  }
  if (GATE_STOP_DECISIONS.has(gateDecision) && businessDecision !== gateDecision) {
    issues.push(`decision_gate=${gateDecision} 인데 decision_readiness.business_decision=${businessDecision}. 정지/전환 결정은 두 계약이 일치해야 함.`);
  }
  if (
    businessDecision === 'VALIDATION_GO' &&
    !['BUILD_FOR_VALIDATION_ONLY', 'DO_NOT_BUILD'].includes(productDecision)
  ) {
    issues.push('business_decision=VALIDATION_GO 에서는 product_build_decision이 BUILD_FOR_VALIDATION_ONLY 또는 DO_NOT_BUILD 이어야 함.');
  }
  // T1 하드블록 (Phase 2 Tier A): 풀 빌드 권한(BUILD_NOW)은 T1 직접 고객 행동 근거 ≥ 1 이 하드 요건.
  // 기존 GO+T1 / VALIDATION_GO→product 체크의 emergent 조합이 아닌, BUILD_NOW 에 대한 단일 명시 invariant.
  // BUILDER_OVERRIDE_BUILD(명시적 builder escape, R-CM-016 8.1) 는 T1=0 에서도 허용 — 사용자가 위험을 인지하고 강행.
  // GO+BUILD_NOW+T1=0 동시 성립 시 위 GO+T1=0 체크(business 레이어)와 본 체크(product 레이어)가 둘 다 발화 —
  // 중복이 아닌 의도적 이중 레이어 강제(서로 다른 결정 필드에 대한 피드백). dedup 불필요.
  if (productDecision === 'BUILD_NOW' && counts.T1 === 0) {
    issues.push('product_build_decision=BUILD_NOW 이지만 T1 직접 고객 행동 근거가 0건. 풀 빌드 권한(BUILD_NOW)은 T1(실제 결제·예약·사용 로그 등 고객 행동) 1건 이상이 하드 요건 — T1 부재 시 BUILD_FOR_VALIDATION_ONLY(검증 트랙) 또는 명시적 builder override(BUILDER_OVERRIDE_BUILD)로만 진행.');
  }
}

/**
 * 다음-실험 관점(investment_recommendation + gtm_decision) 이 사업 결정과 정합한지 검증 (P8b 차분 1).
 *
 * 기존 checkDecisionReadinessAlignment 는 4쌍만 cross-check 하여 investment/gtm 을 미검증 →
 * business_decision=NO_GO + investment_recommendation=INVEST 같은 모순이 R-PL-003 predicate +
 * logical-integrity-checker 양쪽에서 통과 가능하던 갭을 닫는다.
 * 판정 정합성 명세표 SSOT: `.claude/skills/mvp-scoper/references/decision-readiness-protocol.md`.
 */
function checkVerdictPerspectiveAlignment(readiness, issues) {
  const businessDecision = readiness?.business_decision;
  const investment = readiness?.investment_recommendation?.recommendation;
  const gtmDecision = readiness?.gtm_plan?.gtm_decision;

  // INVEST(전액 투자)는 business_decision=GO(또는 builder escape)에서만 정합. STOP/검증 결정과 모순.
  // businessDecision 부재는 checkDecisionReadinessRequiredKeys 가 이미 flag → 여기서 중복 노이즈 회피.
  if (investment === 'INVEST' && businessDecision && !BUSINESS_GO_DECISIONS.has(businessDecision)) {
    issues.push(
      `decision_readiness.investment_recommendation=INVEST 인데 business_decision=${businessDecision}. ` +
        `전액 투자(INVEST)는 business_decision=GO 에서만 정합 — 검증 단계는 VALIDATE_ONLY, ` +
        `정지/전환은 DO_NOT_INVEST/PIVOT_INVESTIGATION/WAIT 으로 기록해야 함.`,
    );
  }

  // GTM 실험 착수(GO_TO_GTM_EXPERIMENT)는 정지/전환 사업 결정과 모순 (현재 아이디어 폐기/피벗인데 실험 착수).
  if (gtmDecision === 'GO_TO_GTM_EXPERIMENT' && GTM_GO_INCOHERENT_BUSINESS.has(businessDecision)) {
    issues.push(
      `decision_readiness.gtm_plan.gtm_decision=GO_TO_GTM_EXPERIMENT 인데 business_decision=${businessDecision}. ` +
        `정지/전환 결정에서 현재 아이디어 GTM 실험 착수는 모순 — NO_GO_TO_GTM/PIVOT_GTM 으로 기록해야 함.`,
    );
  }
}

function checkDecisionReadinessDashboard(readiness, issues) {
  const dashboard = readiness.evidence_dashboard;
  if (!Array.isArray(dashboard?.confirmed_data) || dashboard.confirmed_data.length < 1) {
    issues.push('decision_readiness.evidence_dashboard.confirmed_data 최소 1건 필요.');
  }
  if (!Array.isArray(dashboard?.missing_data) || dashboard.missing_data.length < 1) {
    issues.push('decision_readiness.evidence_dashboard.missing_data 최소 1건 필요.');
  }
}

function checkDecisionReadinessMatrix(readiness, issues) {
  const matrix = readiness.decision_matrix || {};
  const businessDecision = readiness.business_decision;
  for (const axisName of DECISION_MATRIX_AXES) {
    const axis = matrix[axisName];
    if (!axis?.status || !axis?.reasoning || !Array.isArray(axis?.evidence_refs)) {
      issues.push(`decision_readiness.decision_matrix.${axisName}는 status/reasoning/evidence_refs를 포함해야 함.`);
    }
    if (businessDecision === 'GO' && ['fail', 'unknown'].includes(axis?.status)) {
      issues.push(`business_decision=GO 이지만 decision_matrix.${axisName}.status=${axis.status}. 모든 핵심 축이 pass/mixed 이상이어야 함.`);
    }
  }
}

function isGoConditionIncomplete(condition) {
  return GO_CONDITION_FIELDS.some((field) => !condition[field]);
}

function checkDecisionReadinessGoConditions(readiness, issues) {
  const notFullGo = NOT_FULL_GO_DECISIONS.has(readiness.business_decision);
  if (notFullGo && (!Array.isArray(readiness.no_go_reasons) || readiness.no_go_reasons.length < 1)) {
    issues.push('decision_readiness.no_go_reasons 최소 1건 필요. VALIDATION_GO도 full business GO가 아닌 이유를 기록해야 함.');
  }
  if (notFullGo && (!Array.isArray(readiness.go_conditions) || readiness.go_conditions.length < 1)) {
    issues.push('decision_readiness.go_conditions 최소 1건 필요. 무엇을 만족하면 GO로 바뀌는지 기록해야 함.');
  }
  if (Array.isArray(readiness.go_conditions)) {
    readiness.go_conditions.forEach((condition, index) => {
      if (isGoConditionIncomplete(condition)) {
        issues.push(`decision_readiness.go_conditions[${index}] 필수 필드 누락.`);
      }
    });
  }
}

function checkGtmPlanCoreFields(gtm, issues) {
  if (!gtm?.gtm_decision || !gtm?.beachhead_icp || !gtm?.primary_motion) {
    issues.push('decision_readiness.gtm_plan은 gtm_decision/beachhead_icp/primary_motion을 포함해야 함.');
  }
}

function checkGtmPlanArrayFields(gtm, issues) {
  if (!Array.isArray(gtm?.channels) || gtm.channels.length < 1) {
    issues.push('decision_readiness.gtm_plan.channels 최소 1건 필요.');
  }
  if (!isActionListCountValid(gtm?.first_14_days_actions)) {
    issues.push(actionListCountMessage('decision_readiness.gtm_plan.first_14_days_actions'));
  }
  if (!Array.isArray(gtm?.success_metrics) || gtm.success_metrics.length < 1) {
    issues.push('decision_readiness.gtm_plan.success_metrics 최소 1건 필요.');
  }
}

function checkDecisionReadinessGtmPlan(readiness, issues) {
  const gtm = readiness.gtm_plan;
  checkGtmPlanCoreFields(gtm, issues);
  checkGtmPlanArrayFields(gtm, issues);
}

function checkDecisionReadinessHumanSummary(readiness, issues) {
  const summary = readiness.human_decision_summary;
  for (const key of HUMAN_SUMMARY_FIELDS) {
    if (!summary?.[key] || String(summary[key]).length < 10) {
      issues.push(`decision_readiness.human_decision_summary.${key} 누락 또는 너무 짧음.`);
    }
  }
}

// 역할 분리 NO_GO 감사 (Phase 2 Tier B) — 고위험 verdict 에서 decision_audit(반대 결정 steelman) 필수.
// 목적: AI 가 분석+판정을 동시 수행하는 self-reference 편향 보강. 같은 AI 작성이라 진정한 역할 분리는
// 아니며, (a) 반대 케이스 강제 구축 + (b) 사용자(독립 판정자) surface 가 본질 (R-CM-016 Rule 10).
const AUDIT_REQUIRED_BUSINESS = new Set(['GO', 'NO_GO']);
const AUDIT_REQUIRED_PRODUCT = new Set(['BUILD_NOW', 'BUILDER_OVERRIDE_BUILD', 'DO_NOT_BUILD']);

function checkDecisionAudit(readiness, issues) {
  const bd = readiness.business_decision;
  const pd = readiness.product_build_decision;
  if (!AUDIT_REQUIRED_BUSINESS.has(bd) && !AUDIT_REQUIRED_PRODUCT.has(pd)) return;
  const audit = readiness.decision_audit;
  // Array.isArray 명시 — 배열은 typeof 'object' + truthy 라 type guard 를 통과하므로 별도 차단
  // (없으면 "steelman_opposite 가 비었다" 오진단 메시지 — code-review HIGH).
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    issues.push(
      `고위험 결정(business_decision=${bd ?? '(미정)'} / product_build_decision=${pd ?? '(미정)'})에는 decision_audit(역할 분리 NO_GO 감사 — 반대 결정 steelman, 객체 형식)가 필수. AI self-reference 편향 보강 + 사용자 독립 판정용 (steelman_opposite + why_not_overturned 기술).`,
    );
    return;
  }
  const steel = typeof audit.steelman_opposite === 'string' ? audit.steelman_opposite.trim() : '';
  const why = typeof audit.why_not_overturned === 'string' ? audit.why_not_overturned.trim() : '';
  // 길이 임계 40/20 은 mvp-scope.schema.json#decision_audit.{steelman_opposite,why_not_overturned}.minLength 와 동기 필수.
  if (steel.length < 40) {
    issues.push(
      'decision_audit.steelman_opposite 가 비었거나 너무 짧음(<40자). 반대 결정의 가장 강한 근거를 실질적으로 기술해야 함 (placeholder/공란 금지).',
    );
  }
  if (why.length < 20) {
    issues.push(
      'decision_audit.why_not_overturned 가 비었거나 너무 짧음(<20자). steelman 에도 verdict 가 유지되는 이유(또는 뒤집힘)를 기술해야 함.',
    );
  }
}

export function evaluateDecisionReadinessPreflight(mvp, market = null, gate = null) {
  const issues = [];
  const readiness = mvp?.decision_readiness;
  if (!readiness) {
    issues.push(
      'mvp-scope.json#decision_readiness 없음. 사람이 사업 Go/No-Go를 판단할 수 있도록 business_decision, 부족 데이터, Go 조건, GTM 실험을 분리해 기록해야 함.',
    );
    return issues;
  }

  checkDecisionReadinessRequiredKeys(readiness, issues);
  const counts = collectReadinessEvidenceCounts(readiness, gate, market);
  checkDecisionReadinessAlignment(readiness, mvp, gate, counts, issues);
  checkDecisionAudit(readiness, issues);
  checkVerdictPerspectiveAlignment(readiness, issues);
  checkDecisionReadinessDashboard(readiness, issues);
  checkDecisionReadinessMatrix(readiness, issues);
  checkDecisionReadinessGoConditions(readiness, issues);
  checkDecisionReadinessGtmPlan(readiness, issues);
  checkDecisionReadinessHumanSummary(readiness, issues);

  return issues;
}

const STARTUP_MVP_OPERATING_KEYS = ['team_size', 'cadence', 'timebox', 'budget_guardrail', 'default_decision'];
const STARTUP_MVP_REQUIRED_PHASE_IDS = [
  'idea_intake',
  'evidence_sweep',
  'problem_shaping',
  'solution_shaping',
  'decision_readiness',
  'pretotype_gtm',
  'mvp_build',
  'measure_learn',
];
const STARTUP_MVP_PHASE_KEYS = [
  'id',
  'name',
  'objective',
  'founder_prompt',
  'ai_support',
  'activities',
  'artifacts',
  'evidence_required',
  'decision_rule',
  'next_if_pass',
  'next_if_fail',
];
const STARTUP_MVP_PHASE_ARRAY_KEYS = ['founder_prompt', 'ai_support', 'activities', 'artifacts', 'evidence_required'];
const STARTUP_MVP_POLICY_EXAMPLE_KEYS = ['t1_examples', 't2_examples', 't3_examples'];

function checkStartupMvpStandardBasis(workflow, issues) {
  if (!Array.isArray(workflow.standard_basis) || workflow.standard_basis.length < 3) {
    issues.push('startup_mvp_workflow.standard_basis는 업계표준 근거를 최소 3개 포함해야 함.');
    return;
  }
  workflow.standard_basis.forEach((basis, index) => {
    if (!basis.framework || !basis.source_url || !basis.principle || !basis.applied_as) {
      issues.push(`startup_mvp_workflow.standard_basis[${index}] 필수 필드 누락.`);
    }
  });
}

function checkStartupMvpOperatingMode(workflow, issues) {
  const operating = workflow.operating_mode;
  for (const key of STARTUP_MVP_OPERATING_KEYS) {
    if (!operating?.[key]) issues.push(`startup_mvp_workflow.operating_mode.${key} 누락.`);
  }
}

function checkStartupMvpPhaseEntry(phase, index, issues) {
  for (const key of STARTUP_MVP_PHASE_KEYS) {
    if (!(key in phase)) issues.push(`startup_mvp_workflow.phases[${index}].${key} 누락.`);
  }
  for (const arrayKey of STARTUP_MVP_PHASE_ARRAY_KEYS) {
    if (!Array.isArray(phase[arrayKey]) || phase[arrayKey].length < 1) {
      issues.push(`startup_mvp_workflow.phases[${index}].${arrayKey} 최소 1개 필요.`);
    }
  }
}

function checkStartupMvpPhases(workflow, issues) {
  const phases = workflow.phases;
  if (!Array.isArray(phases) || phases.length < 5) {
    issues.push('startup_mvp_workflow.phases는 최소 5단계 이상 필요.');
    return;
  }
  const phaseIds = new Set(phases.map((phase) => phase.id));
  for (const phaseId of STARTUP_MVP_REQUIRED_PHASE_IDS) {
    if (!phaseIds.has(phaseId)) {
      issues.push(`startup_mvp_workflow.phases에 ${phaseId} 단계가 필요함.`);
    }
  }
  phases.forEach((phase, index) => checkStartupMvpPhaseEntry(phase, index, issues));
}

function checkStartupMvpSupportModel(workflow, issues) {
  const support = workflow.support_model;
  if (!support?.user_assumption || String(support.user_assumption).length < 10) {
    issues.push('startup_mvp_workflow.support_model.user_assumption 누락.');
  }
  if (!Array.isArray(support?.ai_must_do) || support.ai_must_do.length < 3) {
    issues.push('startup_mvp_workflow.support_model.ai_must_do 최소 3개 필요.');
  }
  if (!Array.isArray(support?.ai_must_not_do) || support.ai_must_not_do.length < 3) {
    issues.push('startup_mvp_workflow.support_model.ai_must_not_do 최소 3개 필요.');
  }
}

function checkStartupMvpEvidencePolicy(workflow, issues) {
  const policy = workflow.evidence_policy;
  if (policy?.claim_requires_source !== true) {
    issues.push('startup_mvp_workflow.evidence_policy.claim_requires_source=true 필요.');
  }
  if (policy?.no_t1_no_business_go !== true) {
    issues.push('startup_mvp_workflow.evidence_policy.no_t1_no_business_go=true 필요.');
  }
  for (const key of STARTUP_MVP_POLICY_EXAMPLE_KEYS) {
    if (!Array.isArray(policy?.[key]) || policy[key].length < 1) {
      issues.push(`startup_mvp_workflow.evidence_policy.${key} 최소 1개 필요.`);
    }
  }
}

export function evaluateStartupMvpWorkflowPreflight(mvp) {
  const issues = [];
  const workflow = mvp?.startup_mvp_workflow;
  if (!workflow) {
    issues.push(
      'mvp-scope.json#startup_mvp_workflow 없음. 소수인원 스타트업이 바로 실행할 수 있는 업계표준 MVP 검증 워크플로우가 필요함.',
    );
    return issues;
  }

  checkStartupMvpStandardBasis(workflow, issues);
  checkStartupMvpOperatingMode(workflow, issues);
  checkStartupMvpPhases(workflow, issues);
  checkStartupMvpSupportModel(workflow, issues);
  checkStartupMvpEvidencePolicy(workflow, issues);

  return issues;
}

const STARTER_GTM_REQUIRED_SECTIONS = [
  'icp',
  'positioning',
  'channel_hypotheses',
  'messaging',
  'success_metrics',
  'next_actions',
];

function checkStarterGtmRequiredSections(starter, issues) {
  for (const section of STARTER_GTM_REQUIRED_SECTIONS) {
    if (!(section in starter)) issues.push(`starter_gtm.${section} 누락.`);
  }
}

function checkStarterGtmIcp(starter, issues) {
  if (!starter.icp?.segment || !starter.icp?.buyer_or_user || !starter.icp?.urgent_trigger) {
    issues.push('starter_gtm.icp는 segment/buyer_or_user/urgent_trigger를 모두 포함해야 함.');
  }
  if (!Array.isArray(starter.icp?.evidence_refs) || starter.icp.evidence_refs.length < 1) {
    issues.push('starter_gtm.icp.evidence_refs 최소 1개 필요.');
  }
}

function checkStarterGtmPositioning(starter, issues) {
  if (!starter.positioning?.primary_alternative || !starter.positioning?.wedge) {
    issues.push('starter_gtm.positioning은 primary_alternative와 wedge를 포함해야 함.');
  }
  if (!starter.positioning?.one_sentence || String(starter.positioning.one_sentence).length < 10) {
    issues.push('starter_gtm.positioning.one_sentence는 비전문가용 한 문장 설명이어야 함.');
  }
}

function checkStarterGtmChannelEntry(channel, index, issues) {
  if (!channel.channel || !channel.why_this_channel || !channel.evidence_tier || !channel.success_metric) {
    issues.push(`starter_gtm.channel_hypotheses[${index}] 필수 필드 누락.`);
  }
  const experiment = channel.first_experiment;
  if (
    !experiment?.experiment ||
    !experiment?.audience ||
    !experiment?.timebox ||
    !experiment?.success_threshold
  ) {
    issues.push(`starter_gtm.channel_hypotheses[${index}].first_experiment 필수 필드 누락.`);
  }
}

function checkStarterGtmChannels(starter, market, issues) {
  const channels = starter.channel_hypotheses;
  if (!Array.isArray(channels) || channels.length < 2) {
    issues.push('starter_gtm.channel_hypotheses는 최소 2개 필요.');
    return;
  }
  channels.forEach((channel, index) => checkStarterGtmChannelEntry(channel, index, issues));

  const primary = channels[0];
  const cacTier = market?.unit_economics?.cac?.evidence_tier;
  if (primary?.channel === 'paid' && !['T1', 'T2'].includes(cacTier)) {
    issues.push('starter_gtm.channel_hypotheses[0]=paid 이지만 CAC T2+ 근거가 없음. paid는 primary channel로 둘 수 없음.');
  }
}

function checkStarterGtmMessaging(starter, issues) {
  if (
    !starter.messaging?.pain_statement ||
    !starter.messaging?.promise ||
    !starter.messaging?.proof_needed
  ) {
    issues.push('starter_gtm.messaging은 pain_statement/promise/proof_needed를 모두 포함해야 함.');
  }
}

function checkStarterGtmSuccessMetrics(starter, issues) {
  if (
    !starter.success_metrics?.acquisition_metric ||
    !starter.success_metrics?.activation_metric ||
    !starter.success_metrics?.learning_metric
  ) {
    issues.push('starter_gtm.success_metrics는 acquisition/activation/learning 지표를 모두 포함해야 함.');
  }
  if (!isActionListCountValid(starter.next_actions)) {
    issues.push(actionListCountMessage('starter_gtm.next_actions'));
  }
}

export function evaluateStarterGtmPreflight(market) {
  const issues = [];
  const starter = market?.starter_gtm;
  if (!starter) {
    issues.push('market-research.json#starter_gtm 없음. Stage 3 진입 전 비마케터용 ICP/포지셔닝/채널 실험 가이드가 필요함.');
    return issues;
  }

  checkStarterGtmRequiredSections(starter, issues);
  checkStarterGtmIcp(starter, issues);
  checkStarterGtmPositioning(starter, issues);
  checkStarterGtmChannels(starter, market, issues);
  checkStarterGtmMessaging(starter, issues);
  checkStarterGtmSuccessMetrics(starter, issues);

  return issues;
}

// ═══════════════════════════════════════════════════════════════
// 1. 전제조건 검증
// ═══════════════════════════════════════════════════════════════

/**
 * 스테이지 실행 전제조건을 검증한다.
 * STAGE_MAP.requiredInputJsonFiles + getRequiredInputs() (brief2dev.yaml SSOT)에 정의된
 * 정확한 입력 파일의 존재 + 구조 유효성을 확인.
 *
 * @param {string} stageId
 * @param {string} [pipelineType] - 파이프라인 타입 (BRIEF2DEV_FULL | BRIEF2DEV_SCAFFOLD)
 * @returns {{ allowed: boolean, issues: Array<{ stage: string, error: string }> }}
 */
function collectCanRunStageInputIssues(requiredInputs, issues) {
  const missing = [];
  for (const relPath of requiredInputs) {
    const absPath = join(PROJECT_ROOT, relPath);
    if (!existsSync(absPath)) missing.push(relPath);
  }
  const missingSet = new Set(missing);

  for (const relPath of missing) {
    const classification = classifyOutputFile(relPath);
    issues.push({
      stage: classification.stageId || relPath,
      error: `${relPath.split('/').pop()} 없음`,
    });
  }

  for (const relPath of requiredInputs) {
    if (missingSet.has(relPath)) continue;
    const classification = classifyOutputFile(relPath);
    if (!classification.stageId) continue;
    const struct = validateStructure(classification.stageId);
    if (!struct.valid) {
      issues.push({ stage: classification.stageId, error: struct.error });
    }
  }
}

function collectMvpScopingPreflightIssues(issues) {
  const market = loadStageJson('market_research');
  const deepResearchIssues = evaluateDeepResearchEvidence(market);
  for (const error of deepResearchIssues.criticals) {
    issues.push({ stage: 'market_research', error });
  }
  const starterGtmIssues = evaluateStarterGtmPreflight(market);
  for (const error of starterGtmIssues) {
    issues.push({ stage: 'market_research', error });
  }
}

function collectStageSpecificPreflightIssues(stageId, issues) {
  if (stageId === 'market_research') {
    const guidanceIssues = evaluateBusinessGuidancePreflight(loadStageJson('intake'));
    for (const error of guidanceIssues) {
      issues.push({ stage: 'intake', error });
    }
    return;
  }
  if (stageId === 'mvp_scoping') {
    collectMvpScopingPreflightIssues(issues);
    return;
  }
  if (stageId === 'platform_decision') {
    const gateIssues = evaluateBuildWorthinessGatePreflight(
      loadStageJson('mvp_scoping'),
      loadStageJson('market_research'),
      {
        stageHandoff: loadHandoffJson('mvp_scoping'),
        dedicatedHandoff: loadBuildWorthinessGateHandoff(),
      },
    );
    for (const error of gateIssues) {
      issues.push({ stage: 'mvp_scoping', error });
    }
  }
}

export function canRunStage(stageId, pipelineType = null) {
  const info = STAGE_MAP.get(stageId);
  if (!info) return { allowed: false, issues: [{ stage: stageId, error: '미등록 스테이지' }] };
  if (info.order === 1) return { allowed: true, issues: [] };

  // 모드 인식: 스킵된 스테이지는 실행 불가 (scaffold에서 Phase 1 실행 방지)
  if (pipelineType && !isStageActive(stageId, pipelineType)) {
    return { allowed: false, issues: [{ stage: stageId, error: '현재 모드에서 스킵된 스테이지' }] };
  }

  // 모드 인식 입력 검증: scaffold 모드에서는 스킵된 스테이지의 산출물을 요구하지 않음
  const requiredInputs = pipelineType
    ? getRequiredInputsForMode(stageId, pipelineType)
    : getRequiredInputs(stageId);

  const issues = [];
  collectCanRunStageInputIssues(requiredInputs, issues);
  collectStageSpecificPreflightIssues(stageId, issues);

  return { allowed: issues.length === 0, issues };
}

// ── P10-B Early-Kill (autonomous mode 한정) ──

const EARLY_KILL_STAGE = 'mvp_scoping';
const NEGATIVE_RECOMMENDATIONS = new Set(['pivot', 'not_recommended']);
const NEGATIVE_GO_NO_GO = new Set(['no_go', 'pivot']);
const EARLY_KILL_EXEMPT_MODES = new Set(['builder', 'learning']);

/**
 * market-research verdict 단일 해석 (SSOT — P8b 차분 1).
 *
 * verdict 표현은 산출물 shape 변화로 3 경로가 존재한다. 우선순위(방어 fallback):
 *   1. mr.verdict — flat 표기 (legacy/alternate)
 *   2. mr.interpretation.verdict — interpretation 블록 표기
 *   3. mr.viability_score.recommendation — 스키마 표준 경로 (recommended/needs_review/pivot/not_recommended)
 *
 * R-CM-016-rule-8-1 predicate + logical-integrity-checker(checkLI2) 가 동일 체인을
 * 복제하던 것을 단일 진입점으로 통합 — precedence 변경 시 drift 차단 (동작 보존 dedup).
 * early-kill 의 resolveNegativeVerdict 는 별 목적(go_no_go_recommendation 포함)이라 분리 유지.
 *
 * @param {object|null} mr - market-research stage 산출물
 * @returns {string|undefined} verdict 문자열 (없으면 undefined)
 */
export function resolveMarketVerdict(mr) {
  return mr?.verdict || mr?.interpretation?.verdict || mr?.viability_score?.recommendation;
}

/**
 * 정규 5축 SSOT — schema(`market-research.schema.json#viability_score.components.properties`)
 * + `viability-score-rubric.md` + market-researcher SKILL.md Step 5 와 동기화 (PR #693).
 */
export const VIABILITY_AXES = [
  'market_opportunity',
  'problem_severity',
  'differentiation',
  'technical_feasibility',
  'monetization',
];

/**
 * P3 차분 2+4: viability_score 축별 evidence 정직성 강제 (단일 진입점).
 * checkLI11(logical-integrity-checker) + R-PL-001-rule-7-viability-t3-cap predicate 양쪽이 소비
 * (P8b evaluateDecisionReadinessPreflight 패턴 — 로직 중복 회피).
 *
 * 규칙 (viability-score-rubric.md SSOT): score ≥4 (강한 긍정) 축은
 * `component_evidence[axis].tier ∈ {T1,T2}` + `evidence_refs` 비어있지 않아야 한다.
 * T3-only 또는 근거 부재 → 위반 (= "T3-only 축 score ≤3 상한" 의 대우).
 *
 * opt-in-by-presence: `viability_score.component_evidence` 부재 시 빈 배열 (skip) —
 * archive/legacy 산출물 호환 (proposal "schema hard-required 금지").
 *
 * @param {object|null} mr - market-research stage 산출물
 * @returns {Array<{axis:string, score:number, tier:(string|null), refs_count:number, reason:string}>}
 */
export function evaluateViabilityAxisEvidence(mr) {
  const components = mr?.viability_score?.components;
  const evidence = mr?.viability_score?.component_evidence;
  if (!components || typeof components !== 'object') return []; // skip: 축 점수 부재
  if (!evidence || typeof evidence !== 'object') return []; // skip: opt-in-by-presence (archive 호환)
  const violations = [];
  for (const axis of VIABILITY_AXES) {
    const v = viabilityAxisEvidenceViolation(axis, components[axis], evidence[axis]);
    if (v) violations.push(v);
  }
  return violations;
}

/** 단일 축의 evidence grounding 위반 판정 (없으면 null). evaluateViabilityAxisEvidence 보조. */
function viabilityAxisEvidenceViolation(axis, score, ev) {
  if (typeof score !== 'number' || score < 4) return null; // 강한 긍정(≥4) 축만 근거 요구
  const tier = typeof ev?.tier === 'string' ? ev.tier : null;
  const refs = Array.isArray(ev?.evidence_refs) ? ev.evidence_refs : [];
  if ((tier === 'T1' || tier === 'T2') && refs.length > 0) return null; // grounded
  const tierLabel = tier === 'T3' ? 'T3(ai_estimate)' : tier || '부재';
  return {
    axis,
    score,
    tier,
    refs_count: refs.length,
    reason: `viability 축 ${axis}=${score} (≥4 강한 긍정) 인데 근거 tier=${tierLabel} + evidence_refs ${refs.length}건. T3-only 축은 score ≤3 상한 — 4-5점은 T1/T2 evidence_ref 필요 (viability-score-rubric.md SSOT, R-PL-001 Rule 7 축-수준).`,
  };
}

/** market-research 의 강한 부정 verdict 를 반환 (없으면 null). */
function resolveNegativeVerdict(mr) {
  const recommendation = mr?.viability_score?.recommendation;
  if (NEGATIVE_RECOMMENDATIONS.has(recommendation)) return recommendation;
  const goNoGo = mr?.interpretation?.go_no_go_recommendation?.verdict;
  if (NEGATIVE_GO_NO_GO.has(goNoGo)) return goNoGo;
  return null;
}

/** autonomous + non-builder/learning run 이면 early-kill 자격 (business-context 기준). */
function isAutonomousProductionRun(bc) {
  if (!bc || bc.interaction_mode?.mode !== 'autonomous') return false;
  const mode = bc.mode || bc.business?.mode;
  return !EARLY_KILL_EXEMPT_MODES.has(mode);
}

/**
 * Early-Kill 순수 판정 (I/O 없음 — 단위 테스트 가능).
 *
 * autonomous mode + production(비 builder/learning) run 에서 Stage 2 verdict 가 강한 부정이면
 * mvp_scoping 자동진행을 차단한다. dead idea 가 build 단계로 silently 흐르는 것을 방지.
 *
 * @param {object|null} businessContext - intake stage 산출물 (interaction_mode.mode + mode)
 * @param {object|null} marketResearch - market_research stage 산출물 (verdict)
 * @returns {{ kill: boolean, reason: string|null, verdict: string|null }}
 */
export function evaluateEarlyKill(businessContext, marketResearch) {
  const noKill = { kill: false, reason: null, verdict: null };
  if (!isAutonomousProductionRun(businessContext)) return noKill;

  const verdict = resolveNegativeVerdict(marketResearch);
  if (!verdict) return noKill;

  return {
    kill: true,
    verdict,
    reason:
      `Stage 2 market-research verdict = "${verdict}" (강한 부정). ` +
      `autonomous mode 에서 mvp_scoping 자동진행을 차단합니다 — dead idea 가 build 단계로 흐르는 것을 방지.`,
  };
}

/**
 * Early-Kill 게이트 (pipeline-boundary-guard B3 위임 진입점).
 *
 * 발동: targetStageId === 'mvp_scoping' + autonomous mode + production run + Stage 2 부정 verdict.
 * guided mode 는 R-CM-031 Rule 2-A Guided Checkpoint 가 이미 surface 하므로 skip.
 * builder/learning mode 는 R-CM-016 Rule 8.1 escape (LEARNING_RUN_ARTIFACT) 보존을 위해 skip.
 * fail-open (R-CM-006 Rule 2): 입력 부재/파싱 실패/판정 불가 → { kill: false }.
 *
 * @param {string} targetStageId
 * @param {string|null} pipelineType
 * @returns {{ kill: boolean, reason: string|null, verdict: string|null }}
 */
export function checkEarlyKill(targetStageId, pipelineType = null) {
  const noKill = { kill: false, reason: null, verdict: null };
  try {
    if (targetStageId !== EARLY_KILL_STAGE) return noKill;
    if (pipelineType && !isStageActive(targetStageId, pipelineType)) return noKill;
    return evaluateEarlyKill(loadStageJson('intake'), loadStageJson('market_research'));
  } catch {
    return noKill;
  }
}

/**
 * 특정 스테이지의 전제조건 파일을 3단계로 검증한다.
 * getRequiredInputs() 기반으로 정확한 입력 파일만 검증.
 *
 * L1: 파일 존재 (existsSync)
 * L2: JSON 파싱 가능 (JSON.parse)
 * L3: 비어있지 않은 객체 (Object.keys > 0)
 *
 * @param {string} stageId
 * @returns {{ valid: boolean, missing: string[], corrupted: string[] }}
 */
export function checkPrerequisiteFiles(stageId) {
  const info = STAGE_MAP.get(stageId);
  if (!info || info.order <= 1) return { valid: true, missing: [], corrupted: [] };

  const missing = [];
  const corrupted = [];

  for (const relPath of getRequiredInputs(stageId)) {
    const absPath = join(PROJECT_ROOT, relPath);
    const fileName = relPath.split('/').pop();

    if (!existsSync(absPath)) {
      missing.push(fileName);
      continue;
    }

    if (!relPath.endsWith('.json')) continue;

    try {
      const data = JSON.parse(readFileSync(absPath, 'utf-8'));
      if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
        corrupted.push(`${fileName} (빈 객체)`);
      }
    } catch {
      corrupted.push(`${fileName} (JSON 파싱 실패)`);
    }
  }

  return {
    valid: missing.length === 0 && corrupted.length === 0,
    missing,
    corrupted,
  };
}

// ═══════════════════════════════════════════════════════════════
// 2. 산출물 구조 검증
// ═══════════════════════════════════════════════════════════════

/**
 * JSON 산출물의 구조를 검증한다.
 * 파일 존재 + JSON 파싱 + 필수 키 존재 확인.
 *
 * @param {string} stageId
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateStructure(stageId) {
  const info = STAGE_MAP.get(stageId);
  if (!info?.jsonFile) return { valid: true };

  const absPath = join(getDataDir(), info.jsonFile);
  if (!existsSync(absPath)) return { valid: true };

  let data;
  try {
    data = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch {
    return { valid: false, error: `JSON 파싱 실패: ${info.jsonFile}` };
  }

  if (!data || typeof data !== 'object') {
    return { valid: false, error: `유효하지 않은 JSON: ${info.jsonFile}` };
  }

  const required = REQUIRED_KEYS[stageId];
  if (!required) return { valid: true };

  const missing = required.filter(k => !(k in data));
  if (missing.length > 0) {
    return { valid: false, error: `${info.jsonFile}: 필수 키 누락 [${missing.join(', ')}]` };
  }

  return { valid: true };
}

/**
 * 모든 존재하는 산출물의 구조를 일괄 검증한다.
 *
 * @param {string} [pipelineType] - 파이프라인 타입. 제공 시 활성 스테이지만 검증.
 * @returns {{ passed: boolean, issues: Array<{ stageId: string, error: string }> }}
 */
export function validateAllStructures(pipelineType = null) {
  const issues = [];
  for (const [stageId, info] of STAGE_MAP) {
    if (!info.jsonFile) continue;
    if (pipelineType && !isStageActive(stageId, pipelineType)) continue;
    if (!checkStageOutputs(stageId).jsonExists) continue;

    const result = validateStructure(stageId);
    if (!result.valid) {
      issues.push({ stageId, error: result.error });
    }
  }
  return { passed: issues.length === 0, issues };
}

/**
 * JSON 산출물을 JSON Schema에 대해 검증한다 (Schema-First 원칙).
 * REQUIRED_KEYS보다 깊은 검증: required 중첩, type, enum, minLength, minItems 등.
 *
 * trip-jarvis의 Contract-First Guard 개념을 brief2dev 파이프라인에 이식.
 *
 * @param {string} stageId
 * @returns {{ valid: boolean, errors: string[], schemaFound: boolean }}
 */
export function validateSchema(stageId) {
  const data = loadStageJson(stageId);
  if (!data) return { valid: true, errors: [], schemaFound: false };
  return validateStageOutput(stageId, data);
}

/**
 * 모든 존재하는 산출물을 JSON Schema에 대해 검증한다.
 *
 * @returns {{ passed: boolean, issues: Array<{ stageId: string, errors: string[] }> }}
 */
export function validateAllSchemas() {
  const issues = [];
  for (const [stageId, info] of STAGE_MAP) {
    if (!info.jsonFile) continue;
    if (!checkStageOutputs(stageId).jsonExists) continue;

    const result = validateSchema(stageId);
    if (result.schemaFound && !result.valid) {
      issues.push({ stageId, errors: result.errors });
    }
  }
  return { passed: issues.length === 0, issues };
}

// ═══════════════════════════════════════════════════════════════
// 3. Confidence 검증
// ═══════════════════════════════════════════════════════════════

/**
 * 단일 스테이지의 handoff confidence를 평가한다.
 *
 * @param {string} stageId
 * @returns {{ verdict: 'PASS'|'REVIEW'|'FAIL'|'SKIP', confidence: number, threshold: number }}
 */
const CONFIDENCE_LEVEL_SCORE = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

function resolveHandoffConfidenceScore(handoff) {
  if (typeof handoff.confidence === 'number') return handoff.confidence;
  const conf = handoff.confidence;
  if (conf && typeof conf === 'object') {
    if (typeof conf.score === 'number') return conf.score;
    const fromLevel = CONFIDENCE_LEVEL_SCORE[conf.level];
    if (fromLevel !== undefined) return fromLevel;
  }
  const legacy = handoff.result?.confidence;
  const fromLegacy = CONFIDENCE_LEVEL_SCORE[legacy];
  return fromLegacy !== undefined ? fromLegacy : 0;
}

function evaluateActiveRunStaleness(stageId, passThreshold) {
  // Cascading Invalidation (연쇄 무효화) 적용: active-run에서 상태가 completed/skipped가 아니면 FAIL
  try {
    const run = loadActiveRun();
    if (run && run.stages[stageId]) {
      const status = run.stages[stageId].status;
      if (status === 'pending' || status === 'stale') {
        return { verdict: 'FAIL', confidence: 0, threshold: passThreshold, reason: '상류 변경으로 인해 무효화(stale) 됨' };
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function evaluateConfidence(stageId) {
  const thresholds = CONFIDENCE_THRESHOLDS[stageId];
  if (!thresholds) return { verdict: 'SKIP', confidence: 0, threshold: 0 };

  const staleResult = evaluateActiveRunStaleness(stageId, thresholds.pass);
  if (staleResult) return staleResult;

  const handoff = loadHandoffJson(stageId);
  if (!handoff) return { verdict: 'SKIP', confidence: 0, threshold: 0 };

  const confidence = resolveHandoffConfidenceScore(handoff);

  if (confidence >= thresholds.pass) {
    return { verdict: 'PASS', confidence, threshold: thresholds.pass };
  }
  if (confidence >= thresholds.review) {
    return { verdict: 'REVIEW', confidence, threshold: thresholds.pass };
  }
  return { verdict: 'FAIL', confidence, threshold: thresholds.review };
}

/**
 * 특정 스테이지 실행 전, 이전 스테이지의 confidence를 평가한다.
 *
 * @param {string} targetStageId
 * @param {string} [pipelineType] - 파이프라인 타입. 제공 시 활성 스테이지만 검증.
 * @returns {{ allowed: boolean, bottleneck?: object, reviews: object[] }}
 */
export function checkPrerequisiteConfidence(targetStageId, pipelineType = null) {
  const targetInfo = STAGE_MAP.get(targetStageId);
  if (!targetInfo || targetInfo.order <= 1) return { allowed: true, reviews: [] };

  const reviews = [];
  for (const [stageId, info] of STAGE_MAP) {
    if (info.order >= targetInfo.order) break;
    // 모드 인식: 스킵된 스테이지의 confidence는 검증하지 않음
    if (pipelineType && !isStageActive(stageId, pipelineType)) continue;

    const result = evaluateConfidence(stageId);
    if (result.verdict === 'FAIL') {
      return {
        allowed: false,
        bottleneck: { stageId, ...result },
        reviews,
      };
    }
    if (result.verdict === 'REVIEW') {
      reviews.push({ stageId, ...result });
    }
  }

  return { allowed: true, reviews };
}

// ═══════════════════════════════════════════════════════════════
// 4. 교차 스테이지 정합성
// ═══════════════════════════════════════════════════════════════

/**
 * 스테이지 간 교차 정합성을 검증한다.
 *
 * @param {string} [pipelineType] - 파이프라인 타입. 제공 시 활성 스테이지만 검증.
 * @returns {{ passed: boolean, criticals: string[], warnings: string[] }}
 */
const STACK_LAYERS_TO_CHECK = ['frontend', 'backend', 'database', 'auth'];

function loadConsistencyStageData(pipelineType) {
  const active = (id) => !pipelineType || isStageActive(id, pipelineType);
  return {
    platform: active('platform_decision') ? loadStageJson('platform_decision') : null,
    stack: active('stack_selection') ? loadStageJson('stack_selection') : null,
    business: active('intake') ? loadStageJson('intake') : null,
    market: active('market_research') ? loadStageJson('market_research') : null,
    infra: active('infra_design') ? loadStageJson('infra_design') : null,
    mvp: active('mvp_scoping') ? loadStageJson('mvp_scoping') : null,
  };
}

function checkPlatformStackAlignment(platform, stack, criticals) {
  if (!platform || !stack) return;
  const p = platform.recommendation?.platform || platform.selected_platform || platform.platform;
  const s = stack.platform;
  if (p && s && p.toLowerCase() !== s.toLowerCase()) {
    criticals.push(`플랫폼 불일치: platform-decision="${p}", stack-config="${s}". /stack-selector 재실행 필요.`);
  }
}

function checkBusinessMarketPreflight(business, market, criticals, warnings) {
  if (!business || !market) return;
  const guidanceIssues = evaluateBusinessGuidancePreflight(business);
  if (guidanceIssues.length > 0) {
    criticals.push(
      `Stage 1 guided validation 갭: Stage 2가 실행되었지만 business-context가 비즈니스 초심자용 검증 루프를 완료하지 않음 — ${guidanceIssues[0]}`,
    );
  }
  const deepResearchIssues = evaluateDeepResearchEvidence(market);
  for (const issue of deepResearchIssues.criticals) {
    criticals.push(`Stage 2 deep-research 갭: ${issue}`);
  }
  for (const issue of deepResearchIssues.warnings) {
    warnings.push(`Stage 2 deep-research 주의: ${issue}`);
  }
}

function checkInfraBudget(business, infra, criticals) {
  if (!business?.constraints?.budget || !infra?.cost_estimation) return;
  const budget = parseBudget(business.constraints.budget);
  const cost = infra.cost_estimation.monthly_total || infra.cost_estimation.total_monthly;
  if (budget > 0 && typeof cost === 'number' && cost > budget) {
    criticals.push(`예산 초과: 월 비용 $${cost} > 제약 $${budget}. /infra-designer 재실행 필요.`);
  }
}

function checkStackAlternatives(stack, warnings) {
  if (!stack) return;
  for (const layer of STACK_LAYERS_TO_CHECK) {
    const layerData = stack.stack?.[layer] || stack[layer];
    const alternatives = layerData?.alternatives || layerData?.candidates || layerData?.options;
    if (Array.isArray(alternatives) && alternatives.length < 3) {
      warnings.push(`${layer} 레이어: ${alternatives.length}안만 비교 (3안 이상 권장)`);
    }
  }
}

function checkUnitEconomics(market, pipelineMode, criticals, warnings) {
  if (!market?.unit_economics?.viability_ratios) return;
  const ratio = market.unit_economics.viability_ratios.ltv_cac_ratio;
  const result = evaluateLtvCac(ratio, pipelineMode);
  if (result.severity === 'critical') criticals.push(result.message);
  else if (result.severity === 'warning') warnings.push(result.message);
}

function checkStarterGtmPreflightConsistency(market, mvp, warnings) {
  if (!market || !mvp) return;
  const starterGtmIssues = evaluateStarterGtmPreflight(market);
  if (starterGtmIssues.length > 0) {
    warnings.push(
      `Starter GTM 갭: Stage 3가 실행되었지만 Stage 2 starter_gtm이 불완전함 — ${starterGtmIssues[0]}`,
    );
  }
}

function buildMustFeatureLookup(must) {
  return {
    mustNames: new Set(must.map((f) => f.name?.toLowerCase())),
    mustIds: new Set(must.map((f) => f.id).filter(Boolean)),
  };
}

function valuesToStrings(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(valuesToStrings);
  if (typeof value === 'object') return Object.values(value).flatMap(valuesToStrings);
  return [String(value)];
}

function normalizedRequirementText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requirementLabel(req) {
  if (typeof req === 'string') return req;
  if (!req || typeof req !== 'object') return String(req || '');
  return req.required_feature || req.feature || req.name || req.text || req.description || req.requirement || req.id || '';
}

function requirementIds(req) {
  if (!req || typeof req !== 'object') return [];
  return [
    req.id,
    req.requirement_id,
    req.requirementId,
    req.code,
    req.regulatory_requirement_id,
  ].filter(Boolean).map(String);
}

function featureRequirementIds(feature) {
  return valuesToStrings([
    feature?.covers_requirement_ids,
    feature?.requirement_ids,
    feature?.regulatory_requirement_ids,
    feature?.compliance_requirement_ids,
    feature?.mapped_requirement_ids,
  ]);
}

function featureSearchText(feature) {
  return normalizedRequirementText(valuesToStrings([
    feature?.id,
    feature?.name,
    feature?.description,
    feature?.justification,
    feature?.regulatory_rationale,
    feature?.compliance_rationale,
    feature?.acceptance_criteria,
    feature?.evidence_refs,
    feature?.notes,
  ]).join(' '));
}

function requirementTokens(label) {
  return normalizedRequirementText(label)
    .split(' ')
    .filter((token) => token.length >= 3);
}

export function featureCoversRegulatoryRequirement(feature, req) {
  const label = requirementLabel(req);
  const featureText = featureSearchText(feature);
  const normalizedLabel = normalizedRequirementText(label);
  const reqIds = new Set(requirementIds(req));
  const featureIds = new Set(featureRequirementIds(feature));
  const idMatch = [...reqIds].some((id) => featureIds.has(id));
  const textMatch = normalizedLabel.length > 0 && featureText.includes(normalizedLabel);
  const tokens = requirementTokens(label);
  const tokenMatch = tokens.length > 0 && tokens.every((token) => featureText.includes(token));

  if (textMatch || tokenMatch) return idMatch ? 'id_with_text' : 'text';
  if (idMatch) return 'id_only';
  return null;
}

function checkPricingFeatureMapping(mvp, warnings) {
  const required = mvp?.pricing_hypothesis?.mvp_impact?.features_required_by_pricing;
  if (!required || !mvp?.features?.must) return;
  const { mustNames, mustIds } = buildMustFeatureLookup(mvp.features.must);
  for (const reqFeature of required) {
    const lower = reqFeature.toLowerCase();
    if (!mustNames.has(lower) && !mustIds.has(reqFeature)) {
      warnings.push(`가격→Must 갭: "${reqFeature}"가 pricing_hypothesis에서 요구되지만 features.must에 없음.`);
    }
  }
}

function checkGtmFeatureMapping(mvp, warnings) {
  const required = mvp?.gtm_hypothesis?.mvp_features_required;
  if (!required || !mvp?.features?.must) return;
  const { mustNames, mustIds } = buildMustFeatureLookup(mvp.features.must);
  for (const req of required) {
    const fid = req.maps_to_feature_id;
    const fname = req.feature?.toLowerCase();
    if (fid && !mustIds.has(fid) && fname && !mustNames.has(fname)) {
      warnings.push(`GTM→Must 갭: "${req.feature}" (${fid})가 gtm_hypothesis에서 요구되지만 features.must에 없음.`);
    }
  }
}

function checkRegulationFeatureMapping(market, mvp, pipelineMode, warnings) {
  const regulations = market?.regulatory_landscape?.applicable_regulations;
  if (!regulations || !mvp?.features?.must) return;
  for (const reg of regulations) {
    if (shouldSkipRegulation(pipelineMode, reg)) continue;
    const reqFeatures = reg.mvp_impact?.required_features || [];
    for (const rf of reqFeatures) {
      const matches = mvp.features.must.map((feature) => featureCoversRegulatoryRequirement(feature, rf)).filter(Boolean);
      if (matches.some((match) => match === 'text' || match === 'id_with_text')) continue;
      const label = requirementLabel(rf);
      if (matches.includes('id_only')) {
        warnings.push(
          `규제→Must 검토: "${label}"는 ${reg.regulation} 요구사항 ID 매핑은 있으나 feature 텍스트/근거에서 의미 근거를 확인하지 못함.`,
        );
      } else {
        warnings.push(`규제→Must 갭: "${label}"가 ${reg.regulation} 준수에 필요하지만 features.must에 없음.`);
      }
    }
  }
}

function checkValidationReadinessPlan(mvp, warnings) {
  if (!mvp?.validation_readiness) return;
  const plan = mvp.validation_readiness.post_build_validation_plan;
  if (!Array.isArray(plan) || plan.length === 0) {
    warnings.push('검증 준비도 갭: post_build_validation_plan이 비어있음. 최소 1건의 빌드 후 검증 계획 필요.');
  }
}

function checkConstraintTimelinePropagation(business, mvp, warnings) {
  if (!business?.constraints || !mvp?.mvp_summary) return;
  const constraintTimeline = business.constraints.timeline;
  const mvpTimeline = mvp.mvp_summary.timeline_estimate;
  if (!constraintTimeline || !mvpTimeline) return;
  const timelineWeeks = parseTimelineToWeeks(constraintTimeline);
  const mvpWeeks = parseTimelineToWeeks(mvpTimeline);
  if (timelineWeeks > 0 && mvpWeeks > 0 && mvpWeeks > timelineWeeks * 1.5) {
    warnings.push(
      `타임라인 전파 불일치: MVP 추정 ${mvpWeeks}주 > 제약 ${timelineWeeks}주의 150%. 범위 축소 검토.`,
    );
  }
}

function sumComplianceCosts(regulations) {
  let total = 0;
  for (const reg of regulations) {
    if (reg.compliance_cost_estimate?.monthly) {
      total += reg.compliance_cost_estimate.monthly;
    }
  }
  return total;
}

function checkTotalOperatingCost(business, market, infra, warnings) {
  const regulations = market?.regulatory_landscape?.applicable_regulations;
  if (!regulations || !infra?.cost_estimation) return;
  const complianceCost = sumComplianceCosts(regulations);
  if (complianceCost === 0 || !business?.constraints?.budget) return;
  const budget = parseBudget(business.constraints.budget);
  const infraCost = infra.cost_estimation.monthly_total || infra.cost_estimation.total_monthly || 0;
  const totalCost = infraCost + complianceCost;
  if (budget > 0 && totalCost > budget) {
    warnings.push(
      `총 운영 비용 초과: 인프라 $${infraCost} + 규제 준수 $${complianceCost} = $${totalCost} > 예산 $${budget}.`,
    );
  }
}

export function checkConsistency(pipelineType = null) {
  const criticals = [];
  const warnings = [];
  const { platform, stack, business, market, infra, mvp } = loadConsistencyStageData(pipelineType);
  const pipelineMode = getPipelineMode();

  checkPlatformStackAlignment(platform, stack, criticals);
  checkBusinessMarketPreflight(business, market, criticals, warnings);
  checkInfraBudget(business, infra, criticals);
  checkStackAlternatives(stack, warnings);
  checkUnitEconomics(market, pipelineMode, criticals, warnings);
  checkStarterGtmPreflightConsistency(market, mvp, warnings);
  checkPricingFeatureMapping(mvp, warnings);
  checkGtmFeatureMapping(mvp, warnings);
  checkRegulationFeatureMapping(market, mvp, pipelineMode, warnings);
  checkValidationReadinessPlan(mvp, warnings);
  checkConstraintTimelinePropagation(business, mvp, warnings);
  checkTotalOperatingCost(business, market, infra, warnings);

  // ── Native Process Fusion: scaffold documentation + regression readiness ──
  // output-gate SKILL.md의 Major checks를 코드 경로로 연결한다.
  const fusion = checkOutputGateNativeProcessFusion(getScaffoldDir(), mvp);
  warnings.push(...fusion.warnings);

  return { passed: criticals.length === 0, criticals, warnings };
}

function parseTimelineToWeeks(timeline) {
  if (typeof timeline === 'number') return timeline;
  if (typeof timeline !== 'string') return 0;
  const weekMatch = timeline.match(/(\d+)\s*(?:주|week|weeks|w)/i);
  if (weekMatch) return parseInt(weekMatch[1], 10);
  const monthMatch = timeline.match(/(\d+)\s*(?:개월|month|months|m)/i);
  if (monthMatch) return parseInt(monthMatch[1], 10) * 4;
  // brief2dev 제약 조건 정규화 값
  const mapping = { sprint: 2, month: 8, quarter: 20, long: 32 };
  return mapping[timeline.toLowerCase()] || 0;
}

function parseBudget(budget) {
  if (typeof budget === 'number') return budget;
  if (typeof budget !== 'string') return 0;
  const match = budget.match(/\$?\s*(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

// ═══════════════════════════════════════════════════════════════
// 5. 콘텐츠 품질 검증
// ═══════════════════════════════════════════════════════════════

/**
 * 모든 파이프라인 산출물의 콘텐츠 품질을 검증한다.
 *
 * @returns {{ passed: boolean, issues: Array<{ stageId: string, description: string }> }}
 */
function loadStageContentJson(info) {
  if (!info.jsonFile) return null;
  const absPath = join(getDataDir(), info.jsonFile);
  if (!existsSync(absPath)) return null;
  try {
    const data = JSON.parse(readFileSync(absPath, 'utf-8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function checkStagePlaceholderPatterns(stageId, info, data, issues) {
  for (const { path, value } of extractStrings(data)) {
    for (const qp of QUALITY_PATTERNS) {
      if (qp.pattern.test(value)) {
        issues.push({ stageId, description: `${info.jsonFile}.${path}: ${qp.description}` });
      }
    }
  }
  for (const field of detectEmptyValues(data)) {
    issues.push({ stageId, description: `${info.jsonFile}.${field}: 값이 비어있음` });
  }
}

function checkStageEvidenceMinimum(stageId, info, data, issues) {
  if (stageId !== 'stack_selection' && stageId !== 'market_research') return;
  if (!data.evidence_summary) return;
  const { t1_count = 0, t2_count = 0 } = data.evidence_summary;
  const t2Plus = t1_count + t2_count;
  const minRequired = stageId === 'stack_selection' ? 3 : 1;
  if (t2Plus < minRequired) {
    issues.push({
      stageId,
      description: `${info.jsonFile}: T2+ 증거 ${t2Plus}건 < 최소 ${minRequired}건. AI 추정만으로 구성된 산출물은 허용되지 않음.`,
    });
  }
}

function checkMarketDeepResearchContent(stageId, data, issues) {
  if (stageId !== 'market_research') return;
  const deepResearchIssues = evaluateDeepResearchEvidence(data);
  for (const description of deepResearchIssues.criticals) {
    issues.push({ stageId, description: `market-research.json: ${description}` });
  }
}

function checkScaffoldStackDecisionsContent(issues) {
  const stackDecisionsPath = join(getDataDir(), 'stack-decisions.json');
  if (!existsSync(stackDecisionsPath)) return;
  let sd;
  try {
    sd = JSON.parse(readFileSync(stackDecisionsPath, 'utf-8'));
  } catch {
    return;
  }
  if (sd.evidence_summary) {
    const { t1_count = 0, t2_count = 0 } = sd.evidence_summary;
    if (t1_count + t2_count < 3) {
      issues.push({
        stageId: 'scaffolding',
        description: `stack-decisions.json: T2+ 증거 ${t1_count + t2_count}건 < 최소 3건. scaffold 모드에서도 리서치 근거 필수.`,
      });
    }
  } else if (sd.research_evidence === undefined) {
    issues.push({
      stageId: 'scaffolding',
      description: `stack-decisions.json: research_evidence 필드 누락. 리서치 없는 스택 결정은 허용되지 않음.`,
    });
  }
}

export function checkContentQuality() {
  const issues = [];

  for (const [stageId, info] of STAGE_MAP) {
    const data = loadStageContentJson(info);
    if (!data) continue;
    checkStagePlaceholderPatterns(stageId, info, data, issues);
    checkStageEvidenceMinimum(stageId, info, data, issues);
    checkMarketDeepResearchContent(stageId, data, issues);
  }

  checkScaffoldStackDecisionsContent(issues);

  return { passed: issues.length === 0, issues };
}

function extractStringsFromArray(arr, path, depth) {
  const results = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item === 'string' && item.length > 0) {
      results.push({ path: `${path}[${i}]`, value: item });
    } else if (typeof item === 'object' && item !== null) {
      results.push(...extractStrings(item, `${path}[${i}]`, depth + 1));
    }
  }
  return results;
}

function extractStrings(obj, prefix = '', depth = 0) {
  const results = [];
  if (depth > 3 || !obj || typeof obj !== 'object') return results;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string' && value.length > 0) {
      results.push({ path, value });
    } else if (Array.isArray(value)) {
      results.push(...extractStringsFromArray(value, path, depth));
    } else if (typeof value === 'object' && value !== null) {
      results.push(...extractStrings(value, path, depth + 1));
    }
  }
  return results;
}

function isLegitEmptyOrMetadata(key, path) {
  return METADATA_FIELDS.has(key) || LEGIT_EMPTY_PATHS.has(path);
}

function isLeafEmptyValue(value) {
  if (value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function detectEmptyValues(obj, prefix = '', depth = 0) {
  const emptyFields = [];
  if (depth > 3 || !obj || typeof obj !== 'object') return emptyFields;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isLegitEmptyOrMetadata(key, path)) continue;

    if (isLeafEmptyValue(value)) {
      emptyFields.push(path);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      emptyFields.push(...detectEmptyValues(value, path, depth + 1));
    }
  }
  return emptyFields;
}

// ═══════════════════════════════════════════════════════════════
// 6. 하위 스테이지 영향
// ═══════════════════════════════════════════════════════════════

/**
 * 변경된 스테이지 이후의 모든 스테이지를 반환한다.
 * brief2dev은 선형 파이프라인이므로, 이후 모든 스테이지가 영향받는다.
 *
 * @param {string} changedStageId
 * @returns {string[]}
 */
export function getAffectedStages(changedStageId) {
  const info = STAGE_MAP.get(changedStageId);
  if (!info) return [];

  return [...STAGE_MAP.entries()]
    .filter(([_, meta]) => meta.order > info.order)
    .map(([id]) => id);
}

// ═══════════════════════════════════════════════════════════════
// 7. Handoff 검증
// ═══════════════════════════════════════════════════════════════

/**
 * 산출물이 있는 스테이지에 handoff도 있는지 검증한다.
 *
 * @returns {{ passed: boolean, missing: string[] }}
 */
export function checkHandoffCompleteness(pipelineType = null) {
  const missing = [];
  for (const [stageId, info] of STAGE_MAP) {
    if (!info.jsonFile) continue;
    // 모드 인식: 스킵된 스테이지의 handoff는 검증하지 않음
    if (pipelineType && !isStageActive(stageId, pipelineType)) continue;
    const outputs = checkStageOutputs(stageId);
    if (outputs.jsonExists && !outputs.handoffExists) {
      missing.push(stageId);
    }
  }
  return { passed: missing.length === 0, missing };
}

/**
 * Handoff JSON의 필수 필드를 검증한다 (handoff.schema.json SSOT).
 *
 * @param {Object} handoffData
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateHandoffStructure(handoffData) {
  const HANDOFF_REQUIRED = ['schema_version', 'stage', 'stage_number', 'status', 'confidence', 'assumptions', 'open_questions'];
  if (!handoffData || typeof handoffData !== 'object') {
    return { valid: false, missing: HANDOFF_REQUIRED };
  }
  const missing = HANDOFF_REQUIRED.filter(k => !(k in handoffData));
  // confidence 객체의 필수 서브필드 검증
  if (handoffData.confidence && typeof handoffData.confidence === 'object') {
    if (!('level' in handoffData.confidence)) missing.push('confidence.level');
    if (!('score' in handoffData.confidence)) missing.push('confidence.score');
  }
  return { valid: missing.length === 0, missing };
}
