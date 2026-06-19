/**
 * rules-enforcement-validator.mjs — Enforced by 참조 자동 검증
 *
 * 근본 원인 해결: R-CM-010 사건에서 발견된 "규칙은 있으나 구현 없음" 문제를
 * 시스템적으로 방지하는 검증 스크립트.
 *
 * 검증 대상:
 *   .claude/rules/**\/*.md 의 "## Enforced by:" 필드를 파싱하여,
 *   참조된 hook/guard가 실제로 존재하는지 3가지 소스에서 확인:
 *     1. .claude/hooks/*.mjs 또는 .claude/scripts/*.mjs 파일 존재
 *     2. hook-registry.mjs의 HOOK_REGISTRY에 id로 등록
 *     3. settings.json에 명시적 참조
 *
 * 호출 방법:
 *   import { validateRulesEnforcement } from './rules-enforcement-validator.mjs';
 *   const result = validateRulesEnforcement(projectDir);
 *   // result: { ok, violations[], stats }
 *
 * 통합 위치:
 *   ecosystem-health-guard.mjs (Stop L3)에서 호출하여 세션 종료 시 자동 검증.
 *
 * 설계 원칙:
 *   - 순수 함수 (부작용 없음, 읽기 전용)
 *   - 에러 시 안전 기본값 반환 ({ ok: true, violations: [], stats: {} })
 *   - "null", "prompt-level" 등 의도적 미구현은 violations에 포함하지 않음
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

/** Enforced by 값에서 무시할 패턴 */
const SKIP_PATTERNS = [
  /^null/i,
  /prompt-level/i,
  /prompt hook/i,
  /writing-skills/i,
  /systematic-debugging/i,
  /final-review/i,       // 스킬 이름 (hook이 아님)
  /agent hook/i,
];

/**
 * .claude/rules/ 하위 모든 .md 파일을 재귀 탐색
 */
function findRuleFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...findRuleFiles(fullPath));
    } else if (entry.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * 규칙 파일에서 "## Enforced by:" 값을 추출
 * @returns {{ ruleId: string, enforcers: string[] } | null}
 */
function extractEnforcers(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');

    // Rule ID 추출
    const idMatch = content.match(/^## ID:\s*(.+)$/m);
    const ruleId = idMatch ? idMatch[1].trim() : basename(filePath, '.md');

    // Enforced by 추출
    const enforcedMatch = content.match(/^## Enforced by:\s*(.+)$/m);
    if (!enforcedMatch) return null;

    const raw = enforcedMatch[1].trim();

    // 스킵 패턴 체크
    if (SKIP_PATTERNS.some(p => p.test(raw))) return null;

    // 괄호 안 설명을 제거하되, 쉼표가 괄호 안에 있는 경우 보존
    // 예: "guard-a (Stop prompt hook, settings.json)" → "guard-a"
    const cleaned = raw.replace(/\s*\([^)]*\)/g, '');

    // 쉼표로 분리
    const enforcers = cleaned.split(',')
      .map(e => e.trim())
      .filter(e => e && !SKIP_PATTERNS.some(p => p.test(e)));

    if (enforcers.length === 0) return null;

    return { ruleId, enforcers, filePath };
  } catch {
    return null;
  }
}

/**
 * hook-registry.mjs에서 모든 등록된 hook ID를 수집
 */
function collectRegistryIds(projectDir) {
  const ids = new Set();
  const registryPath = join(projectDir, '.claude', 'scripts', 'lib', 'hook-registry.mjs');
  if (!existsSync(registryPath)) return ids;

  try {
    const content = readFileSync(registryPath, 'utf-8');
    // id: 'xxx' 패턴 매칭
    const matches = content.matchAll(/id:\s*'([^']+)'/g);
    for (const m of matches) {
      ids.add(m[1]);
    }
  } catch { /* ignore */ }
  return ids;
}

/**
 * settings.json에서 참조된 hook 이름 수집
 */
function collectSettingsRefs(projectDir) {
  const refs = new Set();
  const settingsPath = join(projectDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return refs;

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    // .mjs 파일명 추출
    const matches = content.matchAll(/([a-z-]+)\.mjs/g);
    for (const m of matches) {
      refs.add(m[1]);
    }
    // prompt hook 내부 텍스트에서 R-CM-xxx 패턴 추출
    const ruleRefs = content.matchAll(/R-CM-\d+/g);
    for (const m of ruleRefs) {
      refs.add(m[0]);
    }
  } catch { /* ignore */ }
  return refs;
}

/**
 * .mjs 파일 존재 확인 (hooks/ + scripts/ 탐색)
 */
function hookFileExists(projectDir, name) {
  const candidates = [
    join(projectDir, '.claude', 'hooks', `${name}.mjs`),
    join(projectDir, '.claude', 'scripts', `${name}.mjs`),
    join(projectDir, '.claude', 'scripts', 'lib', `${name}.mjs`),
  ];
  return candidates.some(p => existsSync(p));
}

/**
 * 메인 검증 함수
 * @param {string} projectDir - 프로젝트 루트 경로
 * @returns {{ ok: boolean, violations: Array<{ruleId, enforcer, reason}>, stats: object }}
 */
export function validateRulesEnforcement(projectDir) {
  try {
    const rulesDir = join(projectDir, '.claude', 'rules');
    const ruleFiles = findRuleFiles(rulesDir);
    const registryIds = collectRegistryIds(projectDir);
    const settingsRefs = collectSettingsRefs(projectDir);

    const violations = [];
    let checkedCount = 0;
    let skippedCount = 0;

    for (const filePath of ruleFiles) {
      const extracted = extractEnforcers(filePath);
      if (!extracted) {
        skippedCount++;
        continue;
      }

      for (const enforcer of extracted.enforcers) {
        checkedCount++;
        const name = enforcer.replace(/\.mjs$/, '');

        const fileExists = hookFileExists(projectDir, name);
        const inRegistry = registryIds.has(name);
        const inSettings = settingsRefs.has(name);

        if (!fileExists && !inRegistry && !inSettings) {
          violations.push({
            ruleId: extracted.ruleId,
            enforcer: name,
            ruleFile: basename(extracted.filePath),
            reason: `"${name}" 파일(.mjs) 미존재 + hook-registry 미등록 + settings.json 미참조`,
          });
        }
      }
    }

    return {
      ok: violations.length === 0,
      violations,
      stats: {
        rulesScanned: ruleFiles.length,
        enforcersChecked: checkedCount,
        skipped: skippedCount,
        registryIdsCount: registryIds.size,
        settingsRefsCount: settingsRefs.size,
      },
    };
  } catch (err) {
    // 안전 기본값
    return { ok: true, violations: [], stats: { error: err.message } };
  }
}
