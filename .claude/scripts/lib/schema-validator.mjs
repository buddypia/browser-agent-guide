/**
 * schema-validator.mjs — JSON Schema 기반 스테이지 산출물 검증
 *
 * trip-jarvis의 Contract-First Guard 개념을 brief2dev 파이프라인에 이식.
 * API Contract 대신 Stage Output JSON Schema로 강제.
 *
 * 특징:
 *   - 외부 의존성 없음 (ajv 등 미사용). JSON Schema Draft 2020-12 서브셋 직접 검증.
 *   - required, type, enum, minLength, minItems, minimum, maximum, pattern 지원.
 *   - 깊이 3까지 중첩 객체 검증 (파이프라인 산출물에 충분).
 *   - $defs + $ref 지원: 로컬 (#/$defs/...) + 외부 파일 (../common/...#/$defs/...).
 *   - allOf 지원: 배열 항목을 병합하여 검증.
 *   - 외부 $ref 파일은 1회 로드 후 캐싱.
 *
 * 소비자:
 *   - phase-boundary-file-guard.mjs (PreToolUse Write|Edit)
 *   - pipeline-drift-guard.mjs (Stop)
 *   - pipeline-validator.mjs (validateSchema)
 *
 * 설계 원칙:
 *   - 외부 의존성 0 (node_modules 불필요)
 *   - 실패 시 에러 메시지 반환 (throw 안 함)
 *   - 스키마 로딩은 1회 캐싱
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { STAGE_SCHEMAS_DIR, SCHEMAS_DIR as SYSTEM_SCHEMAS_DIR } from './pipeline-config.mjs';
import { safeReadJson } from './utils.mjs';

/** stage-output/ 디렉토리 (스테이지별 스키마 위치) */
const SCHEMAS_DIR = STAGE_SCHEMAS_DIR;

/** 스테이지 ID → 스키마 파일명 매핑 */
const STAGE_SCHEMA_MAP = {
  intake: 'business-context.schema.json',
  market_research: 'market-research.schema.json',
  mvp_scoping: 'mvp-scope.schema.json',
  platform_decision: 'platform-decision.schema.json',
  stack_selection: 'stack-config.schema.json',
  infra_design: 'infra-config.schema.json',
  output_gate: 'pipeline-progress.schema.json',
};

/** 시스템 매니페스트 → 스키마 파일명 매핑 */
const SYSTEM_SCHEMA_MAP = {
  'rule-manifest': 'rule-manifest.schema.json',
  'context-manifest': 'context-manifest.schema.json',
  'agent-manifest': 'agent-manifest.schema.json',
  'ecosystem-state': 'ecosystem-state.schema.json',
};

/** 스키마 캐시 */
const schemaCache = new Map();

// ═══════════════════════════════════════════════════════════════
// 스키마 로딩
// ═══════════════════════════════════════════════════════════════

/**
 * 스키마를 캐시 키로 로드한다 (공통 헬퍼).
 * @param {string} cacheKey - 캐시 키
 * @param {string} schemaPath - 스키마 파일 절대 경로
 * @returns {object|null}
 */
function loadCachedSchema(cacheKey, schemaPath) {
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey);
  const schema = safeReadJson(schemaPath);
  if (schema) schemaCache.set(cacheKey, schema);
  return schema;
}

/**
 * 스테이지의 JSON Schema를 로드한다.
 * @param {string} stageId
 * @returns {object|null}
 */
export function loadSchema(stageId) {
  const entry = STAGE_SCHEMA_MAP[stageId];
  if (!entry) return null;

  const schemaFile = typeof entry === 'string' ? entry : entry.file;
  const isRoot = typeof entry === 'object' && entry.root;
  const schemaPath = isRoot
    ? join(SYSTEM_SCHEMAS_DIR, schemaFile)
    : join(SCHEMAS_DIR, schemaFile);

  return loadCachedSchema(stageId, schemaPath);
}

/**
 * 핸드오프 스키마를 로드한다.
 * @returns {object|null}
 */
export function loadHandoffSchema() {
  return loadCachedSchema('_handoff', join(SCHEMAS_DIR, 'handoff.schema.json'));
}

// ═══════════════════════════════════════════════════════════════
// 검증 엔진 (경량 JSON Schema Draft 2020-12 서브셋)
// ═══════════════════════════════════════════════════════════════

/**
 * JSON 데이터를 스키마에 대해 검증한다.
 *
 * @param {object} data - 검증 대상 JSON 데이터
 * @param {object} schema - JSON Schema
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(data, schema) {
  const errors = [];
  validateNode(data, schema, '', errors, schema.$defs || {});
  return { valid: errors.length === 0, errors };
}

/**
 * 스테이지 산출물을 스키마에 대해 검증한다.
 *
 * @param {string} stageId - 스테이지 ID
 * @param {object} data - 산출물 JSON 데이터
 * @returns {{ valid: boolean, errors: string[], schemaFound: boolean }}
 */
export function validateStageOutput(stageId, data) {
  const schema = loadSchema(stageId);
  if (!schema) return { valid: true, errors: [], schemaFound: false };

  const result = validate(data, schema);
  return { ...result, schemaFound: true };
}

/**
 * 핸드오프 데이터를 스키마에 대해 검증한다.
 *
 * @param {object} data
 * @returns {{ valid: boolean, errors: string[], schemaFound: boolean }}
 */
export function validateHandoff(data) {
  const schema = loadHandoffSchema();
  if (!schema) return { valid: true, errors: [], schemaFound: false };

  const result = validate(data, schema);
  return { ...result, schemaFound: true };
}

/**
 * 타입 매핑 + 디렉토리로부터 스키마를 로드하고 검증한다 (공통 헬퍼).
 *
 * @param {Record<string, string>} schemaMap - 타입 → 스키마 파일명 매핑
 * @param {string} schemasDir - 스키마 파일이 위치한 디렉토리
 * @param {string} cachePrefix - 캐시 키 프리픽스
 * @param {string} type - 검증 대상 타입
 * @param {object} data - 검증 대상 JSON 데이터
 * @returns {{ valid: boolean, errors: string[], schemaFound: boolean }}
 */
function validateWithSchemaMap(schemaMap, schemasDir, cachePrefix, type, data) {
  const schemaFile = schemaMap[type];
  if (!schemaFile) return { valid: true, errors: [], schemaFound: false };

  const cacheKey = `${cachePrefix}${type}`;
  const schema = loadCachedSchema(cacheKey, join(schemasDir, schemaFile));
  if (!schema) return { valid: true, errors: [], schemaFound: false };

  const result = validate(data, schema);
  return { ...result, schemaFound: true };
}

/**
 * 시스템 매니페스트를 스키마에 대해 검증한다.
 *
 * @param {string} type - 매니페스트 타입 (rule-manifest, context-manifest, agent-manifest, ecosystem-state)
 * @param {object} data - 매니페스트 JSON 데이터
 * @returns {{ valid: boolean, errors: string[], schemaFound: boolean }}
 */
export function validateSystemManifest(type, data) {
  return validateWithSchemaMap(SYSTEM_SCHEMA_MAP, SYSTEM_SCHEMAS_DIR, '_system_', type, data);
}

// ═══════════════════════════════════════════════════════════════
// 내부: 재귀 검증 노드
// ═══════════════════════════════════════════════════════════════

/** 재귀 깊이 상한 — 병적 중첩 스키마에서 스택 오버플로 방지 */
const MAX_VALIDATION_DEPTH = 50;

function validateNode(data, schema, path, errors, defs, depth = 0) {
  if (!schema || typeof schema !== 'object') return;

  // 재귀 깊이 제한 — 스택 오버플로 방지
  if (depth > MAX_VALIDATION_DEPTH) {
    errors.push(`${path || '(root)'}: 검증 깊이 초과 (최대 ${MAX_VALIDATION_DEPTH})`);
    return;
  }

  // allOf 지원: 모든 서브스키마를 병합하여 검증
  if (schema.allOf) {
    let merged = {};
    for (const sub of schema.allOf) {
      const resolved = resolveRef(sub, defs);
      if (resolved) merged = mergeSchemas(merged, resolved);
    }
    // allOf 이외의 속성도 병합 (description, items 등)
    for (const [k, v] of Object.entries(schema)) {
      if (k !== 'allOf') merged[k] = v;
    }
    return validateNode(data, merged, path, errors, defs, depth + 1);
  }

  // $ref 해결 (로컬 + 외부 파일)
  if (schema.$ref) {
    const resolved = resolveRef(schema, defs);
    if (resolved) {
      const merged = { ...resolved };
      for (const [k, v] of Object.entries(schema)) {
        if (k !== '$ref') merged[k] = v;
      }
      // 외부 파일의 $defs를 현재 defs에 병합
      if (resolved.$defs) {
        defs = { ...defs, ...resolved.$defs };
      }
      return validateNode(data, merged, path, errors, defs, depth + 1);
    }
    return;
  }

  // type 검증
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!checkType(data, types)) {
      // null 허용 체크
      if (data === null && types.includes('null')) return;
      errors.push(`${path || '(root)'}: 타입 불일치 — 기대: ${types.join('|')}, 실제: ${typeof data}`);
      return; // 타입 불일치 시 하위 검증 중단
    }
  }

  // null이면 하위 검증 불필요
  if (data === null) return;

  // const 검증
  if ('const' in schema && data !== schema.const) {
    errors.push(`${path || '(root)'}: 값 불일치 — 기대: ${schema.const}, 실제: ${data}`);
  }

  // enum 검증
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path || '(root)'}: enum 불일치 — 허용: [${schema.enum.join(', ')}], 실제: ${data}`);
  }

  // string 검증
  if (typeof data === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) {
      errors.push(`${path}: 최소 길이 미달 — 기대: ${schema.minLength}자 이상, 실제: ${data.length}자`);
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(data)) {
          errors.push(`${path}: 패턴 불일치 — 기대: ${schema.pattern}`);
        }
      } catch {
        errors.push(`${path}: 스키마 패턴 정규식 오류 — "${schema.pattern}" (잘못된 정규식)`);
      }
    }
  }

  // number 검증
  if (typeof data === 'number') {
    if (schema.minimum != null && data < schema.minimum) {
      errors.push(`${path}: 최소값 미달 — 기대: ${schema.minimum} 이상, 실제: ${data}`);
    }
    if (schema.maximum != null && data > schema.maximum) {
      errors.push(`${path}: 최대값 초과 — 기대: ${schema.maximum} 이하, 실제: ${data}`);
    }
  }

  // array 검증 — 모든 항목을 검증 (이전: 처음 5개만 → 6번째 이후 위반 놓침)
  if (Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) {
      errors.push(`${path}: 최소 항목 미달 — 기대: ${schema.minItems}개 이상, 실제: ${data.length}개`);
    }
    if (schema.items && data.length > 0) {
      for (let i = 0; i < data.length; i++) {
        validateNode(data[i], schema.items, `${path}[${i}]`, errors, defs, depth + 1);
      }
    }
  }

  // object 검증
  if (typeof data === 'object' && !Array.isArray(data)) {
    // required 검증
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in data)) {
          errors.push(`${path ? path + '.' : ''}${key}: 필수 필드 누락`);
        }
      }
    }

    // propertyNames 검증 (객체 키 이름 제약)
    if (schema.propertyNames) {
      const pnSchema = schema.propertyNames;
      for (const key of Object.keys(data)) {
        if (pnSchema.enum && !pnSchema.enum.includes(key)) {
          errors.push(`${path ? path + '.' : ''}${key}: 허용되지 않는 키 — 허용: [${pnSchema.enum.join(', ')}]`);
        }
        if (pnSchema.pattern) {
          try {
            if (!new RegExp(pnSchema.pattern).test(key)) {
              errors.push(`${path ? path + '.' : ''}${key}: 키 이름 패턴 불일치 — 기대: ${pnSchema.pattern}`);
            }
          } catch {
            errors.push(`${path ? path + '.' : ''}${key}: 스키마 propertyNames 정규식 오류 — "${pnSchema.pattern}"`);
          }
        }
      }
    }

    // properties 하위 검증
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          validateNode(data[key], propSchema, `${path ? path + '.' : ''}${key}`, errors, defs, depth + 1);
        }
      }
    }

    // additionalProperties 하위 검증 (propertyNames와 함께 동적 키 객체 검증)
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (!schema.properties || !(key in schema.properties)) {
          validateNode(value, schema.additionalProperties, `${path ? path + '.' : ''}${key}`, errors, defs, depth + 1);
        }
      }
    }
  }
}

/** 외부 $ref 파일 캐시 */
const externalSchemaCache = new Map();

/**
 * $ref를 해결한다. 로컬 (#/$defs/...) 과 외부 파일 (../common/...#/$defs/...) 모두 지원.
 * @param {object} schema - $ref를 포함한 스키마 노드
 * @param {object} defs - 현재 스코프의 $defs
 * @returns {object|null} 해결된 스키마, 또는 null
 */
function resolveRef(schema, defs) {
  if (!schema.$ref) return schema;
  const ref = schema.$ref;

  // 로컬 $ref: #/$defs/stack_layer
  if (ref.startsWith('#/$defs/')) {
    const refKey = ref.replace('#/$defs/', '');
    return defs[refKey] || null;
  }

  // 외부 파일 $ref: ../common/research-evidence.defs.json#/$defs/research_evidence_array
  const hashIdx = ref.indexOf('#');
  if (hashIdx === -1) return null;

  const filePart = ref.substring(0, hashIdx);
  const fragPart = ref.substring(hashIdx + 1); // /$defs/research_evidence_array

  // 외부 파일 로드 (stage-output/ 기준 상대경로)
  let extSchema = externalSchemaCache.get(filePart);
  if (!extSchema) {
    // SCHEMAS_DIR (stage-output/) 기준 해결 시도, 없으면 SYSTEM_SCHEMAS_DIR (schemas/) 시도
    extSchema = safeReadJson(join(SCHEMAS_DIR, filePart))
      || safeReadJson(join(SYSTEM_SCHEMAS_DIR, filePart));
    if (!extSchema) return null;
    externalSchemaCache.set(filePart, extSchema);
  }

  // JSON Pointer 해결: /$defs/research_evidence_array
  const segments = fragPart.split('/').filter(Boolean);
  let target = extSchema;
  for (const seg of segments) {
    if (!target || typeof target !== 'object') return null;
    target = target[seg];
  }
  return target || null;
}

/**
 * 두 스키마를 얕게 병합한다. allOf 항목 병합용.
 */
function mergeSchemas(base, overlay) {
  const merged = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (k === 'required' && merged.required) {
      // required 배열은 합집합
      merged.required = [...new Set([...merged.required, ...v])];
    } else if (k === 'properties' && merged.properties) {
      // properties는 깊은 병합
      merged.properties = { ...merged.properties, ...v };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

function checkType(data, types) {
  if (data === null) return types.includes('null');
  if (Array.isArray(data)) return types.includes('array');
  const jsType = typeof data;
  // V-1 fix: integer 타입은 Number.isInteger()로 엄격 검증
  if (jsType === 'number') {
    if (types.includes('number')) return true;
    if (types.includes('integer')) return Number.isInteger(data);
    return false;
  }
  return types.includes(jsType);
}

// ═══════════════════════════════════════════════════════════════
// 유틸리티
// ═══════════════════════════════════════════════════════════════

/**
 * 스키마 존재 여부를 확인한다 (Schema-First 원칙).
 * @param {string} stageId
 * @returns {boolean}
 */
export function hasSchema(stageId) {
  const entry = STAGE_SCHEMA_MAP[stageId];
  if (!entry) return false;
  const schemaFile = typeof entry === 'string' ? entry : entry.file;
  const isRoot = typeof entry === 'object' && entry.root;
  const dir = isRoot ? SYSTEM_SCHEMAS_DIR : SCHEMAS_DIR;
  return existsSync(join(dir, schemaFile));
}

// ═══════════════════════════════════════════════════════════════
// Auto-Healing (Tolerant Pipeline)
// ═══════════════════════════════════════════════════════════════

/**
 * 스키마를 바탕으로 JSON 데이터의 사소한 타입 에러나 누락된 필수 필드를 자동 교정(Auto-heal)한다.
 * @param {any} data - 원본 데이터
 * @param {object} schema - JSON Schema
 * @param {object} defs - $defs 스코프
 * @returns {any} 교정된 데이터
 */
export function autoHeal(data, schema, defs = schema?.$defs || {}) {
  if (!schema || typeof schema !== 'object') return data;

  if (schema.allOf) {
    let merged = { ...schema };
    delete merged.allOf;
    for (const sub of schema.allOf) {
      const resolved = resolveRef(sub, defs) || sub;
      merged = mergeSchemas(merged, resolved);
    }
    return autoHeal(data, merged, defs);
  }

  if (schema.$ref) {
    const resolved = resolveRef(schema, defs);
    if (resolved) {
       const merged = { ...resolved };
       for (const [k, v] of Object.entries(schema)) {
         if (k !== '$ref') merged[k] = v;
       }
       return autoHeal(data, merged, { ...defs, ...(resolved.$defs || {}) });
    }
    return data;
  }

  // 타입 강제 변환 (Coercion)
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (data != null && !checkType(data, types)) {
      if (types.includes('string')) {
        if (typeof data === 'number' || typeof data === 'boolean') data = String(data);
      } else if (types.includes('number') || types.includes('integer')) {
        if (typeof data === 'string' && !isNaN(Number(data))) data = Number(data);
      } else if (types.includes('boolean')) {
        if (data === 'true') data = true;
        if (data === 'false') data = false;
      } else if (types.includes('array')) {
        if (!Array.isArray(data)) data = [data];
      }
    }
  }

  // 배열 하위 교정
  if (Array.isArray(data)) {
    if (schema.items && data.length > 0) {
      for (let i = 0; i < data.length; i++) {
        data[i] = autoHeal(data[i], schema.items, defs);
      }
    }
    return data;
  }

  // 객체 하위 교정
  if (typeof data === 'object' && data !== null) {
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          data[key] = autoHeal(data[key], propSchema, defs);
        } else if (schema.required && schema.required.includes(key)) {
          // 누락된 필수 필드에 기본값 자동 주입
          data[key] = generateDefault(propSchema, defs);
        }
      }
    }
  }

  return data;
}

/**
 * 스키마에 기반하여 안전한 기본값을 생성한다.
 */
function generateDefault(schema, defs) {
  if (!schema) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.$ref) {
    const resolved = resolveRef(schema, defs);
    if (resolved) return generateDefault(resolved, defs);
    return null;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes('array')) return [];
    if (types.includes('object')) return {};
    if (types.includes('string')) return "";
    if (types.includes('number') || types.includes('integer')) return 0;
    if (types.includes('boolean')) return false;
  }
  return null;
}

/**
 * 스키마에서 required 필드만 추출한다 (빠른 확인용).
 * @param {string} stageId
 * @returns {string[]}
 */
export function getRequiredFields(stageId) {
  const schema = loadSchema(stageId);
  return schema?.required || [];
}

/** 스키마 디렉토리 경로 (외부 참조용) */
export const SCHEMAS_DIRECTORY = SCHEMAS_DIR;
