#!/usr/bin/env node
/**
 * schema-loader.mjs (R-CM-023 Rule 4)
 *
 * data/schemas/ 의 JSON Schema를 ajv로 안전하게 로드/검증하는 헬퍼.
 *
 * 캡슐화하는 함정:
 *   - draft 2020-12 사용 (ajv default는 draft-07)
 *   - common/*.defs.json 의 cross-schema $ref 사전 등록
 *   - leading-slash 변형(`common/...` 와 `/common/...`) 양쪽 키 등록
 *   - ajv-formats 자동 적용 (date-time, uri 등)
 *
 * 사용:
 *   import { createValidator, loadSchema, validate } from './lib/schema-loader.mjs';
 *
 *   const validator = createValidator('stage-output/business-context.schema.json');
 *   const ok = validator(data);
 *   if (!ok) console.error(validator.errors);
 *
 *   // 또는 한 줄로
 *   const { ok, errors } = validate('stage-output/business-context', data);
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..', '..', '..');
const SCHEMAS_DIR = join(ROOT, 'data', 'schemas');
const COMMON_DIR = join(SCHEMAS_DIR, 'common');

let _sharedAjv = null;

/**
 * ajv 인스턴스를 lazy-init. 한 프로세스에서 재사용.
 */
function getAjv() {
  if (_sharedAjv) return _sharedAjv;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  if (existsSync(COMMON_DIR)) {
    for (const f of readdirSync(COMMON_DIR).filter(x => x.endsWith('.json'))) {
      const def = JSON.parse(readFileSync(join(COMMON_DIR, f), 'utf8'));
      // ajv가 ref resolve 시 leading-slash를 붙이는 경우가 있어 양쪽 변형 모두 등록
      ajv.addSchema(def, `common/${f}`);
      ajv.addSchema(def, `/common/${f}`);
    }
  }
  _sharedAjv = ajv;
  return ajv;
}

/**
 * schema 이름을 정규화. ".schema.json" 자동 부착, leading slash 제거.
 *   "business-context"             → "stage-output/business-context.schema.json"
 *   "stage-output/business-context"→ "stage-output/business-context.schema.json"
 *   "active-run"                   → "active-run.schema.json"
 *   절대경로                       → 그대로
 */
function resolveSchemaPath(name) {
  if (isAbsolute(name)) return name;
  let n = name.startsWith('/') ? name.slice(1) : name;
  if (!n.endsWith('.json')) n = `${n}.schema.json`;
  // top-level 우선 시도, 없으면 stage-output 접두 시도
  const candidates = [
    join(SCHEMAS_DIR, n),
    join(SCHEMAS_DIR, 'stage-output', n)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // 마지막 후보 그대로 반환 (호출자가 에러 처리)
  return candidates[0];
}

/**
 * schema 파일을 로드해 JSON 객체 반환. ajv에 등록은 하지 않음.
 */
export function loadSchema(name) {
  const p = resolveSchemaPath(name);
  if (!existsSync(p)) {
    throw new Error(`schema not found: ${name} (resolved to ${p})`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

const _validatorCache = new Map();

/**
 * schema에 대한 ajv validator를 만든다 (process-level 캐싱).
 *   - common/$defs는 사전 등록되어 있음
 *   - 같은 name으로 재호출 시 캐시된 validator 반환 ($id 중복 등록 방지)
 *   - returned function은 ajv 표준: validator(data) → boolean, validator.errors는 위반 배열
 */
export function createValidator(name) {
  if (_validatorCache.has(name)) return _validatorCache.get(name);
  const schema = loadSchema(name);
  const ajv = getAjv();
  // schema의 $id를 ajv가 이미 알고 있으면 그것을 재사용 (중복 등록 방지)
  let v;
  if (schema.$id) {
    const existing = ajv.getSchema(schema.$id);
    v = existing ?? ajv.compile(schema);
  } else {
    v = ajv.compile(schema);
  }
  _validatorCache.set(name, v);
  return v;
}

/**
 * 한 줄 검증 헬퍼. 반환값: { ok: boolean, errors: array | null }.
 */
export function validate(name, data) {
  const v = createValidator(name);
  const ok = v(data);
  return { ok, errors: ok ? null : (v.errors || []) };
}

/**
 * 디버깅 보조: ajv가 인지하는 schema 키 목록.
 */
export function listRegisteredSchemas() {
  const ajv = getAjv();
  return Object.keys(ajv.schemas).filter(k => !k.startsWith('http://json-schema.org'));
}

/**
 * 외부 $ref 문자열을 raw schema 객체로 resolve. fixture generator 등에서 사용.
 *   ref 예: "../common/research-evidence.defs.json#/$defs/evidence_summary"
 *           "common/research-evidence.defs.json#/$defs/evidence_summary"
 *
 * 매칭 전략:
 *   1. URL fragment 분리
 *   2. file 파트의 basename으로 common/ 디렉토리 검색 (단순화)
 *   3. fragment path를 따라가서 sub-schema 반환
 */
/**
 * JSON Schema 두 객체를 deep-merge. override 우선.
 *   - object + object → 키별 재귀 merge
 *   - array → override
 *   - primitive → override
 *   - allOf/$ref/description 등 일부 키는 호출자가 사전 제외 (이 함수는 keys 전부 처리)
 */
export function deepMergeSchema(base, override) {
  if (base == null) return override;
  if (override == null) return base;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    if (k in out && typeof out[k] === 'object' && typeof override[k] === 'object'
        && !Array.isArray(out[k]) && !Array.isArray(override[k])) {
      out[k] = deepMergeSchema(out[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

export function resolveExternalRef(ref) {
  if (typeof ref !== 'string' || ref.startsWith('#')) return null;
  const [filePart, fragPart = ''] = ref.split('#');
  const baseName = filePart.split('/').filter(Boolean).pop();
  if (!baseName) return null;
  // common/ 우선, 그 다음 schemas root
  const candidates = [
    join(COMMON_DIR, baseName),
    join(SCHEMAS_DIR, baseName)
  ];
  let raw = null;
  for (const c of candidates) {
    if (existsSync(c)) { raw = JSON.parse(readFileSync(c, 'utf8')); break; }
  }
  if (!raw) return null;
  if (!fragPart) return { schema: raw, root: raw };
  const segs = fragPart.split('/').filter(Boolean);
  let n = raw;
  for (const s of segs) n = n?.[s];
  return n ? { schema: n, root: raw } : null;
}

// CLI 모드: node lib/schema-loader.mjs <name> <data.json>
if (process.argv[1] === __filename) {
  const [, , name, dataPath] = process.argv;
  if (!name || !dataPath) {
    console.error('usage: schema-loader.mjs <schema-name> <data.json>');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  const { ok, errors } = validate(name, data);
  if (ok) {
    console.log(`PASS  ${name}  ${dataPath}`);
    process.exit(0);
  } else {
    console.log(`FAIL  ${name}  ${dataPath}`);
    console.log(JSON.stringify(errors, null, 2));
    process.exit(1);
  }
}
