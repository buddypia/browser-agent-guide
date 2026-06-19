// brief2dev Observatory — stage-output read-only aggregator (R-CM-035 invariant).
// CLI (skill/hook)만 writer. 본 모듈은 .brief2dev SSOT 를 읽기만 한다.
// fail-safe: 모든 오류는 빈 결과로 degrade (R-CM-006 Rule 2 fail-open 정합).

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { STAGE_MAP } from './pipeline-config.mjs';
import { extractConfidenceScore } from './utils.mjs';

// stage-output 파일 basename → 파이프라인 스테이지 id, 그리고 스테이지 순서.
// SSOT 는 pipeline-config.mjs#STAGE_MAP (CLAUDE.md #13). 자체 매핑 재선언 금지
// — multi-session-discovery.mjs 와 동일하게 STAGE_MAP 에서 derive 한다.
const STAGE_ORDER = [...STAGE_MAP.keys()];
const FILE_TO_STAGE = Object.fromEntries(
  [...STAGE_MAP]
    .filter(([, info]) => typeof info.jsonFile === 'string')
    .map(([stageId, info]) => [info.jsonFile.replace(/\.json$/, ''), stageId]),
);

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * P0-A2 fix (2026-05-22): handoff JSON 의 confidence/evidence_grade 를 stage-output 에 merge.
 *
 * 배경: 사용자 보고 — Observatory renderStageCard 가 stage-output/*.json 의 confidence/
 *   evidence_grade 만 읽는데, 실제 SSOT 는 handoff (skill detail). 결과: 8/8 stages
 *   confidence 배지 미표시.
 *
 * 정책:
 *   - handoff.confidence object {score, level, evidence_counts, reasoning} / number 양식 둘 다 지원
 *   - stage-output 의 기존 confidence/evidence_grade 가 null/undefined 일 때만 handoff 값으로 채움
 *   - handoff 부재 / parse 실패 = fail-open
 *   - hover tooltip 용 raw meta (level, evidence_counts, reasoning) 는 _handoff_meta 로 보존
 *
 * @param {object} stageData - stage-output JSON object (mutated in-place)
 * @param {string} stageId
 * @param {string} runRoot - .brief2dev/runs/<run_id> 루트
 */
function mergeHandoffConfidence(stageData, stageId, runRoot) {
  if (!stageData || typeof stageData !== 'object') return;
  const handoffFile = STAGE_MAP.get(stageId)?.handoffFile;
  if (typeof handoffFile !== 'string') return;
  const handoff = readJsonSafe(join(runRoot, 'handoff', handoffFile));
  if (!handoff) return;
  const conf = handoff.confidence;
  const score = extractConfidenceScore(conf);
  if (score !== null && (stageData.confidence === null || stageData.confidence === undefined)) {
    stageData.confidence = score;
  }
  if (
    typeof handoff.evidence_grade === 'string' &&
    handoff.evidence_grade &&
    (stageData.evidence_grade === null || stageData.evidence_grade === undefined)
  ) {
    stageData.evidence_grade = handoff.evidence_grade;
  }
  if (typeof conf === 'object' && conf !== null) {
    stageData._handoff_meta = {
      level: typeof conf.level === 'string' ? conf.level : null,
      evidence_counts:
        conf.evidence_counts && typeof conf.evidence_counts === 'object'
          ? conf.evidence_counts
          : null,
      reasoning: typeof conf.reasoning === 'string' ? conf.reasoning : null,
    };
  }
}

/**
 * 한 run 의 stage-output/*.json 을 read-only 로 모두 읽어 스테이지별로 묶는다.
 * @param {string} worktreePath  세션의 worktree 루트
 * @param {string} runId         run id
 * order = 산출물이 존재하는 스테이지(정렬). pipeline_order = 전체 8 스테이지
 * (SSOT STAGE_MAP, 흐름도 전체 표시용 — 클라이언트 하드코딩 drift 제거).
 * @returns {{ok:boolean, run_id:string, order:string[], pipeline_order:string[], stages:Object, pipeline_progress:object|null}}
 */
export function listStageOutputs(worktreePath, runId) {
  const empty = {
    ok: false,
    run_id: runId,
    order: [],
    pipeline_order: STAGE_ORDER,
    stages: {},
    pipeline_progress: null,
  };
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return empty;
  if (typeof runId !== 'string' || runId.length === 0) return empty;

  const runRoot = join(resolve(worktreePath), '.brief2dev', 'runs', runId);
  const stageDir = join(runRoot, 'stage-output');

  let files = [];
  try {
    files = readdirSync(stageDir).filter((f) => f.endsWith('.json'));
  } catch {
    // 디렉터리 부재 등 — fail-safe (existsSync 선검사 불요, TOCTOU 회피).
    return { ...empty, ok: true };
  }

  const stages = {};
  for (const file of files) {
    const base = file.replace(/\.json$/, '');
    const data = readJsonSafe(join(stageDir, file));
    if (data === null) continue;
    // R-3 fix (2026-05-22): STAGE_MAP 매핑 안 되는 stage-output 파일 (legacy / extra) 은 skip.
    // 예: infra-design.json (extra, kebab-case) — STAGE_MAP 의 jsonFile 은 infra-config.json
    // (snake_case stage_id=infra_design 와 매핑). basename fallback (kebab) 으로 stale card
    // 표시 시 사용자 confusion 우려. 명시 매핑된 stage 만 노출.
    const stageId = FILE_TO_STAGE[base];
    if (!stageId) continue;
    // R-2 NOTE (2026-05-22): scaffolding stage 는 STAGE_MAP.jsonFile=null 이라 stage-output 파일
    // 자체 부재 + Pipeline view 카드 부재. design intentional — scaffolding 단계는 코드 생성이
    // 산출물이므로 별도 JSON 산출물 없음. handoff JSON 만 존재. 사용자 인지를 위해 pipeline_order
    // 8 stages 는 그대로 노출 (flow chart 표시용). 후속 task 로 placeholder card 추가 검토 가능.
    mergeHandoffConfidence(data, stageId, runRoot);
    stages[base] = {
      file: base,
      stage_id: stageId,
      data,
    };
  }

  // pipeline-progress 는 stage-output 또는 run 루트 어디든 있을 수 있다.
  const pipelineProgress =
    (stages['pipeline-progress'] && stages['pipeline-progress'].data) ||
    readJsonSafe(join(runRoot, 'pipeline-progress.json')) ||
    null;

  const present = new Set(Object.values(stages).map((s) => s.stage_id));
  const order = STAGE_ORDER.filter((id) => present.has(id));

  return {
    ok: true,
    run_id: runId,
    order,
    pipeline_order: STAGE_ORDER,
    stages,
    pipeline_progress: pipelineProgress,
  };
}
