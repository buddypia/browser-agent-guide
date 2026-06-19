#!/usr/bin/env node
/**
 * Archive Indexer (R-CM-032)
 *
 * Builds archive-index.json from durable archive snapshots. This keeps archive
 * reuse portable even when system_persistent index files are ignored, missing,
 * or stale in another worktree.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  extractEvidenceSummary,
  extractKeyDecisions3,
  extractStageProgress,
  extractTagsFromBusinessContext,
  extractViabilityScore,
} from './archive-tag-extractor.mjs';

const ARCHIVE_INDEX_COMMENT =
  'R-CM-032 Archive Reuse Discipline SSOT. Generated from durable .brief2dev/archives/<archive_slug>/ snapshots. Rebuild with node .claude/scripts/archive-index-rebuild.mjs.';

const NON_ARCHIVE_DIRS = new Set([
  'system',
  'runs',
  'archives',
  'governance',
  'inbox',
  'transplants',
  '_archive',
]);

const REASONS = new Set(['completed', 'aborted', 'learning_run', 'pivot']);

const AUDIT_STATUS_BY_REASON = {
  completed: null,
  aborted: 'ABORTED_RUN',
  learning_run: 'LEARNING_RUN_ARTIFACT',
  pivot: 'PIVOTED_RUN',
};

const STAGE_FILE_MAP = [
  ['intake', 'business-context.json'],
  ['market_research', 'market-research.json'],
  ['mvp_scoping', 'mvp-scope.json'],
  ['platform_decision', 'platform-decision.json'],
  ['stack_selection', 'stack-config.json'],
  ['infra_design', 'infra-config.json'],
];

export function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeReason(raw) {
  return REASONS.has(raw) ? raw : 'completed';
}

function oneLine(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.split(/[.\n]/)[0].trim().slice(0, 80) || fallback;
}

export function inferBusinessDomain(businessContext, meta, fallback) {
  const business = businessContext?.business || {};
  return oneLine(
    business.name,
    oneLine(
      business.description,
      oneLine(
        businessContext?.business_description,
        oneLine(meta?.business_description, fallback),
      ),
    ),
  );
}

export function inferStageProgress(sourceRoot, meta) {
  const fromMeta = extractStageProgress(meta || {});
  if (fromMeta.length > 0) return fromMeta;

  const progress = [];
  for (const [stage, file] of STAGE_FILE_MAP) {
    if (existsSync(join(sourceRoot, 'stage-output', file))) {
      progress.push(stage);
    }
  }
  if (existsSync(join(sourceRoot, 'stage-output', 'scaffold-manifest.json'))) {
    progress.push('scaffolding');
  }
  if (existsSync(join(sourceRoot, 'reports', 'output-gate-report.md'))) {
    progress.push('output_gate');
  }
  return progress;
}

export function hasArchivePayload(archiveRoot) {
  return (
    existsSync(join(archiveRoot, '_archive-meta.json')) ||
    existsSync(join(archiveRoot, 'stage-output', 'business-context.json')) ||
    existsSync(join(archiveRoot, 'handoff', 'stage-1-handoff.json'))
  );
}

export function scanArchiveSnapshots(dataRoot, opts = {}) {
  const onlySlugs = new Set(opts.archiveSlugs || []);
  const roots = [];
  const seen = new Set();

  function collect(root) {
    if (!root || !existsSync(root)) return;
    const isArchivesContainer = basename(root) === 'archives';
    for (const dirent of readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const slug = dirent.name;
      if (!isArchivesContainer && NON_ARCHIVE_DIRS.has(slug)) continue;
      if (slug.startsWith('.')) continue;
      if (onlySlugs.size > 0 && !onlySlugs.has(slug)) continue;
      if (seen.has(slug)) continue;

      const archiveRoot = join(root, slug);
      if (hasArchivePayload(archiveRoot)) {
        roots.push(archiveRoot);
        seen.add(slug);
      }
    }
  }

  // New canonical location first. Legacy root snapshots are read-only fallback
  // so old archives remain discoverable while new archives are written under
  // .brief2dev/archives/<slug>/.
  collect(dataRoot);
  collect(opts.legacyDataRoot);

  return roots;
}

function archivePathForRoot(archiveRoot, archiveSlug) {
  return basename(dirname(archiveRoot)) === 'archives'
    ? `.brief2dev/archives/${archiveSlug}`
    : `.brief2dev/${archiveSlug}`;
}

function isNonEmptyMeta(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function loadArchiveSnapshot(archiveRoot, opts = {}) {
  const archiveSlug = opts.archiveSlug || basename(archiveRoot);
  // Prefer the in-memory meta the caller already computed (archive-and-reset
  // Phase 2.5 returns it for both dry-run and real run). Disk read is the
  // fallback for callers that scan on-disk snapshots (rebuild path).
  const meta = isNonEmptyMeta(opts.meta)
    ? opts.meta
    : readJsonSafe(join(archiveRoot, '_archive-meta.json')) || {};
  const reason = normalizeReason(opts.reason || meta.reason);
  return {
    archiveRoot,
    archiveSlug,
    meta,
    reason,
    baseSlug: opts.baseSlug || meta.base_slug || archiveSlug,
  };
}

export function buildArchiveIndexEntryFromArchive(archiveRoot, opts = {}) {
  const snapshot = loadArchiveSnapshot(archiveRoot, opts);
  const { archiveSlug, meta, reason, baseSlug } = snapshot;

  // Payload read root, separate from archive identity: callers pass readRoot
  // to read stage-output/handoff from a source other than the archive
  // snapshot (slug/path stay derived from archiveRoot). Defaults to archiveRoot.
  const readRoot = typeof opts.readRoot === 'string' && opts.readRoot.length > 0
    ? opts.readRoot
    : archiveRoot;

  const businessContext = readJsonSafe(join(readRoot, 'stage-output', 'business-context.json'));
  const marketResearch = readJsonSafe(join(readRoot, 'stage-output', 'market-research.json'));
  const handoff1 = readJsonSafe(join(readRoot, 'handoff', 'stage-1-handoff.json'));
  const handoff2 = readJsonSafe(join(readRoot, 'handoff', 'stage-2-handoff.json'));

  if (!businessContext && !handoff1) return null;

  return {
    archive_slug: archiveSlug,
    archived_at: new Date(meta.archived_at || Date.now()).toISOString(),
    reason,
    audit_status: meta.audit_status ?? AUDIT_STATUS_BY_REASON[reason] ?? null,
    business_domain: inferBusinessDomain(businessContext, meta, baseSlug),
    tags: extractTagsFromBusinessContext(businessContext || {}),
    stage_progress: inferStageProgress(readRoot, meta),
    viability_score: marketResearch ? extractViabilityScore(marketResearch) : null,
    evidence_summary: handoff1 ? extractEvidenceSummary(handoff1) : { T1: 0, T2: 0, T3: 0, grade: 'D' },
    key_decisions_3: extractKeyDecisions3(handoff1, handoff2),
    freshness: { market_data_age_days: 0 },
    archive_path: archivePathForRoot(archiveRoot, archiveSlug),
  };
}

function compareArchivedAtDesc(a, b) {
  const aTime = Date.parse(a.meta?.archived_at || '') || 0;
  const bTime = Date.parse(b.meta?.archived_at || '') || 0;
  if (bTime !== aTime) return bTime - aTime;
  return a.archiveSlug.localeCompare(b.archiveSlug);
}

export function rebuildArchiveIndexes(opts = {}) {
  const dataRoot = opts.dataRoot;
  const archiveRoots = opts.archiveRoots || scanArchiveSnapshots(dataRoot, opts);
  const snapshots = archiveRoots
    .map((archiveRoot) => loadArchiveSnapshot(archiveRoot))
    .sort(compareArchivedAtDesc);

  const archiveIndex = {
    $comment: ARCHIVE_INDEX_COMMENT,
    schema_version: '1.0',
    entries: [],
  };
  const skipped = [];

  for (const snapshot of snapshots) {
    const entry = buildArchiveIndexEntryFromArchive(snapshot.archiveRoot, snapshot);
    if (!entry) {
      skipped.push({ archive_slug: snapshot.archiveSlug, reason: 'missing Stage 1 business-context/handoff' });
      continue;
    }
    archiveIndex.entries.push(entry);
  }

  return {
    archiveIndex,
    summary: {
      archives_scanned: snapshots.length,
      entries: archiveIndex.entries.length,
      skipped,
    },
  };
}
