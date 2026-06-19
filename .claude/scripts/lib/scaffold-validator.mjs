#!/usr/bin/env node
/**
 * scaffold-validator.mjs — Post-Deployment Scaffold Validation Engine
 *
 * scaffold-deploy.mjs 배포 완료 후, scaffold-manifest 대비 결정론적 검증을 수행한다.
 * AI 해석이 아닌 스키마/매니페스트 기반 기계적 검증으로 정합성을 보장.
 *
 * 검증 항목:
 *   1. 필수 파일 존재 (scaffold-manifest.required_files)
 *   2. 필수 디렉토리 존재 (scaffold-manifest.required_directories)
 *   3. JSON 스키마 유효성 (scaffold-manifest.json_schema_validations)
 *   4. 스킬 배포율 (deployed-skills.json SSOT 대비)
 *   5. Hook 와이어링 완전성 (settings.json ↔ hooks/ 파일)
 *   6. 스킬 계약 충족 가능성 (skill-contracts.json)
 *
 * Usage:
 *   import { validateScaffold } from './scaffold-validator.mjs';
 *   const report = validateScaffold(scaffoldDir, { platform: 'web-nextjs' });
 *
 * Zero external dependencies (Node.js built-ins only).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { rewriteSinglePath } from './template-engine.mjs';
import { resolveStackDependencies } from './stack-dependency-resolver.mjs';

/**
 * 단일 REQUIRED_FILES 항목에 대해 포인터-인지 content 검사를 수행한다.
 *
 * 1. 파일 부재 → FAIL/req.severity
 * 2. 포인터 해석 1-hop:
 *    trimmed 전체가 /^:?@(AGENTS|CLAUDE)\.md$/ 이면 대상 파일 1회 follow.
 *    대상도 pure 포인터이면 순환 = FAIL/critical (복구 명령 포함).
 * 3. 해석된 content의 content_contains 마커:
 *    전부 누락 = FAIL/critical (본문 통째 소실 의심)
 *    일부 누락 = WARN/major (기존 동작 보존)
 * 4. throw 금지 (fail-open)
 *
 * @param {string} scaffoldDir
 * @param {{ path: string, severity: string, description: string, content_contains?: string[] }} req
 * @returns {{ status: 'PASS'|'WARN'|'FAIL', severity: string, message: string }}
 */
export function checkRequiredFile(scaffoldDir, req) {
  const fullPath = join(scaffoldDir, req.path);
  if (!existsSync(fullPath)) {
    return { status: 'FAIL', severity: req.severity, message: `필수 파일 누락: ${req.description}` };
  }

  if (!req.content_contains || req.content_contains.length === 0) {
    return { status: 'PASS', severity: req.severity, message: req.description };
  }

  let content;
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    // fail-open: unreadable but exists → PASS
    return { status: 'PASS', severity: req.severity, message: req.description };
  }

  const POINTER_RE = /^:?@(AGENTS|CLAUDE)\.md$/;
  // 포인터 해석은 CLAUDE.md/AGENTS.md 항목에만 — DESIGN.md 등 타 항목이 포인터 내용을 가지면 false PASS 위험
  const pointerEligible = req.path === 'CLAUDE.md' || req.path === 'AGENTS.md';
  if (pointerEligible && POINTER_RE.test(content.trim())) {
    // 1-hop pointer resolution
    const targetName = content.trim().replace(/^:?@/, '');
    const targetPath = join(scaffoldDir, targetName);
    if (!existsSync(targetPath)) {
      return { status: 'FAIL', severity: 'critical', message: `포인터 대상 파일 미존재: ${targetName}` };
    }
    let targetContent;
    try {
      targetContent = readFileSync(targetPath, 'utf-8');
    } catch {
      return { status: 'PASS', severity: req.severity, message: req.description };
    }
    if (POINTER_RE.test(targetContent.trim())) {
      return {
        status: 'FAIL',
        severity: 'critical',
        message: `순환 포인터 검출 (${req.path} ↔ ${targetName}). 복구: cp .claude/templates/CLAUDE.md.golden CLAUDE.md && printf ':@CLAUDE.md\\n' > AGENTS.md`,
      };
    }
    content = targetContent;
  }

  const missing = req.content_contains.filter((s) => !content.includes(s));
  if (missing.length === req.content_contains.length) {
    return {
      status: 'FAIL',
      severity: 'critical',
      message: `필수 문자열 전부 누락 (본문 소실 의심): ${missing.join(', ')}. 복구: cp .claude/templates/CLAUDE.md.golden CLAUDE.md`,
    };
  }
  if (missing.length > 0) {
    return { status: 'WARN', severity: 'major', message: `필수 문자열 누락: ${missing.join(', ')}` };
  }
  return { status: 'PASS', severity: req.severity, message: req.description };
}

// ═══════════════════════════════════════════════════════════════
// Core Validation Engine
// ═══════════════════════════════════════════════════════════════

/**
 * scaffold 디렉토리를 검증하고 구조화된 리포트를 반환한다.
 *
 * @param {string} scaffoldDir - scaffold 루트 디렉토리
 * @param {object} options
 * @param {string} options.platform - 플랫폼 ID (예: 'web-nextjs')
 * @param {string} [options.referencesDir] - references 디렉토리 경로
 * @param {string} [options.schemasDir] - schemas 디렉토리 경로
 * @returns {ValidationReport}
 */
export function validateScaffold(scaffoldDir, options = {}) {
  const report = createReport();

  // Phase 1: Required Files
  validateRequiredFiles(scaffoldDir, report);

  // Phase 2: Required Directories
  validateRequiredDirectories(scaffoldDir, report);

  // Phase 3: JSON Schema Validations (structural only — no ajv dependency)
  validateJsonStructure(scaffoldDir, report);

  // Phase 3.25: Answer Grounding Gate contract
  validateAnswerGrounding(scaffoldDir, report);

  // Phase 3.3: Beginner Guidance contract
  validateBeginnerGuidance(scaffoldDir, report);

  // Phase 3.4: Decision Register (R13 — 파이프라인 기각 맥락 전달, production_seed 전용 WARN)
  validateDecisionRegister(scaffoldDir, report);

  // Phase 3.5: DESIGN.md SSOT structure
  validateDesignMd(scaffoldDir, report);

  // Phase 4: Skill Deployment Rate
  if (options.referencesDir) {
    validateSkillDeployment(scaffoldDir, options.referencesDir, report);
  }

  // Phase 5: Hook Wiring Completeness
  validateHookWiring(scaffoldDir, report);

  // Phase 6: Skill Contract Satisfiability
  if (options.referencesDir) {
    validateSkillContracts(scaffoldDir, options.referencesDir, report);
  }

  // Phase 7: Template Context Injection
  validateTemplateContext(scaffoldDir, report);

  // Phase 8: Skill Template Variable Resolution (런타임 검증)
  validateTemplateVariableResolution(scaffoldDir, report);

  // Phase 9: Package.json Dependency Completeness (런타임 검증)
  validateDependencyCompleteness(scaffoldDir, report);

  // Phase 10: project-config.json Commands Executability (런타임 검증)
  validateCommandsExecutability(scaffoldDir, report);

  // Phase 11: Skill Circular Dependency Detection (런타임 검증)
  if (options.referencesDir) {
    validateSkillCircularDependencies(scaffoldDir, options.referencesDir, report);
  }

  // Phase 12: Stack-config ↔ package.json 의존성 정렬 (런타임 검증, 카탈로그 필요)
  if (options.referencesDir) {
    validateStackDependencyAlignment(scaffoldDir, options.referencesDir, report);
  }

  // Compute summary
  report.summary = computeSummary(report);

  return report;
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: Required Files
// ═══════════════════════════════════════════════════════════════

export const REQUIRED_FILES = [
  { path: 'project-config.json', severity: 'critical', description: 'WHERE/HOW SSOT' },
  { path: 'project-brief.json', severity: 'critical', description: 'WHAT/WHY SSOT' },
  { path: 'DESIGN.md', severity: 'critical', description: 'VISUAL SSOT', content_contains: ['## Overview', '## Colors', '## Typography', '## Components'] },
  { path: 'CLAUDE.md', severity: 'critical', description: 'AI 가이드라인', content_contains: ['feature-pilot', 'project-config.json', 'Answer Grounding Gate'] },
  { path: 'Makefile', severity: 'critical', description: '품질 게이트', content_contains: ['q.check'] },
  { path: '.claude/settings.json', severity: 'critical', description: 'Hook 와이어링' },
  { path: '.gitignore', severity: 'major', description: 'Git 제외 패턴' },
  { path: '.env.example', severity: 'major', description: '환경 변수 템플릿' },
  { path: 'docs/brief2dev/discovery-index.json', severity: 'major', description: 'Discovery 라우팅' },
  { path: 'docs/brief2dev/assumptions-tracker.json', severity: 'major', description: '가정 추적' },
  { path: 'docs/brief2dev/decision-dashboard.json', severity: 'major', description: '창업자 의사결정 대시보드' },
  { path: 'scripts/decision-check.mjs', severity: 'major', description: '의사결정 게이트 실행기' },
  { path: 'scripts/decision-record.mjs', severity: 'major', description: '사용자 결정 기록기' },
  { path: '.claude/rules/MANIFEST.json', severity: 'major', description: 'Rules MANIFEST' },
  { path: '.claude/agents/MANIFEST.json', severity: 'major', description: 'Agents MANIFEST' },
  { path: '.claude/contexts/MANIFEST.json', severity: 'major', description: 'Contexts MANIFEST' },
  { path: 'docs/design/tokens/design-tokens.css', severity: 'major', description: 'DESIGN.md derived CSS tokens' },
  { path: '.mcp.json', severity: 'major', description: 'MCP 서버 설정 (mcp-catalog selection)' },
];

function validateRequiredFiles(scaffoldDir, report) {
  for (const req of REQUIRED_FILES) {
    const result = checkRequiredFile(scaffoldDir, req);
    report.checks.push({
      phase: 'required_files',
      status: result.status,
      severity: result.severity,
      path: req.path,
      message: result.message,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: Required Directories
// ═══════════════════════════════════════════════════════════════

const REQUIRED_DIRS = [
  { path: '.claude/skills', severity: 'critical', description: '스킬 에코시스템', min_files: 10 },
  { path: '.claude/hooks', severity: 'critical', description: 'Guard Hook', min_files: 5 },
  { path: '.claude/rules', severity: 'major', description: '코딩 규칙' },
  { path: '.claude/agents', severity: 'major', description: '에이전트' },
  { path: '.claude/scripts/lib', severity: 'major', description: '공유 스크립트' },
  { path: '.claude/pipelines', severity: 'major', description: '파이프라인 YAML' },
  { path: 'docs/brief2dev/stage-outputs', severity: 'major', description: 'Phase 1 산출물' },
  { path: 'docs/brief2dev/reports', severity: 'info', description: 'Phase 1 리포트' },
  { path: 'docs/design', severity: 'major', description: 'Design artifacts' },
  { path: 'docs/design/tokens', severity: 'major', description: 'Derived design tokens' },
  { path: 'data/schemas/stage-output', severity: 'major', description: 'Stage Output 스키마' },
];

function validateRequiredDirectories(scaffoldDir, report) {
  for (const req of REQUIRED_DIRS) {
    const fullPath = join(scaffoldDir, req.path);
    const exists = existsSync(fullPath) && statSync(fullPath).isDirectory();

    if (!exists) {
      report.checks.push({
        phase: 'required_directories',
        status: 'FAIL',
        severity: req.severity,
        path: req.path,
        message: `필수 디렉토리 누락: ${req.description}`,
      });
      continue;
    }

    if (req.min_files) {
      const count = countFilesRecursive(fullPath);
      if (count < req.min_files) {
        report.checks.push({
          phase: 'required_directories',
          status: 'WARN',
          severity: 'major',
          path: req.path,
          message: `파일 수 부족: ${count}/${req.min_files} (${req.description})`,
        });
        continue;
      }
    }

    report.checks.push({
      phase: 'required_directories',
      status: 'PASS',
      severity: req.severity,
      path: req.path,
      message: req.description,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 3: JSON Structure Validation
// ═══════════════════════════════════════════════════════════════

const JSON_VALIDATIONS = [
  { file: 'project-config.json', required_keys: ['project_name', 'platform', 'paths', 'conventions', 'commands'] },
  {
    file: 'project-brief.json',
    required_keys: [
      'schema_version',
      'project',
      'mvp',
      'architecture',
      'answer_grounding',
      'answer_grounding.evidence.source_refs',
      'answer_grounding.answer_policy.claim_requires_source',
      'business_advisory',
      'business_advisory.recommendations',
      'business_advisory.next_best_actions',
      'business_advisory.answer_policy.claim_requires_source',
      'beginner_guidance',
      'beginner_guidance.next_steps',
      'beginner_guidance.correction_triggers',
      'beginner_guidance.answer_policy.correct_wrong_direction',
    ],
  },
  { file: 'docs/brief2dev/discovery-index.json', required_keys: ['schema_version', 'skill_bindings'] },
  { file: 'docs/brief2dev/assumptions-tracker.json', required_keys: ['schema_version'] },
  {
    file: 'docs/brief2dev/decision-dashboard.json',
    required_keys: [
      'schema_version',
      'operating_model.mode',
      'decision_state.business_decision',
      'decision_state.product_build_decision',
      'next_required_decision',
      'beginner_guidance.correction_triggers',
      'validation_actions',
      'gates.strict_check_command',
    ],
  },
  { file: '.claude/settings.json', required_keys: ['hooks'] },
];

function validateJsonStructure(scaffoldDir, report) {
  for (const val of JSON_VALIDATIONS) {
    const fullPath = join(scaffoldDir, val.file);
    if (!existsSync(fullPath)) continue; // already caught by Phase 1

    try {
      const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
      const missingKeys = val.required_keys.filter(k => {
        const keys = k.split('.');
        let obj = data;
        for (const key of keys) {
          if (obj == null || typeof obj !== 'object' || !(key in obj)) return true;
          obj = obj[key];
        }
        return false;
      });

      if (missingKeys.length > 0) {
        report.checks.push({
          phase: 'json_structure',
          status: 'FAIL',
          severity: 'critical',
          path: val.file,
          message: `필수 키 누락: ${missingKeys.join(', ')}`,
        });
      } else {
        report.checks.push({
          phase: 'json_structure',
          status: 'PASS',
          severity: 'critical',
          path: val.file,
          message: `구조 검증 통과 (${val.required_keys.length} keys)`,
        });
      }
    } catch (e) {
      report.checks.push({
        phase: 'json_structure',
        status: 'FAIL',
        severity: 'critical',
        path: val.file,
        message: `JSON 파싱 실패: ${e.message}`,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 3.25: Answer Grounding Gate Contract
// ═══════════════════════════════════════════════════════════════

function validateAnswerGrounding(scaffoldDir, report) {
  const briefPath = join(scaffoldDir, 'project-brief.json');
  if (!existsSync(briefPath)) return; // Required files phase already reports it.

  try {
    const brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
    const mode = brief.generation_mode || 'full_analysis';
    const grounding = brief.answer_grounding;

    if (!grounding || typeof grounding !== 'object') {
      report.checks.push({
        phase: 'answer_grounding',
        status: mode === 'scaffold' ? 'WARN' : 'FAIL',
        severity: mode === 'scaffold' ? 'major' : 'critical',
        path: 'project-brief.json#answer_grounding',
        message: 'answer_grounding 계약 누락',
      });
      return;
    }

    const evidence = grounding.evidence || {};
    const persona = grounding.primary_persona || {};
    const sourceRefs = Array.isArray(evidence.source_refs) ? evidence.source_refs.filter(Boolean) : [];
    const counts = evidence.counts || {};
    const policy = grounding.answer_policy || {};
    const issues = [];

    if (mode !== 'scaffold') {
      if (!grounding.target_segment) issues.push('target_segment');
      if (!persona.name) issues.push('primary_persona.name');
      if (!persona.jtbd && !grounding.jtbd) issues.push('primary_persona.jtbd');
      if (!grounding.current_alternative) issues.push('current_alternative');
      if (sourceRefs.length < 3) issues.push('evidence.source_refs>=3');
    }

    if (policy.claim_requires_source !== true) issues.push('answer_policy.claim_requires_source=true');
    if (policy.no_t1_no_business_go !== true) issues.push('answer_policy.no_t1_no_business_go=true');
    if (policy.answer_from_context_first !== true) issues.push('answer_policy.answer_from_context_first=true');

    const confidenceCap = Number(evidence.confidence_cap);
    if ((counts.T1 || 0) === 0 && Number.isFinite(confidenceCap) && confidenceCap > 0.7) {
      issues.push('confidence_cap<=0.7 when T1=0');
    }

    if (issues.length > 0) {
      report.checks.push({
        phase: 'answer_grounding',
        status: 'FAIL',
        severity: 'critical',
        path: 'project-brief.json#answer_grounding',
        message: `근거 계약 불완전: ${issues.join(', ')}`,
      });
      return;
    }

    report.checks.push({
      phase: 'answer_grounding',
      status: 'PASS',
      severity: 'critical',
      path: 'project-brief.json#answer_grounding',
      message: `근거 계약 확인: status=${grounding.status || 'unknown'}, strongest=${evidence.strongest_tier || 'unknown'}, refs=${sourceRefs.length}`,
    });
  } catch (e) {
    report.checks.push({
      phase: 'answer_grounding',
      status: 'FAIL',
      severity: 'critical',
      path: 'project-brief.json',
      message: `answer_grounding 검증 실패: ${e.message}`,
    });
  }
}

/**
 * decision_register(R13 — 파이프라인 기각 맥락 전달) 강제 대상 판정.
 * production_seed 만 대상 — full_analysis 는 legacy 호환 모드, scaffold 는 Phase 1 데이터 부재라
 * 비어있는 것이 정상. production_seed 는 Phase 1~6 산출물을 요구하므로 decision_register 가
 * 비어있으면 기각 맥락이 생성 프로젝트로 전달되지 않은 것(silently-dead 신호) → WARN.
 * @param {string} mode - project-brief.generation_mode
 * @param {object} brief - project-brief 객체
 * @returns {string[]} issue 문자열 (0개 = 위반 없음)
 */
export function decisionRegisterIssues(mode, brief) {
  if (mode !== 'production_seed') return [];
  const register = brief && Array.isArray(brief.decision_register) ? brief.decision_register : [];
  const nonEmpty = register.filter(
    (d) => d && typeof d === 'object' && typeof d.decision === 'string' && d.decision.trim(),
  );
  if (nonEmpty.length === 0) {
    return ['decision_register (파이프라인 기각 맥락 — R13 누수 차단)'];
  }
  return [];
}

function validateDecisionRegister(scaffoldDir, report) {
  const briefPath = join(scaffoldDir, 'project-brief.json');
  if (!existsSync(briefPath)) return; // Required files phase already reports it.

  try {
    const brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
    const mode = brief.generation_mode || 'full_analysis';
    const issues = decisionRegisterIssues(mode, brief);
    if (issues.length > 0) {
      report.checks.push({
        phase: 'decision_register',
        status: 'WARN',
        severity: 'major',
        path: 'project-brief.json#decision_register',
        message: `의사결정 레지스터 비어있음(production_seed): ${issues.join(', ')} — 기각된 대안/제약이 생성 프로젝트로 전달되지 않음`,
      });
      return;
    }
    const register = Array.isArray(brief.decision_register) ? brief.decision_register : [];
    if (register.length > 0) {
      report.checks.push({
        phase: 'decision_register',
        status: 'PASS',
        severity: 'info',
        path: 'project-brief.json#decision_register',
        message: `의사결정 레지스터 확인: ${register.length}개 항목`,
      });
    }
  } catch (e) {
    report.checks.push({
      phase: 'decision_register',
      status: 'WARN',
      severity: 'major',
      path: 'project-brief.json',
      message: `decision_register 검증 실패: ${e.message}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 3.3: Beginner Guidance Contract
// ═══════════════════════════════════════════════════════════════

/**
 * process-contract done_when 이 beginner_guidance 에 의무화한 wrong-turn 카테고리.
 * (scope / GO claims / paid acquisition / pricing / segment broadening)
 * SSOT: data/process-contracts/brief2dev.process-contract.json (scaffolding stage done_when)
 * forward-traceability(RTM): 개수(>=5)가 아닌 *명시 카테고리 커버리지*를 강제한다.
 */
export const MANDATED_CORRECTION_CATEGORIES = [
  'scope',
  'go_claim',
  'paid_acquisition',
  'pricing',
  'segment_broadening',
];

/**
 * correction_triggers 가 의무 카테고리를 모두 커버하는지 검사.
 * @param {Array} triggers - beginner_guidance.correction_triggers
 * @returns {{ covered: string[], missing: string[] }}
 */
export function correctionCategoryCoverage(triggers) {
  const present = new Set(
    (Array.isArray(triggers) ? triggers : [])
      .map((t) => (t && typeof t === 'object' ? t.category : null))
      .filter((c) => typeof c === 'string' && c.trim().length > 0),
  );
  const covered = MANDATED_CORRECTION_CATEGORIES.filter((c) => present.has(c));
  const missing = MANDATED_CORRECTION_CATEGORIES.filter((c) => !present.has(c));
  return { covered, missing };
}

/**
 * 허용되는 category 값 = 의무 5개 + 'other'. schema enum 과 1:1 일치.
 * SSOT: data/schemas/project-brief.schema.json (correction_triggers[].category enum)
 */
export const VALID_CORRECTION_CATEGORIES = [...MANDATED_CORRECTION_CATEGORIES, 'other'];

/**
 * correction_triggers 중 enum 에 없는 category 값을 가진 항목을 검출.
 * schema 가 1차 게이트이나, validateBeginnerGuidance 경로에서 invalid 값이
 * "categories missing" 으로 오인되지 않도록 명확한 진단을 제공한다.
 * @param {Array} triggers - beginner_guidance.correction_triggers
 * @returns {string[]} invalid category 값 목록 (입력 순서, 중복 제거)
 */
export function invalidCorrectionCategories(triggers) {
  const seen = new Set();
  const invalid = [];
  for (const t of Array.isArray(triggers) ? triggers : []) {
    const cat = t && typeof t === 'object' ? t.category : null;
    if (
      typeof cat === 'string' &&
      cat.trim().length > 0 &&
      !VALID_CORRECTION_CATEGORIES.includes(cat) &&
      !seen.has(cat)
    ) {
      seen.add(cat);
      invalid.push(cat);
    }
  }
  return invalid;
}

/**
 * correction_triggers 의 category 계약 위반 issue 문자열을 합산.
 * (missing: 의무 카테고리 미커버 / invalid: enum 밖 값) — validateBeginnerGuidance 가
 * 단일 spread push 로 소비하여 거대 함수의 분기를 외부화한다.
 * @param {Array} triggers
 * @returns {string[]} issue 문자열 (0개 = 위반 없음)
 */
export function correctionCategoryIssues(triggers) {
  const issues = [];
  const { missing } = correctionCategoryCoverage(triggers);
  if (missing.length > 0) {
    issues.push(`correction_triggers categories missing: ${missing.join(', ')}`);
  }
  const invalid = invalidCorrectionCategories(triggers);
  if (invalid.length > 0) {
    issues.push(`correction_triggers categories invalid: ${invalid.join(', ')}`);
  }
  return issues;
}

/**
 * 출시 후 트랙 (PMF/GMF) 결정적 생성 강제 — "build = done" 함정 차단 (P0-3).
 * production_seed / full_analysis 같은 풀 파이프라인 산출물은 `post_launch_guidance`
 * (+ `day90_gate_ref`) 가 의무. scaffold(deprecated) 모드는 면제.
 * correctionCategoryIssues 패턴 동치 — validateBeginnerGuidance 가 단일 spread push 로 소비.
 * @param {string} mode - project-brief.generation_mode
 * @param {object} guidance - beginner_guidance 객체
 * @returns {string[]} issue 문자열 (0개 = 위반 없음)
 */
export function postLaunchGuidanceIssues(mode, guidance) {
  if (mode === 'scaffold') return [];
  const postLaunch =
    guidance && typeof guidance === 'object' ? guidance.post_launch_guidance : null;
  if (!postLaunch || typeof postLaunch !== 'object') {
    return ['post_launch_guidance (출시 후 트랙 — done≠끝)'];
  }
  // schema required ["trigger", "steps", "day90_gate_ref"] + steps minItems:1 와 동등 강제.
  // day90_gate_ref 만 검사하면 validator 독립 경로(schema 미동반)에서 불완전 산출물 false-pass.
  const issues = [];
  if (!postLaunch.trigger) issues.push('post_launch_guidance.trigger');
  if (!Array.isArray(postLaunch.steps) || postLaunch.steps.length === 0) {
    issues.push('post_launch_guidance.steps (minItems: 1)');
  }
  if (!postLaunch.day90_gate_ref) issues.push('post_launch_guidance.day90_gate_ref');
  return issues;
}

function validateBeginnerGuidance(scaffoldDir, report) {
  const briefPath = join(scaffoldDir, 'project-brief.json');
  if (!existsSync(briefPath)) return; // Required files phase already reports it.

  try {
    const brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
    const mode = brief.generation_mode || 'full_analysis';
    const guidance = brief.beginner_guidance;

    if (!guidance || typeof guidance !== 'object') {
      report.checks.push({
        phase: 'beginner_guidance',
        status: mode === 'scaffold' ? 'WARN' : 'FAIL',
        severity: mode === 'scaffold' ? 'major' : 'critical',
        path: 'project-brief.json#beginner_guidance',
        message: 'beginner_guidance 계약 누락',
      });
      return;
    }

    const nextSteps = Array.isArray(guidance.next_steps) ? guidance.next_steps : [];
    const correctionTriggers = Array.isArray(guidance.correction_triggers)
      ? guidance.correction_triggers
      : [];
    const policy = guidance.answer_policy || {};
    const sourceRefs = Array.isArray(guidance.source_refs) ? guidance.source_refs.filter(Boolean) : [];
    const issues = [];

    if (nextSteps.length !== 3) issues.push('next_steps=3');
    if (correctionTriggers.length < 5) issues.push('correction_triggers>=5');
    if (sourceRefs.length < 1) issues.push('source_refs>=1');
    if (policy.explain_what_why_how !== true) issues.push('answer_policy.explain_what_why_how=true');
    if (policy.use_plain_language !== true) issues.push('answer_policy.use_plain_language=true');
    if (policy.prefer_choices_over_open_strategy !== true) issues.push('answer_policy.prefer_choices_over_open_strategy=true');
    if (policy.claim_requires_source !== true) issues.push('answer_policy.claim_requires_source=true');
    if (policy.correct_wrong_direction !== true) issues.push('answer_policy.correct_wrong_direction=true');

    for (const [index, step] of nextSteps.entries()) {
      if (!step?.why) issues.push(`next_steps[${index}].why`);
      if (!step?.how) issues.push(`next_steps[${index}].how`);
      if (!step?.evidence_needed) issues.push(`next_steps[${index}].evidence_needed`);
      if (!Array.isArray(step?.source_refs) || step.source_refs.filter(Boolean).length === 0) {
        issues.push(`next_steps[${index}].source_refs>=1`);
      }
    }

    for (const [index, trigger] of correctionTriggers.entries()) {
      if (!trigger?.trigger) issues.push(`correction_triggers[${index}].trigger`);
      if (!trigger?.redirect) issues.push(`correction_triggers[${index}].redirect`);
      if (!trigger?.required_evidence) issues.push(`correction_triggers[${index}].required_evidence`);
      if (!trigger?.blocked_until) issues.push(`correction_triggers[${index}].blocked_until`);
    }

    // forward-traceability(RTM): process-contract 가 명시한 5개 wrong-turn 카테고리 커버리지
    // (missing) + enum 밖 값 (invalid) 을 단일 helper 로 검증. 개수(>=5)만으로는 부족.
    issues.push(...correctionCategoryIssues(correctionTriggers));

    // 출시 후 트랙 (PMF/GMF) 결정적 생성 강제 — "build = done" 함정 차단 (P0-3).
    // churn 의 60-70% 가 첫 90일에 집중. scaffold(deprecated) 모드는 면제.
    issues.push(...postLaunchGuidanceIssues(mode, guidance));

    if (issues.length > 0) {
      report.checks.push({
        phase: 'beginner_guidance',
        status: 'FAIL',
        severity: 'critical',
        path: 'project-brief.json#beginner_guidance',
        message: `초심자 안내 계약 불완전: ${issues.join(', ')}`,
      });
      return;
    }

    report.checks.push({
      phase: 'beginner_guidance',
      status: 'PASS',
      severity: 'critical',
      path: 'project-brief.json#beginner_guidance',
      message: `초심자 안내 계약 확인: next_steps=${nextSteps.length}, corrections=${correctionTriggers.length}`,
    });
  } catch (e) {
    report.checks.push({
      phase: 'beginner_guidance',
      status: 'FAIL',
      severity: 'critical',
      path: 'project-brief.json',
      message: `beginner_guidance 검증 실패: ${e.message}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 3.5: DESIGN.md Structure Validation
// ═══════════════════════════════════════════════════════════════

function validateDesignMd(scaffoldDir, report) {
  const designPath = join(scaffoldDir, 'DESIGN.md');
  if (!existsSync(designPath)) return; // Required files phase already reports it.

  try {
    const content = readFileSync(designPath, 'utf-8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatter) {
      report.checks.push({
        phase: 'design_md',
        status: 'FAIL',
        severity: 'critical',
        path: 'DESIGN.md',
        message: 'YAML front matter 누락',
      });
      return;
    }

    const tokenChecks = [
      { key: /^colors:/m, label: 'colors' },
      { key: /^typography:/m, label: 'typography' },
      { key: /^spacing:/m, label: 'spacing' },
      { key: /^rounded:/m, label: 'rounded' },
      { key: /^components:/m, label: 'components' },
    ];
    const missingTokens = tokenChecks
      .filter(check => !check.key.test(frontmatter[1]))
      .map(check => check.label);

    if (missingTokens.length > 0) {
      report.checks.push({
        phase: 'design_md',
        status: missingTokens.includes('colors') || missingTokens.includes('typography') ? 'FAIL' : 'WARN',
        severity: missingTokens.includes('colors') || missingTokens.includes('typography') ? 'critical' : 'major',
        path: 'DESIGN.md',
        message: `필수/권장 토큰 누락: ${missingTokens.join(', ')}`,
      });
    }

    const canonicalOrder = [
      'Overview',
      'Colors',
      'Typography',
      'Layout',
      'Elevation & Depth',
      'Shapes',
      'Components',
      "Do's and Don'ts",
    ];
    const headingMatches = [...content.matchAll(/^##\s+(.+)$/gm)].map(match => match[1].trim());
    const missingSections = canonicalOrder.filter(section => !headingMatches.includes(section));
    const presentIndexes = canonicalOrder
      .map(section => headingMatches.indexOf(section))
      .filter(index => index >= 0);
    const ordered = presentIndexes.every((value, index, arr) => index === 0 || value > arr[index - 1]);

    if (missingSections.length > 0 || !ordered) {
      report.checks.push({
        phase: 'design_md',
        status: 'WARN',
        severity: 'major',
        path: 'DESIGN.md',
        message: `canonical sections ${missingSections.length > 0 ? `누락: ${missingSections.join(', ')}` : '순서 불일치'}`,
      });
    } else {
      report.checks.push({
        phase: 'design_md',
        status: 'PASS',
        severity: 'critical',
        path: 'DESIGN.md',
        message: 'YAML tokens + canonical markdown sections 확인',
      });
    }
  } catch (e) {
    report.checks.push({
      phase: 'design_md',
      status: 'FAIL',
      severity: 'critical',
      path: 'DESIGN.md',
      message: `DESIGN.md 검증 실패: ${e.message}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 4: Skill Deployment Rate
// ═══════════════════════════════════════════════════════════════

function validateSkillDeployment(scaffoldDir, referencesDir, report) {
  const deployedPath = join(referencesDir, 'deployed-skills.json');
  if (!existsSync(deployedPath)) {
    report.checks.push({
      phase: 'skill_deployment',
      status: 'FAIL',
      severity: 'critical',
      path: 'deployed-skills.json',
      message: 'SSOT 파일 없음',
    });
    return;
  }

  const manifest = JSON.parse(readFileSync(deployedPath, 'utf-8'));
  const expectedSkills = Object.values(manifest.categories).flatMap(c => c.skills);
  const expectedTotal = manifest.total || expectedSkills.length;
  const skillsDir = join(scaffoldDir, '.claude', 'skills');

  let deployed = 0;
  const missing = [];

  for (const skillId of expectedSkills) {
    const skillPath = join(skillsDir, skillId, 'SKILL.md');
    if (existsSync(skillPath)) {
      deployed++;
    } else {
      missing.push(skillId);
    }
  }

  const rate = expectedTotal > 0 ? deployed / expectedTotal : 0;
  const minRate = 0.95;

  report.checks.push({
    phase: 'skill_deployment',
    status: rate >= minRate ? 'PASS' : 'FAIL',
    severity: 'critical',
    path: '.claude/skills/',
    message: `배포율: ${deployed}/${expectedTotal} (${(rate * 100).toFixed(1)}%, 최소 ${minRate * 100}%)`,
    details: missing.length > 0 ? { missing_skills: missing.slice(0, 10) } : undefined,
  });
}

// ═══════════════════════════════════════════════════════════════
// Phase 5: Hook Wiring Completeness
// ═══════════════════════════════════════════════════════════════

const CRITICAL_HOOKS = [
  'feature-boundary-guard.mjs',
  'coverage-threshold-guard.mjs',
  'secret-leak-guard.mjs',
  'destructive-git-guard.mjs',
  'commit-guard.mjs',
];

function validateHookWiring(scaffoldDir, report) {
  const settingsPath = join(scaffoldDir, '.claude', 'settings.json');
  const hooksDir = join(scaffoldDir, '.claude', 'hooks');

  if (!existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks || {};

    // Collect all hook file references from settings.json
    const referencedFiles = new Set();
    for (const [, eventHooks] of Object.entries(hooks)) {
      if (!Array.isArray(eventHooks)) continue;
      for (const hookGroup of eventHooks) {
        const hookList = hookGroup.hooks || [];
        for (const h of hookList) {
          if (h.command) {
            // Extract .mjs file from command string
            const match = h.command.match(/[\w/-]+\.mjs/);
            if (match) referencedFiles.add(match[0]);
          }
        }
      }
    }

    // Check critical hooks exist as files
    for (const hookFile of CRITICAL_HOOKS) {
      const hookPath = join(hooksDir, hookFile);
      if (!existsSync(hookPath)) {
        report.checks.push({
          phase: 'hook_wiring',
          status: 'FAIL',
          severity: 'critical',
          path: `.claude/hooks/${hookFile}`,
          message: `필수 Guard 파일 누락`,
        });
      } else {
        report.checks.push({
          phase: 'hook_wiring',
          status: 'PASS',
          severity: 'critical',
          path: `.claude/hooks/${hookFile}`,
          message: 'Guard 파일 존재',
        });
      }
    }

    // Check that referenced files actually exist
    const orphanFiles = [];
    for (const ref of referencedFiles) {
      const baseName = ref.split('/').pop();
      // Check in hooks/ or scripts/
      const inHooks = existsSync(join(hooksDir, baseName));
      const inScripts = existsSync(join(scaffoldDir, '.claude', 'scripts', baseName));
      const inScriptsLib = existsSync(join(scaffoldDir, '.claude', 'scripts', 'lib', baseName));
      if (!inHooks && !inScripts && !inScriptsLib) {
        orphanFiles.push(baseName);
      }
    }

    if (orphanFiles.length > 0) {
      report.checks.push({
        phase: 'hook_wiring',
        status: orphanFiles.length >= 3 ? 'FAIL' : 'WARN',
        severity: orphanFiles.length >= 3 ? 'critical' : 'major',
        path: '.claude/settings.json',
        message: `${orphanFiles.length}개 Hook 참조가 실제 파일과 불일치`,
        details: { orphan_files: orphanFiles },
      });
    }
  } catch (e) {
    report.checks.push({
      phase: 'hook_wiring',
      status: 'FAIL',
      severity: 'critical',
      path: '.claude/settings.json',
      message: `설정 파싱 실패: ${e.message}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 6: Skill Contract Satisfiability
// ═══════════════════════════════════════════════════════════════

function validateSkillContracts(scaffoldDir, referencesDir, report) {
  const contractsPath = join(referencesDir, 'skill-contracts.json');
  if (!existsSync(contractsPath)) {
    report.checks.push({
      phase: 'skill_contracts',
      status: 'WARN',
      severity: 'info',
      path: 'skill-contracts.json',
      message: '계약 파일 없음 — 계약 검증 스킵',
    });
    return;
  }

  const contracts = JSON.parse(readFileSync(contractsPath, 'utf-8'));
  const allContracts = contracts.contracts || {};
  let satisfiable = 0;
  let unsatisfiable = 0;

  for (const [skillId, contract] of Object.entries(allContracts)) {
    if (skillId.startsWith('_')) continue; // skip _category_defaults

    // Check calls reference existing skills
    if (contract.calls && contract.calls.length > 0) {
      const skillsDir = join(scaffoldDir, '.claude', 'skills');
      const missingCalls = contract.calls.filter(id =>
        !existsSync(join(skillsDir, id, 'SKILL.md'))
      );
      if (missingCalls.length > 0) {
        report.checks.push({
          phase: 'skill_contracts',
          status: 'WARN',
          severity: 'major',
          path: `.claude/skills/${skillId}/`,
          message: `호출 대상 스킬 누락: ${missingCalls.join(', ')}`,
        });
        unsatisfiable++;
        continue;
      }
    }

    // Check required input files exist (static files only, skip templates)
    if (contract.inputs?.required_files) {
      const missingInputs = contract.inputs.required_files.filter(f => {
        if (f.path.includes('{') || f.path === 'user_input') return false;
        if (f.scope === 'brief2dev_only') return false;
        const resolvedPath = rewriteSinglePath(f.path);
        return !existsSync(join(scaffoldDir, resolvedPath));
      });
      if (missingInputs.length > 0 && contract.execution_context !== 'brief2dev_only') {
        report.checks.push({
          phase: 'skill_contracts',
          status: 'WARN',
          severity: 'info',
          path: `.claude/skills/${skillId}/`,
          message: `필수 입력 파일 부재: ${missingInputs.map(f => f.path).join(', ')}`,
        });
      }
    }

    satisfiable++;
  }

  report.checks.push({
    phase: 'skill_contracts',
    status: unsatisfiable === 0 ? 'PASS' : 'WARN',
    severity: unsatisfiable > 0 ? 'major' : 'info',
    path: 'skill-contracts.json',
    message: `계약 충족: ${satisfiable} 통과, ${unsatisfiable} 경고`,
  });
}

// ═══════════════════════════════════════════════════════════════
// Phase 7: Template Context Injection
// ═══════════════════════════════════════════════════════════════

function validateTemplateContext(scaffoldDir, report) {
  const skillsDir = join(scaffoldDir, '.claude', 'skills');
  if (!existsSync(skillsDir)) return;

  // Sample check: verify context block exists in key skills
  const sampleSkills = ['feature-pilot', 'feature-architect', 'feature-implementer', 'discover'];
  let injected = 0;

  for (const skillId of sampleSkills) {
    const skillPath = join(skillsDir, skillId, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    try {
      const content = readFileSync(skillPath, 'utf-8');
      if (content.includes('SCAFFOLD-CONTEXT-START')) {
        injected++;
      }
    } catch { /* ignore */ }
  }

  const checked = sampleSkills.filter(id => existsSync(join(skillsDir, id, 'SKILL.md'))).length;

  report.checks.push({
    phase: 'template_context',
    status: checked > 0 && injected === checked ? 'PASS' : injected > 0 ? 'WARN' : 'FAIL',
    severity: 'major',
    path: '.claude/skills/*/SKILL.md',
    message: `컨텍스트 주입: ${injected}/${checked} 핵심 스킬에 SCAFFOLD-CONTEXT 블록 존재`,
  });
}

// ═══════════════════════════════════════════════════════════════
// Phase 8: Skill Template Variable Resolution (런타임 검증)
// ═══════════════════════════════════════════════════════════════

/**
 * 배포된 스킬의 SKILL.md에서 미해결 템플릿 변수를 감지한다.
 * {FEATURES_DIR}, {PROJECT_NAME} 등이 실제 값으로 치환되었는지 검증.
 */
function validateTemplateVariableResolution(scaffoldDir, report) {
  const skillsDir = join(scaffoldDir, '.claude', 'skills');
  if (!existsSync(skillsDir)) return;

  // 템플릿 변수 패턴: {UPPER_SNAKE_CASE} 형태 (실제 JSON 스키마 제외)
  const templateVarPattern = /\{([A-Z][A-Z0-9_]{2,})\}/g;
  // 허용 목록: 약어, 런타임 플레이스홀더, 환경별 변수 등 scaffolder 치환 대상이 아닌 것
  const allowedVars = new Set([
    // 일반 약어
    'N', 'URL', 'ISO', 'ID', 'PR', 'API', 'DB', 'CI', 'CD', 'SLA', 'SLO',
    'MVP', 'KPI', 'ROI', 'TAM', 'SAM', 'SOM', 'GTM', 'JTBD', 'DDD',
    'CRUD', 'REST', 'HTTP', 'HTTPS', 'CSS', 'HTML', 'SQL', 'JSON', 'YAML',
    'AWS', 'GCP', 'CLI', 'SDK', 'ORM', 'JWT', 'CORS', 'CSRF', 'XSS',
    // 런타임 플레이스홀더 (스킬 실행 시 동적 채움)
    'TIMESTAMP', 'CACHE_HIT_RATE', 'FAILURE_POINT', 'FAILURE_REASON',
    'GCP_PROJECT_ID', 'GCP_REGION', 'ENV_VARS',
    'GITHUB_ACCOUNT', 'PR_URL_A', 'PR_URL_B',
    'PROJECT_NAME', 'SPEC_ID', 'FEATURE_ID', 'FEATURE_NAME',
    'BRANCH_NAME', 'COMMIT_HASH', 'DEPLOY_URL',
    'TABLE_NAME', 'COLUMN_NAME', 'INDEX_NAME',
    'ERROR_MESSAGE', 'STACK_TRACE', 'ROOT_CAUSE',
  ]);
  // scaffolder가 치환해야 하는 핵심 변수 (이것만 감지 대상)
  const scaffolderVars = new Set([
    'FEATURES_DIR', 'SHARED_DIR', 'TESTS_DIR', 'DOCS_DIR',
    'COMPONENT_EXT', 'FEATURE_LAYERS', 'SOURCE_ROOT',
    'TESTS_UNIT', 'TESTS_E2E', 'CONFIG_DIR', 'STYLES_DIR',
  ]);

  let totalSkills = 0;
  let unresolvedSkills = 0;
  const unresolvedDetails = [];

  try {
    const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const skillId of skillDirs) {
      const skillPath = join(skillsDir, skillId, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      totalSkills++;
      try {
        const content = readFileSync(skillPath, 'utf-8');
        const matches = [...content.matchAll(templateVarPattern)];
        const unresolved = matches
          .map(m => m[1])
          .filter(v => scaffolderVars.has(v)); // scaffolder가 치환해야 하는 변수만 감지

        if (unresolved.length > 0) {
          const uniqueVars = [...new Set(unresolved)];
          unresolvedSkills++;
          if (unresolvedDetails.length < 10) { // 상위 10개만 보고
            unresolvedDetails.push(`${skillId}: ${uniqueVars.join(', ')}`);
          }
        }
      } catch { /* ignore read errors */ }
    }
  } catch { /* ignore dir errors */ }

  if (totalSkills === 0) return;

  const resolvedRate = ((totalSkills - unresolvedSkills) / totalSkills * 100).toFixed(1);

  report.checks.push({
    phase: 'template_variable_resolution',
    status: unresolvedSkills === 0 ? 'PASS' : 'WARN',
    severity: unresolvedSkills > 10 ? 'major' : 'info',
    path: '.claude/skills/*/SKILL.md',
    message: `템플릿 변수 해결: ${resolvedRate}% (${totalSkills - unresolvedSkills}/${totalSkills} 스킬 정상)`,
    details: unresolvedDetails.length > 0 ? { unresolved: unresolvedDetails } : undefined,
  });
}

// ═══════════════════════════════════════════════════════════════
// Phase 9: Package.json Dependency Completeness (런타임 검증)
// ═══════════════════════════════════════════════════════════════

/**
 * package.json의 핵심 의존성이 선언되어 있는지 검증한다.
 * project-config.json의 framework 정보를 기반으로 필수 의존성을 결정.
 */
function validateDependencyCompleteness(scaffoldDir, report) {
  const pkgPath = join(scaffoldDir, 'package.json');
  const configPath = join(scaffoldDir, 'project-config.json');

  if (!existsSync(pkgPath)) return;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // 프레임워크별 필수 의존성 매핑
    const frameworkDeps = {
      'next': ['next', 'react', 'react-dom'],
      'nuxt': ['nuxt'],
      'sveltekit': ['@sveltejs/kit', 'svelte'],
      'remix': ['@remix-run/react', '@remix-run/node'],
    };

    // 공통 개발 도구 (quality gate 실행에 필수)
    const qualityDeps = ['typescript'];

    // project-config.json에서 프레임워크 감지
    let detectedFramework = null;
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        const fw = (config.framework || '').toLowerCase();
        if (fw.includes('next')) detectedFramework = 'next';
        else if (fw.includes('nuxt')) detectedFramework = 'nuxt';
        else if (fw.includes('svelte')) detectedFramework = 'sveltekit';
        else if (fw.includes('remix')) detectedFramework = 'remix';
      } catch { /* ignore */ }
    }

    const requiredDeps = [...qualityDeps];
    if (detectedFramework && frameworkDeps[detectedFramework]) {
      requiredDeps.push(...frameworkDeps[detectedFramework]);
    }

    const missing = requiredDeps.filter(dep => !allDeps[dep]);

    report.checks.push({
      phase: 'dependency_completeness',
      status: missing.length === 0 ? 'PASS' : 'WARN',
      severity: missing.length > 0 ? 'major' : 'info',
      path: 'package.json',
      message: missing.length === 0
        ? `필수 의존성 ${requiredDeps.length}개 모두 선언됨`
        : `누락 의존성: ${missing.join(', ')}`,
    });
  } catch (e) {
    report.checks.push({
      phase: 'dependency_completeness',
      status: 'FAIL',
      severity: 'critical',
      path: 'package.json',
      message: `package.json 파싱 실패: ${e.message}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 10: Commands Executability (런타임 검증)
// ═══════════════════════════════════════════════════════════════

/**
 * project-config.json의 commands가 실제 실행 가능한지 검증한다.
 * Makefile 타겟 또는 npm script가 존재하는지 확인.
 */
function validateCommandsExecutability(scaffoldDir, report) {
  const configPath = join(scaffoldDir, 'project-config.json');
  if (!existsSync(configPath)) return;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const commands = config.commands || {};
    const pkgPath = join(scaffoldDir, 'package.json');
    const makefilePath = join(scaffoldDir, 'Makefile');

    // npm scripts 수집
    let npmScripts = {};
    if (existsSync(pkgPath)) {
      try {
        npmScripts = JSON.parse(readFileSync(pkgPath, 'utf-8')).scripts || {};
      } catch { /* ignore */ }
    }

    // Makefile 타겟 수집
    const makeTargets = new Set();
    if (existsSync(makefilePath)) {
      try {
        const makefile = readFileSync(makefilePath, 'utf-8');
        const targetPattern = /^([a-zA-Z0-9._-]+)\s*:/gm;
        let match;
        while ((match = targetPattern.exec(makefile)) !== null) {
          makeTargets.add(match[1]);
        }
      } catch { /* ignore */ }
    }

    let executable = 0;
    let nonExecutable = 0;
    let skipped = 0;
    const issues = [];

    for (const [key, cmd] of Object.entries(commands)) {
      if (cmd === null) { skipped++; continue; }

      const cmdStr = String(cmd);
      let found = false;

      // npm run xxx 패턴 확인
      const npmMatch = cmdStr.match(/npm\s+run\s+(\S+)/);
      if (npmMatch && npmScripts[npmMatch[1]]) found = true;

      // pnpm/yarn/bun script 패턴 확인
      const packageManagerMatch = cmdStr.match(/^(pnpm|yarn|bun)\s+(\S+)/);
      if (packageManagerMatch) {
        const scriptName = packageManagerMatch[2];
        if (scriptName === 'install') found = true;
        if (scriptName === 'exec') found = true;
        if (npmScripts[scriptName]) found = true;
      }

      // npx xxx 패턴은 항상 실행 가능하다고 간주
      if (cmdStr.includes('npx')) found = true;

      // make xxx 패턴 확인
      const makeMatch = cmdStr.match(/make\s+(\S+)/);
      if (makeMatch && makeTargets.has(makeMatch[1])) found = true;

      // 직접 node/bash 명령은 실행 가능하다고 간주
      if (cmdStr.startsWith('node ') || cmdStr.startsWith('bash ')) found = true;

      if (found) {
        executable++;
      } else {
        nonExecutable++;
        if (issues.length < 5) {
          issues.push(`${key}: ${cmdStr}`);
        }
      }
    }

    const total = executable + nonExecutable;
    if (total === 0) return;

    report.checks.push({
      phase: 'commands_executability',
      status: nonExecutable === 0 ? 'PASS' : nonExecutable <= 2 ? 'WARN' : 'FAIL',
      severity: nonExecutable > 2 ? 'major' : 'info',
      path: 'project-config.json → commands',
      message: `명령 실행 가능: ${executable}/${total} (스킵: ${skipped})${issues.length > 0 ? ' — 미확인: ' + issues.join('; ') : ''}`,
    });
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════
// Phase 11: Skill Circular Dependency Detection (런타임 검증)
// ═══════════════════════════════════════════════════════════════

/**
 * 스킬 계약의 calls 관계에서 순환 의존성을 감지한다.
 * DFS 기반 사이클 감지 — Tier 1→Tier 2→Utility 체인의 순환 참조 방지.
 */
function validateSkillCircularDependencies(scaffoldDir, referencesDir, report) {
  const contractsPath = join(referencesDir, 'skill-contracts.json');
  if (!existsSync(contractsPath)) {
    report.checks.push({
      phase: 'circular_dependency',
      status: 'WARN',
      severity: 'info',
      path: 'skill-contracts.json',
      message: '계약 파일 없음 — 순환 의존성 검증 스킵',
    });
    return;
  }

  try {
    const contracts = JSON.parse(readFileSync(contractsPath, 'utf-8'));
    const allContracts = contracts.contracts || {};

    // 의존 그래프 구축
    const graph = {};
    for (const [skillId, contract] of Object.entries(allContracts)) {
      if (skillId.startsWith('_')) continue;
      graph[skillId] = contract.calls || [];
    }

    // DFS 사이클 감지
    const cycles = [];
    const visited = new Set();
    const inStack = new Set();

    function dfs(node, path) {
      if (inStack.has(node)) {
        // 사이클 발견: path에서 node 이후 부분이 사이클
        const cycleStart = path.indexOf(node);
        const cycle = path.slice(cycleStart).concat(node);
        cycles.push(cycle);
        return;
      }
      if (visited.has(node)) return;

      visited.add(node);
      inStack.add(node);

      for (const neighbor of (graph[node] || [])) {
        dfs(neighbor, [...path, node]);
      }

      inStack.delete(node);
    }

    for (const node of Object.keys(graph)) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    // 중복 사이클 제거 (정규화: 사전순 최소 노드를 시작으로 회전)
    const uniqueCycles = new Set();
    const deduped = [];
    for (const cycle of cycles) {
      const nodes = cycle.slice(0, -1); // 마지막(=첫번째) 제거
      const minIdx = nodes.indexOf(nodes.slice().sort()[0]);
      const normalized = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)].join(' → ');
      if (!uniqueCycles.has(normalized)) {
        uniqueCycles.add(normalized);
        deduped.push(normalized);
      }
    }

    if (deduped.length > 0) {
      report.checks.push({
        phase: 'circular_dependency',
        status: 'FAIL',
        severity: 'critical',
        path: 'skill-contracts.json',
        message: `순환 의존성 ${deduped.length}건 발견`,
        details: { cycles: deduped },
      });
    } else {
      const edgeCount = Object.values(graph).reduce((sum, calls) => sum + calls.length, 0);
      report.checks.push({
        phase: 'circular_dependency',
        status: 'PASS',
        severity: 'info',
        path: 'skill-contracts.json',
        message: `순환 의존성 없음 (${Object.keys(graph).length} 스킬, ${edgeCount} 의존 관계)`,
      });
    }
  } catch (e) {
    report.checks.push({
      phase: 'circular_dependency',
      status: 'WARN',
      severity: 'info',
      path: 'skill-contracts.json',
      message: `순환 의존성 검증 실패: ${e.message}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 12: Stack-config ↔ package.json 의존성 정렬 (런타임 검증)
// ═══════════════════════════════════════════════════════════════

/** project-config.json#platform 감지 (부재/파싱 실패 시 web-nextjs). */
function detectScaffoldPlatform(scaffoldDir) {
  const configPath = join(scaffoldDir, 'project-config.json');
  if (!existsSync(configPath)) return 'web-nextjs';
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return typeof config.platform === 'string' && config.platform ? config.platform : 'web-nextjs';
  } catch {
    return 'web-nextjs';
  }
}

/** 카탈로그 rules 의 vendor dep 키를 매치/미매치 룰로 분리한다. */
function partitionVendorDeps(rules, matchedRuleIds) {
  const matched = new Set();
  const unmatched = new Set();
  const matchedSet = new Set(matchedRuleIds);
  for (const rule of rules) {
    const keys = [...Object.keys(rule.dependencies || {}), ...Object.keys(rule.devDependencies || {})];
    const target = matchedSet.has(rule.id) ? matched : unmatched;
    for (const key of keys) target.add(key);
  }
  return { matched, unmatched };
}

/** stack_dependency_alignment check 객체를 빌드한다. */
function buildAlignmentCheck(missing, phantom, unmapped, matchedRuleIds) {
  const aligned = missing.length === 0 && phantom.length === 0;
  const issues = [];
  if (missing.length) issues.push(`선정 vendor 미설치: ${missing.join(', ')}`);
  if (phantom.length) issues.push(`미선정 vendor 설치됨(phantom): ${phantom.join(', ')}`);
  const okMsg = `stack-config 의존성 정렬 OK (룰 ${matchedRuleIds.length}건 매치${unmapped.length ? `, 미매핑 레이어 ${unmapped.length}건` : ''})`;
  return {
    phase: 'stack_dependency_alignment',
    status: aligned ? 'PASS' : 'WARN',
    severity: aligned ? 'info' : 'major',
    path: 'package.json',
    message: aligned ? okMsg : issues.join(' | '),
    details: { missing, phantom_vendor: phantom, unmapped_layers: unmapped, matched_rule_ids: matchedRuleIds },
  };
}

/**
 * stack-config.json 의 선정 스택과 package.json 의존성이 정렬되는지 검증한다.
 * - missing: 매치 룰 vendor 가 package.json 에 없음 (선정했으나 미설치) → WARN/major
 * - phantom_vendor: 미매치 룰 vendor 가 package.json 에 존재 (미선정인데 설치됨 — 본 버그의 회귀 검출기) → WARN/major
 * - unmapped_layers: 어떤 룰도 못 잡은 레이어 → info (참고)
 *
 * phantom 검사는 카탈로그 기지(旣知) vendor 에만 한정 — 사용자 수동 추가 라이브러리(stripe 등) 미간섭(오탐 방지).
 * skeleton/no-discovery 모드(입력 부재) + 비 web-nextjs 플랫폼(catalogMissing)은 silent skip (Phase 9 :1039 패턴 정합).
 */
function validateStackDependencyAlignment(scaffoldDir, referencesDir, report) {
  const pkgPath = join(scaffoldDir, 'package.json');
  // 검증기는 scaffold 내부 복사본(Phase 7 deployDiscoveryKnowledgeBase 산출)을 읽고,
  // 생성기(scaffold-deploy.mjs#resolveSeedDependencies)는 source pipeline dir 을 읽는다.
  // 둘 다 동일 카탈로그 SSOT 로 정합 — 복사본 stale 시 phantom WARN 이 안전망으로 작동.
  const stackConfigPath = join(scaffoldDir, 'docs', 'brief2dev', 'stage-outputs', 'stack-config.json');
  const catalogPath = join(referencesDir, 'stack-dependency-catalog.json');
  if (!existsSync(pkgPath) || !existsSync(stackConfigPath) || !existsSync(catalogPath)) return;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const stackConfig = JSON.parse(readFileSync(stackConfigPath, 'utf-8'));
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));

    const platform = detectScaffoldPlatform(scaffoldDir);
    const resolved = resolveStackDependencies(stackConfig, catalog, platform);
    if (resolved.catalogMissing) return; // 비 web-nextjs 등 — 카탈로그 무관 플랫폼

    const rules = Array.isArray(catalog[platform].rules) ? catalog[platform].rules : [];
    const { matched, unmatched } = partitionVendorDeps(rules, resolved.matchedRuleIds);
    const missing = [...matched].filter((key) => !allDeps[key]);
    const phantom = [...unmatched].filter((key) => allDeps[key] && !matched.has(key));

    report.checks.push(buildAlignmentCheck(missing, phantom, resolved.unmappedLayers, resolved.matchedRuleIds));
  } catch (e) {
    report.checks.push({
      phase: 'stack_dependency_alignment',
      status: 'WARN',
      severity: 'info',
      path: 'package.json',
      message: `stack 의존성 정렬 검증 실패: ${e.message}`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Report Utilities
// ═══════════════════════════════════════════════════════════════

/** @typedef {{ checks: Check[], summary: Summary }} ValidationReport */
/** @typedef {{ phase: string, status: string, severity: string, path: string, message: string, details?: any }} Check */
/** @typedef {{ total: number, pass: number, fail: number, warn: number, critical_failures: number, verdict: string }} Summary */

function createReport() {
  return { checks: [], summary: null };
}

function computeSummary(report) {
  const total = report.checks.length;
  const pass = report.checks.filter(c => c.status === 'PASS').length;
  const fail = report.checks.filter(c => c.status === 'FAIL').length;
  const warn = report.checks.filter(c => c.status === 'WARN').length;
  const criticalFailures = report.checks.filter(c => c.status === 'FAIL' && c.severity === 'critical').length;

  return {
    total,
    pass,
    fail,
    warn,
    critical_failures: criticalFailures,
    verdict: criticalFailures > 0 ? 'FAIL' : fail > 0 ? 'WARN' : 'PASS',
  };
}

/**
 * 검증 리포트를 콘솔에 출력한다.
 * @param {ValidationReport} report
 */
export function printReport(report) {
  console.log('\n═══ Scaffold Validation Report ═══\n');

  const grouped = {};
  for (const check of report.checks) {
    if (!grouped[check.phase]) grouped[check.phase] = [];
    grouped[check.phase].push(check);
  }

  for (const [phase, checks] of Object.entries(grouped)) {
    console.log(`  [${phase}]`);
    for (const c of checks) {
      const icon = c.status === 'PASS' ? '+' : c.status === 'FAIL' ? 'X' : '!';
      console.log(`    [${icon}] ${c.severity.toUpperCase()} ${c.path} — ${c.message}`);
    }
    console.log('');
  }

  const s = report.summary;
  console.log(`═══ Verdict: ${s.verdict} (${s.pass}/${s.total} pass, ${s.fail} fail, ${s.warn} warn, ${s.critical_failures} critical) ═══\n`);
}

// ═══════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════

function countFilesRecursive(dir) {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) count++;
      else if (entry.isDirectory()) count += countFilesRecursive(join(dir, entry.name));
    }
  } catch { /* ignore */ }
  return count;
}
