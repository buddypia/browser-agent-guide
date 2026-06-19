/**
 * research-library-aggregator.mjs — Research 산출물 read-only 집계
 *
 * wt-A 의 `runs/<run_id>/research/{deep-research,web-search}/` 디렉터리를
 * 디렉터리 walk 로 list 하고 meta JSON 을 함께 머지하여 Observatory UI 에
 * 전달한다.
 *
 * R-CM-035 정합: WebUI 측 read-only writer 없음 — fs.read 만.
 * R-CM-026 정합: 디렉터리 패턴 직접 walk (layout SSOT 의존 없음 — wt-A 머지 전후
 * 모두 동일 동작 보장).
 * R-CM-006 fail-open: 모든 fs 오류는 silent skip + 빈 배열 반환.
 *
 * Boundary (R-CM-028): 관점 1 (brief2dev 자체) 전용.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SUPPORTED_TYPES = Object.freeze({
  'deep-research': 'deep_research',
  'web-search': 'web_search',
});

/**
 * 특정 run_id 의 research 디렉터리 1개 (deep-research 또는 web-search) 를 list.
 *
 * @param {string} runRoot - `<worktree>/.brief2dev/runs/<run_id>/`
 * @param {string} subdir - 'deep-research' 또는 'web-search'
 * @returns {Array<{doc_id, type, has_markdown, has_meta, size_bytes, modified_at, meta}>}
 */
function listResearchSubdir(runRoot, subdir) {
  const dir = join(runRoot, 'research', subdir);
  if (!existsSync(dir)) return [];

  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  // doc_id 별 (md, meta) 페어 그룹화
  const groups = new Map();
  for (const entry of entries) {
    let docId;
    let kind;
    if (entry.endsWith('.meta.json')) {
      docId = entry.slice(0, -'.meta.json'.length);
      kind = 'meta';
    } else if (entry.endsWith('.md')) {
      docId = entry.slice(0, -'.md'.length);
      kind = 'md';
    } else {
      continue;
    }

    if (!groups.has(docId)) {
      groups.set(docId, { docId, mdPath: null, metaPath: null });
    }
    const group = groups.get(docId);
    if (kind === 'md') group.mdPath = join(dir, entry);
    if (kind === 'meta') group.metaPath = join(dir, entry);
  }

  // 각 그룹에 대해 stat + meta 파싱
  const docs = [];
  for (const group of groups.values()) {
    let size = 0;
    let modifiedAt = null;
    let meta = null;

    const statPath = group.mdPath || group.metaPath;
    if (statPath) {
      try {
        const st = statSync(statPath);
        size = st.size;
        modifiedAt = st.mtime.toISOString();
      } catch {
        // ignore
      }
    }
    if (group.metaPath) {
      try {
        meta = JSON.parse(readFileSync(group.metaPath, 'utf-8'));
      } catch {
        meta = null;
      }
    }

    docs.push({
      doc_id: group.docId,
      type: SUPPORTED_TYPES[subdir] || subdir,
      has_markdown: Boolean(group.mdPath),
      has_meta: Boolean(group.metaPath),
      size_bytes: size,
      modified_at: modifiedAt,
      meta,
    });
  }

  // session_id 의 timestamp prefix (dr-YYYYMMDD-HHMMSS / ws-YYYYMMDD-HHMMSS-slug) 가
  // 사전순 = 시간 역순일 수 있음. 최신 우선이 UX 자연스러움 → modified_at desc.
  docs.sort((a, b) => {
    if (!a.modified_at) return 1;
    if (!b.modified_at) return -1;
    const byMtime = b.modified_at.localeCompare(a.modified_at);
    if (byMtime !== 0) return byMtime;
    // 동일 mtime (같은 ms 에 기록된 페어) tiebreaker — doc_id 의 timestamp prefix desc
    return b.doc_id.localeCompare(a.doc_id);
  });

  return docs;
}

/**
 * 특정 run_id 의 research/* 디렉터리들을 모두 집계.
 *
 * @param {string} worktreePath - 세션의 worktree 루트 (multi-session-discovery 의 worktree_path)
 * @param {string} runId
 * @returns {{deep_research: Array, web_search: Array, total: number}}
 */
export function listResearchDocs(worktreePath, runId) {
  if (typeof worktreePath !== 'string' || typeof runId !== 'string' || runId.length === 0) {
    return { deep_research: [], web_search: [], total: 0 };
  }
  const runRoot = join(resolve(worktreePath), '.brief2dev', 'runs', runId);
  if (!existsSync(runRoot)) {
    return { deep_research: [], web_search: [], total: 0 };
  }

  const deepResearch = listResearchSubdir(runRoot, 'deep-research');
  const webSearch = listResearchSubdir(runRoot, 'web-search');

  return {
    deep_research: deepResearch,
    web_search: webSearch,
    total: deepResearch.length + webSearch.length,
  };
}

/**
 * 단일 research 문서의 markdown 본문 + meta 반환.
 *
 * @param {string} worktreePath
 * @param {string} runId
 * @param {string} docId - 'dr-YYYYMMDD-HHMMSS' 또는 'ws-YYYYMMDD-HHMMSS-slug'
 * @returns {{ok: boolean, markdown?: string, meta?: object, type?: string, reason?: string}}
 */
export function readResearchDoc(worktreePath, runId, docId) {
  if (
    typeof worktreePath !== 'string' ||
    typeof runId !== 'string' ||
    typeof docId !== 'string'
  ) {
    return { ok: false, reason: 'invalid args' };
  }
  // doc_id prefix 로 subdir 추론
  let subdir;
  if (docId.startsWith('dr-')) subdir = 'deep-research';
  else if (docId.startsWith('ws-')) subdir = 'web-search';
  else return { ok: false, reason: `unknown doc_id prefix: ${docId}` };

  // path traversal 방어: docId 가 '/'이나 '..'를 포함하면 거부
  if (docId.includes('/') || docId.includes('..') || docId.includes('\\')) {
    return { ok: false, reason: 'invalid doc_id (path traversal)' };
  }

  const dir = join(resolve(worktreePath), '.brief2dev', 'runs', runId, 'research', subdir);
  const mdPath = join(dir, `${docId}.md`);
  const metaPath = join(dir, `${docId}.meta.json`);

  if (!existsSync(mdPath) && !existsSync(metaPath)) {
    return { ok: false, reason: 'doc not found' };
  }

  let markdown = null;
  let meta = null;
  try {
    if (existsSync(mdPath)) markdown = readFileSync(mdPath, 'utf-8');
  } catch {
    markdown = null;
  }
  try {
    if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    meta = null;
  }

  return {
    ok: true,
    type: SUPPORTED_TYPES[subdir],
    markdown,
    meta,
  };
}

// 테스트용 internal export
export const _internal = {
  listResearchSubdir,
  SUPPORTED_TYPES,
};
