#!/usr/bin/env node
/**
 * archive-and-reset.mjs — 현재 파이프라인을 archive로 봉인하고 작업 폴더를 정리한다.
 *
 * 사용:
 *   node .claude/scripts/archive-and-reset.mjs                  # 현재 run을 archive
 *   node .claude/scripts/archive-and-reset.mjs --learning-run   # Learning Run 마커 (R-CM-016 Rule 8.1)
 *   node .claude/scripts/archive-and-reset.mjs --dry-run        # 영향 범위만 출력
 *   node .claude/scripts/archive-and-reset.mjs --force          # 충돌 시 덮어쓰기 (기본은 timestamp suffix)
 *   node .claude/scripts/archive-and-reset.mjs --force-cleanup  # idle + 캐논 잔재 강제 정리 (run_id slug)
 *
 * 동작 (트랜잭션 안전):
 *   Phase 1: 검증 (read-only)
 *     - active-run.json 로드, 상태 검증
 *     - slug 결정 (충돌 시 timestamp suffix 자동 부여)
 *     - 캐논 산출물 인벤토리 작성 (이후 검증용)
 *
 *   Phase 2: archive (write)
 *     - .brief2dev/archives/<final_slug>/{stage-output,handoff,reports}/ 복사 (atomic swap)
 *     - .brief2dev/archives/<final_slug>/_archive-meta.json 작성 (Fix-A: 마커 영구 보존)
 *     - cpSync 후 인벤토리 검증 — 누락 시 즉시 abort (Fix-E: 부분 실패 차단)
 *
 *   Phase 3: 정합성 갱신 (write)
 *     - registry.json#projects.<final_slug> 등록 (audit_status 포함)
 *     - active_project 갱신
 *
 *   Phase 4: 캐논 정리 (write)
 *     - Phase 2 검증 통과한 경우에만 캐논 stage-output/*.json, handoff/*.json, pipeline-memory.json 삭제
 *     - 어느 단계든 실패 시 abort + 사용자 안내
 *
 *   Phase 5: Saga reset (write)
 *     - resetPipeline() — active-run.json idle 초기화
 *
 * 실패 모드 처리:
 *   - Phase 1 실패 → exit 1, 변경 없음
 *   - Phase 2 cpSync 실패 → archive 디렉토리는 saga-manager가 best-effort로 정리. 캐논 보존. exit 1.
 *   - Phase 2 인벤토리 검증 실패 → archive 디렉토리는 그대로 두고 (사용자가 검토), 캐논 보존. exit 1.
 *   - Phase 3 registry 실패 → archive는 성공. registry 부분 갱신 위험. exit 1 + 사용자 안내.
 *   - Phase 4/5 실패 → archive + registry는 성공. 사용자 수동 정리.
 *
 * 보존 (절대 손대지 않음):
 *   .brief2dev/archives/<other-slug>/ — 다른 archive
 *   .brief2dev/learnings.jsonl       — 영구 SSOT (R-CM-020)
 *   .brief2dev/registry.json         — 누적 SSOT (entry 추가만)
 *   .brief2dev/reports/              — 영구 보고서
 *   .brief2dev/_archive/, transplants/, session-history/, inbox/
 */

import { existsSync, readdirSync, rmSync, mkdirSync, statSync, lstatSync, unlinkSync, cpSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomicSync } from './lib/atomic-fs.mjs';
import {
  loadActiveRun,
  resetPipeline,
  computeProjectSlug,
  autoArchiveCanonical,
  autoRegisterProject,
} from './lib/saga-manager.mjs';
import { getPipelineDataRoot, CODE_ROOT, assertSafeProjectDir } from './lib/pipeline-config.mjs';
import { getArchivesRoot, getRunsRoot, getActiveRunId, resolveIdeaMemoryPath, resolveSystemFile } from './lib/layout-resolver.mjs';
import {
  buildArchiveIndexEntryFromArchive,
  readJsonSafe,
} from './lib/archive-indexer.mjs';
import { pickSibling, deriveCurrentStage } from './lib/archive-meta-backfill.mjs';
import { detectTransitionPatterns, formatLearningsPrompt } from './lib/transition-pattern-detector.mjs';

const SETTINGS_PATH = join(CODE_ROOT, '.claude', 'settings.json');

// ─── 실행 옵션 (module var — runArchiveAndReset() 진입 시 opts 로 설정) ───
// 이전엔 module-load 시 process.argv 로 derive 했으나, webui 가 in-process import
// 할 때 import 만으로 동작이 결정되면 안 되므로 mutable 기본값 + runArchiveAndReset
// 본문 / parseCliOpts (CLI guard) 에서 설정한다.
// orphan run (active 가 아닌 .brief2dev/runs/<id>/ 잔재) 을 각각 개별 archive
// 로 봉인한 뒤 캐논에서 제거한다. 데이터 없는 빈/끊어진 항목은 archive 없이
// 제거만 한다. 이후 normal flow 가 active run 을 이어서 archive + reset 한다.
let DRY_RUN = false;
let FORCE_OVERWRITE = false;
let FORCE_CLEANUP = false;
let MIGRATE_ORPHANS = false;

// ─── Reason 4-way 분기 (P4, 2026-04-29) ───
// --reason {completed|aborted|learning_run|pivot} 으로 archive 의도를 명시.
// --learning-run 은 backward-compat (--reason learning_run 으로 매핑).
const REASONS = {
  completed: {
    audit_status: null,
    rationale: 'Pipeline completed successfully. Archived for historical reference.',
  },
  aborted: {
    audit_status: 'ABORTED_RUN',
    rationale: 'User aborted run before completion. Artifacts may be incomplete.',
  },
  learning_run: {
    audit_status: 'LEARNING_RUN_ARTIFACT',
    rationale: 'R-CM-016 Rule 8.1: viability low / pivot 상태 또는 invalidated assumption 미해소 — Builder Mode로 격리됨.',
  },
  pivot: {
    audit_status: 'PIVOTED_RUN',
    rationale: 'Business direction pivoted. Original artifacts preserved as decision history.',
  },
};

function parseReason(argv) {
  // --reason X | --reason=X
  const idx = argv.findIndex((a) => a === '--reason' || a.startsWith('--reason='));
  if (idx >= 0) {
    const raw = argv[idx].startsWith('--reason=') ? argv[idx].slice(9) : argv[idx + 1];
    if (!raw || !(raw in REASONS)) {
      console.error(`[archive-and-reset] ERROR: --reason 값 누락 또는 잘못됨. 허용: ${Object.keys(REASONS).join(', ')}`);
      process.exit(2);
    }
    return raw;
  }
  // backward-compat: --learning-run → reason=learning_run
  if (argv.includes('--learning-run')) return 'learning_run';
  // 기본값: completed (정상 완료 가정)
  return 'completed';
}

// REASON/REASON_INFO/LEARNING_RUN 도 module var — runArchiveAndReset() 진입 시 설정.
let REASON = 'completed';
let REASON_INFO = REASONS.completed;
let LEARNING_RUN = false; // backward-compat 변수 (writeArchiveMeta 등에서 사용)

function log(...a) { console.log('[archive-and-reset]', ...a); }
function err(...a) { console.error('[archive-and-reset] ERROR:', ...a); }

function timestampSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** Phase 1: 검증. 변경 없음. 다음 단계 입력 객체 반환. */
function validateAndPlan() {
  const run = loadActiveRun();
  if (!run) {
    const inventory = collectCanonicalInventory(null);
    const orphanRuns = collectOrphanRuns(null, { trackSymlinks: true });
    if (FORCE_CLEANUP && orphanRuns.length > 0) {
      return {
        run: { run_id: null, status: 'idle', current_stage: null, shared_context: {}, stages: {} },
        activeRunId: null,
        isIdle: true,
        isOrphanOnly: true,
        baseSlug: 'unknown',
        finalSlug: 'unknown',
        suffixed: false,
        inventory,
        runScopedArtifacts: 0,
        orphanRuns,
      };
    }
    log('active-run.json 없음. 종료.');
    return null;
  }

  const isIdle = run.status === 'idle';
  const baseSlug = computeProjectSlug(run);

  // 캐논 잔재 인벤토리 (R-CM-026 P2 layout-aware: runs/<active_run_id>/<subdir>/).
  // active run이 있으면 해당 run의 산출물을, idle이면 빈 인벤토리.
  // orphan run 디렉터리 (active와 무관한 run_id 또는 _unassigned-*)는 별도 함수로 인식.
  const activeRunId = run.run_id || getActiveRunId();
  const inventory = collectCanonicalInventory(activeRunId);
  // reports/는 governance retrospective 등 cross-run 영구 영역이므로 정합성 위반 판정에서 제외.
  // archive에는 함께 복사되지만 idle 상태에서 reports 존재만으로 차단하지 않는다.
  const runScopedArtifacts = inventory.stageOutput.length + inventory.handoff.length;
  const orphanRuns = collectOrphanRuns(activeRunId, { trackSymlinks: true });
  const orphanFileCount = orphanRuns.reduce((sum, o) => sum + o.fileCount, 0);

  if (isIdle) {
    if (runScopedArtifacts === 0 && orphanFileCount === 0) {
      log('진행 상태가 대기(idle)이고 작업 폴더에 정리할 잔재 없음 (reports/는 영구 영역, 무시).');
      return null;
    }
    if (!FORCE_CLEANUP) {
      err('진행 상태는 대기(idle)인데 작업 폴더에 잔재가 있습니다 (정합성 깨짐).');
      if (activeRunId) {
        err(`  active(${activeRunId}):`);
        err(`    stage-output: ${inventory.stageOutput.length}개`);
        err(`    handoff:      ${inventory.handoff.length}개`);
        err(`    (참고) reports: ${inventory.reports.length}개 — 영구 영역이므로 차단 사유에서 제외`);
      }
      if (orphanRuns.length > 0) {
        err(`  미정리 기록 (${orphanRuns.length}개 디렉터리, ${orphanFileCount}개 파일):`);
        for (const o of orphanRuns) err(`    ${o.runId}: ${o.fileCount} 파일`);
      }
      err('해소 옵션:');
      err('  (a) shared_context.business_description을 active-run.json에 수동 보강 후 재실행');
      err('  (b) --force-cleanup 으로 run_id 기반 임시 slug archive 또는 미정리 기록 정리');
      err('  (c) 수동으로 작업 폴더 검토 + 정리');
      return null;
    }
  }

  // orphan-only 시나리오 (R-CM-026 P2 완성, 2026-05-02): idle + active 인벤토리 비고 + orphan 만 존재.
  // archive 안 하고 orphan 디렉터리만 정리하므로 slug 결정 불필요.
  const isOrphanOnly = isIdle && FORCE_CLEANUP &&
                       runScopedArtifacts === 0 &&
                       orphanRuns.length > 0;

  let finalSlug = baseSlug;
  let suffixed = false;
  if (!isOrphanOnly) {
    // slug 결정: idle이면 baseSlug=run_id 또는 unknown.
    if (!baseSlug || baseSlug === 'unknown') {
      err('slug를 결정할 수 없습니다 (business_description + run_id 모두 부재).');
      return null;
    }

    // 충돌 감지: 같은 slug 디렉토리 이미 존재하면 timestamp suffix
    const baseDir = join(getArchivesRoot(), baseSlug);
    const legacyBaseDir = join(getPipelineDataRoot(), baseSlug);
    const hasCanonicalArchive = existsSync(baseDir);
    const hasLegacyArchive = existsSync(legacyBaseDir);
    if (hasCanonicalArchive || hasLegacyArchive) {
      if (FORCE_OVERWRITE && hasCanonicalArchive && !hasLegacyArchive) {
        log(`충돌: .brief2dev/archives/${baseSlug}/ 이미 존재 — --force로 덮어쓰기`);
      } else {
        finalSlug = `${baseSlug}-${timestampSuffix()}`;
        suffixed = true;
        const conflictPath = hasCanonicalArchive ? `.brief2dev/archives/${baseSlug}/` : `.brief2dev/${baseSlug}/ (legacy)`;
        log(`충돌 회피: ${conflictPath} 이미 존재 → .brief2dev/archives/${finalSlug}/ 로 archive`);
      }
    }
  }

  return {
    run,
    activeRunId,
    isIdle,
    isOrphanOnly,
    baseSlug,
    finalSlug,
    suffixed,
    inventory,
    runScopedArtifacts,
    orphanRuns,
  };
}

/**
 * R-CM-026 P2 layout-aware 인벤토리.
 * activeRunId가 있으면 .brief2dev/runs/<activeRunId>/<sub>/ 안의 파일을 수집.
 * activeRunId가 null이면 빈 인벤토리 (orphan은 collectOrphanRuns로 별도 수집).
 *
 * pipeline-memory.json은 system_persistent (R-CM-026 system 카테고리)이므로 archive 대상이 아님.
 * 본 함수는 더이상 pipelineMemory 필드를 채우지 않는다 (호환성을 위해 false 유지).
 */
function collectCanonicalInventory(activeRunId) {
  const result = { stageOutput: [], handoff: [], reports: [], pipelineMemory: false };
  if (!activeRunId) return result;

  const runDir = join(getRunsRoot(), activeRunId);
  for (const [key, dir] of [
    ['stageOutput', 'stage-output'],
    ['handoff', 'handoff'],
    ['reports', 'reports'],
  ]) {
    const full = join(runDir, dir);
    if (!existsSync(full)) continue;
    const files = readdirSync(full).filter(f => {
      const fp = join(full, f);
      try { return statSync(fp).isFile(); } catch { return false; }
    });
    result[key] = files;
  }
  return result;
}

/**
 * R-CM-026 P2 layout-aware orphan 인식.
 * .brief2dev/runs/ 안의 디렉터리 중 active run과 다른 모든 디렉터리.
 * 마이그레이션 잔재 (_unassigned-*) 또는 archive 절차 누락된 이전 run.
 *
 * @param {string} activeRunId
 * @param {object} [opts]
 * @param {boolean} [opts.includeEmpty=false] - 파일 0 개 디렉터리/symlink 도 포함
 * @param {boolean} [opts.trackSymlinks=false] - symlink 을 lstat 으로 식별하고
 *   타깃을 따라가지 않는다 (R-CM-034 per-worktree isolation — symlink 은 다른
 *   worktree run 을 가리킬 수 있어 따라가면 타 세션 라이브 데이터를 건드림)
 * @returns {Array<{runId:string, dirPath:string, isSymlink:boolean, fileCount:number, files:string[]}>}
 */
function collectOrphanRuns(activeRunId, opts = {}) {
  const { includeEmpty = false, trackSymlinks = false } = opts;
  const orphans = [];
  if (!existsSync(getRunsRoot())) return orphans;
  for (const entry of readdirSync(getRunsRoot())) {
    if (activeRunId && entry === activeRunId) continue;
    const dirPath = join(getRunsRoot(), entry);
    let isSymlink = false;
    if (trackSymlinks) {
      try { isSymlink = lstatSync(dirPath).isSymbolicLink(); } catch { continue; }
    }
    const files = [];
    if (!isSymlink) {
      let isDir = false;
      try { isDir = statSync(dirPath).isDirectory(); } catch { isDir = false; }
      if (!isDir) {
        if (!trackSymlinks) continue; // 기존 동작: 비디렉터리/stat 실패 skip
      } else {
        walkAllFiles(dirPath, dirPath, files);
      }
    }
    if (files.length > 0 || includeEmpty) {
      orphans.push({ runId: entry, dirPath, isSymlink, fileCount: files.length, files });
    }
  }
  return orphans;
}

function walkAllFiles(dir, baseDir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkAllFiles(full, baseDir, out);
    else out.push(full);
  }
}

/** Phase 2 검증: archive 디렉토리에 모든 source 파일이 복사됐는지 확인 */
function verifyArchiveIntegrity(archiveRoot, inventory) {
  const missing = [];
  for (const [key, dir] of [['stageOutput', 'stage-output'], ['handoff', 'handoff'], ['reports', 'reports']]) {
    const archiveSubDir = join(archiveRoot, dir);
    for (const f of inventory[key]) {
      const expected = join(archiveSubDir, f);
      if (!existsSync(expected)) missing.push(`${dir}/${f}`);
    }
  }
  return missing;
}

/**
 * R-CM-026 P2 layout-aware 캐논 정리.
 * activeRunId 의 runs/<activeRunId>/{stage-output,handoff}/ 안의 인벤토리 파일을 삭제.
 * pipeline-memory.json 은 system_persistent 이므로 archive 정리 대상이 아님 (R-CM-014 prune 영역).
 */
function clearCanonicalArtifacts(activeRunId, inventory) {
  const removed = [];
  if (!activeRunId) return removed;
  const runDir = join(getRunsRoot(), activeRunId);
  for (const [key, dir] of [['stageOutput', 'stage-output'], ['handoff', 'handoff']]) {
    for (const f of inventory[key]) {
      const path = join(runDir, dir, f);
      if (existsSync(path)) {
        if (!DRY_RUN) rmSync(path, { force: true });
        removed.push(path);
      }
    }
  }
  return removed;
}

/**
 * R-CM-026 P2 force-cleanup orphan 정리.
 * collectOrphanRuns 가 발견한 디렉터리들을 통째로 제거.
 * archive 절차 우회 (3-B Learning Run 정리 시나리오용).
 */
function clearOrphanRuns(orphans) {
  const removed = [];
  for (const o of orphans) {
    if (existsSync(o.dirPath)) {
      if (!DRY_RUN) rmSync(o.dirPath, { recursive: true, force: true });
      removed.push(o.dirPath);
    }
  }
  return removed;
}

/**
 * Phase 6: settings.json permissions.deny에 archive 와일드카드 패턴을 ensure.
 * (Removed: It was overriding permissions.allow and blocking legitimate Read access to governance directories)
 */
const ARCHIVE_DENY_PATTERN = 'Read(./.brief2dev/*/**)';

function ensureArchiveWildcardDeny(dryRun) {
  return { changed: false, reason: 'disabled to allow governance reads' };
}

function writeArchiveMeta(archiveRoot, plan, reason) {
  const info = REASONS[reason] || REASONS.completed;
  const meta = {
    schema_version: '1.1',
    archived_at: new Date().toISOString(),
    sealed_via: 'archive-and-reset',
    run_id: plan.run.run_id,
    business_description: plan.run.shared_context?.business_description || null,
    status_at_archive: plan.run.status,
    current_stage_at_archive: plan.run.current_stage,
    stages_summary: Object.fromEntries(
      Object.entries(plan.run.stages || {}).map(([k, v]) => [k, {
        status: v.status,
        confidence: v.confidence,
        evidence_grade: v.evidence_grade,
      }])
    ),
    base_slug: plan.baseSlug,
    archive_slug: plan.finalSlug,
    timestamp_suffixed: plan.suffixed,
    reason,
    learning_run: reason === 'learning_run',
    audit_status: info.audit_status,
    rationale: info.rationale,
    learnings_candidates: detectTransitionPatterns(plan.run),
  };
  if (!DRY_RUN) {
    if (!existsSync(archiveRoot)) mkdirSync(archiveRoot, { recursive: true });
    // R-CM-014 / R-CM-030 — atomic write 로 multi-worktree race 차단
    writeJsonAtomicSync(join(archiveRoot, '_archive-meta.json'), meta);
  }
  return meta;
}

// ───────────────────────────────────────────────────────────────────────────
// archive-index.json append (R-CM-032 Archive Reuse Discipline)
// ───────────────────────────────────────────────────────────────────────────

function updateArchiveIndex(archiveRoot, plan, reason, meta) {
  // R-CM-026 lifecycle: system_persistent. layout-resolver 헬퍼로 hardcode 회피 (Rule 8).
  const indexPath = resolveSystemFile('archive-index.json');
  const indexDir = dirname(indexPath);

  if (!existsSync(indexDir)) {
    if (!DRY_RUN) {
      mkdirSync(indexDir, { recursive: true });
    } else {
      log(`  [dry-run] would create ${indexDir}`);
      return;
    }
  }

  // 초기 index 또는 기존 index 로드
  let index = readJsonSafe(indexPath);
  if (!index) {
    index = { schema_version: '1.0', entries: [] };
  }
  if (!Array.isArray(index.entries)) {
    index.entries = [];
  }

  // Phase 2 has not created the archive snapshot yet in dry-run, so reading
  // archiveRoot would always (falsely) yield "Stage 1 산출물 부재". Phase 2
  // copies the canonical run dir verbatim into archiveRoot, so in dry-run we
  // read that source dir to predict exactly what the real run will register.
  // No activeRunId (idle/orphan) → no source → genuine skip (readRoot unset).
  const readRoot = DRY_RUN && plan.activeRunId
    ? join(getRunsRoot(), plan.activeRunId)
    : undefined;

  const entry = buildArchiveIndexEntryFromArchive(archiveRoot, {
    archiveSlug: plan.finalSlug,
    reason,
    meta,
    baseSlug: plan.baseSlug,
    readRoot,
  });
  if (!entry) {
    log(`  Stage 1 산출물 부재 — index entry 생성 skip`);
    return;
  }

  // 중복 archive_slug 제거 후 prepend (최신 우선 — similarity 검색 시 빠른 매칭)
  index.entries = index.entries.filter(e => e.archive_slug !== entry.archive_slug);
  index.entries.unshift(entry);

  if (!DRY_RUN) {
    // R-CM-014 / R-CM-030 — atomic write 로 multi-worktree race 차단 (archive-index 는 동시 호출 위협 가장 큰 자산)
    writeJsonAtomicSync(indexPath, index);
    log(`  → archive-index entry 추가: ${entry.archive_slug} (tags: ${entry.tags.business_model}/${entry.tags.revenue_model}, viability: ${entry.viability_score})`);
  } else {
    log(`  [dry-run] would add archive-index entry: ${entry.archive_slug}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// orphan run 마이그레이션 (--migrate-orphans)
// ───────────────────────────────────────────────────────────────────────────

/**
 * .brief2dev/runs/ 하위에서 active 가 아닌 모든 항목 (빈 디렉터리/symlink 포함).
 * collectOrphanRuns 의 includeEmpty + trackSymlinks 프리셋 (DRY — 중복 제거).
 *
 * @returns {Array<{runId:string, dirPath:string, isSymlink:boolean, fileCount:number, files:string[]}>}
 */
function collectAllOrphanEntries(activeRunId) {
  return collectOrphanRuns(activeRunId, { includeEmpty: true, trackSymlinks: true });
}

/** 기존 봉인 기록의 _archive-meta.json 전체 수집 (sibling 백필 입력). */
function collectExistingArchiveMetas() {
  if (!existsSync(getArchivesRoot())) return [];
  const out = [];
  for (const ent of readdirSync(getArchivesRoot(), { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const meta = readJsonSafe(join(getArchivesRoot(), ent.name, '_archive-meta.json'));
    if (meta) out.push({ slug: ent.name, meta });
  }
  return out;
}

/**
 * orphan 항목 1개를 ABORTED archive 로 봉인 (데이터 보존).
 * @param {object} orphan
 * @param {Array<{slug:string,meta:object}>} [existingMetas] - sibling 백필 풀.
 *   호출자가 루프 밖에서 1회 수집해 전달 (O(N×M) walk 회피).
 */
function archiveOneOrphan(orphan, existingMetas = collectExistingArchiveMetas()) {
  const bc = readJsonSafe(join(orphan.dirPath, 'stage-output', 'business-context.json'));
  let desc =
    bc?.business?.name || bc?.business?.description || bc?.business_description || null;
  let currentStage = null;
  let stages = {};
  // stage-output 부재 orphan 은 동일 run_id 의 rich sibling archive 로 백필
  // (사용자 결정 2026-05-18 — null 메타 봉인 재발 차단). 부재 시 fail-open.
  if (!desc) {
    // orphan 은 아직 getArchivesRoot() 에 없으므로 targetSlug 자기 제외 불필요 ('' 의도적).
    const sib = pickSibling('', orphan.runId, existingMetas);
    if (sib) {
      desc = sib.meta.business_description || null;
      currentStage =
        sib.meta.current_stage_at_archive || deriveCurrentStage(sib.meta.stages_summary) || null;
      if (sib.meta.stages_summary && typeof sib.meta.stages_summary === 'object') {
        stages = Object.fromEntries(
          Object.entries(sib.meta.stages_summary).map(([k, v]) => [k, { status: v.status }]),
        );
      }
    }
  }
  const pseudoRun = {
    run_id: orphan.runId,
    status: 'aborted',
    current_stage: currentStage,
    started_at: null,
    shared_context: { business_description: desc },
    stages,
  };
  const baseSlug = computeProjectSlug(pseudoRun); // desc 있으면 그것, 없으면 run_id
  let finalSlug = baseSlug;
  let suffixed = false;
  if (existsSync(join(getArchivesRoot(), finalSlug))) {
    finalSlug = `${baseSlug}-${timestampSuffix()}`;
    suffixed = true;
  }
  const archiveRoot = join(getArchivesRoot(), finalSlug);
  const plan = { run: pseudoRun, activeRunId: orphan.runId, baseSlug, finalSlug, suffixed };

  if (!DRY_RUN) {
    // orphan 디렉터리 전체를 archive 로 1:1 스냅샷 (stage-output/handoff/
    // reports/references/research 등 모든 잔재 보존).
    mkdirSync(archiveRoot, { recursive: true });
    cpSync(orphan.dirPath, archiveRoot, { recursive: true });
  }
  const meta = writeArchiveMeta(archiveRoot, plan, 'aborted');
  try {
    updateArchiveIndex(archiveRoot, plan, 'aborted', meta);
  } catch (e) {
    err(`  archive-index 갱신 실패 (fail-open): ${e.message}`);
  }
  if (!DRY_RUN) {
    autoRegisterProject(pseudoRun, {
      archive_dir: finalSlug,
      archive_path: `.brief2dev/archives/${finalSlug}`,
      sealed_via: 'archive-and-reset:migrate-orphans',
      reason: 'aborted',
      audit_status: 'ABORTED_RUN',
    });
  }
  return { finalSlug, suffixed };
}

/** orphan 항목 1개를 캐논에서 제거 (symlink 는 링크만, 디렉터리는 recursive). */
function removeOrphanEntry(orphan) {
  if (DRY_RUN) return;
  if (orphan.isSymlink) {
    try {
      unlinkSync(orphan.dirPath);
    } catch (e) {
      err(`  symlink 포인터 제거 실패 (수동 확인 필요): runs/${orphan.runId} — ${e.message}`);
    }
    return;
  }
  if (existsSync(orphan.dirPath)) rmSync(orphan.dirPath, { recursive: true, force: true });
}

/** Phase M: 모든 orphan 을 개별 봉인 (데이터 있으면) + 캐논에서 제거. */
function runOrphanMigration(activeRunId) {
  const orphans = collectAllOrphanEntries(activeRunId);
  log(`Phase M: 미정리 기록 마이그레이션 — ${orphans.length}개 항목 (현재 작업 ${activeRunId ?? 'none'} 제외)`);
  if (orphans.length === 0) {
    log('  (미정리 기록 없음)');
    log('');
    return;
  }
  const existingMetas = collectExistingArchiveMetas();
  for (const o of orphans) {
    if (o.fileCount > 0) {
      const { finalSlug, suffixed } = archiveOneOrphan(o, existingMetas);
      log(`  ${DRY_RUN ? '[dry-run] ' : ''}봉인: ${o.runId} (${o.fileCount} 파일) → archives/${finalSlug}${suffixed ? ' (timestamp suffix)' : ''} [ABORTED_RUN]`);
      removeOrphanEntry(o);
      log(`  ${DRY_RUN ? '[dry-run] would remove' : 'removed'}: runs/${o.runId}`);
    } else {
      removeOrphanEntry(o);
      log(`  ${DRY_RUN ? '[dry-run] would remove' : 'removed'} (데이터 없음, archive 생략): runs/${o.runId}${o.isSymlink ? ' (symlink)' : ''}`);
    }
  }
  log('');
}

/**
 * archive-and-reset 의 importable core. CLI 진입점 (parseCliOpts → 본 함수) 과
 * webui in-process 호출 (run-mutator.archiveRun → 본 함수) 의 공통 실행 본문.
 *
 * 이전엔 `main()` 이 module-load 시 derive 된 const 들을 읽었으나, in-process import
 * 를 위해 opts 를 module var 로 설정하는 진입점으로 변경했다. opts 미지정 키는 안전
 * 기본값 (dry-run 아님 / completed reason) 으로 동작한다.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {boolean} [opts.forceOverwrite=false]
 * @param {boolean} [opts.forceCleanup=false]
 * @param {boolean} [opts.migrateOrphans=false]
 * @param {string}  [opts.reason='completed'] - REASONS 키 (completed|aborted|learning_run|pivot)
 * @returns {{ ok: true, mode?: string, skipped?: boolean, reason?: string, archive_slug?: string, removed_count?: number }}
 * @throws {Error} invalid reason / archive 실패 시
 */
export function runArchiveAndReset(opts = {}) {
  // opts → module var 설정 (이전 const derive 대체). webui in-process / CLI 공통 진입.
  DRY_RUN = !!opts.dryRun;
  FORCE_OVERWRITE = !!opts.forceOverwrite;
  FORCE_CLEANUP = !!opts.forceCleanup;
  MIGRATE_ORPHANS = !!opts.migrateOrphans;
  REASON = opts.reason || 'completed';
  if (!(REASON in REASONS)) throw new Error('invalid reason: ' + REASON);
  REASON_INFO = REASONS[REASON];
  LEARNING_RUN = REASON === 'learning_run';

  // SAFETY: vitest globalSetup 격리 실패 시 실제 repo 오염 방지.
  assertSafeProjectDir();

  // ── Phase M: orphan 마이그레이션 (active run 이어서 normal flow 가 처리) ──
  if (MIGRATE_ORPHANS) {
    if (DRY_RUN) log('==== DRY-RUN MODE: 실제 변경 없음 ====');
    runOrphanMigration(getActiveRunId());
  }

  // ── Phase 1: 검증 ──
  const plan = validateAndPlan();
  if (!plan) return { ok: true, skipped: true, reason: 'nothing-to-archive' };

  log(`run_id: ${plan.run.run_id ?? '(none)'}`);
  log(`base slug:  ${plan.baseSlug}`);
  log(`final slug: ${plan.finalSlug}${plan.suffixed ? ' (timestamp suffix 부여 — 충돌 회피)' : ''}`);
  log(`status: ${plan.run.status}, current_stage: ${plan.run.current_stage ?? '(none)'}`);
  log(`잔재 파일 (active=${plan.activeRunId ?? 'none'}): stage-output=${plan.inventory.stageOutput.length}, handoff=${plan.inventory.handoff.length}, reports=${plan.inventory.reports.length}`);
  if (plan.orphanRuns && plan.orphanRuns.length > 0) {
    log(`미정리 기록: ${plan.orphanRuns.length}개 디렉터리, ${plan.orphanRuns.reduce((s, o) => s + o.fileCount, 0)}개 파일`);
    for (const o of plan.orphanRuns) log(`  ${o.runId}: ${o.fileCount}개`);
  }
  if (DRY_RUN) log('==== DRY-RUN MODE: 실제 변경 없음 ====');

  // ── force-cleanup orphan only 시나리오 ──
  // R-CM-026 P2 완성 사이클의 3-B Learning Run 정리 시나리오용. archive 우회.
  if (plan.isOrphanOnly) {
    log('Phase O: 미정리 기록 디렉터리 정리 (archive 우회)');
    const orphanRemoved = clearOrphanRuns(plan.orphanRuns);
    log(`  ${DRY_RUN ? '[dry-run] would remove' : 'removed'}: ${orphanRemoved.length}개 디렉터리`);
    log('');
    if (DRY_RUN) log('DRY-RUN 완료. 실제 실행: --dry-run 제거.');
    else log('미정리 기록 정리 완료. registry.json 의 archive_dir 잔존 entry 는 별도 검토 필요.');
    return { ok: true, mode: 'orphan-cleanup' };
  }

  // 임시: archive 함수가 baseSlug 기반으로 동작하므로, finalSlug != baseSlug일 때 호출 직전 우회 필요.
  // saga-manager.autoArchiveCanonical은 computeProjectSlug(run)을 내부 호출.
  // 충돌 시 finalSlug로 archive하려면 in-memory에서 business_description을 변형하거나,
  // 직접 cpSync를 수행해야 함. 후자가 결정론적.
  const archiveRoot = join(getArchivesRoot(), plan.finalSlug);

  // ── Phase 2: archive ──
  log('Phase 2: archive snapshot 생성');
  if (plan.suffixed) {
    // 충돌 회피 — 직접 archive 수행
    if (!DRY_RUN) {
      try {
        directArchive(plan.activeRunId, archiveRoot);
      } catch (e) {
        err(`archive 실패: ${e.message}`);
        err('작업 폴더는 그대로 보존됩니다. 부분 archive가 archiveRoot에 남았다면 수동 검토 필요.');
        throw new Error('archive 실패: ' + e.message);
      }
    } else {
      log(`  [dry-run] would directArchive(canonical → ${archiveRoot})`);
    }
  } else {
    // 충돌 없음 — saga-manager 표준 경로 (atomic swap 보장)
    if (!DRY_RUN) autoArchiveCanonical({ ...plan.run, shared_context: plan.run.shared_context });
    else log(`  [dry-run] would autoArchiveCanonical → ${archiveRoot}`);
  }
  log(`  → ${archiveRoot.replace(getPipelineDataRoot(), '.brief2dev')}/`);

  // 인벤토리 검증
  if (!DRY_RUN) {
    const missing = verifyArchiveIntegrity(archiveRoot, plan.inventory);
    if (missing.length > 0) {
      err(`archive 무결성 검증 실패: ${missing.length}개 누락`);
      for (const m of missing.slice(0, 10)) err(`  missing: ${m}`);
      err('작업 폴더는 정리하지 않습니다. archive 디렉토리를 수동 검토하세요.');
      throw new Error(`archive 무결성 검증 실패: ${missing.length}개 누락 (${missing.slice(0, 3).join(', ')})`);
    }
  }

  // 메타 파일 작성 (P4: --reason 4-way 분기 영구 보존)
  log('Phase 2.5: _archive-meta.json 작성');
  const meta = writeArchiveMeta(archiveRoot, plan, REASON);
  log(`  reason: ${REASON}, audit_status: ${meta.audit_status || '(none)'}`);

  // ── Phase 2.7: archive-index 갱신 (R-CM-032 Archive Reuse Discipline) ──
  log('Phase 2.7: archive-index.json 갱신 (R-CM-032)');
  try {
    updateArchiveIndex(archiveRoot, plan, REASON, meta);
  } catch (e) {
    err(`  archive-index 갱신 실패 (fail-open): ${e.message}`);
    // 본 Phase 는 archive 자체를 차단하지 않는다 (R-CM-032 Rule 6 fail-open).
  }

  // ── Phase 3: registry 갱신 ──
  log('Phase 3: registry.json 갱신');
  const extra = {
    archive_dir: plan.finalSlug,
    archive_path: `.brief2dev/archives/${plan.finalSlug}`,
    sealed_via: 'archive-and-reset',
    reason: REASON,
    audit_status: REASON_INFO.audit_status,
  };
  if (!DRY_RUN) {
    autoRegisterProject(plan.run, extra);
    log(`  → registry.projects.${computeProjectSlug(plan.run)} (audit_status=${extra.audit_status || 'null'})`);
  } else {
    log(`  [dry-run] would register projects.${computeProjectSlug(plan.run)} with extra=${JSON.stringify(extra)}`);
  }

  // ── Phase 4: 캐논 정리 ──
  log('Phase 4: 작업 폴더 정리');
  const removed = clearCanonicalArtifacts(plan.activeRunId, plan.inventory);
  if (removed.length === 0) {
    log('  (정리할 파일 없음)');
  } else {
    log(`  ${DRY_RUN ? '[dry-run] would remove' : 'removed'}: ${removed.length}개 파일`);
  }

  // ── Phase 4.5: idea-memory.json 봉인 (R-CM-014 P3, 2026-05-06) ──
  // R-CM-028 Two-Perspective Boundary 데이터 분리 — idea-memory.json 은 run-scoped 이므로
  // archive 봉인 + 캐논 정리. system pipeline-memory.json 은 보존 (기존 정책 유지).
  log('Phase 4.5: idea-memory.json archive (R-CM-014 P3)');
  if (plan.activeRunId) {
    const ideaMemoryPath = resolveIdeaMemoryPath(plan.activeRunId);
    if (ideaMemoryPath && existsSync(ideaMemoryPath)) {
      const archiveTarget = join(archiveRoot, 'idea-memory.json');
      if (!DRY_RUN) {
        try {
          if (existsSync(archiveTarget)) rmSync(archiveTarget, { force: true });
          cpSync(ideaMemoryPath, archiveTarget);
          rmSync(ideaMemoryPath, { force: true });
        } catch (e) {
          err(`idea-memory archive 실패: ${e.message}`);
          err('  archive 디렉토리는 그대로 두고 작업 폴더의 idea-memory.json 만 보존됩니다.');
        }
      }
      log(`  → ${archiveTarget.replace(getPipelineDataRoot(), '.brief2dev')}`);
    } else {
      log('  (idea-memory.json 부재 — skip)');
    }
  } else {
    log('  (activeRunId 없음 — skip)');
  }

  // ── Phase 5: Saga reset ──
  log('Phase 5: 진행 상태 초기화 (Saga reset)');
  if (!DRY_RUN) {
    resetPipeline();
    log('  → active-run.json idle, transition_log에 force_reset 기록');
  } else {
    log('  [dry-run] would call resetPipeline() → idle');
  }

  // ── Phase 6: settings.json deny 와일드카드 ensure ──
  log('Phase 6: settings.json permissions.deny 와일드카드 ensure (archive prejudge 차단)');
  const denyResult = ensureArchiveWildcardDeny(DRY_RUN);
  if (denyResult.changed) {
    log(`  ${DRY_RUN ? '[dry-run] would add' : 'added'}: ${denyResult.pattern}`);
  } else {
    log(`  (skip: ${denyResult.reason})`);
  }

  log('');
  if (DRY_RUN) {
    log('DRY-RUN 완료. 실제 실행: --dry-run 제거.');
  } else {
    log(`완료. archive: .brief2dev/archives/${plan.finalSlug}/`);
    log('다음 비즈니스 아이디어를 입력하면 새 run이 시작됩니다.');
  }

  // ── P2-5 phase 2: learnings.jsonl 자동 prompt ──
  // R-CM-016 Rule 10 User Sovereignty — 자동 등록 X, 사용자 검토 후 수동.
  const prompt = formatLearningsPrompt(meta.learnings_candidates);
  if (prompt) {
    console.log(prompt);
  }

  // 성공 종료 — webui in-process 호출자 (run-mutator.archiveRun) 가 archive_slug 를 소비.
  // removed 는 Phase 4 의 const (clearCanonicalArtifacts 결과) — 동일 함수 scope.
  return {
    ok: true,
    mode: 'archive',
    archive_slug: plan.finalSlug,
    reason: REASON,
    removed_count: removed.length,
  };
}

/**
 * 충돌 회피 시 직접 archive 수행. saga-manager.autoArchiveCanonical은 baseSlug 기반이라
 * 다른 디렉토리로 보낼 수 없음. 동일 atomic 패턴 (tmp → rename, old → 삭제)으로 직접 구현.
 *
 * Atomic 보장 (autoArchiveCanonical과 동일):
 *   1. tmp 경로에 cpSync (실패해도 dst 무사)
 *   2. dst가 존재하면 old로 rename (atomic)
 *   3. tmp를 dst로 rename (atomic)
 *   4. old 삭제
 *   실패 시 old → dst 롤백 시도.
 */
function directArchive(activeRunId, archiveRoot) {
  // autoArchiveCanonical 과 동일한 subdir 목록 — transcript 포함 (loom UI archive 대화 surface).
  const subdirs = ['stage-output', 'handoff', 'reports', 'transcript'];
  const now = Date.now();
  if (!activeRunId) return; // idle + orphan 시나리오는 archive 우회 (clearOrphanRuns 사용)
  const runDir = join(getRunsRoot(), activeRunId);
  mkdirSync(archiveRoot, { recursive: true });
  for (const sub of subdirs) {
    const src = join(runDir, sub);
    if (!existsSync(src)) continue;
    const dst = join(archiveRoot, sub);
    const tmp = join(archiveRoot, `.${sub}.tmp-${now}`);
    const old = join(archiveRoot, `.${sub}.old-${now}`);
    try {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
      cpSync(src, tmp, { recursive: true });
      if (existsSync(dst)) renameSync(dst, old);
      renameSync(tmp, dst);
      if (existsSync(old)) rmSync(old, { recursive: true, force: true });
    } catch (e) {
      try { if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      try {
        if (existsSync(old) && !existsSync(dst)) renameSync(old, dst);
        else if (existsSync(old)) rmSync(old, { recursive: true, force: true });
      } catch { /* ignore */ }
      throw e;
    }
  }
}

/** CLI argv → runArchiveAndReset opts. parseReason 는 잘못된 --reason 시 exit(2). */
function parseCliOpts(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    forceOverwrite: argv.includes('--force'),
    forceCleanup: argv.includes('--force-cleanup'),
    migrateOrphans: argv.includes('--migrate-orphans'),
    reason: parseReason(argv),
  };
}

// CLI guard — `node archive-and-reset.mjs ...` 직접 실행 시에만 동작.
// in-process import (webui run-mutator) 시에는 main() side-effect 가 돌지 않는다.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runArchiveAndReset(parseCliOpts(process.argv.slice(2)));
    process.exit(0);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}
