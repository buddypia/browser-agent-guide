#!/usr/bin/env node
/**
 * template-engine.mjs — Deterministic Skill Template Resolver
 *
 * SKILL.md 배포 시 플랫폼별 컨텍스트를 결정론적으로 주입한다.
 * AI의 비결정적 경로 해석을 방지하고, 모든 스킬이 동일한 해결된 경로를 참조하도록 보장.
 *
 * 메커니즘:
 *   1. platform-paths.json에서 플랫폼별 경로/규약을 읽음
 *   2. 각 SKILL.md 상단에 <!-- SCAFFOLD-CONTEXT --> 블록을 주입
 *   3. 블록에 해결된 경로, 규약, 품질 명령을 포함
 *   4. AI는 이 블록을 읽어 경로를 결정론적으로 해결
 *
 * Zero external dependencies (Node.js built-ins only).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════════
// Context Block Template
// ═══════════════════════════════════════════════════════════════

const CONTEXT_BLOCK_START = '<!-- SCAFFOLD-CONTEXT-START -->';
const CONTEXT_BLOCK_END = '<!-- SCAFFOLD-CONTEXT-END -->';

/**
 * platform-paths.json에서 플랫폼 설정을 로드한다.
 * @param {string} referencesDir - references 디렉토리 경로
 * @param {string} platformId - 플랫폼 ID (예: 'web-nextjs')
 * @returns {object|null} 플랫폼 경로/규약 설정
 */
export function loadPlatformConfig(referencesDir, platformId) {
  try {
    const raw = readFileSync(join(referencesDir, 'platform-paths.json'), 'utf-8');
    const all = JSON.parse(raw);
    return all[platformId] || null;
  } catch {
    return null;
  }
}

/**
 * 해결된 컨텍스트 블록을 생성한다.
 * 이 블록이 SKILL.md 상단에 주입되어, AI가 경로를 결정론적으로 해결하도록 한다.
 *
 * @param {string} platformId - 플랫폼 ID
 * @param {object} platformConfig - platform-paths.json에서 로드한 설정
 * @param {object} [options] - 추가 옵션
 * @param {string} [options.projectName] - 프로젝트명
 * @param {object} [options.commands] - 품질 명령어 매핑
 * @returns {string} 주입할 컨텍스트 블록
 */
export function generateContextBlock(platformId, platformConfig, options = {}) {
  if (!platformConfig) return '';

  const conv = platformConfig.conventions || {};
  const lines = [
    CONTEXT_BLOCK_START,
    '<!--',
    '  [scaffold-deploy 자동 생성 — 수동 편집 금지]',
    '  이 블록은 scaffold-deploy.mjs의 template-engine이 배포 시 주입한 결정론적 컨텍스트이다.',
    '  project-config.json과 동일한 값을 포함하며, AI가 경로를 즉시 해결할 수 있도록 한다.',
    '',
    `  platform: ${platformId}`,
    `  source_root: ${platformConfig.source_root}`,
    `  features: ${platformConfig.features}`,
    `  shared: ${platformConfig.shared}`,
    `  tests: ${platformConfig.tests}`,
    `  tests_unit: ${platformConfig.tests_unit}`,
    `  tests_e2e: ${platformConfig.tests_e2e}`,
    `  docs_features: ${platformConfig.docs_features}`,
    `  component_extension: ${conv.component_extension || 'N/A'}`,
    `  test_suffix: ${conv.test_suffix || 'N/A'}`,
    `  style_approach: ${conv.style_approach || 'N/A'}`,
    `  feature_structure: [${(conv.feature_structure || []).join(', ')}]`,
  ];

  if (options.commands) {
    lines.push('');
    lines.push('  commands:');
    for (const [key, val] of Object.entries(options.commands)) {
      if (val) lines.push(`    ${key}: ${val}`);
    }
  }

  if (options.projectName) {
    lines.push('');
    lines.push(`  project_name: ${options.projectName}`);
  }

  lines.push('-->');
  lines.push(CONTEXT_BLOCK_END);
  lines.push('');

  return lines.join('\n');
}

/**
 * SKILL.md에 컨텍스트 블록을 주입한다.
 * 기존 블록이 있으면 교체하고, 없으면 frontmatter 직후에 삽입한다.
 *
 * @param {string} skillContent - 원본 SKILL.md 내용
 * @param {string} contextBlock - 주입할 컨텍스트 블록
 * @returns {string} 컨텍스트가 주입된 SKILL.md 내용
 */
export function injectContextBlock(skillContent, contextBlock) {
  if (!contextBlock) return skillContent;

  // 기존 블록 제거
  const existingBlockRegex = new RegExp(
    `${escapeRegex(CONTEXT_BLOCK_START)}[\\s\\S]*?${escapeRegex(CONTEXT_BLOCK_END)}\\n?`,
    'g'
  );
  const cleaned = skillContent.replace(existingBlockRegex, '');

  // frontmatter (---...---) 직후에 삽입
  const frontmatterRegex = /^---\n[\s\S]*?\n---\n/;
  const match = cleaned.match(frontmatterRegex);

  if (match) {
    const insertPos = match.index + match[0].length;
    return cleaned.slice(0, insertPos) + '\n' + contextBlock + cleaned.slice(insertPos);
  }

  // frontmatter가 없으면 최상단에 삽입
  return contextBlock + cleaned;
}

/**
 * SKILL.md를 처리하여 컨텍스트가 주입된 결과를 반환한다.
 *
 * @param {string} skillContent - 원본 SKILL.md 내용
 * @param {string} platformId - 플랫폼 ID
 * @param {object} platformConfig - 플랫폼 설정
 * @param {object} [options] - 추가 옵션
 * @returns {string} 처리된 SKILL.md 내용
 */
export function processSkillTemplate(skillContent, platformId, platformConfig, options = {}) {
  const block = generateContextBlock(platformId, platformConfig, options);
  let result = injectContextBlock(skillContent, block);

  // Phase 2: scaffolder 변수를 실제 값으로 치환
  if (platformConfig) {
    result = resolveTemplateVariables(result, platformConfig, options);
  }

  return result;
}

/**
 * SKILL.md 본문의 scaffolder 변수 ({FEATURES_DIR} 등)를 실제 값으로 치환한다.
 * SCAFFOLD-CONTEXT 블록 내부는 이미 해결된 값이므로 치환 대상에서 제외.
 *
 * @param {string} content - SKILL.md 내용
 * @param {object} platformConfig - platform-paths.json 설정
 * @param {object} [options] - 추가 옵션
 * @returns {string} 변수가 치환된 내용
 */
function resolveTemplateVariables(content, platformConfig, options = {}) {
  const conv = platformConfig.conventions || {};

  // scaffolder 변수 → 실제 값 매핑
  const varMap = {
    'FEATURES_DIR': platformConfig.features,
    'SHARED_DIR': platformConfig.shared,
    'TESTS_DIR': platformConfig.tests,
    'TESTS_UNIT': platformConfig.tests_unit,
    'TESTS_E2E': platformConfig.tests_e2e,
    'DOCS_DIR': platformConfig.docs_features,
    'SOURCE_ROOT': platformConfig.source_root,
    'CONFIG_DIR': platformConfig.config,
    'STYLES_DIR': platformConfig.styles,
    'COMPONENT_EXT': conv.component_extension,
    'FEATURE_LAYERS': (conv.feature_structure || []).join(', '),
  };

  // SCAFFOLD-CONTEXT 블록 분리 (블록 내부는 치환하지 않음)
  const blockStart = CONTEXT_BLOCK_START;
  const blockEnd = CONTEXT_BLOCK_END;
  const startIdx = content.indexOf(blockStart);
  const endIdx = content.indexOf(blockEnd);

  let before = '', contextBlock = '', after = '';
  if (startIdx !== -1 && endIdx !== -1) {
    before = content.slice(0, startIdx);
    contextBlock = content.slice(startIdx, endIdx + blockEnd.length);
    after = content.slice(endIdx + blockEnd.length);
  } else {
    before = '';
    contextBlock = '';
    after = content;
  }

  // 본문(before + after)에서만 변수 치환
  for (const [varName, value] of Object.entries(varMap)) {
    if (value == null) continue;
    // {VAR_NAME} 패턴 치환 (코드 블록, 경로 참조 등에서 사용)
    const pattern = new RegExp(`\\{${varName}\\}`, 'g');
    before = before.replace(pattern, value);
    after = after.replace(pattern, value);
  }

  return before + contextBlock + after;
}

/**
 * execution_context에 따라 스킬을 필터링해야 하는지 판단한다.
 * brief2dev_only 스킬은 scaffold에 배포되지만, 실행 컨텍스트 경고가 주입된다.
 *
 * @param {string} executionContext - 스킬의 execution_context 값
 * @returns {string|null} 주입할 경고 문자열 (null이면 경고 불필요)
 */
export function getExecutionContextWarning(executionContext) {
  if (executionContext === 'brief2dev_only') {
    return '> **NOTE**: 이 스킬은 brief2dev 파이프라인 전용으로 설계되었습니다. 생성된 프로젝트에서는 Continuous Discovery 모드로 동작합니다.\n';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// Pipeline Data Path Rewrite (R-CM-028 배포 분기 — applyEnforcedByOverride 동형)
// ═══════════════════════════════════════════════════════════════

/**
 * 관점 1(.brief2dev/runs/<run_id>/) 경로를 관점 2(docs/brief2dev/) 경로로
 * 결정론적으로 치환한다. 소스 스킬 파일은 불변, 배포 사본에만 적용.
 *
 * 보존 대상 (치환 skip):
 *   - YAML frontmatter 블록 (---...---)
 *   - SCAFFOLD-CONTEXT 블록 내부
 *   - '.brief2dev/transplants/' 포함 라인 (OSS attribution)
 *   - '@scaffold-path-keep' marker 포함 라인 (관점 1 prose)
 *
 * 멱등: 'docs/brief2dev'는 '.brief2dev' substring을 포함하지 않으므로 2회 적용 = 1회 적용.
 * CRLF 안전: 라인 split 시 '\r?\n'으로 CR 보존.
 *
 * @param {string} content - 원본 파일 내용
 * @param {object} [options]
 * @param {string} [options.pipelineDataRoot='docs/brief2dev'] - 관점 2 루트 경로
 * @returns {string} 치환된 내용 (변경 없으면 원본 반환)
 */
export const PIPELINE_PATH_REWRITES = [
  // ordered longest-prefix first (catch-all 마지막)
  ['.brief2dev/runs/<run_id>/stage-output/', '<root>/stage-outputs/'],
  ['.brief2dev/runs/<run_id>/reports/',      '<root>/reports/'],
  ['.brief2dev/runs/<run_id>/references/',   '<root>/references/'],
  ['.brief2dev/runs/<run_id>/handoff/',      '<root>/handoff/'],
  ['.brief2dev/runs/<run_id>/',              '<root>/'],
  ['.brief2dev/run/active.json',             '<root>/run/active.json'], // @layout-resolver-allow — rewrite 매핑 원본 패턴 SSOT
  ['.brief2dev/inbox/',                      '<root>/inbox/'], // @layout-resolver-allow — rewrite 매핑 원본 패턴 SSOT
  ['.brief2dev/',                            '<root>/'],  // catch-all — 마지막
];

// keep-marker: 라인 끝에 이 문자열이 있으면 치환 skip
const PATH_KEEP_MARKER = '@scaffold-path-keep';
// 보존 패턴: OSS attribution (transplants)
const PATH_KEEP_PATTERN = '.brief2dev/transplants/'; // @layout-resolver-allow — 보존 패턴 식별 상수

// 관점 2 파이프라인 데이터 루트의 단일 SSOT (scaffold-deploy / buildDefaultProjectConfig import).
export const SCAFFOLD_PIPELINE_DATA_ROOT = 'docs/brief2dev';

/** ordered longest-prefix replaceAll 적용 (치환 로직 SSOT) */
function applyOrderedRewrites(str, rewrites) {
  let s = str;
  for (const [from, to] of rewrites) {
    if (s.includes(from)) s = s.replaceAll(from, to);
  }
  return s;
}

function resolveRewrites(pipelineDataRoot) {
  return PIPELINE_PATH_REWRITES.map(([from, to]) => [from, to.replaceAll('<root>', pipelineDataRoot)]);
}

/**
 * 단일 path string 전용 치환 (frontmatter/SCAFFOLD-CONTEXT 로직 없음).
 * skill-contracts.json#required_files[].path 같은 단일 경로 정규화에 사용.
 * 보존 패턴/keep-marker 포함 시 무변경.
 */
export function rewriteSinglePath(pathStr, { pipelineDataRoot = SCAFFOLD_PIPELINE_DATA_ROOT } = {}) {
  if (!pathStr || typeof pathStr !== 'string') return pathStr;
  if (!pathStr.includes('.brief2dev/')) return pathStr;
  if (pathStr.includes(PATH_KEEP_PATTERN) || pathStr.includes(PATH_KEEP_MARKER)) return pathStr;
  return applyOrderedRewrites(pathStr, resolveRewrites(pipelineDataRoot));
}

export function rewritePipelineDataPaths(content, { pipelineDataRoot = SCAFFOLD_PIPELINE_DATA_ROOT } = {}) {
  if (!content || typeof content !== 'string') return content;
  // 참조 없으면 no-op (고속 경로)
  if (!content.includes('.brief2dev/')) return content;

  // 치환 테이블: '<root>' → 실제 pipelineDataRoot
  const rewrites = resolveRewrites(pipelineDataRoot);

  // frontmatter 블록 분리 (CRLF 안전 — injectContextBlock 정규식의 CRLF 강화판)
  const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
  const fmMatch = content.match(frontmatterRegex);
  let frontmatter = '';
  let body = content;
  if (fmMatch) {
    frontmatter = fmMatch[0];
    body = content.slice(fmMatch[0].length);
  }

  // SCAFFOLD-CONTEXT 블록 분리 (복수 블록 대비 — 첫 START ~ 마지막 END 전체 보호)
  const startIdx = body.indexOf(CONTEXT_BLOCK_START);
  const endIdx   = body.lastIndexOf(CONTEXT_BLOCK_END);
  let beforeCtx = body, ctxBlock = '', afterCtx = '';
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    beforeCtx = body.slice(0, startIdx);
    ctxBlock  = body.slice(startIdx, endIdx + CONTEXT_BLOCK_END.length);
    afterCtx  = body.slice(endIdx + CONTEXT_BLOCK_END.length);
  }

  // 라인 단위 치환 (CRLF 보존)
  function rewriteSegment(seg) {
    if (!seg.includes('.brief2dev/')) return seg;
    // \r?\n 으로 분할하고 CR 보존 (capture group → [line, sep, line, sep, ...])
    const lines = seg.split(/(\r?\n)/);
    const result = [];
    for (let i = 0; i < lines.length; i++) {
      const part = lines[i];
      // 홀수 인덱스는 separator — 그대로
      if (i % 2 === 1) { result.push(part); continue; }
      // 보존 조건
      if (part.includes(PATH_KEEP_PATTERN) || part.includes(PATH_KEEP_MARKER)) {
        result.push(part);
        continue;
      }
      result.push(applyOrderedRewrites(part, rewrites));
    }
    return result.join('');
  }

  const rewrittenBefore = rewriteSegment(beforeCtx);
  const rewrittenAfter  = rewriteSegment(afterCtx);

  return frontmatter + rewrittenBefore + ctxBlock + rewrittenAfter;
}

// ═══════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
