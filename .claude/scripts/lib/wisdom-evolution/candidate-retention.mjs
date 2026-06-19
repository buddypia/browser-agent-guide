/**
 * candidate-retention.mjs — bounded wisdom candidate inbox
 *
 * Wisdom candidates are review artifacts, not execution context. Keep the active
 * inbox small so SessionStart can understand the task from approved wisdom and
 * current state, while old raw candidates remain available in .brief2dev/_archive.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveArchiveDir, resolveGovernanceDir } from '../layout-resolver.mjs';

export const DEFAULT_ACTIVE_CANDIDATE_LIMIT = 10;
const CANDIDATES_SUBDIR = 'wisdom-candidates';
const ARCHIVE_SUBDIR = 'wisdom-candidates';

function parseLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_ACTIVE_CANDIDATE_LIMIT;
  return parsed;
}

function parseBriefTimestamp(file) {
  const match = file.match(
    /^wisdom-candidate-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, ms] = match;
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`);
  return Number.isFinite(time) ? time : null;
}

function parseDate(value) {
  if (!value || typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function candidateTime(file, data, fallbackMs) {
  return (
    parseDate(data?.generated_at) ??
    parseDate(data?.promoted_at) ??
    parseDate(data?.last_observed) ??
    parseDate(data?.first_observed) ??
    parseBriefTimestamp(file) ??
    fallbackMs ??
    0
  );
}

function archiveMonth(createdMs) {
  const d = new Date(createdMs || Date.now());
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shouldProtect(data, parseError, nowMs) {
  if (parseError) return 'invalid-json-review-required';
  if (data?.retention === 'pinned' || data?.pinned === true) return 'pinned';
  const retainUntil = parseDate(data?.retain_until);
  if (retainUntil && retainUntil > nowMs) return 'retain-until';
  if (data?.status === 'approved' && data?._loaded !== true) return 'approved-pending-load';
  return null;
}

function readCandidate(path, file, nowMs) {
  let fallbackMs = 0;
  try {
    fallbackMs = statSync(path).mtimeMs;
  } catch {
    // Missing files are handled by the caller's best effort flow.
  }

  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const createdMs = candidateTime(file, data, fallbackMs);
    return {
      file,
      path,
      data,
      createdMs,
      protectedReason: shouldProtect(data, null, nowMs),
      parseError: null,
    };
  } catch (error) {
    return {
      file,
      path,
      data: null,
      createdMs: parseBriefTimestamp(file) ?? fallbackMs,
      protectedReason: shouldProtect(null, error, nowMs),
      parseError: error,
    };
  }
}

function uniqueArchivePath(targetPath, sourcePath) {
  if (!existsSync(targetPath)) return targetPath;
  const digest = createHash('sha256').update(sourcePath).digest('hex').slice(0, 8);
  const dir = dirname(targetPath);
  const file = basename(targetPath, '.json');
  let candidate = join(dir, `${file}.${digest}.json`);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${file}.${digest}.${index}.json`);
    index += 1;
  }
  return candidate;
}

function appendRetentionLog(projectDir, entries, nowIso) {
  if (entries.length === 0) return;
  const logPath = join(resolveArchiveDir(ARCHIVE_SUBDIR, projectDir), 'retention-log.jsonl');
  mkdirSync(dirname(logPath), { recursive: true });
  const lines = entries.map((entry) => JSON.stringify({ ...entry, archived_at: nowIso })).join('\n');
  writeFileSync(logPath, `${lines}\n`, { flag: 'a' });
}

/**
 * Enforce a bounded active wisdom-candidate inbox.
 *
 * Non-destructive policy:
 *   - keep approved-but-not-loaded candidates in the active inbox
 *   - keep invalid JSON in the active inbox for human repair
 *   - keep pinned or retain_until candidates
 *   - keep the newest N remaining candidates
 *   - move older candidates to .brief2dev/_archive/wisdom-candidates/YYYY-MM/
 *
 * @param {string} projectDir
 * @param {{ maxActive?: number, dryRun?: boolean, now?: Date }} [options]
 * @returns {{ scanned: number, kept: number, archived: number, protected: number, archiveRoot: string, actions: object[] }}
 */
export function enforceWisdomCandidateRetention(projectDir, options = {}) {
  const maxActive = parseLimit(
    options.maxActive ?? process.env.BRIEF2DEV_WISDOM_CANDIDATE_ACTIVE_LIMIT,
  );
  const candidatesDir = resolveGovernanceDir(CANDIDATES_SUBDIR, projectDir);
  const archiveRoot = resolveArchiveDir(ARCHIVE_SUBDIR, projectDir);
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  if (!existsSync(candidatesDir)) {
    return { scanned: 0, kept: 0, archived: 0, protected: 0, archiveRoot, actions: [] };
  }

  const entries = readdirSync(candidatesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => readCandidate(join(candidatesDir, entry.name), entry.name, nowMs));

  const protectedEntries = entries.filter((entry) => entry.protectedReason);
  const eligible = entries
    .filter((entry) => !entry.protectedReason)
    .sort((a, b) => b.createdMs - a.createdMs || b.file.localeCompare(a.file));

  const keepSet = new Set(eligible.slice(0, maxActive).map((entry) => entry.path));
  const toArchive = eligible.filter((entry) => !keepSet.has(entry.path));
  const actions = [];

  for (const entry of toArchive) {
    const month = archiveMonth(entry.createdMs);
    const targetDir = join(archiveRoot, month);
    const targetPath = uniqueArchivePath(join(targetDir, entry.file), entry.path);
    const action = {
      file: entry.file,
      from: entry.path,
      to: targetPath,
      reason: `active-limit-${maxActive}`,
    };
    actions.push(action);

    if (!options.dryRun) {
      mkdirSync(targetDir, { recursive: true });
      renameSync(entry.path, targetPath);
    }
  }

  if (!options.dryRun) {
    appendRetentionLog(projectDir, actions, nowIso);
  }

  return {
    scanned: entries.length,
    kept: entries.length - actions.length,
    archived: actions.length,
    protected: protectedEntries.length,
    archiveRoot,
    actions,
  };
}
