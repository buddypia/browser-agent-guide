/**
 * archive-library-aggregator.mjs — 봉인 기록(archive) read-only 집계
 *
 * `.brief2dev/archives/<slug>/` 스냅샷을 디렉터리 walk 로 list 하고
 * `_archive-meta.json` 을 머지하여 Observatory UI 에 전달한다. 사용자가
 * 봉인된 작업 기록을 추적/열람할 수 있게 한다 (사용자 결정 2026-05-17).
 *
 * ARCHIVES_ROOT 는 system_persistent (main worktree 기준) 이므로 모든
 * worktree 의 봉인 기록이 한 곳에 모여 보인다 (R-CM-026 / R-CM-030).
 *
 * R-CM-035 정합: WebUI 측 read-only — fs.read 만, write 없음.
 * R-CM-006 fail-open: 모든 fs 오류는 silent skip + 빈 결과 반환.
 * Boundary (R-CM-028): 관점 1 (brief2dev 자체) 전용.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { getArchivesRoot } from './layout-resolver.mjs';

// 봉인 기록 내부에서 사용자에게 노출하는 산출물 서브디렉터리.
// transcript: archive-and-reset 가 runs/<id>/ 전체를 봉인할 때 자동 포함되는
// .jsonl 채팅 이력. frontend 가 raw 를 받아 readArchiveFile.content 를
// line-by-line 파싱한다 (transcript-aggregator 와 동일 normalizer 사용).
const ARCHIVE_SUBDIRS = Object.freeze([
  'stage-output', 'handoff', 'reports', 'references', 'transcript',
]);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * archive 디렉터리 1개의 산출물 파일을 (재귀) 수집.
 * @param {string} archiveRoot
 * @param {object} [opts]
 * @param {boolean} [opts.withSize=true] - false 면 statSync 생략 (목록 endpoint
 *   는 file_count 만 쓰므로 N×파일 statSync syscall 을 피한다).
 */
function listArchiveFiles(archiveRoot, opts = {}) {
  const withSize = opts.withSize !== false;
  const out = [];
  for (const sub of ARCHIVE_SUBDIRS) {
    const subRoot = join(archiveRoot, sub);
    const stack = [subRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!ent.isFile()) continue;
        let size = 0;
        if (withSize) {
          try {
            size = statSync(full).size;
          } catch {
            /* size 측정 실패는 표시값 0 으로 degrade */
          }
        }
        // archiveRoot 기준 상대 경로 (POSIX 표기로 정규화 — UI/요청 일관성).
        const rel = relative(archiveRoot, full).split(sep).join('/');
        out.push({ path: rel, size_bytes: size });
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * 모든 봉인 기록 목록. 최신(archived_at desc) 우선.
 *
 * @returns {{archives: Array<object>, total: number}}
 */
export function listArchives() {
  if (!existsSync(getArchivesRoot())) return { archives: [], total: 0 };

  let entries = [];
  try {
    entries = readdirSync(getArchivesRoot(), { withFileTypes: true });
  } catch {
    return { archives: [], total: 0 };
  }

  const archives = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue; // 임시/숨김 디렉터리 제외
    const archiveRoot = join(getArchivesRoot(), ent.name);
    const meta = readJson(join(archiveRoot, '_archive-meta.json')) || {};
    const files = listArchiveFiles(archiveRoot);
    archives.push({
      slug: ent.name,
      reason: meta.reason || null,
      audit_status: meta.audit_status ?? null,
      archived_at: meta.archived_at || null,
      run_id: meta.run_id || null,
      business_description: meta.business_description || null,
      status_at_archive: meta.status_at_archive || null,
      current_stage_at_archive: meta.current_stage_at_archive || null,
      // 봉인 시점 8단계 진행 스냅샷 (loom archive cover 의 read-only 단계 스트립용).
      // active-run stages 와 동일 shape ({ <stageId>: { status, confidence, evidence_grade } }).
      stages_summary: meta.stages_summary || null,
      sealed_via: meta.sealed_via || null,
      file_count: files.length,
    });
  }

  archives.sort((a, b) => {
    const at = Date.parse(a.archived_at || '') || 0;
    const bt = Date.parse(b.archived_at || '') || 0;
    if (bt !== at) return bt - at;
    return a.slug.localeCompare(b.slug);
  });

  return { archives, total: archives.length };
}

/** slug 가 단일 디렉터리 세그먼트인지 검증 (path traversal 방어). */
function isSafeSlug(slug) {
  return (
    typeof slug === 'string' &&
    slug.length > 0 &&
    !slug.includes('/') &&
    !slug.includes('\\') &&
    !slug.includes('..') &&
    !slug.startsWith('.')
  );
}

/**
 * 봉인 기록 1개의 상세 — meta + 산출물 파일 목록.
 *
 * @param {string} slug
 * @returns {{ok: boolean, slug?, meta?, files?, reason?: string}}
 */
export function readArchiveDetail(slug) {
  if (!isSafeSlug(slug)) return { ok: false, reason: 'invalid slug' };
  const archiveRoot = join(getArchivesRoot(), slug);
  if (!existsSync(archiveRoot)) return { ok: false, reason: 'archive not found' };
  const meta = readJson(join(archiveRoot, '_archive-meta.json'));
  return {
    ok: true,
    slug,
    meta: meta || {},
    files: listArchiveFiles(archiveRoot),
  };
}

/**
 * 봉인 기록 안의 단일 파일 본문 반환 (json/md/txt).
 *
 * @param {string} slug
 * @param {string} relPath - archiveRoot 기준 상대 경로 (POSIX)
 * @returns {{ok: boolean, slug?, path?, kind?, content?, reason?: string}}
 */
export function readArchiveFile(slug, relPath) {
  if (!isSafeSlug(slug)) return { ok: false, reason: 'invalid slug' };
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { ok: false, reason: 'invalid path' };
  }
  if (relPath.includes('..') || relPath.includes('\\') || relPath.startsWith('/')) {
    return { ok: false, reason: 'invalid path (traversal)' };
  }
  const archiveRoot = resolve(join(getArchivesRoot(), slug));
  const target = resolve(join(archiveRoot, relPath));
  // 이중 방어: resolve 후에도 archiveRoot 밖이면 거부.
  if (target !== archiveRoot && !target.startsWith(archiveRoot + sep)) {
    return { ok: false, reason: 'invalid path (escape)' };
  }
  if (!existsSync(target)) return { ok: false, reason: 'file not found' };
  let content;
  try {
    content = readFileSync(target, 'utf-8');
  } catch {
    return { ok: false, reason: 'read failed' };
  }
  const lower = relPath.toLowerCase();
  const kind = lower.endsWith('.json') ? 'json' : lower.endsWith('.md') ? 'markdown' : 'text';
  return { ok: true, slug, path: relPath, kind, content };
}

// 테스트용 internal export
export const _internal = { listArchiveFiles, isSafeSlug, ARCHIVE_SUBDIRS };
