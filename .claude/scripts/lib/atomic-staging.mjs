/**
 * atomic-staging.mjs — scaffold-deploy 의 tmp-staging + per-entry overlay 헬퍼.
 *
 * 배경:
 *   scaffold-deploy.mjs 의 12-Phase 파이프라인은 scaffoldDir 에 직접 write 한다.
 *   중간 phase 가 throw 하면 partial 상태로 잔존 (F2). 같은 scaffoldDir 에
 *   재배포 시 stale 파일이 silently 살아남음 (F3). 한편 individual JSON write
 *   가 non-atomic 이면 partial 파일 (F1) 도 가능.
 *
 * 해결 (Option C):
 *   1. setupAtomicStaging: scaffoldDir 안에 unique tmp dir (`.staging-XXXXXX`)
 *      생성.
 *   2. Phase 1–9 (실제 12 calls — 7.5/8.5/8.6 sub-phase 포함) 가 stagingDir
 *      로 write (atomic-fs 의 writeJsonAtomicSync 와 함께 F1+F2 둘 다 차단).
 *   3. commitAtomicStaging: stagingDir 의 모든 entry 를 scaffoldDir 에
 *      per-entry rename 으로 overlay. 디렉토리는 dest 부재 시 디렉토리 전체
 *      rename (POSIX atomic), 존재 시 recurse merge. 파일/심볼릭은 단일
 *      rename (POSIX atomic on same fs).
 *   4. rollbackAtomicStaging: throw 시 stagingDir 전체 rm — scaffoldDir 의
 *      기존 상태 보존.
 *   5. cleanupStaleStagingDirs: 24h 이상 된 .staging-* 잔존 dir 정리.
 *
 * 한계 (정직 명시):
 *   - commit 중간 throw 시 일부 entry 만 overlay (per-entry rename 의 한계).
 *     POSIX 가 multi-rename atomic 보장 미지원 → best-effort.
 *   - same-filesystem 가정 (cross-fs 시 rename 이 EXDEV).
 *   - scaffoldDir 가 framework skeleton 으로 prefilled 된 상태에서 동작
 *     (순수 Cookiecutter 의 "전체 dir swap" 패턴은 미적용).
 */

import {
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

export const STAGING_DIR_PREFIX = '.staging-';
export const STAGING_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * scaffoldDir 안의 stale staging dir (24h 이상) 정리.
 * fail-open: 어떤 단계 실패해도 throw 하지 않는다.
 *
 * @param {string} scaffoldDir
 * @returns {number} 정리된 staging dir 수
 */
export function cleanupStaleStagingDirs(scaffoldDir) {
  if (!scaffoldDir || !existsSync(scaffoldDir)) return 0;
  let cleanedCount = 0;
  try {
    const entries = readdirSync(scaffoldDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(STAGING_DIR_PREFIX)) continue;
      const fullPath = join(scaffoldDir, entry.name);
      try {
        const stats = statSync(fullPath);
        if (now - stats.mtimeMs >= STAGING_STALE_THRESHOLD_MS) {
          rmSync(fullPath, { recursive: true, force: true });
          cleanedCount++;
        }
      } catch {
        /* 단일 entry 실패 → 다음으로 (fail-open per-entry) */
      }
    }
  } catch {
    /* readdirSync 실패 → fail-open */
  }
  return cleanedCount;
}

/**
 * scaffoldDir 안에 unique staging tmp dir 생성.
 *
 * @param {string} scaffoldDir
 * @returns {string} 절대 경로 staging dir
 * @throws scaffoldDir 생성/접근 실패 시 fs 오류 전파
 */
export function setupAtomicStaging(scaffoldDir) {
  if (!scaffoldDir) {
    throw new Error('[staging] scaffoldDir is required');
  }
  if (!existsSync(scaffoldDir)) {
    mkdirSync(scaffoldDir, { recursive: true });
  }
  // mkdtempSync(prefix) → "<prefix>XXXXXX" 디렉토리를 생성하고 절대 경로 반환
  return mkdtempSync(join(scaffoldDir, STAGING_DIR_PREFIX));
}

/**
 * stagingPath 의 entry 들을 scaffoldPath 에 per-entry rename 으로 overlay.
 * 디렉토리는 dest 부재 시 dir 전체 rename, 존재 시 recurse merge.
 *
 * @param {string} stagingPath
 * @param {string} scaffoldPath
 */
function walkAndCommitOverlay(stagingPath, scaffoldPath) {
  const entries = readdirSync(stagingPath, { withFileTypes: true });
  for (const entry of entries) {
    const stagingChild = join(stagingPath, entry.name);
    const scaffoldChild = join(scaffoldPath, entry.name);
    if (entry.isDirectory()) {
      if (!existsSync(scaffoldChild)) {
        renameSync(stagingChild, scaffoldChild);
      } else {
        const scaffoldChildStats = statSync(scaffoldChild);
        if (!scaffoldChildStats.isDirectory()) {
          throw new Error(
            `[staging] conflict: ${scaffoldChild} is not a directory but staging has directory`,
          );
        }
        walkAndCommitOverlay(stagingChild, scaffoldChild);
        try {
          rmSync(stagingChild, { recursive: false });
        } catch {
          /* 비어있지 않거나 정리 실패 — best-effort */
        }
      }
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      renameSync(stagingChild, scaffoldChild);
    }
    /* 그 외 (FIFO/device 등) → skip */
  }
}

/**
 * stagingDir 의 모든 entry 를 scaffoldDir 에 atomic per-entry overlay 후
 * stagingDir cleanup.
 *
 * @param {string} stagingDir
 * @param {string} scaffoldDir
 * @throws stagingDir/scaffoldDir 부재 또는 entry conflict 시
 */
export function commitAtomicStaging(stagingDir, scaffoldDir) {
  if (!stagingDir || !existsSync(stagingDir)) {
    throw new Error(`[staging] staging dir does not exist: ${stagingDir}`);
  }
  if (!scaffoldDir || !existsSync(scaffoldDir)) {
    throw new Error(`[staging] scaffold dir does not exist: ${scaffoldDir}`);
  }
  walkAndCommitOverlay(stagingDir, scaffoldDir);
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * stagingDir 전체 제거. 실패 시 throw 하지 않고 warn.
 *
 * @param {string} stagingDir
 */
export function rollbackAtomicStaging(stagingDir) {
  if (!stagingDir || !existsSync(stagingDir)) return;
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    /* fail-open — main 단계 throw 가 우선 */
  }
}
