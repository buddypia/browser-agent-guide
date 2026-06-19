/**
 * run-mutator.mjs — Loom 'Runs' 대시보드의 단일 run mutation 진입점 (cross-worktree).
 *
 * R-CM-035 예외 5 (2026-06-18): RUN archive / hard-delete WebUI mutation 위임 허용.
 *   memory-mutator.mjs (예외 1/3 — AI 메모리 4동작) + decision-mutator.mjs (예외 — 결정 응답)
 *   와 같은 위임 모델. brief2dev-webui.mjs 가 본 모듈을 직접 import 한다 (child_process 아님 →
 *   단방향 흐름 + SSOT 단일성).
 *
 * 본 모듈은 R-CM-035 predicate 의 WEBUI_FILE_PATTERNS *밖*이다 (webui 서버는 호출만, write 는
 * 본 모듈 + archive-and-reset core 집중).
 *
 * Cross-worktree 핵심 (withProjectDirOverride):
 *   webui 서버는 main 프로세스로 돌지만, archive/삭제 대상 run 은 *다른 worktree* 의
 *   worktree_local 자산 (`run/active.json`, `runs/<id>/`) 일 수 있다. withProjectDirOverride(worktreePath, fn)
 *   로 worktree_local 해석 base 를 그 worktree 로 동기 스코프 override 하면 loadActiveRun /
 *   getRunsRoot / resetPipeline 이 그 worktree 기준으로 동작한다. system_persistent
 *   (getArchivesRoot / loadRegistry → resolveSystemPersistentRoot git-common-dir) 는 override
 *   무영향 → archive snapshot / registry / index 는 항상 main 에 누적된다 (R-CM-026 / R-CM-030 정합).
 *   override 누출 방지를 위해 archive 코어 (runArchiveAndReset) 는 sync fs 만 사용한다.
 *
 * 3동작 모델:
 *   - archive (active run)          : runArchiveAndReset 으로 봉인 + reset → 복구 가능 (archives snapshot)
 *   - hard-delete (active run)      : 봉인 없이 runs/<id>/ 제거 + active.json idle 화 → 복구 불가
 *   - hard-delete-archived (archive): archives/<slug>/ 제거 + registry entry 정리 → 복구 불가
 *
 * 멀티세션 / 안전장치:
 *   1. path traversal 방어 — assertSafeRunId (active run dir) / assertSafeSlug (archive).
 *   2. atomic write — registry 갱신은 saveRegistry (writeJsonAtomicSync).
 *   3. archive 코어의 atomic swap (directArchive tmp→rename) 으로 부분 실패 차단.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  withProjectDirOverride,
  getArchivesRoot,
  getRunsRoot,
} from './layout-resolver.mjs';
import { runArchiveAndReset } from '../archive-and-reset.mjs';
import { loadActiveRun, resetPipeline } from './saga-manager.mjs';
import { loadRegistry, saveRegistry } from './pipeline-config.mjs';

export class RunMutationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RunMutationError';
    this.code = code;
  }
}

// ── 공통 가드 (path traversal 방어) ──────────────────────────────────────
/**
 * run_id 가 단일 디렉터리 세그먼트인지 검증 (runs/<id>/ rmSync blast radius 차단).
 * memory-mutator.assertSafeId 동형.
 */
function assertSafeRunId(id) {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('..')
  ) {
    throw new RunMutationError('잘못된 run 식별자', 'invalid_id');
  }
}

/**
 * archive slug 가 단일 디렉터리 세그먼트인지 검증 (archives/<slug>/ rmSync blast radius 차단).
 * archive-library-aggregator.isSafeSlug 동형 ('.' prefix 도 차단).
 */
function assertSafeSlug(slug) {
  if (
    typeof slug !== 'string' ||
    slug.length === 0 ||
    slug.includes('/') ||
    slug.includes('\\') ||
    slug.includes('..') ||
    slug.startsWith('.')
  ) {
    throw new RunMutationError('잘못된 아카이브 식별자', 'invalid_id');
  }
}

// ── public API ───────────────────────────────────────────────────────────
/**
 * active run 1개를 archive 봉인 + reset 한다 (복구 가능 — archives snapshot).
 *
 * worktreePath 가 명시되면 그 worktree 의 worktree_local 자산 (active.json / runs/<id>)을 대상으로
 * 한다 (cross-worktree). archive snapshot 은 system_persistent (main) 에 누적된다.
 *
 * @param {object} args
 * @param {string} [args.worktreePath] - 대상 run 의 worktree 절대 경로. falsy 면 projectDir 사용.
 * @param {string} [args.runId] - 대상 run_id. 명시 시 active run_id 와 일치 검증.
 * @param {string} [args.reason='aborted'] - REASONS 키 (completed|aborted|learning_run|pivot).
 * @param {string} [args.projectDir] - worktreePath 부재 시 fallback base.
 * @returns {{ ok: true, mode: 'archive', archive_slug: string|null, run_id: string }}
 * @throws {RunMutationError} pipeline_idle | invalid_state | archive_failed
 */
export function archiveRun({ worktreePath, runId, reason = 'aborted', projectDir } = {}) {
  return withProjectDirOverride(worktreePath || projectDir, () => {
    const run = loadActiveRun();
    if (!run || run.status === 'idle') {
      throw new RunMutationError('archive 할 active run 이 없습니다', 'pipeline_idle');
    }
    if (runId && run.run_id && run.run_id !== runId) {
      throw new RunMutationError('run_id 불일치', 'invalid_state');
    }
    let r;
    try {
      r = runArchiveAndReset({ reason });
    } catch (e) {
      throw new RunMutationError('archive 실패: ' + e.message, 'archive_failed');
    }
    if (!r || !r.ok) {
      throw new RunMutationError('archive 실패', 'archive_failed');
    }
    return {
      ok: true,
      mode: 'archive',
      archive_slug: r.archive_slug || null,
      run_id: run.run_id,
    };
  });
}

/**
 * active run 1개를 봉인 없이 폐기한다 (복구 불가 — runs/<id> 제거 + active.json idle 화).
 *
 * worktreePath override 안에서 getRunsRoot / resetPipeline 이 그 worktree 기준으로 해석된다.
 *
 * @param {object} args
 * @param {string} [args.worktreePath] - 대상 run 의 worktree 절대 경로. falsy 면 projectDir 사용.
 * @param {string} [args.runId] - 대상 run_id. 명시 시 active run_id 와 일치 검증.
 * @param {string} [args.projectDir] - worktreePath 부재 시 fallback base.
 * @returns {{ ok: true, mode: 'hard-delete', run_id: string|null }}
 * @throws {RunMutationError} pipeline_idle | invalid_state | invalid_id
 */
export function hardDeleteRun({ worktreePath, runId, projectDir } = {}) {
  return withProjectDirOverride(worktreePath || projectDir, () => {
    const run = loadActiveRun();
    if (!run || run.status === 'idle') {
      throw new RunMutationError('삭제할 active run 이 없습니다', 'pipeline_idle');
    }
    const rid = run.run_id;
    if (runId && rid && rid !== runId) {
      throw new RunMutationError('run_id 불일치', 'invalid_state');
    }
    // runs/<rid>/ 디렉터리 제거 (있으면). idea-memory.json 포함 — run-scoped 전체 폐기.
    // rid 가 path traversal 안전한지 검사 후 rmSync (blast radius 차단).
    if (rid) {
      assertSafeRunId(rid);
      const runDir = join(getRunsRoot(), rid);
      if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
    }
    // active.json idle 화 (Saga reset).
    resetPipeline();
    return { ok: true, mode: 'hard-delete', run_id: rid || null };
  });
}

/**
 * 이미 봉인된 archive 1개를 영구삭제한다 (복구 불가 — archives/<slug>/ 제거 + registry entry 정리).
 *
 * archives 는 system_persistent (main) 이라 withProjectDirOverride 불필요 — getArchivesRoot /
 * loadRegistry 가 항상 main 기준이다.
 *
 * @param {object} args
 * @param {string} args.slug - 대상 archive slug (단일 디렉터리 세그먼트).
 * @param {string} [args.projectDir] - (unused — archives 는 main 고정. 시그니처 일관성용.)
 * @returns {{ ok: true, mode: 'hard-delete-archived', slug: string }}
 * @throws {RunMutationError} invalid_id | not_found
 */
export function hardDeleteArchivedRun({ slug, projectDir } = {}) {
  assertSafeSlug(slug);
  const dir = join(getArchivesRoot(), slug);
  if (!existsSync(dir)) {
    throw new RunMutationError('아카이브를 찾을 수 없습니다', 'not_found');
  }
  rmSync(dir, { recursive: true, force: true });
  // registry entry 정리 — archive_dir === slug 또는 key === slug 인 project 제거.
  const reg = loadRegistry();
  if (reg && reg.projects) {
    for (const [k, v] of Object.entries(reg.projects)) {
      if ((v && v.archive_dir === slug) || k === slug) delete reg.projects[k];
    }
    if (reg.active_project === slug) reg.active_project = null;
    saveRegistry(reg);
  }
  return { ok: true, mode: 'hard-delete-archived', slug };
}
