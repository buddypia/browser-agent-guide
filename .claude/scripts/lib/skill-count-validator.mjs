/**
 * skill-count-validator.mjs — 스킬 수 SSOT 정합성 검증
 *
 * 근본 원인 해결: deployed-skills.json (SSOT)의 스킬 수가
 * 다수의 문서/코드에 하드코딩되어 있어 drift가 발생하는 문제.
 *
 * 개선된 메커니즘 (R-CM-027):
 * 1. 하드코딩된 파일 목록(SCAN_FILES) 제거 -> 동적 디렉토리 스캔
 * 2. 하드코딩된 예외 숫자(ignoredNumbers) 제거 -> 인라인 예외 마커(@skill-count-ignore) 사용
 *
 * SSOT: .claude/skills/project-scaffolder/references/deployed-skills.json
 *
 * 예외 처리:
 *   의도적으로 다른 스킬 수를 적어야 하는 경우(예: 특정 카테고리 수, 이전 버전 언급 등),
 *   해당 줄에 `@skill-count-ignore` 를 추가하면 검증을 우회합니다.
 *   (HTML 주석 `<!-- @skill-count-ignore -->` 또는 JS 주석 `// @skill-count-ignore` 등 자유)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, sep } from 'path';
import { getHandoffDir, PROJECT_ROOT } from './pipeline-config.mjs';
import { safeReadJson } from './utils.mjs';

const SSOT_PATH = join(
  PROJECT_ROOT,
  '.claude', 'skills', 'project-scaffolder', 'references', 'deployed-skills.json'
);

export function readSSOT() {
  const json = safeReadJson(SSOT_PATH);
  if (!json) return null;

  const breakdown = {};
  let actualTotal = 0;
  for (const [cat, info] of Object.entries(json.categories || {})) {
    breakdown[cat] = info.count || info.skills?.length || 0;
    actualTotal += breakdown[cat];
  }
  return {
    total: json.total || actualTotal,
    actualTotal,
    breakdown,
  };
}

// 재귀적으로 파일 목록을 찾는 유틸리티
function findFiles(dir, exts, fileList = []) {
  if (!existsSync(dir)) return fileList;
  const files = readdirSync(dir);
  for (const file of files) {
    // 성능 최적화: 검색 불필요한 디렉토리 무시
    if (['node_modules', '.git', '.tmp', 'coverage', 'output', 'dist', 'build'].includes(file)) continue;

    const absPath = join(dir, file);
    if (statSync(absPath).isDirectory()) {
      findFiles(absPath, exts, fileList);
    } else {
      if (exts.some(ext => absPath.endsWith(ext))) {
        fileList.push(absPath);
      }
    }
  }
  return fileList;
}

// 동적으로 검증 대상 파일들을 수집
function getTargetFiles() {
  const targets = [];
  
  // 1. Root 파일들
  ['CLAUDE.md', 'README.md'].forEach(f => {
    const p = join(PROJECT_ROOT, f);
    if (existsSync(p)) targets.push(p);
  });

  // 2. 디렉토리 스캔
  const scanDirs = [
    { dir: 'docs', exts: ['.md', '.svg'] },
    { dir: join('.claude', 'skills'), exts: ['SKILL.md'] },
    { dir: join('.claude', 'rules'), exts: ['.md'] },
    { dir: getHandoffDir(), exts: ['.json'], absolute: true },
  ];

  scanDirs.forEach(({dir, exts, absolute}) => {
    findFiles(absolute ? dir : join(PROJECT_ROOT, dir), exts, targets);
  });

  // 3. 특정 스크립트 파일들 (과거 SCAN_FILES에 있던 durable source만 유지)
  const specificFiles = [
    join('.claude', 'scripts', 'scaffold-deploy.mjs')
  ];
  specificFiles.forEach(f => {
    const p = join(PROJECT_ROOT, f);
    if (existsSync(p) && !targets.includes(p)) targets.push(p);
  });

  return targets;
}

const SKILL_COUNT_PATTERNS = [
  /(\d+)\s*개 스킬/g,
  /(\d+)\s*skills/gi,
  /(\d+)\s*Skills/g,
  /skills\/?\s*\((\d+)개\)/gi,
  // 기존 /(\d+)개\)/g 는 문서 전체 스캔 시 너무 많은 오탐을 유발하므로 제거하고
  // 명시적인 패턴만 허용합니다. 필요 시 @skill-count-ignore 를 사용.
];

const IGNORE_MARKER = '@skill-count-ignore';

export function validateSkillCounts() {
  const ssot = readSSOT();
  if (!ssot) {
    return { valid: true, ssotTotal: 0, mismatches: [], error: 'SSOT not found' };
  }

  const expected = ssot.total;
  const mismatches = [];

  // 동적 허용 숫자 계산 (오탐 방지)
  const validNumbers = new Set([expected]);
  for (const count of Object.values(ssot.breakdown)) {
    validNumbers.add(count);
  }
  
  // 파이프라인/Tier 스킬 제외 수식 (하드코딩 제거를 위해 동적 계산)
  const pipelineCount = ssot.breakdown.pipeline || 0;
  const tier1Count = ssot.breakdown.tier1_orchestrators || 0;
  if (pipelineCount > 0) {
    validNumbers.add(expected - pipelineCount); // devSkillCount
    validNumbers.add(expected - pipelineCount - tier1Count); // tier2Total
  }

  const targetFiles = getTargetFiles();

  for (const absPath of targetFiles) {
    let content;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch { continue; }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 인라인 예외 마커 확인
      if (line.includes(IGNORE_MARKER)) continue;

      for (const pattern of SKILL_COUNT_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const num = parseInt(match[1], 10);
          
          // 동적으로 허용된 숫자(SSOT total, 카테고리 수 등)면 통과
          if (validNumbers.has(num)) continue;
          
          // 그 외의 숫자는 예외 마커가 없다면 drift로 간주
          // 지나치게 작은 숫자는 문서의 일반적인 나열일 수 있으므로 10 이상만 감지
          if (num >= 10 && num <= 200) {
            // 프로젝트 상대 경로 계산
            const relPath = absPath.replace(PROJECT_ROOT + sep, '');
            mismatches.push({
              file: relPath,
              lineNum: i + 1,
              lineText: line.trim().slice(0, 120),
              found: num,
              expected,
            });
          }
        }
      }
    }
  }

  // 중복 매칭 제거 (같은 줄에 여러 패턴이 매칭될 수 있음)
  const uniqueMismatches = mismatches.filter((item, index, self) =>
    index === self.findIndex((t) => (
      t.file === item.file && t.lineNum === item.lineNum && t.found === item.found
    ))
  );

  return {
    valid: uniqueMismatches.length === 0,
    ssotTotal: expected,
    ssotBreakdown: ssot.breakdown,
    mismatches: uniqueMismatches,
  };
}

// ═══════════════════════════════════════════════════════════════
// Skill Catalog 정합성 (README ↔ SSOT 스킬 *이름* 미러 drift)
//
// 근본 원인: README "## 스킬 에코시스템" 섹션이 deployed-skills.json(SSOT)의
// 카테고리별 스킬 이름 목록을 수동 미러링한다. 스킬 삭제/리네임/추가 시 README가
// stale 해져도 validateSkillCounts(숫자 검사)는 잡지 못한다 — 정규식이 카테고리
// 헤더 `(N개)` 를 매칭하지 않고, 숫자 멤버십은 다른 카테고리에 같은 수가 있으면
// 통과시키기 때문. 본 검증은 이름 차원(양방향) + 카테고리 헤더 카운트로 보강한다.
// boundary: 관점 1 (brief2dev 자체 README) 전용 — scaffold target README 는 스킬
// 카탈로그 미러가 아니므로 미적용 (R-CM-028 배포 분리).
// ═══════════════════════════════════════════════════════════════

const README_PATH = join(PROJECT_ROOT, 'README.md');
// "## 스킬 에코시스템" 섹션 헤더 (앞뒤 공백 / CRLF 허용)
const CATALOG_SECTION_RE = /^##\s+스킬\s*에코시스템/;
// "### Label (N개) — desc" 카테고리 헤더 → 선언 카운트 캡처
const CATEGORY_HEADER_RE = /^###\s.*?\((\d+)\s*개\)/;
// 백틱 kebab 스킬명. 시작은 소문자, 이후 소문자/숫자/하이픈만 → 경로(.앞), 대문자, _ 제외
const SKILL_NAME_RE = /`([a-z][a-z0-9-]*)`/g;

// SSOT의 모든 deployed 스킬 이름 + excluded 이름 집합
export function readSkillNameSets() {
  const json = safeReadJson(SSOT_PATH);
  if (!json) return null;
  const skills = new Set();
  for (const info of Object.values(json.categories || {})) {
    for (const s of info.skills || []) skills.add(s);
  }
  const excluded = new Set(json.excluded?.skills || []);
  return { skills, excluded };
}

// README "## 스킬 에코시스템" 섹션을 카테고리 블록 단위로 파싱 (순수 — 텍스트 입력).
// @returns {{ blocks: Array<{label, declared, names:[{name,lineNum}], headerLine}>, catalogNames: Set }}
export function parseSkillCatalog(content) {
  const lines = content.split('\n');
  const blocks = [];
  const catalogNames = new Set();
  let inSection = false;
  let block = null;

  const closeBlock = () => { if (block) { blocks.push(block); block = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (CATALOG_SECTION_RE.test(line)) { inSection = true; continue; }
    if (inSection && /^##\s/.test(line)) { closeBlock(); inSection = false; continue; }
    if (!inSection) continue;

    const cat = line.match(CATEGORY_HEADER_RE);
    if (cat) {
      closeBlock();
      block = { label: line.replace(/^###\s+/, '').trim(), declared: parseInt(cat[1], 10), names: [], headerLine: i + 1 };
      continue;
    }
    if (!block) continue; // 섹션 intro 등 블록 밖 토큰 무시
    SKILL_NAME_RE.lastIndex = 0;
    let m;
    while ((m = SKILL_NAME_RE.exec(line)) !== null) {
      block.names.push({ name: m[1], lineNum: i + 1 });
      catalogNames.add(m[1]);
    }
  }
  closeBlock();
  return { blocks, catalogNames };
}

// 파싱된 블록 + SSOT 집합으로부터 정합성 issue 목록 생성
export function collectCatalogIssues(blocks, catalogNames, sets) {
  const issues = [];
  for (const b of blocks) {
    if (b.declared !== b.names.length) {
      issues.push({ kind: 'count_mismatch', file: 'README.md', lineNum: b.headerLine, label: b.label, found: b.declared, expected: b.names.length });
    }
    for (const { name, lineNum } of b.names) {
      if (!sets.skills.has(name) && !sets.excluded.has(name)) {
        issues.push({ kind: 'phantom', file: 'README.md', lineNum, name });
      }
    }
  }
  for (const s of sets.skills) {
    if (!catalogNames.has(s)) issues.push({ kind: 'missing', file: 'README.md', lineNum: 0, name: s });
  }
  return issues;
}

/**
 * README 스킬 카탈로그가 SSOT(deployed-skills.json)와 이름/카운트 정합한지 검증.
 * @param {{readmePath?: string}} [opts]
 * @returns {{valid: boolean, issues: Array, error?: string}}
 *   issue kinds: 'phantom'(README엔 있으나 SSOT/excluded 부재),
 *                'missing'(SSOT엔 있으나 카탈로그 부재),
 *                'count_mismatch'(헤더 (N개) ≠ 블록 내 스킬명 수)
 */
export function validateSkillCatalog(opts = {}) {
  const readmePath = opts.readmePath || README_PATH;
  const sets = readSkillNameSets();
  if (!sets) return { valid: true, issues: [], error: 'SSOT not found' };
  if (!existsSync(readmePath)) return { valid: true, issues: [], error: 'README not found' };

  let content;
  try {
    content = readFileSync(readmePath, 'utf-8');
  } catch {
    return { valid: true, issues: [], error: 'README read failed' };
  }

  const { blocks, catalogNames } = parseSkillCatalog(content);
  // 카탈로그 섹션을 못 찾았으면(헤더 부재) 검증 skip — false positive 회피
  if (blocks.length === 0) return { valid: true, issues: [], error: 'catalog section not found' };

  const issues = collectCatalogIssues(blocks, catalogNames, sets);
  return { valid: issues.length === 0, issues };
}
