// brief2dev Loom — decision read-only aggregator (R-CM-035 invariant).
// CLI (skill/hook/adapter)만 writer. 본 모듈은 .brief2dev SSOT 를 읽기만 한다.
// fail-safe: 모든 오류는 빈 결과로 degrade (R-CM-006 Rule 2 fail-open 정합).
//
// PADR-013 Decision Exchange Protocol 의 control-plane 파일
// (.brief2dev/runs/<run_id>/decisions/*.json) 을 읽어, 각 decision 에
// decision-linter 의 lint 상태(ok/errors/warnings)를 함께 붙여 반환한다.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { lintDecision } from './decision-linter.mjs';
import { resolveSessionDecisionsDir } from './decision-session-path.mjs';

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 한 run 의 decision 파일들을 읽어 lint 상태와 함께 반환한다.
 *
 * @param {string} worktreePath - 세션의 worktree 루트 (resolveSession 이 제공)
 * @param {string} runId        - run id
 * @param {{ now?: string }} [opts] - now 주입 시 lint 의 stale(expiry) 검사를 결정론화 (미지정 시 실제 현재)
 * @returns {{ ok: boolean, run_id: string, decisions: Array<{file:string,data:object,lint:{ok:boolean,errors:Array,warnings:Array}}> }}
 */
export function listDecisions(worktreePath, runId, opts = {}) {
  const empty = { ok: false, run_id: runId, decisions: [] };
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return empty;
  if (typeof runId !== 'string' || runId.length === 0) return empty;
  // path traversal 방어 — runId 는 단일 segment slug 여야 한다. URL 로 triggerable 한 경로이므로
  // '/' / '\\' / '..' 포함 시 거부 (memory-mutator 의 식별자 검증과 동일 정신).
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) return empty;

  // cross-worktree 경로는 reader/writer 단일 SSOT helper 로 조립 (mutator 와 동일 물리 경로 보장).
  const decisionsDir = resolveSessionDecisionsDir(worktreePath, runId);

  let files = [];
  try {
    files = readdirSync(decisionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    // 디렉터리 부재 = 아직 decision 없음 (정상). fail-open 으로 빈 목록 반환.
    return { ok: true, run_id: runId, decisions: [] };
  }

  const decisions = [];
  for (const file of files) {
    const data = readJsonSafe(join(decisionsDir, file));
    if (data === null) continue; // 파싱 실패 파일 skip (fail-safe)
    // requireAnswered:false — pending/rejected 도 패널에 표시하되 status 는 lint 가 보고.
    // opts.now 주입 시 stale(expiry) 검사를 결정론적으로 — 미지정이면 linter 가 실제 현재(new Date()) 사용.
    const { ok, errors, warnings } = lintDecision(data, { requireAnswered: false, now: opts.now });
    decisions.push({ file, data, lint: { ok, errors, warnings } });
  }

  // sequence 오름차순 (없으면 0 취급). 안정 정렬로 동일 sequence 는 파일 발견 순.
  decisions.sort((a, b) => (a.data?.sequence ?? 0) - (b.data?.sequence ?? 0));

  return { ok: true, run_id: runId, decisions };
}
