/**
 * integrity.mjs - 파이프라인 산출물 무결성 유틸리티
 *
 * JSON 구조 검증, 스키마 버전 관리, SHA-256 해싱.
 *
 * 소비자:
 *   - pipeline-audit-runner.mjs (감사 도구)
 *   - test-hooks.mjs (테스트)
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getDataDir, STAGE_MAP } from './pipeline-config.mjs';
import { REQUIRED_KEYS } from './pipeline-validator.mjs';

// ===============================================================
// Hashing
// ===============================================================

/**
 * SHA-256 파일 해시.
 *
 * @param {string} filePath - absolute path
 * @returns {string|null} hex digest, or null if file not readable
 */
export function hashFile(filePath) {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * SHA-256 문자열 해시.
 *
 * @param {string} content
 * @returns {string} hex digest
 */
export function hashContent(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ===============================================================
// Schema Versioning
// ===============================================================

export const CURRENT_SCHEMA_VERSION = '1.0';

const SUPPORTED_SCHEMA_VERSIONS = new Set(['1.0']);

/**
 * 산출물 JSON의 schema_version 필드를 검증한다.
 *
 * @param {string} filePath - JSON 파일 절대 경로
 * @returns {{ status: string, version?: string, message?: string }}
 */
export function validateSchemaVersion(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { status: 'INCOMPATIBLE', message: 'Root must be an object' };
    }

    const version = data.schema_version;

    if (!version) {
      return {
        status: 'MISSING',
        message: `schema_version 필드 없음 — 레거시 산출물. 현재 버전: ${CURRENT_SCHEMA_VERSION}`,
      };
    }

    if (!SUPPORTED_SCHEMA_VERSIONS.has(version)) {
      return {
        status: 'INCOMPATIBLE',
        version,
        message: `미지원 스키마 버전: '${version}'. 지원: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}`,
      };
    }

    if (version !== CURRENT_SCHEMA_VERSION) {
      return {
        status: 'OUTDATED',
        version,
        message: `구버전 스키마: '${version}' (최신: ${CURRENT_SCHEMA_VERSION}). 재생성 권장.`,
      };
    }

    return { status: 'CURRENT', version };
  } catch (e) {
    return { status: 'INCOMPATIBLE', message: `파일 읽기/파싱 실패: ${e.message}` };
  }
}

// ===============================================================
// JSON Structural Validation
// ===============================================================

/**
 * 스테이지별 필수 JSON 키 — pipeline-validator.mjs의 REQUIRED_KEYS를 SSOT로 사용.
 * 이중 정의로 인한 불일치를 방지한다.
 */
export const STAGE_REQUIRED_KEYS = REQUIRED_KEYS;

/**
 * JSON 파일이 파싱 가능하고 필수 키를 포함하는지 검증한다.
 *
 * @param {string} filePath - JSON 파일 절대 경로
 * @param {string[]} [requiredKeys] - 필수 최상위 키
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyJsonStructure(filePath, requiredKeys = []) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { valid: false, error: 'Root must be an object' };
    }

    const missing = requiredKeys.filter(k => !(k in data));
    if (missing.length > 0) {
      return { valid: false, error: `Missing required keys: ${missing.join(', ')}` };
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: `JSON parse error: ${e.message}` };
  }
}

/**
 * 모든 파이프라인 JSON 산출물의 구조적 무결성을 검증한다.
 *
 * @returns {{ passed: boolean, checked: number, mismatches: Array<{ file: string, stageId: string, error: string }> }}
 */
export function verifyStructuralIntegrity() {
  const mismatches = [];
  let checked = 0;

  for (const [stageId, info] of STAGE_MAP) {
    if (!info.jsonFile) continue;

    const absPath = join(getDataDir(), info.jsonFile);
    if (!existsSync(absPath)) continue;

    checked++;

    const requiredKeys = STAGE_REQUIRED_KEYS[stageId];
    if (requiredKeys && requiredKeys.length > 0) {
      const result = verifyJsonStructure(absPath, requiredKeys);
      if (!result.valid) {
        mismatches.push({
          file: `.brief2dev/stage-output/${info.jsonFile}`, // @layout-resolver-allow — audit trail label
          stageId,
          error: result.error,
        });
      }
    }
  }

  return { passed: mismatches.length === 0, checked, mismatches };
}
