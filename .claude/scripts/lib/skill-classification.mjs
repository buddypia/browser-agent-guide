/**
 * skill-classification.mjs
 *
 * brief2dev 세션 실행 가능성 분류 SSOT 헬퍼.
 * `data/registry/skill-classification.json` 의 분류를 Set 으로 변환하여 반환.
 *
 * 소비자:
 * - `.claude/hooks/pipeline-boundary-guard.mjs` — getBlockedSkills() / getAllowedResearchSkills()
 * - `.claude/scripts/audit-context-bloat.mjs` — getBlockedSkills() / getAllowedSkills()
 *
 * R-CM-028 boundary-uniform: 두 소비자 모두 관점 1 (brief2dev 자체) 분류.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_DIR = resolve(dirname(__filename), '..', '..', '..');
const SSOT_PATH = join(PROJECT_DIR, 'data/registry/skill-classification.json');

let cache = null;

function loadClassification() {
  if (cache !== null) return cache;
  const raw = readFileSync(SSOT_PATH, 'utf8');
  cache = JSON.parse(raw);
  return cache;
}

function getBlockedSkills() {
  const c = loadClassification();
  return new Set([
    ...c.blocked.tier_1_orchestrators,
    ...c.blocked.tier_2_delivery,
    ...c.blocked.tier_2_discovery,
    ...c.blocked.tier_2_design,
  ]);
}

function getAllowedPipelineSkills() {
  const c = loadClassification();
  return new Set(c.allowed_pipeline.skills);
}

function getAllowedResearchSkills() {
  const c = loadClassification();
  return new Set(c.allowed_research.skills);
}

function getAllowedSkills() {
  return new Set([
    ...getAllowedPipelineSkills(),
    ...getAllowedResearchSkills(),
  ]);
}

function clearCache() {
  cache = null;
}

export {
  loadClassification,
  getBlockedSkills,
  getAllowedPipelineSkills,
  getAllowedResearchSkills,
  getAllowedSkills,
  clearCache,
  SSOT_PATH,
};
