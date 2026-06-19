/**
 * Engineering plan contract validator.
 *
 * JSON Schema validates shape. This module validates the cross-field rule that
 * every declared failure mode maps to a concrete write_test step.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate as validateSchema } from './schema-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const isCli = process.argv[1] && resolve(process.argv[1]) === __filename;

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectWriteTestText(plan) {
  const chunks = [];
  for (const task of plan?.tasks || []) {
    for (const step of task.steps || []) {
      if (step.type !== 'write_test') continue;
      chunks.push(step.action, step.code, step.expected);
    }
  }
  return normalize(chunks.join(' '));
}

function collectTaskNumbers(plan) {
  return new Set((plan?.tasks || []).map((task) => task.number));
}

/**
 * @param {object} plan
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateEngineeringPlanContract(plan) {
  const errors = [];
  const schemaResult = validateSchema('stage-output/engineering-plan', plan);
  if (!schemaResult.ok) {
    for (const error of schemaResult.errors || []) {
      errors.push(`schema${error.instancePath || ''}: ${error.message}`);
    }
  }

  const writeTestText = collectWriteTestText(plan);
  for (const failureMode of plan?.failure_modes_registry || []) {
    for (const testCase of failureMode.test_cases || []) {
      const needle = normalize(testCase);
      if (!needle || !writeTestText.includes(needle)) {
        errors.push(
          `failure mode "${failureMode.codepath}:${failureMode.failure_mode}" test case "${testCase}" is not present in any write_test step`,
        );
      }
    }
  }

  const taskNumbers = collectTaskNumbers(plan);
  for (const lane of plan?.worktree_parallelization_strategy?.lanes || []) {
    for (const taskNumber of lane.tasks || []) {
      if (!taskNumbers.has(taskNumber)) {
        errors.push(`worktree lane "${lane.name}" references unknown Task ${taskNumber}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function collectPlanArtifacts(rootDir) {
  const featuresDir = join(rootDir, 'docs', 'features');
  const planMarkdownDirs = new Set();
  const contractFiles = new Set();

  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'PLAN.md') planMarkdownDirs.add(dirname(path));
      if (entry.name === 'PLAN.contract.json') contractFiles.add(path);
    }
  }

  walk(featuresDir);
  return { featuresDir, planMarkdownDirs, contractFiles };
}

/**
 * Validate durable engineering-plan contracts under docs/features/**.
 *
 * PLAN.md is optimized for humans and agents. PLAN.contract.json is the
 * machine-checkable sibling that lets quality gates enforce the same promises.
 *
 * @param {string} rootDir
 * @returns {{valid: boolean, errors: string[], checked: number, skipped: boolean}}
 */
export function scanEngineeringPlanContracts(rootDir = process.cwd()) {
  const root = resolve(rootDir);
  const errors = [];
  const { featuresDir, planMarkdownDirs, contractFiles } = collectPlanArtifacts(root);

  if (!existsSync(featuresDir)) {
    return { valid: true, errors, checked: 0, skipped: true };
  }

  for (const planDir of planMarkdownDirs) {
    const contractPath = join(planDir, 'PLAN.contract.json');
    if (!existsSync(contractPath)) {
      errors.push(`${relative(root, join(planDir, 'PLAN.md'))} is missing PLAN.contract.json`);
    } else {
      contractFiles.add(contractPath);
    }
  }

  for (const contractPath of contractFiles) {
    const label = relative(root, contractPath);
    let plan;
    try {
      plan = JSON.parse(readFileSync(contractPath, 'utf-8'));
    } catch (error) {
      errors.push(`${label}: invalid JSON (${error.message})`);
      continue;
    }

    const result = validateEngineeringPlanContract(plan);
    if (!result.valid) {
      for (const error of result.errors) {
        errors.push(`${label}: ${error}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    checked: contractFiles.size,
    skipped: planMarkdownDirs.size === 0 && contractFiles.size === 0,
  };
}

if (isCli) {
  const root = process.argv[2] || process.cwd();
  const result = scanEngineeringPlanContracts(root);
  if (result.skipped) {
    console.log('ℹ️  Engineering plan contracts not applicable: no docs/features/**/PLAN.md files');
  } else if (result.valid) {
    console.log(`✅ Engineering plan contracts passed (${result.checked} contract file(s))`);
  } else {
    console.error('❌ Engineering plan contract validation failed');
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
}
