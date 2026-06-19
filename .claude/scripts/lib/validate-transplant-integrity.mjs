/**
 * validate-transplant-integrity.mjs - OSS 이식 정합성 검증
 *
 * 레지스트리의 모든 active 자산에 대해 8가지 교차 참조를 결정론적으로 검증한다.
 * 이식 완료 후 "유령 자산", "미등록 참조", "교차 참조 불일치"를 자동 감지하여
 * 동일 유형의 정합성 문제가 재발하지 않도록 보장한다.
 *
 * 검증 축 (8개, 2026-04-25 5→9축 확장 → 2026-05-22 RULE_ENFORCED_BY 제거로 8축):
 *   1. FILE_EXISTS         — target_path 파일이 실제로 존재하는가
 *   2. HOOK_SETTINGS       — hook 자산이 settings.json에 등록되어 있는가
 *   3. SKILL_MANIFEST      — template 자산이 부모 스킬 MANIFEST references에 등록되어 있는가
 *   4. DEPLOYED_ASSETS     — template 자산이 deployed-assets.json에 추적되는가
 *   5. FRONTMATTER_VALID   — skill/agent/rule .md의 YAML frontmatter가 유효한가 (R-CM-018)
 *   6. IMPORT_RESOLVE      — hook/script .mjs의 import 경로가 실제 파일을 가리키는가
 *   7. SKILL_DUPLICATE     — skill name 또는 trigger_keywords가 기존 스킬과 충돌하지 않는가
 *   8. CLAUDE_MD_STALENESS — CLAUDE.md의 카운트/참조가 deployed-skills/rules와 일치하는가
 *   [removed] RULE_ENFORCED_BY — MANIFEST.enforced_by 필드 폐지 (2026-05-22) 로 비교 대상 부재.
 *                                 rule .md `## Enforced by:` 가 단일 SSOT. audit-rule-enforcement.mjs
 *                                 (R-CM-024) I1-I5 가 자산 실재성/wiring 을 더 강하게 검증.
 *
 * 소비자:
 *   - ecosystem-health-guard.mjs (Stop L3) — 세션 종료 시 자동 실행
 *   - CLI 직접 실행: node .claude/scripts/lib/validate-transplant-integrity.mjs [--json]
 *
 * 근거:
 *   7건 정합성 이슈의 공통 근본 원인 해결 (2026-04-05 감사에서 발견)
 *   R-CM-015 (OSS Transplant Protocol) + R-CM-006 (Hook Convention) 강제
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname, isAbsolute } from 'node:path';
import { getTransplantsRoot } from './layout-resolver.mjs';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ═══════════════════════════════════════════════════════════════
// 유틸리티
// ═══════════════════════════════════════════════════════════════

function loadJSON(pathArg) {
  // P7-C Stage 2.3: 절대경로 / 상대경로 모두 지원 (layout-resolver 절대경로와 호환)
  const absPath = isAbsolute(pathArg) ? pathArg : join(PROJECT_DIR, pathArg);
  if (!existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function extractSkillName(targetPath) {
  // ".claude/skills/<skill-name>/references/..." → skill-name
  const match = targetPath.match(/\.claude\/skills\/([^/]+)\//);
  return match ? match[1] : null;
}

// ═══════════════════════════════════════════════════════════════
// 5가지 검증 축
// ═══════════════════════════════════════════════════════════════

function checkFileExists(asset) {
  const absPath = join(PROJECT_DIR, asset.target_path);
  if (existsSync(absPath)) return null;
  return {
    check: 'FILE_EXISTS',
    severity: 'CRITICAL',
    asset_id: asset.id,
    asset_name: asset.name,
    message: `파일 부재: ${asset.target_path}`,
  };
}

function checkHookSettings(asset, settingsContent) {
  if (asset.type !== 'hook') return null;

  const hookFile = basename(asset.target_path);
  if (settingsContent.includes(hookFile)) return null;

  return {
    check: 'HOOK_SETTINGS',
    severity: 'MAJOR',
    asset_id: asset.id,
    asset_name: asset.name,
    message: `settings.json에 미등록: ${hookFile}`,
  };
}

function checkSkillManifest(asset) {
  if (asset.type !== 'template') return null;

  const skillName = extractSkillName(asset.target_path);
  if (!skillName) return null;

  const manifest = loadJSON(`.claude/skills/${skillName}/MANIFEST.json`);
  if (!manifest) {
    return {
      check: 'SKILL_MANIFEST',
      severity: 'MAJOR',
      asset_id: asset.id,
      asset_name: asset.name,
      message: `스킬 MANIFEST 없음: ${skillName}/MANIFEST.json`,
    };
  }

  const refs = manifest.references || [];
  const refFile = asset.target_path.replace(`.claude/skills/${skillName}/`, '');
  const found = refs.some(r => r.file === refFile);
  if (found) return null;

  return {
    check: 'SKILL_MANIFEST',
    severity: 'MAJOR',
    asset_id: asset.id,
    asset_name: asset.name,
    message: `${skillName}/MANIFEST.json references에 미등록: ${refFile}`,
  };
}

function checkDeployedAssets(asset, deployedAssets) {
  if (asset.type !== 'template') return null;
  if (!deployedAssets) return null;

  const sr = deployedAssets.skill_references;
  if (!sr) return null;

  // Normalize target_path: ".claude/skills/X/references/Y" → "skills/X/references/Y"
  const deployPath = asset.target_path.replace(/^\.claude\//, '');

  // Check in always
  if (sr.always && sr.always.includes(deployPath)) return null;

  // Check in by_skill
  if (sr.by_skill) {
    for (const files of Object.values(sr.by_skill)) {
      if (files.includes(deployPath)) return null;
    }
  }

  // Check in templates (GH Actions etc.)
  if (sr.templates) {
    for (const files of Object.values(sr.templates)) {
      if (Array.isArray(files) && files.includes(deployPath)) return null;
    }
  }

  return {
    check: 'DEPLOYED_ASSETS',
    severity: 'MINOR',
    asset_id: asset.id,
    asset_name: asset.name,
    message: `deployed-assets.json에 미추적: ${deployPath}`,
  };
}

// checkRuleEnforcedBy 함수 제거 (2026-05-22 사용자 결정 — MANIFEST.enforced_by 필드 폐지).
// 이전 책임: rule .md ↔ MANIFEST.json 의 enforced_by prose 일치 검증.
// 폐지 사유: MANIFEST.json 의 enforced_by 필드 자체 제거 → 비교 대상 부재.
// 대체: audit-rule-enforcement.mjs (R-CM-024) 가 rule .md 의 `## Enforced by:` 만 SSOT 로 사용하여
//       I1 (dead_mechanism) / I2 (not_registered) / I5 (unwired_script) 검증.

// ═══════════════════════════════════════════════════════════════
// 6. FRONTMATTER_VALID — skill/agent/rule .md의 frontmatter (R-CM-018 #1, #3)
// ═══════════════════════════════════════════════════════════════

function checkFrontmatterValid(asset) {
  if (!['skill', 'agent', 'rule'].includes(asset.type)) return null;
  if (!asset.target_path.endsWith('.md')) return null;

  const absPath = join(PROJECT_DIR, asset.target_path);
  if (!existsSync(absPath)) return null; // FILE_EXISTS will catch this

  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }

  // skill: SKILL.md만 검사 (디렉토리)
  if (asset.type === 'skill' && !asset.target_path.endsWith('SKILL.md')) {
    // skill type asset의 target_path가 .claude/skills/{name}/ 인 경우 SKILL.md를 찾음
    const skillMd = absPath.endsWith('/') ? absPath + 'SKILL.md' : asset.target_path + '/SKILL.md';
    const skillAbs = join(PROJECT_DIR, skillMd);
    if (!existsSync(skillAbs)) return null;
    try { text = readFileSync(skillAbs, 'utf8'); } catch { return null; }
  }

  // YAML frontmatter 추출
  const fmMatch = text.match(/^---\n([\s\S]+?)\n---/);

  // rule은 frontmatter가 아닌 ## ID: 형식 사용 — 예외 처리
  if (asset.type === 'rule') {
    if (!/^## ID:\s*R-/m.test(text)) {
      return {
        check: 'FRONTMATTER_VALID',
        severity: 'MAJOR',
        asset_id: asset.id,
        asset_name: asset.name,
        message: `rule .md에 "## ID: R-..." 헤더 누락`,
      };
    }
    if (!/^## Severity:/m.test(text)) {
      return {
        check: 'FRONTMATTER_VALID',
        severity: 'MAJOR',
        asset_id: asset.id,
        asset_name: asset.name,
        message: `rule .md에 "## Severity:" 헤더 누락`,
      };
    }
    return null;
  }

  // skill/agent: YAML frontmatter 필수
  if (!fmMatch) {
    return {
      check: 'FRONTMATTER_VALID',
      severity: 'MAJOR',
      asset_id: asset.id,
      asset_name: asset.name,
      message: `${asset.type} .md에 YAML frontmatter 누락 (--- ... --- 블록)`,
    };
  }

  const fm = fmMatch[1];
  const issues = [];

  // name 필수 + kebab-case
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (!nameMatch) {
    issues.push('name 필드 누락');
  } else {
    const name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
    if (!/^[a-z][a-z0-9-]+$/.test(name)) {
      issues.push(`name="${name}"가 kebab-case 위반 (^[a-z][a-z0-9-]+$)`);
    }
  }

  // description 필수 + 10자 이상
  const descMatch = fm.match(/^description:\s*([\s\S]+?)(?=\n\w|$)/m);
  if (!descMatch) {
    issues.push('description 필드 누락');
  } else {
    const desc = descMatch[1].trim();
    if (desc.length < 10) {
      issues.push(`description이 너무 짧음 (${desc.length}자 < 10자)`);
    }
  }

  // R-CM-019: SKILL.md 본문에 버전 히스토리 금지 (skill만)
  if (asset.type === 'skill') {
    if (/^##\s*(변경\s*이력|Changelog|Version\s*History|릴리스\s*노트)/mi.test(text)) {
      issues.push('SKILL.md 본문에 버전 히스토리 섹션 존재 (R-CM-019 위반)');
    }
  }

  if (issues.length === 0) return null;
  return {
    check: 'FRONTMATTER_VALID',
    severity: 'MAJOR',
    asset_id: asset.id,
    asset_name: asset.name,
    message: `frontmatter 위반 (${issues.length}건): ${issues.join('; ')}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 7. IMPORT_RESOLVE — hook/script .mjs의 import 경로 검증
// ═══════════════════════════════════════════════════════════════

function checkImportResolve(asset) {
  if (!['hook', 'script'].includes(asset.type)) return null;
  if (!asset.target_path.endsWith('.mjs')) return null;

  const absPath = join(PROJECT_DIR, asset.target_path);
  if (!existsSync(absPath)) return null;

  let text;
  try { text = readFileSync(absPath, 'utf8'); } catch { return null; }

  // 상대 경로 import 추출 (./, ../, 또는 같은 디렉토리)
  const importPattern = /import\s+(?:.+?\s+from\s+)?['"]((?:\.\.?\/|\.\/)[^'"]+)['"]/g;
  const dir = dirname(absPath);
  const failed = [];

  let m;
  while ((m = importPattern.exec(text)) !== null) {
    const importPath = m[1];
    const resolved = join(dir, importPath);
    // .mjs 또는 .js 확장자 자동 시도
    const candidates = [
      resolved,
      resolved.endsWith('.mjs') || resolved.endsWith('.js') ? null : resolved + '.mjs',
      resolved.endsWith('.mjs') || resolved.endsWith('.js') ? null : resolved + '.js',
      join(resolved, 'index.mjs'),
      join(resolved, 'index.js'),
    ].filter(Boolean);
    if (!candidates.some(c => existsSync(c))) {
      failed.push(importPath);
    }
  }

  if (failed.length === 0) return null;
  return {
    check: 'IMPORT_RESOLVE',
    severity: 'CRITICAL',
    asset_id: asset.id,
    asset_name: asset.name,
    message: `미해결 import (${failed.length}건): ${failed.join(', ')}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 8. SKILL_DUPLICATE — skill name 충돌 + trigger_keywords 중복
// ═══════════════════════════════════════════════════════════════

function checkSkillDuplicate(asset, allTransplants) {
  if (asset.type !== 'skill') return null;

  // target_path에서 skill name 추출
  const m = asset.target_path.match(/\.claude\/skills\/([^/]+)/);
  if (!m) return null;
  const thisName = m[1];

  // 기존 .claude/skills/ 디렉토리 스캔
  const skillsDir = join(PROJECT_DIR, '.claude/skills');
  if (!existsSync(skillsDir)) return null;
  let dirs;
  try {
    dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(name => name !== thisName);
  } catch {
    return null;
  }

  // trigger_keywords 충돌 검사 (이 자산의 MANIFEST에서 추출)
  const thisManifestPath = join(skillsDir, thisName, 'MANIFEST.json');
  let thisTriggers = [];
  try {
    if (existsSync(thisManifestPath)) {
      const mf = JSON.parse(readFileSync(thisManifestPath, 'utf8'));
      thisTriggers = mf.public_api?.trigger_keywords || [];
    }
  } catch {}

  if (thisTriggers.length === 0) return null;

  const conflicts = [];
  for (const otherName of dirs) {
    const otherManifestPath = join(skillsDir, otherName, 'MANIFEST.json');
    if (!existsSync(otherManifestPath)) continue;
    try {
      const otherMf = JSON.parse(readFileSync(otherManifestPath, 'utf8'));
      const otherTriggers = otherMf.public_api?.trigger_keywords || [];
      const overlap = thisTriggers.filter(t => otherTriggers.includes(t));
      if (overlap.length > 0) {
        conflicts.push({ other: otherName, overlap });
      }
    } catch {}
  }

  if (conflicts.length === 0) return null;
  const summary = conflicts
    .slice(0, 3)
    .map(c => `${c.other}([${c.overlap.join(',')}])`)
    .join(', ');
  return {
    check: 'SKILL_DUPLICATE',
    severity: 'MAJOR',
    asset_id: asset.id,
    asset_name: asset.name,
    message: `trigger_keywords 충돌: ${summary}${conflicts.length > 3 ? ` (+${conflicts.length - 3})` : ''}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 9. CLAUDE_MD_STALENESS — CLAUDE.md 카운트/참조 정합성
// ═══════════════════════════════════════════════════════════════

let _claudeMdCache = null;
function loadClaudeMd() {
  if (_claudeMdCache !== null) return _claudeMdCache;
  const path = join(PROJECT_DIR, 'CLAUDE.md');
  if (!existsSync(path)) {
    _claudeMdCache = '';
    return '';
  }
  try {
    _claudeMdCache = readFileSync(path, 'utf8');
  } catch {
    _claudeMdCache = '';
  }
  return _claudeMdCache;
}

function checkClaudeMdStaleness(asset, deployedSkills) {
  // skill 자산만 처리. rule/hook은 transplant-wire에서 권고 출력만.
  if (asset.type !== 'skill') return null;
  if (!deployedSkills || !deployedSkills.total) return null;

  const claudeMd = loadClaudeMd();
  if (!claudeMd) return null;

  // CLAUDE.md에 "N개의 스킬", "스킬 N개", "전체 스킬: N" 같은 명시적 카운트 검사
  const m = claudeMd.match(/(\d{2,3})\s*개\s*(의\s*)?스킬|스킬\s*(\d{2,3})\s*개|전체\s*스킬\s*[:：]\s*(\d{2,3})/);
  if (!m) return null;
  const claimed = parseInt(m[1] || m[3] || m[4], 10);
  if (claimed === deployedSkills.total) return null;

  return {
    check: 'CLAUDE_MD_STALENESS',
    severity: 'MINOR',
    asset_id: asset.id,
    asset_name: asset.name,
    message: `CLAUDE.md "${m[0]}" vs deployed-skills.json total=${deployedSkills.total} 불일치 (${claimed} → ${deployedSkills.total} 갱신 필요)`,
  };
}

// ═══════════════════════════════════════════════════════════════
// 메인 검증 함수
// ═══════════════════════════════════════════════════════════════

export function validateTransplantIntegrity() {
  const emptyResult = {
    ok: true,
    checked: 0,
    total_issues: 0,
    by_severity: { CRITICAL: 0, MAJOR: 0, MINOR: 0 },
    by_check: {},
    issues: [],
  };
  const registry = loadJSON(join(getTransplantsRoot(), 'transplant-registry.json'));
  if (!registry) {
    return { ...emptyResult, message: 'No transplant registry found' };
  }

  const settingsPath = join(PROJECT_DIR, '.claude/settings.json');
  const settingsContent = existsSync(settingsPath)
    ? readFileSync(settingsPath, 'utf8')
    : '';

  const deployedAssets = loadJSON('.claude/skills/project-scaffolder/references/deployed-assets.json');
  // rulesManifest 로딩 제거 (2026-05-22): checkRuleEnforcedBy 폐지로 MANIFEST.enforced_by 의존 부재.
  const deployedSkills = loadJSON('.claude/skills/project-scaffolder/references/deployed-skills.json');

  const issues = [];
  let checked = 0;

  for (const transplant of registry.transplants || []) {
    for (const asset of transplant.assets || []) {
      // Skip non-active assets
      if (asset.status !== 'active') continue;
      checked++;

      const checks = [
        checkFileExists(asset),
        checkHookSettings(asset, settingsContent),
        checkSkillManifest(asset),
        checkDeployedAssets(asset, deployedAssets),
        // checkRuleEnforcedBy 제거 (2026-05-22): MANIFEST.enforced_by 필드 폐지로 .md ↔ MANIFEST 프로즈 비교
        // 자체가 무의미. enforced_by 의 자산 실재성/wiring 은 audit-rule-enforcement.mjs (R-CM-024) 가 검증.
        checkFrontmatterValid(asset),
        checkImportResolve(asset),
        checkSkillDuplicate(asset, registry.transplants),
        checkClaudeMdStaleness(asset, deployedSkills),
      ];

      for (const issue of checks) {
        if (issue) {
          issue.transplant_id = transplant.transplant_id;
          issue.source_oss = transplant.source_oss;
          issues.push(issue);
        }
      }
    }
  }

  const bySeverity = {
    CRITICAL: issues.filter(i => i.severity === 'CRITICAL').length,
    MAJOR: issues.filter(i => i.severity === 'MAJOR').length,
    MINOR: issues.filter(i => i.severity === 'MINOR').length,
  };

  const byCheck = {};
  for (const issue of issues) {
    byCheck[issue.check] = (byCheck[issue.check] || 0) + 1;
  }

  return {
    ok: issues.length === 0,
    checked,
    total_issues: issues.length,
    by_severity: bySeverity,
    by_check: byCheck,
    issues,
  };
}

// ═══════════════════════════════════════════════════════════════
// CLI 실행
// ═══════════════════════════════════════════════════════════════

const isDirectRun = process.argv[1]?.includes('validate-transplant-integrity');

if (isDirectRun) {
  const result = validateTransplantIntegrity();
  const jsonMode = process.argv.includes('--json');

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== Transplant Integrity Check ===`);
    console.log(`Checked: ${result.checked} active assets`);
    console.log(`Issues: ${result.total_issues} (CRITICAL: ${result.by_severity.CRITICAL}, MAJOR: ${result.by_severity.MAJOR}, MINOR: ${result.by_severity.MINOR})`);

    if (result.issues.length > 0) {
      console.log(`\n--- Issues ---`);
      for (const issue of result.issues) {
        console.log(`[${issue.severity}] ${issue.check} | ${issue.source_oss}/${issue.asset_name}`);
        console.log(`  ${issue.message}`);
      }
    } else {
      console.log(`\n✓ All transplanted assets are consistent.`);
    }
  }

  process.exit(result.ok ? 0 : 1);
}
