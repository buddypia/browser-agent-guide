/**
 * multi-session-discovery.mjs — Cross-worktree active session discovery
 *
 * R-CM-026 정합: per-worktree isolation (사용자 결정 2026-05-14) 후 멀티세션
 * 환경에서 main + `.worktrees/*` 의 `.brief2dev/run/active.json` 을 read-only 로
 * 스캔하여 running/paused 세션 목록을 제공한다.
 *
 * R-CM-035 정합: Observatory(WebUI) 가 write 안 함 — 본 모듈은 read-only.
 * R-CM-006 fail-open: 어떤 파일/디렉터리 오류도 silent skip (개별 worktree
 * 의 active.json 누락은 정상 상태).
 *
 * Boundary (R-CM-028): 관점 1 (brief2dev 자체) 전용 — scaffold target 미배포.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STAGE_MAP } from './pipeline-config.mjs';

const PROJECT_DIR_DEFAULT = process.env.CLAUDE_PROJECT_DIR
  ? resolve(process.env.CLAUDE_PROJECT_DIR)
  : process.cwd();

const RUNNING_STATUSES = new Set(['running', 'paused']);
const COMPLETED_STATUSES = new Set(['completed', 'aborted', 'archived', 'failed']);

// stage id → skill 명 매핑. SSOT 는 pipeline-config.mjs#STAGE_MAP
// (brief2dev.yaml 의 코드측 단일 진실, CLAUDE.md #13). 자체 yaml 재파싱 금지.
const STAGE_SKILL = Object.fromEntries(
  [...STAGE_MAP].map(([stageId, info]) => [stageId, info.skill]),
);

/**
 * 사용자 선택 실행 모드를 run-scoped business-context.json#mode 에서 해석.
 * (R-CM-014: user_preference SSOT 는 business-context.json#mode. active.json
 * shared_context 에는 없음.) 실패 시 null — UI graceful degrade.
 *
 * @param {string} worktreePath
 * @param {string|null} runId
 * @returns {string|null}
 */
function resolveExecutionMode(worktreePath, runId) {
  if (typeof worktreePath !== 'string' || typeof runId !== 'string' || runId.length === 0) {
    return null;
  }
  try {
    const bcPath = join(
      worktreePath,
      '.brief2dev',
      'runs',
      runId,
      'stage-output',
      'business-context.json',
    );
    if (!existsSync(bcPath)) return null;
    const bc = JSON.parse(readFileSync(bcPath, 'utf-8'));
    return typeof bc?.mode === 'string' && bc.mode.length > 0 ? bc.mode : null;
  } catch {
    return null;
  }
}

/**
 * 단일 active.json 경로에서 세션 상태를 읽는다.
 * @returns {object|null} { run_id, status, current_stage, started_at, updated_at, mode, business_description } 또는 null
 */
function readActiveJson(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return {
      run_id: data.run_id || null,
      status: data.status || 'idle',
      current_stage: data.current_stage || null,
      started_at: data.started_at || null,
      updated_at: data.updated_at || null,
      completed_at: data.completed_at || null,
      business_description: data?.shared_context?.business_description || null,
      pipeline_type: data.pipeline_type || null,
      stages: data.stages && typeof data.stages === 'object' ? data.stages : null,
    };
  } catch {
    return null;
  }
}

/**
 * 특정 run 의 business-context.json#interaction_mode.mode 를 read-only 로 읽는다.
 * R-CM-031 Interaction Mode (guided/autonomous) 를 Observatory 세션 상세에 노출하기 위함.
 * R-CM-035 정합: read-only (write 없음). R-CM-006 fail-open: 모든 오류 → null.
 * @returns {string|null} 'guided' | 'autonomous' | null (미기록/누락/오류)
 */
function readInteractionMode(worktreePath, runId) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return null;
  if (typeof runId !== 'string' || runId.length === 0) return null;
  const bcPath = join(
    resolve(worktreePath),
    '.brief2dev',
    'runs',
    runId,
    'stage-output',
    'business-context.json',
  );
  if (!existsSync(bcPath)) return null;
  try {
    const data = JSON.parse(readFileSync(bcPath, 'utf-8'));
    const mode = data?.interaction_mode?.mode;
    return mode === 'guided' || mode === 'autonomous' ? mode : null;
  } catch {
    return null;
  }
}

/**
 * `.worktrees/` 하위의 모든 worktree 디렉터리를 list 한다.
 * GitHub Flow 의 `feature/<name>` 같이 슬래시 포함된 branch 는 중첩 디렉터리.
 * 따라서 1-level deep + 2-level deep 탐색이 모두 필요하다.
 *
 * @returns {Array<{name: string, path: string}>}
 */
function listWorktrees(projectDir) {
  const worktreesDir = join(projectDir, '.worktrees');
  if (!existsSync(worktreesDir)) return [];

  const results = [];
  let topEntries = [];
  try {
    topEntries = readdirSync(worktreesDir);
  } catch {
    return [];
  }

  for (const top of topEntries) {
    const topPath = join(worktreesDir, top);
    let topStat;
    try {
      topStat = statSync(topPath);
    } catch {
      continue;
    }
    if (!topStat.isDirectory()) continue;

    // active.json 이 1-level 에 있으면 그게 worktree
    const directActivePath = join(topPath, '.brief2dev', 'run', 'active.json'); // @layout-resolver-allow — cross-worktree discovery scope (R-CM-035 read-only aggregator)
    if (existsSync(directActivePath)) {
      results.push({ name: top, path: topPath });
      continue;
    }

    // 없으면 2-level (예: feature/<name>) 시도
    let subEntries = [];
    try {
      subEntries = readdirSync(topPath);
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      const subPath = join(topPath, sub);
      let subStat;
      try {
        subStat = statSync(subPath);
      } catch {
        continue;
      }
      if (!subStat.isDirectory()) continue;
      const nestedActive = join(subPath, '.brief2dev', 'run', 'active.json'); // @layout-resolver-allow — cross-worktree discovery scope (R-CM-035 read-only aggregator)
      if (existsSync(nestedActive)) {
        results.push({ name: `${top}/${sub}`, path: subPath });
      }
    }
  }
  return results;
}

/**
 * 멀티세션 발견 — main + 모든 worktree 의 active.json 스캔.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - PROJECT_DIR (테스트 격리)
 * @param {boolean} [opts.includeIdle=false] - idle 상태도 포함
 * @param {boolean} [opts.includeCompleted=false] - completed/aborted 도 포함
 * @returns {Array<{source: string, worktree_path: string, ...active_data}>}
 */
export function listActiveSessions(opts = {}) {
  const projectDir = opts.projectDir || PROJECT_DIR_DEFAULT;
  const includeIdle = opts.includeIdle === true;
  const includeCompleted = opts.includeCompleted === true;
  const sessions = [];

  // 1. main worktree
  const mainPath = join(projectDir, '.brief2dev', 'run', 'active.json'); // @layout-resolver-allow — cross-worktree discovery scope (R-CM-035 read-only aggregator)
  const mainData = readActiveJson(mainPath);
  if (mainData) {
    sessions.push({
      source: 'main',
      worktree_path: projectDir,
      active_json_path: mainPath,
      ...mainData,
      interaction_mode: readInteractionMode(projectDir, mainData.run_id),
    });
  }

  // 2. .worktrees/*
  const worktrees = listWorktrees(projectDir);
  for (const wt of worktrees) {
    const wtActivePath = join(wt.path, '.brief2dev', 'run', 'active.json'); // @layout-resolver-allow — cross-worktree discovery scope (R-CM-035 read-only aggregator)
    const wtData = readActiveJson(wtActivePath);
    if (wtData) {
      sessions.push({
        source: `worktree:${wt.name}`,
        worktree_path: wt.path,
        active_json_path: wtActivePath,
        ...wtData,
        interaction_mode: readInteractionMode(wt.path, wtData.run_id),
      });
    }
  }

  // 3. status 필터
  const filtered = sessions.filter((s) => {
    if (RUNNING_STATUSES.has(s.status)) return true;
    if (includeCompleted && COMPLETED_STATUSES.has(s.status)) return true;
    if (includeIdle && s.status === 'idle') return true;
    return false;
  });

  // 4. enrich — 사람이 읽는 mode + stage 별 skill 명 (Observatory 표시용)
  return filtered.map((s) => ({
    ...s,
    mode: resolveExecutionMode(s.worktree_path, s.run_id),
    current_skill: s.current_stage ? STAGE_SKILL[s.current_stage] || null : null,
    stage_skill_map: STAGE_SKILL,
  }));
}

/**
 * 특정 run_id 의 세션을 cross-worktree 에서 찾는다.
 * @param {string} runId
 * @param {object} [opts]
 * @returns {object|null}
 */
export function findSessionByRunId(runId, opts = {}) {
  if (typeof runId !== 'string' || runId.length === 0) return null;
  const all = listActiveSessions({ ...opts, includeIdle: true, includeCompleted: true });
  return all.find((s) => s.run_id === runId) || null;
}

// 테스트용 internal export
export const _internal = {
  readActiveJson,
  readInteractionMode,
  listWorktrees,
  STAGE_SKILL,
  resolveExecutionMode,
  RUNNING_STATUSES,
  COMPLETED_STATUSES,
};
