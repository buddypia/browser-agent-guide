/**
 * pipeline-config.mjs - 파이프라인 스테이지 SSOT
 *
 * SSOT: .claude/pipelines/brief2dev.yaml (선언적 파이프라인 정의)
 * 이 모듈은 brief2dev.yaml의 구조를 코드로 반영한 단일 진실 원천이다.
 *
 * 역할:
 *   - 프로젝트 레지스트리 관리 (다중 프로젝트 지원)
 *   - STAGE_MAP: 스테이지 ↔ 산출물/스킬 매핑
 *   - 동적 경로 해결: getDataDir(), getHandoffDir() 등
 *   - 산출물 존재/완전성 검증 유틸리티
 *
 * Canonical SSOT 경로 구조 (solo-CLI 단일 활성 파이프라인):
 *   .brief2dev/runs/<run_id>/stage-output/  — 스테이지 JSON 산출물 (SSOT)
 *   .brief2dev/runs/<run_id>/handoff/       — 핸드오프 리포트 (SSOT)
 *   .brief2dev/runs/<run_id>/reports/       — 마크다운 리포트 (SSOT)
 *   .brief2dev/run/active.json              — Saga State (worktree-local SSOT)
 *   .brief2dev/archives/<slug>/             — 완료/중단/pivot 파이프라인의 읽기 전용 archive
 *   output/<slug>/                          — scaffold 출력
 *
 * 설계 원칙:
 * - 순수 함수 (부작용 없음, 읽기 전용) — registry I/O 제외
 * - 에러 시 안전 기본값 반환 (throw 안 함)
 * - 멀티프로젝트 동시 실행은 미지원 — 별도 레포 clone 또는 git branch로 격리
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { safeReadJson } from './utils.mjs';
import { writeJsonAtomicSync } from './atomic-fs.mjs';
import {
  resolveSystemFile,
  resolveRunScopedDir,
  getActiveRunId,
  getActiveRunPath as resolveActiveRunPath,
  getPipelineDataRoot,
  getArchivesRoot,
} from './layout-resolver.mjs';

const __filename = fileURLToPath(import.meta.url);

// ═══════════════════════════════════════════════════════════════
// 경로 해결 2축 분리 (SSOT)
//
// 두 가지 루트를 명확히 분리한다 — 이전 설계 결함(PROJECT_ROOT 단일상수)을 해소:
//
//   CODE_ROOT       = brief2dev 레포 내 "코드/리소스" 루트
//                     항상 __filename 기반. 환경변수와 무관.
//                     용도: data/schemas/, .claude/skills/, docs/architecture/ 등
//                     (이것들은 이 저장소 자체의 정적 자산이므로 env와 무관해야 한다)
//
//   PIPELINE_DATA_ROOT = 런타임 파이프라인 데이터 루트 (.brief2dev/)
//                        CLAUDE_PROJECT_DIR 환경변수 우선, 없으면 CODE_ROOT 기반.
//                        용도: run/active.json, runs/<run_id>/{stage-output,handoff,reports}/ 등
//                        (child-process 격리 테스트, 다중 클라이언트 호출 대응)
//
// saga-manager.mjs 등이 자체 정의하던 중복 PIPELINE_DATA_ROOT를 여기로 통합.
// 모든 런타임 경로는 getDataDir(), getHandoffDir() 등 run-scoped export 함수만 사용.
// ═══════════════════════════════════════════════════════════════

/** brief2dev 레포 루트 (코드/리소스 — __filename 고정, env 무시) */
export const CODE_ROOT = join(__filename, '..', '..', '..', '..');

/**
 * 런타임 데이터 루트 (예: `.brief2dev/` 또는 산출물의 `docs/discovery/`) — env-aware + project-config-aware (lazy lookup).
 *
 * **R-CM-026 Rule 8 단일 진입점 SSOT**: 정의는 `./layout-resolver.mjs#getPipelineDataRoot` 가 보유.
 * 본 모듈에서는 호환성 유지를 위해 re-export.
 *
 * @see ./layout-resolver.mjs#getPipelineDataRoot
 */
export { getPipelineDataRoot };

/**
 * 레거시 하위 호환: PROJECT_ROOT는 CODE_ROOT의 별칭.
 * @deprecated 용도에 따라 CODE_ROOT (정적 자산) 또는 PIPELINE_DATA_ROOT (런타임)로 전환.
 */
export const PROJECT_ROOT = CODE_ROOT;

/**
 * Sandbox safety guard for destructive operations during testing.
 *
 * vitest 의 globalSetup 은 NODE_ENV=test + B2D_TEST_SANDBOX=1 + CLAUDE_PROJECT_DIR=<sandbox> 를
 * 모두 set 한다. 그러므로 NODE_ENV=test 인데 B2D_TEST_SANDBOX 가 부재하면 이는 격리 실패
 * 시나리오 — 테스트가 실제 repo 의 .brief2dev/ 를 건드릴 위험이 있어 즉시 거부한다.
 *
 * 정상 사용자 호출 (NODE_ENV !== 'test') 에서는 통과한다.
 * archive-and-reset / migrate-slugs-to-ascii 같은 destructive 스크립트 진입에서 호출.
 */
export function assertSafeProjectDir() {
  if (process.env.NODE_ENV === 'test' && !process.env.B2D_TEST_SANDBOX) {
    throw new Error(
      'SAFETY: NODE_ENV=test 인데 B2D_TEST_SANDBOX flag 가 부재합니다. ' +
      'destructive operation 실행을 거부 — 실제 repo 오염 방지. ' +
      'vitest globalSetup 이 sandbox flag + CLAUDE_PROJECT_DIR 을 설정해야 합니다. ' +
      '직접 실행 시에는 NODE_ENV 를 test 로 set 하지 마세요.'
    );
  }
}

/** .claude/skills/ — 정적 자산 (CODE_ROOT 기반) */
export const SKILLS_DIR = join(CODE_ROOT, '.claude', 'skills');

/** data/schemas/ — 정적 자산 (CODE_ROOT 기반, JSON Schema SSOT) */
export const SCHEMAS_DIR = join(CODE_ROOT, 'data', 'schemas');

/** data/schemas/stage-output/ — 정적 자산 */
export const STAGE_SCHEMAS_DIR = join(SCHEMAS_DIR, 'stage-output');

/** docs/architecture/ — 정적 자산 (CODE_ROOT 기반) */
export const ARCHITECTURE_DIR = join(CODE_ROOT, 'docs', 'architecture');

// ═══════════════════════════════════════════════════════════════
// 프로젝트 레지스트리 (다중 프로젝트 지원)
//
// .brief2dev/registry.json이 SSOT.
// active_project 슬러그로 현재 활성 프로젝트를 결정한다.
// ═══════════════════════════════════════════════════════════════

/**
 * 레지스트리 파일 경로 — R-CM-026 layout SSOT (system 카테고리).
 * P3 전환기: layout-resolver가 옛 경로(.brief2dev/registry.json) 폴백 처리.
 * P2 Stage B 마이그레이션 후 자동으로 .brief2dev/system/registry.json 사용.
 */
const REGISTRY_PATH = resolveSystemFile('registry.json');

/** 모듈 캐시: 활성 프로젝트 슬러그 */
let _activeSlug = null;

/**
 * 레지스트리를 로드한다.
 * @returns {object|null}
 */
export function loadRegistry() {
  return safeReadJson(REGISTRY_PATH);
}

/**
 * 레지스트리를 저장한다.
 * @param {object} registry
 */
export function saveRegistry(registry) {
  registry.updated_at = new Date().toISOString();
  // R-CM-014 / R-CM-030 — system_persistent SSOT 는 모든 worktree 가 공유한다.
  // 다른 모든 system writer 와 동일하게 atomic 교체 (POSIX rename(2) + unique
  // tmp) 로 멀티세션 동시 호출 시 torn-file 을 차단한다.
  writeJsonAtomicSync(REGISTRY_PATH, registry);
}

/**
 * 활성 프로젝트 슬러그를 반환한다.
 *
 * 우선순위:
 *   1. setActiveProject()로 명시적 설정된 값
 *   2. registry.json의 active_project
 *   3. null (미설정)
 *
 * @returns {string|null}
 */
export function getActiveProject() {
  if (_activeSlug) return _activeSlug;
  const reg = loadRegistry();
  _activeSlug = reg?.active_project || null;
  return _activeSlug;
}

/**
 * 활성 프로젝트를 설정하고 레지스트리에 반영한다.
 *
 * @param {string} slug - 프로젝트 슬러그 (kebab-case)
 * @param {object} [meta] - 프로젝트 메타데이터 (name, status 등)
 */
export function setActiveProject(slug, meta = {}) {
  _activeSlug = slug;

  let reg = loadRegistry();
  if (!reg) {
    reg = { schema_version: 1, active_project: null, projects: {}, updated_at: null };
  }

  reg.active_project = slug;
  if (!reg.projects[slug]) {
    reg.projects[slug] = {
      slug,
      name: meta.name || slug,
      created_at: new Date().toISOString(),
      status: 'running',
    };
  }
  if (meta.name) reg.projects[slug].name = meta.name;
  if (meta.status) reg.projects[slug].status = meta.status;

  saveRegistry(reg);
}

/**
 * 레지스트리의 프로젝트 상태를 업데이트한다.
 *
 * @param {string} slug
 * @param {string} status - 'running' | 'completed' | 'failed'
 */
export function updateProjectStatus(slug, status) {
  const reg = loadRegistry();
  if (!reg || !reg.projects[slug]) return;
  reg.projects[slug].status = status;
  saveRegistry(reg);
}

/**
 * 모듈 캐시를 초기화한다 (테스트/재설정용).
 */
export function resetActiveProjectCache() {
  _activeSlug = null;
}

// ═══════════════════════════════════════════════════════════════
// 동적 경로 해결 — canonical SSOT
//
// brief2dev는 solo-CLI 도구이므로 한 레포는 "현재 활성 파이프라인 1개"만 보유.
// 모든 스테이지 산출물은 run-scoped canonical 경로(.brief2dev/runs/<run_id>/<subPath>)에 저장된다.
// 멀티프로젝트가 필요하면 별도 레포 clone 또는 git branch로 격리한다.
//
// archives/<slug> 디렉토리(.brief2dev/archives/<slug>/)는 완료된 파이프라인의 아카이브 전용이며,
// 활성 파이프라인에서는 읽거나 쓰지 않는다. (archiveCanonicalToSlug 참조)
// ═══════════════════════════════════════════════════════════════

/**
 * 스테이지 JSON 산출물 디렉토리 (run-scoped 카테고리, R-CM-026).
 *   active run 있음 → .brief2dev/runs/<run_id>/stage-output
 *   없음 → legacy .brief2dev/stage-output (P3 전환기 폴백)
 * @returns {string} 절대 경로
 */
export function getDataDir() {
  return resolveRunScopedDir('stage-output');
}

/**
 * 스테이지 간 핸드오프 리포트 디렉토리 (run-scoped 카테고리).
 *   active run 있음 → .brief2dev/runs/<run_id>/handoff
 *   없음 → legacy .brief2dev/handoff
 * @returns {string} 절대 경로
 */
export function getHandoffDir() {
  return resolveRunScopedDir('handoff');
}

/**
 * 사람이 읽는 분석 리포트 디렉토리 (run-scoped 카테고리, Markdown).
 *   active run 있음 → .brief2dev/runs/<run_id>/reports
 *   없음 → legacy .brief2dev/reports
 * @returns {string} 절대 경로
 */
export function getReportDir() {
  return resolveRunScopedDir('reports');
}

/**
 * active-run state — Pipeline Saga State SSOT (run 카테고리).
 * R-CM-026 layout: .brief2dev/run/active.json (worktree_local, legacy fallback 포함).
 * @returns {string} 절대 경로
 */
export function getActiveRunPath() {
  return resolveActiveRunPath();
}

/**
 * .brief2dev/inbox/ — 파이프라인 시작 전 참고 자료 스테이징 영역
 * slug과 무관하게 고정 경로. 파이프라인 시작 시 runs/<run_id>/references/로 이동됨.
 * @returns {string} 절대 경로
 */
export function getInboxDir() {
  return join(getPipelineDataRoot(), 'inbox');
}

/**
 * 프로젝트 참고 자료 디렉토리 (run-scoped 카테고리).
 *   active run 있음 → .brief2dev/runs/<run_id>/references
 *   없음 → .brief2dev/runs/_unassigned/references
 * inbox에서 이동된 파일이 저장되는 최종 위치.
 * @returns {string} 절대 경로
 */
export function getReferencesDir() {
  return resolveRunScopedDir('references');
}

/**
 * output/<slug>/ — 생성된 프로젝트 (scaffold)
 * @returns {string} 절대 경로
 */
export function getScaffoldDir() {
  const slug = getActiveProject();
  if (!slug) return join(PROJECT_ROOT, 'output');
  return join(PROJECT_ROOT, 'output', slug);
}

// ═══════════════════════════════════════════════════════════════
// Pipeline Mode SSOT
//
// business-context.json.mode가 파이프라인 전체 모드의 단일 진실 원천.
// 가드/규칙은 이 값을 읽어 mode-aware 검증을 수행한다.
// ═══════════════════════════════════════════════════════════════

/** @type {string|null} mode 캐시 (5초 TTL) */
let _modeCache = null;
let _modeCacheTime = 0;
const _MODE_CACHE_TTL_MS = 5000;

/**
 * 현재 파이프라인의 실행 모드를 반환한다.
 *
 * - "builder": 본인 dogfooding + 외부 유저 0명. 규제/단위경제학 WARN 억제.
 * - "learning": 학습 목적 실행. 일부 품질 체크 완화.
 * - "production" (기본): 모든 규칙 엄격 적용.
 *
 * SSOT: business-context.json.mode (Stage 1 산출물)
 * 없거나 파싱 실패 시 "production"으로 안전 fallback.
 *
 * @returns {string} 파이프라인 모드
 */
export function getPipelineMode() {
  const now = Date.now();
  if (_modeCache && (now - _modeCacheTime) < _MODE_CACHE_TTL_MS) {
    return _modeCache;
  }

  const bcPath = join(getDataDir(), 'business-context.json');
  let mode = 'production';
  if (existsSync(bcPath)) {
    try {
      const data = JSON.parse(readFileSync(bcPath, 'utf-8'));
      if (typeof data?.mode === 'string' && data.mode.length > 0) {
        mode = data.mode;
      }
    } catch {
      // parsing 실패 시 production fallback
    }
  }
  _modeCache = mode;
  _modeCacheTime = now;
  return mode;
}

/** 테스트/재설정용 mode 캐시 초기화 */
export function resetPipelineModeCache() {
  _modeCache = null;
  _modeCacheTime = 0;
}

/**
 * 특정 프로젝트의 모든 경로를 반환한다 (명시적 slug 지정).
 *
 * @param {string} slug - 프로젝트 슬러그
 * @returns {{ dataDir, handoffDir, reportDir, activeRunPath, scaffoldDir }}
 */
export function getProjectPaths(slug) {
  return {
    dataDir: join(getArchivesRoot(), slug, 'stage-output'),
    handoffDir: join(getArchivesRoot(), slug, 'handoff'),
    reportDir: join(getArchivesRoot(), slug, 'reports'),
    referencesDir: join(getArchivesRoot(), slug, 'references'),
    activeRunPath: join(getArchivesRoot(), slug, 'active-run.json'),
    scaffoldDir: join(PROJECT_ROOT, 'output', slug),
    inboxDir: join(getPipelineDataRoot(), 'inbox'),
  };
}

// ═══════════════════════════════════════════════════════════════
// Path Variables (동적)
//
// MANIFEST.json의 path_pattern, inputs, outputs에서 사용하는 변수.
// 활성 프로젝트 슬러그에 따라 동적으로 해결된다.
// ═══════════════════════════════════════════════════════════════

/**
 * 현재 활성 run 기반 경로 변수 매핑을 반환한다 (R-CM-026 layout SSOT).
 *
 * run-scoped 변수($STAGE_OUTPUT/$HANDOFF/$REPORT/$REFERENCES) 는 active run_id 기반
 * runs/<run_id>/<subdir> 경로로 해결. active 없으면 legacy 경로 폴백.
 *
 * scaffold output 은 slug 기반 (별도 SSOT — registry.active_project) 으로 유지.
 *
 * @returns {object} 변수명 → 상대 경로
 */
export function getPathVariables() {
  const runId = getActiveRunId();
  const slug = getActiveProject();
  const runScoped = runId
    ? {
        '$STAGE_OUTPUT': `.brief2dev/runs/${runId}/stage-output`,
        '$HANDOFF': `.brief2dev/runs/${runId}/handoff`,
        '$REPORT': `.brief2dev/runs/${runId}/reports`,
        '$REFERENCES': `.brief2dev/runs/${runId}/references`,
        '$PIPELINE_DATA': `.brief2dev/runs/${runId}`,
      }
    : {
        // active run 부재 시 _unassigned 폴더로 매핑
        '$STAGE_OUTPUT': '.brief2dev/runs/_unassigned/stage-output', // @layout-resolver-allow
        '$HANDOFF': '.brief2dev/runs/_unassigned/handoff', // @layout-resolver-allow
        '$REPORT': '.brief2dev/runs/_unassigned/reports', // @layout-resolver-allow
        '$REFERENCES': '.brief2dev/runs/_unassigned/references', // @layout-resolver-allow
        '$PIPELINE_DATA': '.brief2dev/runs/_unassigned', // @layout-resolver-allow
      };
  return {
    ...runScoped,
    // INBOX는 layout SSOT 의 단일 디렉터리 (run-scoped 아님)
    '$INBOX': '.brief2dev/inbox', // @layout-resolver-allow
    '$SCAFFOLD': slug ? `output/${slug}` : 'output',
  };
}

/**
 * 경로 변수를 실제 상대 경로로 치환한다.
 *
 * @param {string} pathPattern - 변수가 포함된 경로 (예: "$STAGE_OUTPUT/business-context.json")
 * @returns {string} 치환된 경로 (예: ".brief2dev/novalens/stage-output/business-context.json")
 */
export function resolvePathVariable(pathPattern) {
  if (!pathPattern || typeof pathPattern !== 'string') return pathPattern;
  let resolved = pathPattern;
  const vars = getPathVariables();
  for (const [variable, replacement] of Object.entries(vars)) {
    resolved = resolved.replaceAll(variable, replacement);
  }
  return resolved;
}

/**
 * 실제 상대 경로를 경로 변수로 역변환한다 (검증/표시용).
 *
 * @param {string} resolvedPath - 실제 상대 경로
 * @returns {string} 변수가 포함된 경로 (가장 긴 매치 우선)
 */
export function toPathVariable(resolvedPath) {
  if (!resolvedPath || typeof resolvedPath !== 'string') return resolvedPath;
  let result = resolvedPath;
  const vars = getPathVariables();
  // 긴 경로부터 매칭 (예: $STAGE_OUTPUT이 $PIPELINE_DATA보다 먼저)
  const sorted = Object.entries(vars)
    .sort(([, a], [, b]) => b.length - a.length);
  for (const [variable, replacement] of sorted) {
    result = result.replaceAll(replacement, variable);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// 파이프라인 스테이지 매핑 (SSOT)
//
// brief2dev.yaml의 steps 정의를 코드로 반영.
// requiredInputJsonFiles: 파일명만 저장. 전체 경로는 getRequiredInputs()가 동적 해결.
// ═══════════════════════════════════════════════════════════════

export const BUILD_WORTHINESS_GATE_FILE = 'build-worthiness-gate.json';

/**
 * 스테이지 ID → { skill, mdFile, jsonFile, handoffFile, gateHandoffFile, requiredInputJsonFiles } 매핑.
 *
 * requiredInputJsonFiles: 해당 스테이지 실행 전 반드시 존재해야 하는 JSON 파일명 목록.
 *   brief2dev.yaml의 inputs 필드에서 파일명만 추출.
 *   intake는 사용자 입력이므로 빈 배열.
 */
export const STAGE_MAP = new Map([
  ['intake', {
    order: 1,
    skill: 'business-analyzer',
    mdFile: 'BUSINESS-CONTEXT.md',
    jsonFile: 'business-context.json',
    handoffFile: 'stage-1-handoff.json',
    description: '비즈니스 컨텍스트 구조화',
    requiredInputJsonFiles: [],
  }],
  ['market_research', {
    order: 2,
    skill: 'market-researcher',
    mdFile: 'MARKET-RESEARCH.md',
    jsonFile: 'market-research.json',
    handoffFile: 'stage-2-handoff.json',
    description: 'TAM/SAM/SOM, 페르소나, 경쟁사 분석',
    requiredInputJsonFiles: ['business-context.json'],
  }],
  ['mvp_scoping', {
    order: 3,
    skill: 'mvp-scoper',
    mdFile: 'MVP-RECOMMENDATION.md',
    jsonFile: 'mvp-scope.json',
    handoffFile: 'stage-3-handoff.json',
    gateHandoffFile: BUILD_WORTHINESS_GATE_FILE,
    description: 'MVP 범위 정의, MoSCoW 우선순위',
    requiredInputJsonFiles: ['business-context.json', 'market-research.json'],
  }],
  ['platform_decision', {
    order: 4,
    skill: 'platform-selector',
    mdFile: 'PLATFORM-DECISION.md',
    jsonFile: 'platform-decision.json',
    handoffFile: 'stage-4-handoff.json',
    description: '플랫폼 비교 및 결정',
    requiredInputJsonFiles: ['business-context.json', 'market-research.json', 'mvp-scope.json'],
  }],
  ['stack_selection', {
    order: 5,
    skill: 'stack-selector',
    mdFile: 'STACK-ADR.md',
    jsonFile: 'stack-config.json',
    handoffFile: 'stage-5-handoff.json',
    description: '기술 스택 ATAM Lite 평가',
    requiredInputJsonFiles: ['business-context.json', 'market-research.json', 'mvp-scope.json', 'platform-decision.json'],
  }],
  ['infra_design', {
    order: 6,
    skill: 'infra-designer',
    mdFile: 'INFRA-DESIGN.md',
    jsonFile: 'infra-config.json',
    handoffFile: 'stage-6-handoff.json',
    description: '인프라 설계, 비용 추정',
    requiredInputJsonFiles: ['business-context.json', 'market-research.json', 'mvp-scope.json', 'platform-decision.json', 'stack-config.json'],
  }],
  ['scaffolding', {
    order: 7,
    skill: 'project-scaffolder',
    mdFile: null,
    jsonFile: null,
    handoffFile: 'stage-7-handoff.json',
    description: 'Stage 1-6 결정 근거 기반 프로젝트 템플릿 생성',
    requiredInputJsonFiles: [
      'business-context.json',
      'market-research.json',
      'mvp-scope.json',
      'platform-decision.json',
      'stack-config.json',
      'infra-config.json',
    ],
  }],
  ['output_gate', {
    order: 8,
    skill: 'output-gate',
    mdFile: 'SUMMARY.md',
    jsonFile: 'pipeline-progress.json',
    handoffFile: 'stage-8-handoff.json',
    description: '전체 산출물 정합성 검증',
    requiredInputJsonFiles: [
      'business-context.json', 'market-research.json', 'mvp-scope.json',
      'platform-decision.json', 'stack-config.json', 'infra-config.json',
    ],
  }],
]);

/**
 * 스킬 ID → 스테이지 ID 역매핑
 */
export const SKILL_TO_STAGE = new Map(
  [...STAGE_MAP.entries()].map(([stageId, info]) => [info.skill, stageId])
);

// ═══════════════════════════════════════════════════════════════
// Phase Transition Table (SSOT)
//
// 스테이지 간 전환 시 compact 전략을 결정하는 데이터 구조.
// suggest-compact Hook이 이 테이블을 읽어
// 스테이지별 최적 compact 타이밍과 보존할 컨텍스트를 결정한다.
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {Object} PhaseTransition
 * @property {string} from - 출발 스테이지
 * @property {string} to - 도착 스테이지
 * @property {'strongly_recommended'|'recommended'|'optional'} compact_urgency
 * @property {boolean} phase_boundary - Phase 1/2 경계 여부
 * @property {string[]} preserve_context - compact 후 보존해야 할 파일 키
 * @property {string} reason - 권장 이유 (한국어)
 */

/** @type {PhaseTransition[]} */
export const PHASE_TRANSITIONS = [
  {
    from: 'intake',
    to: 'market_research',
    compact_urgency: 'optional',
    phase_boundary: false,
    preserve_context: ['business-context.json'],
    reason: '동일 Phase 내 연속 분석. 비즈니스 컨텍스트만 유지.',
  },
  {
    from: 'market_research',
    to: 'mvp_scoping',
    compact_urgency: 'recommended',
    phase_boundary: false,
    preserve_context: ['business-context.json', 'market-research.json'],
    reason: '시장 분석 → MVP 범위 전환. 컨텍스트 정리 권장.',
  },
  {
    from: 'mvp_scoping',
    to: 'platform_decision',
    compact_urgency: 'recommended',
    phase_boundary: false,
    preserve_context: ['business-context.json', 'mvp-scope.json'],
    reason: 'MVP 범위 → 플랫폼 결정. 기술 판단 컨텍스트로 전환.',
  },
  {
    from: 'platform_decision',
    to: 'stack_selection',
    compact_urgency: 'optional',
    phase_boundary: false,
    preserve_context: ['platform-decision.json', 'mvp-scope.json'],
    reason: '플랫폼 → 스택 선택. 밀접한 기술 판단이므로 연속 가능.',
  },
  {
    from: 'stack_selection',
    to: 'infra_design',
    compact_urgency: 'optional',
    phase_boundary: false,
    preserve_context: ['stack-config.json', 'platform-decision.json'],
    reason: '스택 → 인프라. 기술 결정의 연장선.',
  },
  {
    from: 'infra_design',
    to: 'scaffolding',
    compact_urgency: 'strongly_recommended',
    phase_boundary: true,
    preserve_context: ['stack-config.json', 'infra-config.json', 'platform-decision.json'],
    reason: 'Phase 1 (분석) → Phase 2 (생성) 전환. 컨텍스트 완전 교체 필요.',
  },
  {
    from: 'scaffolding',
    to: 'output_gate',
    compact_urgency: 'recommended',
    phase_boundary: false,
    preserve_context: ['pipeline-progress.json'],
    reason: '생성 완료 → 검증. scaffold 생성 디테일 해제, 검증 컨텍스트 집중.',
  },
];

/**
 * 두 스테이지 간 전환 정보를 반환한다.
 *
 * @param {string} fromStage - 출발 스테이지 ID
 * @param {string} toStage - 도착 스테이지 ID
 * @returns {PhaseTransition|null}
 */
export function getPhaseTransition(fromStage, toStage) {
  return PHASE_TRANSITIONS.find(t => t.from === fromStage && t.to === toStage) || null;
}

/**
 * 스테이지의 필수 입력 파일 목록을 반환한다 (프로젝트 슬러그 포함 상대 경로).
 *
 * STAGE_MAP.requiredInputJsonFiles에서 파일명을 가져와
 * 현재 활성 프로젝트의 stage-output 경로를 동적으로 결합한다.
 *
 * @param {string} stageId - 스테이지 ID
 * @returns {string[]} 필수 입력 파일 상대 경로 목록 (빈 배열 = 전제조건 없음)
 */
export function getRequiredInputs(stageId) {
  const stage = STAGE_MAP.get(stageId);
  if (!stage?.requiredInputJsonFiles || stage.requiredInputJsonFiles.length === 0) return [];

  // R-CM-026: stage-output 디렉토리는 layout-resolver가 결정.
  //   active run 있음 → .brief2dev/runs/<run_id>/stage-output
  //   없음 → legacy .brief2dev/stage-output (P3 전환기 폴백)
  // PROJECT_ROOT 기준 상대 경로로 변환 (validateRequiredInputs가 join(PROJECT_ROOT, ...) 사용).
  const dataDir = getDataDir();
  const prefix = relative(PROJECT_ROOT, dataDir).replace(/\\/g, '/');
  return stage.requiredInputJsonFiles.map(f => `${prefix}/${f}`);
}

/**
 * 스테이지의 필수 입력 파일 존재 여부를 검증한다.
 *
 * @param {string} stageId - 스테이지 ID
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateRequiredInputs(stageId) {
  const inputs = getRequiredInputs(stageId);
  const missing = [];

  for (const relPath of inputs) {
    const absPath = join(PROJECT_ROOT, relPath);
    if (!existsSync(absPath)) {
      missing.push(relPath);
    }
  }

  return { valid: missing.length === 0, missing };
}

// ═══════════════════════════════════════════════════════════════
// 제외 패턴
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// 실행 모드 (Execution Mode) — 모드 인식의 단일 진실 원천
//
// scaffold 모드: Phase 1 스킵 → scaffolding에서 직접 시작
// full_analysis 모드: 기존 8-Stage 전체 실행
//
// 모든 Guard/Validator가 이 API를 통해 모드를 확인한다.
// 개별 파일에서 pipeline_type을 직접 검사하지 않는다.
// ═══════════════════════════════════════════════════════════════

/** scaffold 모드에서 스킵되는 스테이지 */
const SCAFFOLD_SKIP_STAGES = new Set([
  'intake', 'market_research', 'mvp_scoping',
  'platform_decision', 'stack_selection', 'infra_design',
]);

/**
 * 주어진 파이프라인 타입에서 해당 스테이지가 활성(실행 대상)인지 판별한다.
 * 모든 Guard/Validator의 모드 인식은 이 함수를 통해야 한다.
 *
 * @param {string} stageId
 * @param {string} pipelineType — 'BRIEF2DEV_FULL' | 'BRIEF2DEV_SCAFFOLD'
 * @returns {boolean}
 */
export function isStageActive(stageId, pipelineType) {
  if (pipelineType === 'BRIEF2DEV_SCAFFOLD') {
    return !SCAFFOLD_SKIP_STAGES.has(stageId);
  }
  return true; // FULL 모드에서는 모든 스테이지 활성
}

/**
 * 주어진 파이프라인 타입에서 해당 스테이지의 전제조건 입력 파일을 반환한다.
 * scaffold 모드에서는 스킵된 스테이지의 산출물을 요구하지 않는다.
 *
 * @param {string} stageId
 * @param {string} pipelineType
 * @returns {string[]}
 */
export function getRequiredInputsForMode(stageId, pipelineType) {
  if (pipelineType === 'BRIEF2DEV_SCAFFOLD' && !isStageActive(stageId, pipelineType)) {
    return []; // 스킵된 스테이지는 입력 불필요
  }
  if (pipelineType === 'BRIEF2DEV_SCAFFOLD') {
    // 활성 스테이지(scaffolding, output_gate)의 입력에서 스킵된 스테이지 산출물 제외
    const allInputs = getRequiredInputs(stageId);
    return allInputs.filter(path => {
      const classification = classifyOutputFile(path);
      if (!classification.stageId) return true;
      return isStageActive(classification.stageId, pipelineType);
    });
  }
  return getRequiredInputs(stageId);
}

/**
 * 주어진 파이프라인 타입에서 다음 스테이지를 반환한다.
 *
 * @param {string|null} currentStageId
 * @param {string} pipelineType
 * @returns {string|null} 다음 스테이지 ID, null이면 파이프라인 완료
 */
export function getNextStage(currentStageId, pipelineType) {
  if (pipelineType === 'BRIEF2DEV_SCAFFOLD') {
    const scaffoldTransitions = new Map([
      [null, 'scaffolding'],
      ['scaffolding', 'output_gate'],
      ['output_gate', null],
    ]);
    return scaffoldTransitions.get(currentStageId);
  }
  // FULL 모드: 기존 순서
  const fullTransitions = new Map([
    [null, 'intake'],
    ['intake', 'market_research'],
    ['market_research', 'mvp_scoping'],
    ['mvp_scoping', 'platform_decision'],
    ['platform_decision', 'stack_selection'],
    ['stack_selection', 'infra_design'],
    ['infra_design', 'scaffolding'],
    ['scaffolding', 'output_gate'],
    ['output_gate', null],
  ]);
  return fullTransitions.get(currentStageId);
}

/** 검증에서 제외할 경로 프리픽스 */
export const SKIP_PATH_PREFIXES = [
  'test/',
  '.claude/',
  '.quality/',
  '.tmp/',
  'node_modules/',
  'scripts/',
  'data/',
  'docs/',
  'oss/',
];

// ═══════════════════════════════════════════════════════════════
// 산출물 검색
// ═══════════════════════════════════════════════════════════════

/**
 * 스테이지 ID로 산출물 파일들의 존재 여부를 확인한다.
 *
 * @param {string} stageId - 파이프라인 스테이지 ID
 * @returns {{ mdExists: boolean, jsonExists: boolean, handoffExists: boolean, mdPath: string|null, jsonPath: string|null, handoffPath: string|null }}
 */
export function checkStageOutputs(stageId) {
  const stage = STAGE_MAP.get(stageId);
  if (!stage) return { mdExists: false, jsonExists: false, handoffExists: false, mdPath: null, jsonPath: null, handoffPath: null };

  const reportDir = getReportDir();
  const dataDir = getDataDir();
  const handoffDir = getHandoffDir();

  const mdPath = stage.mdFile ? join(reportDir, stage.mdFile) : null;
  const jsonPath = stage.jsonFile ? join(dataDir, stage.jsonFile) : null;
  const handoffPath = stage.handoffFile ? join(handoffDir, stage.handoffFile) : null;

  // 상대 경로 (표시용) — R-CM-026 layout. active run_id 기반 runs/<run_id>/<subdir>.
  // 표시용 path-prefix (legacy fallback 포함, 의도적 layout-aware)
  const runId = getActiveRunId();
  const reportPrefix = runId ? `.brief2dev/runs/${runId}/reports` : '.brief2dev/reports'; // @layout-resolver-allow
  const dataPrefix = runId ? `.brief2dev/runs/${runId}/stage-output` : '.brief2dev/stage-output'; // @layout-resolver-allow
  const handoffPrefix = runId ? `.brief2dev/runs/${runId}/handoff` : '.brief2dev/handoff'; // @layout-resolver-allow

  return {
    mdExists: mdPath ? existsSync(mdPath) : true,
    jsonExists: jsonPath ? existsSync(jsonPath) : true,
    handoffExists: handoffPath ? existsSync(handoffPath) : true,
    mdPath: stage.mdFile ? `${reportPrefix}/${stage.mdFile}` : null,
    jsonPath: stage.jsonFile ? `${dataPrefix}/${stage.jsonFile}` : null,
    handoffPath: stage.handoffFile ? `${handoffPrefix}/${stage.handoffFile}` : null,
  };
}

/**
 * 모든 스테이지의 산출물 존재 현황을 반환한다.
 *
 * @returns {Map<string, { order: number, skill: string, mdExists: boolean, jsonExists: boolean, handoffExists: boolean }>}
 */
export function collectAllStageOutputs() {
  const result = new Map();
  for (const [stageId, info] of STAGE_MAP) {
    const outputs = checkStageOutputs(stageId);
    result.set(stageId, {
      order: info.order,
      skill: info.skill,
      description: info.description,
      ...outputs,
    });
  }
  return result;
}

/**
 * 스테이지 JSON 데이터 파일을 로드한다.
 *
 * @param {string} stageId - 스테이지 ID
 * @returns {object|null}
 */
export function loadStageJson(stageId) {
  const stage = STAGE_MAP.get(stageId);
  if (!stage?.jsonFile) return null;
  return safeReadJson(join(getDataDir(), stage.jsonFile));
}

/**
 * Handoff JSON을 로드한다.
 *
 * @param {string} stageId - 스테이지 ID
 * @returns {object|null}
 */
export function loadHandoffJson(stageId) {
  const stage = STAGE_MAP.get(stageId);
  if (!stage?.handoffFile) return null;
  return safeReadJson(join(getHandoffDir(), stage.handoffFile));
}

/**
 * Build Worthiness Gate mirror handoff를 로드한다.
 *
 * Canonical SSOT는 mvp-scope.json#decision_gate이고, 이 파일은 AI 간 handoff를
 * 명확히 하기 위한 mirror artifact다. validator는 mirror만 존재하는 legacy run도
 * 읽되, canonical과 mirror가 동시에 존재하면 동일성을 검증한다.
 *
 * @returns {object|null}
 */
export function loadBuildWorthinessGateHandoff() {
  return safeReadJson(join(getHandoffDir(), BUILD_WORTHINESS_GATE_FILE));
}

/**
 * pipeline-progress.json을 로드한다.
 *
 * @returns {object|null}
 */
export function loadPipelineProgress() {
  return safeReadJson(join(getDataDir(), 'pipeline-progress.json'));
}

// ═══════════════════════════════════════════════════════════════
// 스킬 검색
// ═══════════════════════════════════════════════════════════════

/**
 * .claude/skills/ 디렉토리에서 모든 스킬 MANIFEST.json을 수집한다.
 *
 * @returns {Map<string, object>} skillId → MANIFEST.json 파싱 결과
 */
export function collectAllSkillManifests() {
  const result = new Map();
  if (!existsSync(SKILLS_DIR)) return result;

  try {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const manifestPath = join(SKILLS_DIR, entry.name, 'MANIFEST.json');
      const manifest = safeReadJson(manifestPath);
      if (manifest) result.set(entry.name, manifest);
    }
  } catch { /* skip */ }
  return result;
}

/**
 * 파일 경로가 파이프라인 산출물에 해당하는지 판단한다.
 *
 * @param {string} filePath - 절대 또는 상대 경로
 * @returns {{ isOutput: boolean, stageId: string|null }}
 */
export function classifyOutputFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/');

  for (const [stageId, info] of STAGE_MAP) {
    if (info.jsonFile && matchesFilename(normalized, info.jsonFile)) {
      return { isOutput: true, stageId, fileType: 'json' };
    }
    if (info.mdFile && matchesFilename(normalized, info.mdFile)) {
      return { isOutput: true, stageId, fileType: 'md' };
    }
    if (info.handoffFile && matchesFilename(normalized, info.handoffFile)) {
      return { isOutput: true, stageId, fileType: 'handoff' };
    }
  }

  return { isOutput: false, stageId: null, fileType: null };
}

/**
 * 파일명이 경로의 마지막 세그먼트와 일치하는지 확인한다.
 * includes() 대신 사용하여 false match 방지.
 * 예: matchesFilename('.brief2dev/novalens/stage-output/business-context.json', 'business-context.json') → true
 *     matchesFilename('not-business-context.json', 'business-context.json') → false
 */
function matchesFilename(normalizedPath, filename) {
  return normalizedPath.endsWith('/' + filename) || normalizedPath === filename;
}

// ═══════════════════════════════════════════════════════════════
// 산출물 완전성 검증
// 스테이지 산출물 존재 vs 기대 파일 교차 검증
//
// 스테이지가 "완료"로 보이지만 (JSON 또는 MD 중 하나만 존재)
// 누락된 산출물이 있는 경우를 감지한다.
// ═══════════════════════════════════════════════════════════════

/**
 * 파이프라인 산출물의 완전성을 교차 검증한다.
 *
 * 검증 로직:
 * - JSON 존재하지만 MD 누락 → incomplete (JSON은 데이터이고 MD는 사람 가독 문서)
 * - MD 존재하지만 JSON 누락 → incomplete (JSON은 다음 스테이지 입력)
 * - handoff 누락 → incomplete (스테이지 전환 메타데이터)
 * - scaffolding (Stage 7): MD/JSON 없음이 정상 (코드 생성이 산출물)
 *
 * @returns {{ mismatches: number, details: Array<{ stageId: string, order: number, missing: string[] }> }}
 */
export function validateStageCompleteness() {
  const details = [];

  for (const [stageId, info] of STAGE_MAP) {
    const outputs = checkStageOutputs(stageId);
    const missing = [];

    // scaffolding은 MD/JSON이 없는 것이 정상
    if (stageId === 'scaffolding') {
      if (!outputs.handoffExists && info.handoffFile) {
        missing.push(outputs.handoffPath);
      }
      if (missing.length > 0) {
        details.push({ stageId, order: info.order, skill: info.skill, missing });
      }
      continue;
    }

    // 스테이지에 산출물이 하나도 없으면 아직 시작 안 한 것 → 검증 대상 아님
    const hasAnyOutput =
      (outputs.jsonPath && outputs.jsonExists) ||
      (outputs.mdPath && outputs.mdExists);
    if (!hasAnyOutput) continue;

    // 산출물이 부분적으로만 존재하면 incomplete
    if (outputs.jsonPath && !outputs.jsonExists) missing.push(outputs.jsonPath);
    if (outputs.mdPath && !outputs.mdExists) missing.push(outputs.mdPath);
    if (info.handoffFile && !outputs.handoffExists) missing.push(outputs.handoffPath);

    if (missing.length > 0) {
      details.push({ stageId, order: info.order, skill: info.skill, missing });
    }
  }

  return { mismatches: details.length, details };
}

// ═══════════════════════════════════════════════════════════════
// ADR 유틸리티
// ═══════════════════════════════════════════════════════════════

/**
 * docs/architecture/adr/ 디렉토리에서 ADR Decision 섹션을 추출한다.
 *
 * @returns {string} ADR 결정 요약 문자열
 */
export function extractAdrDecisions() {
  const adrDir = join(ARCHITECTURE_DIR, 'adr');
  if (!existsSync(adrDir)) return '';

  const files = [];
  try {
    const currentPath = join(adrDir, 'CURRENT.md');
    if (existsSync(currentPath)) {
      const content = readFileSync(currentPath, 'utf-8');
      const match = content.match(/## Current Decisions\s*\n([\s\S]*?)(?=\n## |\n---|$)/);
      if (match) return match[1].trim();
    }

    const entries = readdirSync(adrDir).filter(f => /^\d{3}-.*\.md$/.test(f)).sort();
    for (const entry of entries) {
      const content = readFileSync(join(adrDir, entry), 'utf-8');
      const match = content.match(/## (?:Decision|결정)\s*\n([\s\S]*?)(?=\n## |\n---|$)/);
      if (match) {
        files.push(`### ${entry}\n${match[1].trim()}`);
      }
    }
  } catch { /* skip */ }

  return files.join('\n\n');
}

/**
 * 경로를 프로젝트 루트 기준 상대 경로로 정규화한다.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function toRelativePath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const rootNormalized = PROJECT_ROOT.replace(/\\/g, '/');
  if (normalized.startsWith(rootNormalized)) {
    return normalized.slice(rootNormalized.length + 1);
  }
  return normalized;
}
