#!/usr/bin/env node

// skill-dependency-validator.mjs — 스킬 의존성 그래프 일관성 검증
//
// 모든 .claude/skills/{id}/MANIFEST.json을 스캔하여 3가지 계약을 검증:
//
//   검증 1 (BIDIRECTIONAL): A.calls에 B가 있으면 → B.called_by에 A가 있어야 함
//   검증 2 (SKILL_EXISTS):  calls/called_by의 모든 ID → .claude/skills/{id}/ 존재
//   검증 3 (FRONTMATTER_SYNC): Tier 1 스킬의 MANIFEST.calls → SKILL.md frontmatter calls: 일치
//
// 출력 형식: { valid: boolean, errors: [{ check, skillA, skillB?, message }] }
//
// 사용법:
//   node .claude/scripts/lib/skill-dependency-validator.mjs
//   또는 import { validateSkillDependencies } from './skill-dependency-validator.mjs';
//
// 재사용:
//   - pipeline-config.mjs의 SKILLS_DIR 상수
//   - schema-validator.mjs의 validate() 패턴 (errors 배열 반환)

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { SKILLS_DIR } from './pipeline-config.mjs';

const __filename = fileURLToPath(import.meta.url);

/**
 * 모든 스킬 MANIFEST.json을 로드한다.
 * @returns {Map<string, object>} skillId → manifest
 */
function loadAllManifests() {
  const manifests = new Map();
  if (!existsSync(SKILLS_DIR)) return manifests;

  try {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const manifestPath = join(SKILLS_DIR, entry.name, 'MANIFEST.json');
      if (!existsSync(manifestPath)) continue;
      try {
        manifests.set(entry.name, JSON.parse(readFileSync(manifestPath, 'utf-8')));
      } catch { /* skip malformed */ }
    }
  } catch { /* skip */ }

  return manifests;
}

/**
 * SKILL.md frontmatter에서 calls: 배열을 추출한다.
 * @param {string} skillId
 * @returns {string[]|null} calls 배열 또는 null (frontmatter/calls 미존재)
 */
function parseFrontmatterCalls(skillId) {
  const skillMdPath = join(SKILLS_DIR, skillId, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;

  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1] + '\n'; // 마지막 줄 trailing newline 보장
    const callsMatch = fm.match(/\ncalls:\n((?:\s+- .+\n)*)/);
    if (!callsMatch) return null;

    const calls = [];
    for (const line of callsMatch[1].split('\n')) {
      const m = line.match(/^\s+-\s+(.+)/);
      if (m) calls.push(m[1].trim());
    }
    return calls;
  } catch {
    return null;
  }
}

/**
 * 스킬 의존성 그래프의 일관성을 검증한다.
 *
 * @returns {{ valid: boolean, errors: Array<{ check: string, skillA: string, skillB?: string, message: string }> }}
 */
export function validateSkillDependencies() {
  const errors = [];
  const manifests = loadAllManifests();

  // 검증 1 (BIDIRECTIONAL): A.calls에 B → B.called_by에 A 존재 확인
  for (const [skillId, manifest] of manifests) {
    const calls = manifest.calls || [];
    for (const calledId of calls) {
      const calledManifest = manifests.get(calledId);
      if (!calledManifest) continue; // SKILL_EXISTS에서 별도 검증
      const calledBy = calledManifest.called_by || [];
      if (!calledBy.includes(skillId)) {
        errors.push({
          check: 'BIDIRECTIONAL',
          skillA: skillId,
          skillB: calledId,
          message: `${skillId}.calls → ${calledId} 이지만, ${calledId}.called_by에 ${skillId} 없음`,
        });
      }
    }
  }

  // 검증 1b (BIDIRECTIONAL 역방향): A.called_by에 B → B.calls에 A 존재 확인
  for (const [skillId, manifest] of manifests) {
    const calledBy = manifest.called_by || [];
    for (const callerId of calledBy) {
      const callerManifest = manifests.get(callerId);
      if (!callerManifest) continue; // SKILL_EXISTS에서 별도 검증
      const callerCalls = callerManifest.calls || [];
      if (!callerCalls.includes(skillId)) {
        errors.push({
          check: 'BIDIRECTIONAL',
          skillA: callerId,
          skillB: skillId,
          message: `${skillId}.called_by → ${callerId} 이지만, ${callerId}.calls에 ${skillId} 없음`,
        });
      }
    }
  }

  // 검증 2 (SKILL_EXISTS): calls/called_by → 디렉토리 존재
  const checked = new Set();
  for (const [skillId, manifest] of manifests) {
    for (const refId of [...(manifest.calls || []), ...(manifest.called_by || [])]) {
      const key = `${skillId}→${refId}`;
      if (checked.has(key)) continue;
      checked.add(key);

      const refDir = join(SKILLS_DIR, refId);
      if (!existsSync(refDir)) {
        errors.push({
          check: 'SKILL_EXISTS',
          skillA: skillId,
          skillB: refId,
          message: `${skillId}가 참조하는 스킬 ${refId}의 디렉토리 .claude/skills/${refId}/ 미존재`,
        });
      }
    }
  }

  // 검증 3 (FRONTMATTER_SYNC): Tier 1 MANIFEST.calls ↔ SKILL.md calls:
  for (const [skillId, manifest] of manifests) {
    if (manifest.tier !== 1) continue;

    const manifestCalls = [...(manifest.calls || [])].sort();
    const frontmatterCalls = parseFrontmatterCalls(skillId);

    if (frontmatterCalls === null) {
      if (manifestCalls.length > 0) {
        errors.push({
          check: 'FRONTMATTER_SYNC',
          skillA: skillId,
          message: `Tier 1 ${skillId}: MANIFEST에 ${manifestCalls.length}개 calls, SKILL.md frontmatter에 calls: 없음`,
        });
      }
      continue;
    }

    const sortedFm = [...frontmatterCalls].sort();
    const inManifestOnly = manifestCalls.filter(c => !sortedFm.includes(c));
    const inFrontmatterOnly = sortedFm.filter(c => !manifestCalls.includes(c));

    if (inManifestOnly.length > 0) {
      errors.push({
        check: 'FRONTMATTER_SYNC',
        skillA: skillId,
        message: `${skillId}: MANIFEST에만 존재하는 calls: [${inManifestOnly.join(', ')}]`,
      });
    }
    if (inFrontmatterOnly.length > 0) {
      errors.push({
        check: 'FRONTMATTER_SYNC',
        skillA: skillId,
        message: `${skillId}: SKILL.md frontmatter에만 존재하는 calls: [${inFrontmatterOnly.join(', ')}]`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// CLI entrypoint
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const result = validateSkillDependencies();
  if (result.valid) {
    console.log('스킬 의존성 그래프 검증 통과 (0 violations)');
  } else {
    console.log(`스킬 의존성 그래프 위반 ${result.errors.length}건:`);
    for (const err of result.errors) {
      console.log(`  [${err.check}] ${err.message}`);
    }
  }
  process.exit(result.valid ? 0 : 1);
}
