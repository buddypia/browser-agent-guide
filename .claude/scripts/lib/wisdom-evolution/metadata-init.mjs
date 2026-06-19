/**
 * metadata-init.mjs — Wisdom Metadata Auto-Init
 *
 * SessionEnd 시점에 `.claude/wisdom/.metadata.json` 의 silently dead 함정을 봉인한다.
 *
 * 함정 (이전 상태):
 *   - session-extractor.mjs / wisdom-ref-tracker.mjs 모두 `if (!existsSync(METADATA_PATH)) return;`
 *     로 시작 — metadata 부재 시 silently passthrough.
 *   - confidence scoring / decay / health-score-delta 영구 inert.
 *   - template `{sections:{}, created_at:"", description:"..."}` 도 hook 의
 *     `Object.values(metadata)` 루프와 호환 불가 — `Object.values` 가 wrap object 안으로
 *     진입하지 못해 .md 별 entry 가 발견되지 않음.
 *
 * 본 함수 동작:
 *   1. `wisdomDir` 부재 → silently return (디렉토리 없는데 metadata 만 만들지 않음)
 *   2. `metadataPath` 부재 → 빈 `{}` 로 신규 생성 + .md 파일 스캔하여 default entry 추가
 *   3. `metadataPath` 존재 + legacy empty wrap (`{sections:{}, description:"..."}`)
 *      감지 → reset (production 사례 모두 빈 sections, 손실 0)
 *   4. `metadataPath` 존재 + 정상 schema → 미등록 .md 파일에 대해 default entry 추가
 *
 * Schema 정합 (data/schemas/wisdom-metadata.schema.json):
 *   - root: object with `additionalProperties` per-section
 *   - required per section: file_name / section_id / last_referenced / reference_count / created_at
 *   - optional: confidence (0.3-0.9, default 0.5) / decay_after_days (default 90)
 *
 * R-CM-028 boundary: boundary-uniform — 양 관점 (brief2dev 자체 + scaffold target) 모두 동일 의미.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { writeJsonAtomicSync } from '../atomic-fs.mjs';

const DEFAULT_DECAY_DAYS = 90;
const DEFAULT_CONFIDENCE = 0.5;

/**
 * @param {string} wisdomDir - wisdom 디렉토리 절대 경로 (e.g. /proj/.claude/wisdom)
 * @param {string} metadataPath - .metadata.json 절대 경로 (e.g. /proj/.claude/wisdom/.metadata.json)
 * @param {object} [opts]
 * @param {Date} [opts.now] - 테스트용 timestamp 주입 (default: new Date())
 * @returns {object} { action: 'skipped' | 'created' | 'reset' | 'updated' | 'noop', added: string[] }
 *   action 의미:
 *     - skipped: wisdomDir 부재 → 아무것도 안 함
 *     - created: metadataPath 부재 → 신규 metadata 생성 (added .md entries 포함)
 *     - reset: legacy empty wrap 감지 → 빈 {} 로 reset 후 .md entries 추가
 *     - updated: 정상 metadata 에 신규 .md entries 추가
 *     - noop: metadata 존재 + 모든 .md 이미 등록 → 변경 없음
 */
export function initWisdomMetadataIfMissing(wisdomDir, metadataPath, opts = {}) {
  if (!wisdomDir || !metadataPath) {
    throw new Error('initWisdomMetadataIfMissing: wisdomDir and metadataPath required');
  }
  if (!existsSync(wisdomDir)) {
    return { action: 'skipped', added: [] };
  }

  const now = (opts.now instanceof Date ? opts.now : new Date()).toISOString();
  const fileExists = existsSync(metadataPath);
  let metadata = {};
  let action = fileExists ? 'updated' : 'created';

  if (fileExists) {
    try {
      metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
    } catch {
      // parse 실패 — silently SKIP (fail-open per R-CM-006 Rule 2)
      return { action: 'noop', added: [] };
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { action: 'noop', added: [] };
    }
    // Legacy empty wrap 감지 후 reset
    if (isLegacyEmptyWrap(metadata)) {
      metadata = {};
      action = 'reset';
    }
  }

  let mdFiles;
  try {
    mdFiles = readdirSync(wisdomDir).filter(
      f => f.endsWith('.md') && !f.startsWith('.')
    );
  } catch {
    return { action: 'noop', added: [] };
  }

  const added = [];
  for (const mdFile of mdFiles) {
    if (mdFile in metadata) continue;
    metadata[mdFile] = {
      file_name: mdFile,
      section_id: mdFile.replace(/\.md$/, ''),
      last_referenced: now,
      reference_count: 0,
      created_at: now,
      confidence: DEFAULT_CONFIDENCE,
      decay_after_days: DEFAULT_DECAY_DAYS,
    };
    added.push(mdFile);
  }

  // metadata 생성 / reset / 신규 entry 추가가 없으면 write SKIP
  if (action === 'updated' && added.length === 0) {
    return { action: 'noop', added: [] };
  }

  try {
    // Atomic write — concurrent SessionEnd / PostToolUse Read 사이의 partial write 회피.
    // tmp file rename(2) 으로 원자성 보장 (writeJsonAtomicSync).
    writeJsonAtomicSync(metadataPath, metadata);
  } catch {
    return { action: 'noop', added: [] };
  }

  return { action, added };
}

/**
 * Legacy template (`{sections:{}, created_at:"", description:"..."}`) 빈 wrap 감지.
 * 빈 wrap 만 reset 대상. 비어있지 않은 sections 는 사용자 의도 가능성으로 보존.
 */
function isLegacyEmptyWrap(metadata) {
  if (!('sections' in metadata) || !('description' in metadata)) return false;
  const sections = metadata.sections;
  if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) return false;
  if (Object.keys(sections).length !== 0) return false;
  return true;
}
