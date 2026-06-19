/**
 * observation-recorder.mjs — Wisdom Observation Recorder
 *
 * ECC Continuous Learning v2.1의 observation capture를
 * brief2dev의 Wisdom 시스템에 네이티브 통합.
 *
 * Wisdom 파일이 참조(consult)되거나 파이프라인 스테이지가 완료될 때
 * observation을 JSONL로 기록한다. 이 데이터는 health-scorer가 분석하여
 * 각 wisdom section의 실효성(confidence)을 정량화한다.
 *
 * 저장소: .claude/state/wisdom-observations.jsonl
 * 스키마: data/schemas/wisdom-observation.schema.json
 *
 * 차이점 (ECC vs brief2dev):
 *   ECC: bash+python, 모든 tool call 관찰, instinct YAML 생성
 *   brief2dev: ESM/Node.js, wisdom 참조+스테이지 결과만 관찰, confidence delta 기록
 */

import { existsSync, appendFileSync, readFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { join } from 'path';

const OBSERVATIONS_REL_PATH = '.claude/state/wisdom-observations.jsonl';
const MAX_FILE_SIZE_MB = 5;

/**
 * Wisdom 참조(consult) 이벤트를 기록한다.
 * wisdom-ref-tracker Hook에서 호출.
 *
 * @param {string} projectDir - 프로젝트 루트
 * @param {object} event
 * @param {string} event.wisdom_file - 참조된 wisdom 파일 (예: 'architecture-decisions.md')
 * @param {string} [event.section_id] - 참조된 섹션 (있으면)
 * @param {string} [event.session_id] - 현재 세션 ID
 * @param {string} [event.context] - 참조 컨텍스트 ('pipeline_stage' | 'manual' | 'hook')
 */
export function recordConsultation(projectDir, event) {
  const observation = {
    type: 'consultation',
    timestamp: new Date().toISOString(),
    wisdom_file: event.wisdom_file,
    section_id: event.section_id || null,
    session_id: event.session_id || process.env.SESSION_ID || null,
    context: event.context || 'manual',
  };

  appendObservation(projectDir, observation);
}

/**
 * 파이프라인 스테이지 결과를 기록한다.
 * session-extractor Hook에서 호출.
 *
 * @param {string} projectDir - 프로젝트 루트
 * @param {object} event
 * @param {string} event.stage - 스테이지 이름 (예: 'market_research')
 * @param {'success'|'failure'|'retry'} event.outcome - 결과
 * @param {number} [event.confidence] - 스테이지 confidence (0.0-1.0)
 * @param {string[]} [event.consulted_wisdom] - 참조된 wisdom 파일 목록
 * @param {string} [event.session_id]
 */
export function recordStageOutcome(projectDir, event) {
  const observation = {
    type: 'stage_outcome',
    timestamp: new Date().toISOString(),
    stage: event.stage,
    outcome: event.outcome,
    confidence: event.confidence ?? null,
    consulted_wisdom: event.consulted_wisdom || [],
    session_id: event.session_id || process.env.SESSION_ID || null,
  };

  appendObservation(projectDir, observation);
}

/**
 * Wisdom 수정 이벤트를 기록한다.
 * wisdom 파일이 업데이트될 때 호출.
 *
 * @param {string} projectDir
 * @param {object} event
 * @param {string} event.wisdom_file
 * @param {'create'|'update'|'delete'} event.action
 * @param {string} [event.reason]
 */
export function recordWisdomChange(projectDir, event) {
  const observation = {
    type: 'wisdom_change',
    timestamp: new Date().toISOString(),
    wisdom_file: event.wisdom_file,
    action: event.action,
    reason: event.reason || null,
    session_id: process.env.SESSION_ID || null,
  };

  appendObservation(projectDir, observation);
}

/**
 * Observation JSONL 파일에서 모든 관찰을 읽는다.
 *
 * @param {string} projectDir
 * @param {object} [filter]
 * @param {string} [filter.type] - 관찰 타입 필터
 * @param {number} [filter.days] - 최근 N일만
 * @returns {object[]}
 */
export function readObservations(projectDir, filter) {
  const filePath = join(projectDir, OBSERVATIONS_REL_PATH);
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    let observations = [];

    for (const line of lines) {
      try {
        observations.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    if (filter?.type) {
      observations = observations.filter((o) => o.type === filter.type);
    }
    if (filter?.days) {
      const cutoff = Date.now() - filter.days * 24 * 60 * 60 * 1000;
      observations = observations.filter((o) => new Date(o.timestamp).getTime() >= cutoff);
    }

    return observations;
  } catch {
    return [];
  }
}

// ── Internal ──

function appendObservation(projectDir, observation) {
  const filePath = join(projectDir, OBSERVATIONS_REL_PATH);
  const stateDir = join(projectDir, '.claude', 'state');

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  // Auto-archive if file exceeds size limit
  if (existsSync(filePath)) {
    try {
      const stats = statSync(filePath);
      const sizeMB = stats.size / (1024 * 1024);
      if (sizeMB >= MAX_FILE_SIZE_MB) {
        const archivePath = filePath.replace('.jsonl', `-${Date.now()}.jsonl`);
        renameSync(filePath, archivePath);
      }
    } catch {
      // ignore stat errors
    }
  }

  appendFileSync(filePath, JSON.stringify(observation) + '\n', 'utf-8');
}
