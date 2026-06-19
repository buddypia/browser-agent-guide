/**
 * memory-mutator.mjs — Loom 'AI Memory' 대시보드의 단일 mutation 진입점.
 *
 * R-CM-035 개정:
 *   - 2026-05-30 (예외 1): AI 메모리 항목 삭제(soft) WebUI mutation 허용.
 *   - 2026-06-02 (예외 3): 영구삭제(hard) / 아카이브(복구 가능) 분리 + restore + archived 목록.
 * brief2dev-webui.mjs 가 본 모듈을 직접 import 한다 (child_process 아님 → 단방향 흐름 + SSOT 단일성).
 *
 * 4동작 모델 (사용자 결정 2026-06-02):
 *   - archive         : 원본을 _archive/memory-deleted/<type>/ 봉투(또는 파일 이동)로 보존 후 제거 → 복구 가능
 *   - restore         : 봉투/이동 파일에서 원본 위치로 복원
 *   - hard-delete     : 활성 항목 영구삭제 (봉투 없음 — 복구 불가)
 *   - hard-delete-archived : 이미 아카이브된 항목 영구삭제 (봉투/이동 파일 제거)
 *
 * 타입 부류:
 *   - 봉투 부류 (learnings / pipeline-memory / followup-debt): entry 를 JSON 봉투로 보존.
 *       learnings/pipeline-memory 는 applyPlan(archive)(jsonl/facts 제거 + curation archived + audit) + 봉투.
 *       restore 는 jsonl/facts 재추가 + curation archived entry 정리(R-CM-027 옵션 B — archived→active 전이
 *       미발생, L2/L3 무위반) + 봉투 제거. followup-debt 는 removeDebtItem(splice) + 봉투 / restoreDebtItem.
 *   - 파일 부류 (session-history / wisdom-candidates): 파일 자체가 봉투. archive=이동, restore=역이동, hard=unlink.
 *
 * 멀티세션 race 안전장치:
 *   1. active.json running guard — main + 모든 worktree.
 *   2. atomic write — writeJsonAtomicSync / appendJsonlAtomicSync.
 *   3. path traversal 방어 — assertSafeId.
 *
 * 본 모듈은 R-CM-035 predicate 의 WEBUI_FILE_PATTERNS 밖이다 (webui 서버는 호출만, write 는 여기 + curator 집중).
 */
import {
  existsSync,
  readFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { applyPlan } from '../memory-curator.mjs';
import { removeDebtItem, restoreDebtItem } from '../followup-debt-tracker.mjs';
import {
  resolveSessionHistoryDir,
  resolveGovernanceDir,
  resolveArchiveDir,
  resolveSystemFile,
  listAllActiveRunPaths,
} from './layout-resolver.mjs';
import { writeJsonAtomicSync, appendJsonlAtomicSync } from './atomic-fs.mjs';

const DELETABLE = new Set([
  'learnings',
  'pipeline-memory',
  'session-history',
  'wisdom-candidates',
  'followup-debt',
]);
// idea-memory 는 run_scoped readonly (#623 — active run 중 조회 노출, 삭제는 archive-and-reset)
const READONLY = new Set(['task-passport', 'active-run', 'idea-memory']);
// 파일 부류 — 파일 자체가 봉투 (디렉토리 간 이동/역이동/unlink)
const FILE_TYPES = new Set(['session-history', 'wisdom-candidates']);

export class MemoryMutationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MemoryMutationError';
    this.code = code;
  }
}

// ── 공통 가드 ──────────────────────────────────────────────────────────
function readActiveStatus(activePath) {
  try {
    if (!existsSync(activePath)) return null;
    const parsed = JSON.parse(readFileSync(activePath, 'utf-8'));
    return parsed && typeof parsed.status === 'string' ? parsed.status : null;
  } catch {
    return null;
  }
}

/**
 * main + 모든 worktree 의 active-run 중 running 이 하나라도 있으면 throw (HTTP 409 대응).
 * 경로 수집은 layout-resolver.listAllActiveRunPaths 에 위임 — R-CM-026 단일 진입점.
 */
function assertNoRunningPipeline(projectDir) {
  for (const activePath of listAllActiveRunPaths(projectDir)) {
    if (readActiveStatus(activePath) === 'running') {
      throw new MemoryMutationError(
        '파이프라인 실행 중입니다 — 완료 후 다시 시도하세요',
        'pipeline_running',
      );
    }
  }
}

function assertSafeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.includes('/') || id.includes('..')) {
    throw new MemoryMutationError('잘못된 항목 식별자', 'invalid_id');
  }
}

function validateRequest(type, id) {
  if (!type || !id) {
    throw new MemoryMutationError('type 과 id 가 필요합니다', 'bad_request');
  }
  if (READONLY.has(type)) {
    throw new MemoryMutationError(
      `${type} 은 읽기 전용입니다 — 정리는 archive-and-reset 을 사용하세요`,
      'readonly',
    );
  }
  if (!DELETABLE.has(type)) {
    throw new MemoryMutationError(`알 수 없는 메모리 종류: ${type}`, 'bad_request');
  }
  assertSafeId(id);
}

// ── 봉투 헬퍼 (봉투 부류 전용) ─────────────────────────────────────────
function envelopeDir(type, projectDir) {
  return resolveArchiveDir(join('memory-deleted', type), projectDir);
}
function envelopePath(type, id, projectDir) {
  return join(envelopeDir(type, projectDir), `${id}.json`);
}
function saveEnvelope(type, id, payload, projectDir) {
  const dir = envelopeDir(type, projectDir);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomicSync(join(dir, `${id}.json`), {
    _loom_archive_version: '1.0',
    _archived_at: new Date().toISOString(),
    _type: type,
    _id: id,
    _reason: 'loom-ui-archive',
    payload,
  });
}
function loadEnvelope(type, id, projectDir) {
  const p = envelopePath(type, id, projectDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}
function removeEnvelope(type, id, projectDir) {
  const p = envelopePath(type, id, projectDir);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

// ── system 파일 읽기 / curation 정리 (learnings / pipeline-memory) ─────
function readLearningEntries() {
  const p = resolveSystemFile('learnings.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function findLearning(id) {
  return readLearningEntries().find((e) => e.key === id) || null;
}
function findFact(id) {
  const p = resolveSystemFile('pipeline-memory.json');
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8'));
    return (m.facts || []).find((f) => f.id === id) || null;
  } catch {
    return null;
  }
}
/**
 * R-CM-027 옵션 B: restore 시 curation 의 archived entry 를 제거하여 archived→active 전이를
 * 회피한다 (jsonl/facts 에 재추가된 entry 는 새 lifecycle 로 자연 시작 → L2/L3 무위반).
 */
function clearCurationEntry(kind, key) {
  const p = resolveSystemFile('memory-curation.json');
  if (!existsSync(p)) return;
  let curation;
  try {
    curation = JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return;
  }
  const map = kind === 'learning' ? curation.learning_lifecycle : curation.fact_lifecycle;
  if (map && Object.prototype.hasOwnProperty.call(map, key)) {
    delete map[key];
    writeJsonAtomicSync(p, curation);
  }
}

// ── 타입별 archive (keepEnvelope=true: archive, false: hard-delete 활성) ─
function archiveLearning(id, projectDir, keepEnvelope) {
  const entry = findLearning(id);
  if (!entry) throw new MemoryMutationError(`learning 항목을 찾을 수 없습니다: ${id}`, 'not_found');
  if (keepEnvelope && existsSync(envelopePath('learnings', id, projectDir))) {
    throw new MemoryMutationError(`이미 아카이브되었습니다: ${id}`, 'already_archived');
  }
  const r = applyPlan({
    learning_actions: [
      { key: id, action: 'archive', reason: keepEnvelope ? 'loom-ui-archive' : 'loom-ui-hard-delete' },
    ],
  });
  if (!Array.isArray(r.archived_learnings) || r.archived_learnings.length === 0) {
    throw new MemoryMutationError(`learning 항목을 찾을 수 없습니다: ${id}`, 'not_found');
  }
  // archive: 봉투 보존(복구 가능). hard-delete: 봉투 없이 + curation archived entry 정리(orphan 방지 — 복구 불가).
  if (keepEnvelope) saveEnvelope('learnings', id, entry, projectDir);
  else clearCurationEntry('learning', id);
}
function restoreLearning(id, projectDir) {
  const env = loadEnvelope('learnings', id, projectDir);
  if (!env) throw new MemoryMutationError(`아카이브된 항목이 없습니다: ${id}`, 'not_archived');
  if (findLearning(id)) throw new MemoryMutationError(`이미 활성 상태입니다: ${id}`, 'already_active');
  appendJsonlAtomicSync(resolveSystemFile('learnings.jsonl'), env.payload);
  clearCurationEntry('learning', id);
  removeEnvelope('learnings', id, projectDir);
}

function archiveFact(id, projectDir, keepEnvelope) {
  const fact = findFact(id);
  if (!fact) throw new MemoryMutationError(`fact 항목을 찾을 수 없습니다: ${id}`, 'not_found');
  if (keepEnvelope && existsSync(envelopePath('pipeline-memory', id, projectDir))) {
    throw new MemoryMutationError(`이미 아카이브되었습니다: ${id}`, 'already_archived');
  }
  const r = applyPlan({
    fact_actions: [
      { id, action: 'archive', reason: keepEnvelope ? 'loom-ui-archive' : 'loom-ui-hard-delete' },
    ],
  });
  if (!Array.isArray(r.archived_facts) || r.archived_facts.length === 0) {
    throw new MemoryMutationError(`fact 항목을 찾을 수 없습니다: ${id}`, 'not_found');
  }
  // archive: 봉투 보존(복구 가능). hard-delete: 봉투 없이 + curation archived entry 정리(orphan 방지 — 복구 불가).
  if (keepEnvelope) saveEnvelope('pipeline-memory', id, fact, projectDir);
  else clearCurationEntry('fact', id);
}
function restoreFact(id, projectDir) {
  const env = loadEnvelope('pipeline-memory', id, projectDir);
  if (!env) throw new MemoryMutationError(`아카이브된 항목이 없습니다: ${id}`, 'not_archived');
  if (findFact(id)) throw new MemoryMutationError(`이미 활성 상태입니다: ${id}`, 'already_active');
  const p = resolveSystemFile('pipeline-memory.json');
  const m = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : { facts: [] };
  m.facts = Array.isArray(m.facts) ? m.facts : [];
  m.facts.push(env.payload);
  writeJsonAtomicSync(p, m);
  clearCurationEntry('fact', id);
  removeEnvelope('pipeline-memory', id, projectDir);
}

function archiveDebt(id, projectDir, keepEnvelope) {
  if (keepEnvelope && existsSync(envelopePath('followup-debt', id, projectDir))) {
    throw new MemoryMutationError(`이미 아카이브되었습니다: ${id}`, 'already_archived');
  }
  const removed = removeDebtItem(id);
  if (!removed) throw new MemoryMutationError(`부채 항목을 찾을 수 없습니다: ${id}`, 'not_found');
  if (keepEnvelope) saveEnvelope('followup-debt', id, removed, projectDir);
}
function restoreDebt(id, projectDir) {
  const env = loadEnvelope('followup-debt', id, projectDir);
  if (!env) throw new MemoryMutationError(`아카이브된 항목이 없습니다: ${id}`, 'not_archived');
  restoreDebtItem(env.payload);
  removeEnvelope('followup-debt', id, projectDir);
}

// ── 파일 부류 (session-history / wisdom-candidates) ────────────────────
function fileSourceDir(type, projectDir) {
  if (type === 'session-history') return resolveSessionHistoryDir(projectDir);
  return resolveGovernanceDir('wisdom-candidates', projectDir);
}
function archiveFile(type, id, projectDir) {
  const src = join(fileSourceDir(type, projectDir), id);
  if (!existsSync(src)) throw new MemoryMutationError(`항목을 찾을 수 없습니다: ${id}`, 'not_found');
  const destDir = envelopeDir(type, projectDir);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, id);
  if (existsSync(dest)) throw new MemoryMutationError(`이미 아카이브되었습니다: ${id}`, 'already_archived');
  renameSync(src, dest);
}
function restoreFile(type, id, projectDir) {
  const src = join(envelopeDir(type, projectDir), id);
  if (!existsSync(src)) throw new MemoryMutationError(`아카이브된 항목이 없습니다: ${id}`, 'not_archived');
  const destDir = fileSourceDir(type, projectDir);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, id);
  if (existsSync(dest)) throw new MemoryMutationError(`이미 활성 상태입니다: ${id}`, 'already_active');
  renameSync(src, dest);
}
function hardDeleteFile(type, id, projectDir) {
  const src = join(fileSourceDir(type, projectDir), id);
  if (!existsSync(src)) throw new MemoryMutationError(`항목을 찾을 수 없습니다: ${id}`, 'not_found');
  unlinkSync(src);
}

// ── dispatch ───────────────────────────────────────────────────────────
function dispatchArchive(type, id, projectDir, keepEnvelope) {
  if (type === 'learnings') return archiveLearning(id, projectDir, keepEnvelope);
  if (type === 'pipeline-memory') return archiveFact(id, projectDir, keepEnvelope);
  if (type === 'followup-debt') return archiveDebt(id, projectDir, keepEnvelope);
  // 파일 부류
  return keepEnvelope ? archiveFile(type, id, projectDir) : hardDeleteFile(type, id, projectDir);
}

// ── public API ─────────────────────────────────────────────────────────
/**
 * 메모리 항목 1개를 아카이브한다 (복구 가능 — _archive 봉투/이동 보존).
 * @returns {{ ok: true, type, id, mode: 'archive' }}
 * @throws {MemoryMutationError} bad_request | readonly | invalid_id | pipeline_running | not_found | already_archived
 */
export function archiveMemoryItem({ type, id, projectDir } = {}) {
  validateRequest(type, id);
  assertNoRunningPipeline(projectDir);
  dispatchArchive(type, id, projectDir, true);
  return { ok: true, type, id, mode: 'archive' };
}

/**
 * 활성 메모리 항목 1개를 영구삭제한다 (봉투 없음 — 복구 불가).
 * @returns {{ ok: true, type, id, mode: 'hard-delete' }}
 * @throws {MemoryMutationError} bad_request | readonly | invalid_id | pipeline_running | not_found
 */
export function hardDeleteMemoryItem({ type, id, projectDir } = {}) {
  validateRequest(type, id);
  assertNoRunningPipeline(projectDir);
  dispatchArchive(type, id, projectDir, false);
  return { ok: true, type, id, mode: 'hard-delete' };
}

/**
 * 아카이브된 항목 1개를 원본 위치로 복구한다.
 * @returns {{ ok: true, type, id, mode: 'restore' }}
 * @throws {MemoryMutationError} bad_request | readonly | invalid_id | pipeline_running | not_archived | already_active
 */
export function restoreMemoryItem({ type, id, projectDir } = {}) {
  validateRequest(type, id);
  assertNoRunningPipeline(projectDir);
  if (type === 'learnings') restoreLearning(id, projectDir);
  else if (type === 'pipeline-memory') restoreFact(id, projectDir);
  else if (type === 'followup-debt') restoreDebt(id, projectDir);
  else restoreFile(type, id, projectDir);
  return { ok: true, type, id, mode: 'restore' };
}

/**
 * 이미 아카이브된 항목 1개를 영구삭제한다 (봉투/이동 파일 제거 — 복구 불가).
 * @returns {{ ok: true, type, id, mode: 'hard-delete-archived' }}
 * @throws {MemoryMutationError} bad_request | readonly | invalid_id | pipeline_running | not_archived
 */
export function hardDeleteArchivedItem({ type, id, projectDir } = {}) {
  validateRequest(type, id);
  assertNoRunningPipeline(projectDir);
  if (FILE_TYPES.has(type)) {
    const archived = join(envelopeDir(type, projectDir), id);
    if (!existsSync(archived)) {
      throw new MemoryMutationError(`아카이브된 항목이 없습니다: ${id}`, 'not_archived');
    }
    unlinkSync(archived);
  } else if (!removeEnvelope(type, id, projectDir)) {
    throw new MemoryMutationError(`아카이브된 항목이 없습니다: ${id}`, 'not_archived');
  }
  return { ok: true, type, id, mode: 'hard-delete-archived' };
}

/**
 * wisdom-candidate 1개를 승인(candidate→approved)한다. 다음 SessionStart 의
 * generateSessionHints 가 approved 후보를 [LEARNED PATTERNS] 로 1회 주입한다 (_loaded 마킹).
 *
 * 모듈 철학(instinct-promoter: "자동 wisdom 승격은 절대 수행하지 않는다")에 따라
 * 수동 승인 전용 — Loom 위임 진입점. archive/restore 와 달리 파일을 이동하지 않고
 * status 필드만 전이하므로 별도 함수로 분리 (FILE_TYPES dispatch 와 무관).
 *
 * @returns {{ ok: true, type: 'wisdom-candidates', id, mode: 'approve' }}
 * @throws {MemoryMutationError} bad_request | invalid_id | pipeline_running | not_found | already_approved | not_a_candidate
 */
export function approveWisdomCandidate({ type, id, projectDir } = {}) {
  if (type !== 'wisdom-candidates') {
    throw new MemoryMutationError('승인은 wisdom-candidates 에만 허용됩니다', 'bad_request');
  }
  if (!id) throw new MemoryMutationError('id 가 필요합니다', 'bad_request');
  assertSafeId(id);
  assertNoRunningPipeline(projectDir);

  const src = join(resolveGovernanceDir('wisdom-candidates', projectDir), id);
  if (!existsSync(src)) throw new MemoryMutationError(`항목을 찾을 수 없습니다: ${id}`, 'not_found');
  let data;
  try {
    data = JSON.parse(readFileSync(src, 'utf-8'));
  } catch {
    throw new MemoryMutationError(`후보 파일을 파싱할 수 없습니다: ${id}`, 'not_found');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new MemoryMutationError(`후보 파일 구조가 올바르지 않습니다: ${id}`, 'not_found');
  }
  if (data.status === 'approved') {
    throw new MemoryMutationError(`이미 승인되었습니다: ${id}`, 'already_approved');
  }
  if (data.status && data.status !== 'candidate') {
    throw new MemoryMutationError(
      `승인 가능한 상태가 아닙니다 (status=${data.status})`,
      'not_a_candidate',
    );
  }
  data.status = 'approved';
  data.approved_at = new Date().toISOString();
  data.approved_via = 'loom-ui';
  delete data._loaded; // 재주입 보장 — 승인 직후 1회 주입되도록 로드 마킹 제거
  delete data._loaded_at;
  writeJsonAtomicSync(src, data);
  return { ok: true, type: 'wisdom-candidates', id, mode: 'approve' };
}

function summarizeEnvelope(type, payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (type === 'learnings') return String(payload.insight || payload.key || '');
  if (type === 'pipeline-memory') return String(payload.content || payload.id || '');
  if (type === 'followup-debt') return String(payload.title || payload.description || payload.id || '');
  return '';
}

/**
 * 특정 type 의 아카이브된 항목 목록을 반환한다 (read-only — Loom 패널 아카이브 섹션용).
 * @returns {{ ok: true, type, items: Array<{ id, archived_at, title }> }}
 */
export function listArchivedItems({ type, projectDir } = {}) {
  if (!type) throw new MemoryMutationError('type 이 필요합니다', 'bad_request');
  if (READONLY.has(type)) throw new MemoryMutationError(`${type} 은 읽기 전용입니다`, 'readonly');
  if (!DELETABLE.has(type)) throw new MemoryMutationError(`알 수 없는 메모리 종류: ${type}`, 'bad_request');
  const dir = envelopeDir(type, projectDir);
  if (!existsSync(dir)) return { ok: true, type, items: [] };
  const items = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (FILE_TYPES.has(type)) {
      let archivedAt = null;
      try {
        archivedAt = statSync(full).mtime.toISOString();
      } catch {
        /* ignore stat 실패 */
      }
      items.push({ id: name, archived_at: archivedAt, title: name });
    } else {
      if (!name.endsWith('.json')) continue;
      let env;
      try {
        env = JSON.parse(readFileSync(full, 'utf-8'));
      } catch {
        continue;
      }
      items.push({
        id: env._id || name.replace(/\.json$/, ''),
        archived_at: env._archived_at || null,
        title: summarizeEnvelope(type, env.payload),
      });
    }
  }
  // 최신 archived 가 위로
  items.sort((a, b) => String(b.archived_at || '').localeCompare(String(a.archived_at || '')));
  return { ok: true, type, items };
}

/**
 * 하위호환 — 기존 soft-delete 진입점. archive(복구 가능)와 동일 동작.
 * 기존 호출자/테스트의 mode:'soft-delete' 반환 계약 유지.
 * @returns {{ ok: true, type, id, mode: 'soft-delete' }}
 */
export function deleteMemoryItem({ type, id, projectDir } = {}) {
  const r = archiveMemoryItem({ type, id, projectDir });
  return { ...r, mode: 'soft-delete' };
}
