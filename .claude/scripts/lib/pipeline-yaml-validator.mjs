#!/usr/bin/env node

/**
 * pipeline-yaml-validator.mjs — 파이프라인 YAML ↔ pipeline-config.mjs 정합성 검증
 *
 * brief2dev.yaml의 step 정의와 pipeline-config.mjs의 STAGE_MAP을 교차 검증:
 *
 *   검증 1 (STEP_IDS): YAML steps 키 ↔ STAGE_MAP 키 일치
 *   검증 2 (INPUTS):   YAML steps.{id}.inputs ↔ STAGE_MAP[id].requiredInputJsonFiles 일치 (파일명 기준)
 *   검증 3 (SKILLS):   YAML steps.{id}.skill ↔ STAGE_MAP[id].skill 일치
 *   검증 4 (OUTPUTS):  YAML steps.{id}.outputs 경로 형식 유효성
 *
 * YAML 파싱: 외부 라이브러리 없이 line-by-line 텍스트 파싱
 * (brief2dev.yaml의 형식이 안정적이므로 정규식 기반으로 충분)
 *
 * 출력 형식: { valid: boolean, errors: [{ check, stageId, expected, actual }] }
 *
 * 사용법:
 *   node .claude/scripts/lib/pipeline-yaml-validator.mjs
 *   또는 import { validatePipelineYaml } from './pipeline-yaml-validator.mjs';
 *
 * 재사용:
 *   - pipeline-config.mjs의 STAGE_MAP, PROJECT_ROOT 상수
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { STAGE_MAP, PROJECT_ROOT, getRequiredInputs } from './pipeline-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const PIPELINE_YAML_PATH = join(PROJECT_ROOT, '.claude', 'pipelines', 'brief2dev.yaml');

/**
 * brief2dev.yaml의 steps 섹션을 파싱한다.
 * 각 step에서 skill, inputs, outputs를 추출.
 *
 * @param {string} content - YAML 파일 전체 내용
 * @returns {Map<string, { skill: string|null, inputs: string[], outputs: string[] }>}
 */
function parseYamlSteps(content) {
  const lines = content.split('\n');
  const steps = new Map();
  let inSteps = false;
  let currentStep = null;
  let currentArrayProp = null; // 'inputs' | 'outputs' | null

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.trim() === '' || trimmed.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);

    // 최상위 키 (indent 0)
    if (indent === 0) {
      inSteps = (trimmed.trim() === 'steps:');
      currentStep = null;
      currentArrayProp = null;
      continue;
    }

    if (!inSteps) continue;

    // Step ID (indent 2, 단일 키)
    const stepMatch = trimmed.match(/^  (\w+):$/);
    if (stepMatch) {
      currentStep = stepMatch[1];
      steps.set(currentStep, { skill: null, inputs: [], outputs: [] });
      currentArrayProp = null;
      continue;
    }

    if (!currentStep) continue;

    // 속성 + 인라인 값 (indent 4)
    if (indent === 4) {
      const propMatch = trimmed.trim().match(/^(\w+):\s+(.+)/);
      if (propMatch) {
        const key = propMatch[1];
        const val = propMatch[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
        if (key === 'skill') {
          steps.get(currentStep).skill = val;
        }
        currentArrayProp = null;
        continue;
      }

      // 속성 (배열/객체 시작, indent 4)
      const arrayStartMatch = trimmed.trim().match(/^(\w+):$/);
      if (arrayStartMatch) {
        const key = arrayStartMatch[1];
        currentArrayProp = (key === 'inputs' || key === 'outputs') ? key : null;
        continue;
      }
    }

    // 배열 항목 (indent 6, - prefix)
    if (indent === 6 && currentArrayProp) {
      const itemMatch = trimmed.trim().match(/^- (.+)/);
      if (itemMatch) {
        steps.get(currentStep)[currentArrayProp].push(itemMatch[1].trim());
        continue;
      }
    }

    // 더 깊은 중첩 (compensation, retry 등) → 배열 수집 중지
    if (indent >= 6 && !trimmed.trim().startsWith('- ')) {
      currentArrayProp = null;
    }
  }

  return steps;
}

/**
 * 파이프라인 YAML과 pipeline-config.mjs의 STAGE_MAP을 교차 검증한다.
 *
 * @returns {{ valid: boolean, errors: Array<{ check: string, stageId: string, expected: string, actual: string }> }}
 */
export function validatePipelineYaml() {
  const errors = [];

  if (!existsSync(PIPELINE_YAML_PATH)) {
    errors.push({
      check: 'FILE_EXISTS',
      stageId: '-',
      expected: PIPELINE_YAML_PATH,
      actual: '파일 미존재',
    });
    return { valid: false, errors };
  }

  const content = readFileSync(PIPELINE_YAML_PATH, 'utf-8');
  const yamlSteps = parseYamlSteps(content);
  const stageMapKeys = new Set(STAGE_MAP.keys());
  const yamlKeys = new Set(yamlSteps.keys());

  // 검증 1 (STEP_IDS): YAML steps 키 ↔ STAGE_MAP 키 일치
  for (const key of stageMapKeys) {
    if (!yamlKeys.has(key)) {
      errors.push({
        check: 'STEP_IDS',
        stageId: key,
        expected: 'YAML에 존재',
        actual: 'YAML에 미존재 (STAGE_MAP에만 존재)',
      });
    }
  }
  for (const key of yamlKeys) {
    if (!stageMapKeys.has(key)) {
      errors.push({
        check: 'STEP_IDS',
        stageId: key,
        expected: 'STAGE_MAP에 존재',
        actual: 'STAGE_MAP에 미존재 (YAML에만 존재)',
      });
    }
  }

  // 공통 키에 대해 상세 검증
  for (const [stageId, stageInfo] of STAGE_MAP) {
    const yamlStep = yamlSteps.get(stageId);
    if (!yamlStep) continue;

    // 검증 3 (SKILLS): skill 일치
    if (yamlStep.skill !== stageInfo.skill) {
      errors.push({
        check: 'SKILLS',
        stageId,
        expected: stageInfo.skill,
        actual: yamlStep.skill || '(없음)',
      });
    }

    // 검증 2 (INPUTS): inputs 일치 (와일드카드 포함 시 스킵)
    // YAML inputs: 전체 경로 (.brief2dev/runs/<run_id>/stage-output/xxx.json 또는 slug 포함)
    // STAGE_MAP: requiredInputJsonFiles (파일명만) → getRequiredInputs()로 전체 경로 생성
    const yamlInputs = yamlStep.inputs || [];
    const stageInputs = getRequiredInputs(stageId);
    const hasWildcard = yamlInputs.some(i => i.includes('*'));

    if (!hasWildcard) {
      // 파일명 기준으로 비교 (slug prefix 변동에 대응)
      const extractFilename = (p) => p.split('/').pop();
      const sortedYamlFiles = [...yamlInputs].map(extractFilename).sort();
      const sortedStageFiles = [...stageInputs].map(extractFilename).sort();
      const yamlStr = JSON.stringify(sortedYamlFiles);
      const stageStr = JSON.stringify(sortedStageFiles);

      if (yamlStr !== stageStr) {
        errors.push({
          check: 'INPUTS',
          stageId,
          expected: `STAGE_MAP: ${stageStr}`,
          actual: `YAML: ${yamlStr}`,
        });
      }
    }

    // 검증 4 (OUTPUTS): outputs 경로 형식 유효성 (기본 형식 체크)
    const yamlOutputs = yamlStep.outputs || [];
    for (const outputPath of yamlOutputs) {
      // 와일드카드가 아닌 경로는 docs/ 또는 유효한 경로 형식이어야 함
      if (!outputPath.includes('*') && !outputPath.match(/^[\w./<>-]+$/)) {
        errors.push({
          check: 'OUTPUTS',
          stageId,
          expected: '유효한 경로 형식 (영문, /, -, _, ., <placeholder>)',
          actual: outputPath,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// CLI entrypoint
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const result = validatePipelineYaml();
  if (result.valid) {
    console.log('파이프라인 YAML ↔ Code 정합성 검증 통과 (0 violations)');
  } else {
    console.log(`파이프라인 YAML ↔ Code 위반 ${result.errors.length}건:`);
    for (const err of result.errors) {
      console.log(`  [${err.check}] ${err.stageId}: 기대=${err.expected}, 실제=${err.actual}`);
    }
  }
  process.exit(result.valid ? 0 : 1);
}
