// 視覚フィードバック entry の保存・検索境界。
// disk は従来どおり <inbox>/<slug>/... を即時保存し、hybrid はまずメモリに保持して
// image/file_path が必要になった時だけ disk へ materialize する。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findEntry as findDiskEntry, matchesFilter, queryEntries as queryDiskEntries } from './inbox.js';
import { slugFromCapture } from './slug.js';
import { decodeBase64, writeEntry } from './writer.js';

const DEFAULT_MEMORY_LIMIT = 50;

export function createDiskEntryStore(inboxDir) {
  const currentInbox = () => (typeof inboxDir === 'function' ? inboxDir() : inboxDir);
  return {
    kind: 'disk',
    getInboxDir: currentInbox,
    info() {
      return { storage: 'disk', inboxDir: currentInbox(), memoryEntries: 0 };
    },
    save(payload, opts) {
      return { storage: 'disk', materialized: true, ...writeEntry(currentInbox(), payload, opts) };
    },
    queryEntries(opts) {
      return queryDiskEntries(currentInbox(), opts);
    },
    findEntry(id, scan) {
      return findDiskEntry(currentInbox(), id, scan);
    },
    materialize(entry) {
      return entry;
    },
  };
}

export function createVisualFeedbackStore({ inboxDir, storageMode = 'disk', memoryLimit = DEFAULT_MEMORY_LIMIT } = {}) {
  const mode = normalizeStorageMode(storageMode);
  if (mode === 'disk') return createDiskEntryStore(inboxDir);

  const currentInbox = () => (typeof inboxDir === 'function' ? inboxDir() : inboxDir);
  const memory = [];

  return {
    kind: 'hybrid',
    getInboxDir: currentInbox,
    info() {
      return { storage: 'hybrid', inboxDir: currentInbox(), memoryEntries: memory.length };
    },
    save(payload, opts) {
      const entry = createMemoryEntry({
        inboxDir: currentInbox(),
        payload,
        now: opts?.now,
        taken: (id) => memory.some((e) => e.id === id) || Boolean(findDiskEntry(currentInbox(), id)),
      });
      memory.unshift(entry);
      trimMemory(memory, memoryLimit);
      return {
        type: 'ack',
        id: entry.id,
        dir: entry.dir,
        files: [],
        storage: 'memory',
        materialized: false,
      };
    },
    queryEntries(opts = {}) {
      return mergeEntries(memoryMatches(memory, opts), queryDiskEntries(currentInbox(), opts), opts.limit || 20);
    },
    findEntry(id, scan) {
      return memory.find((e) => e.id === id) || findDiskEntry(currentInbox(), id, scan);
    },
    materialize(entry) {
      if (!entry || entry.storage !== 'memory' || entry.materialized) return entry;
      const written = writeEntry(entry.inboxDir || currentInbox(), entry.payload, { id: entry.id });
      entry.dir = written.dir;
      entry.shot = join(written.dir, 'shot.png');
      entry.files = written.files;
      entry.materialized = true;
      return entry;
    },
  };
}

export function normalizeStorageMode(value) {
  const mode = String(value || 'disk').toLowerCase();
  if (mode === 'hybrid' || mode === 'memory') return 'hybrid';
  return 'disk';
}

function createMemoryEntry({ inboxDir, payload, now, taken }) {
  const shotBuffer = decodeBase64(payload?.image?.shot);
  if (!shotBuffer || !shotBuffer.length) throw new Error('image.shot (base64 PNG) が必要です。');

  const capturedAt = payload?.capturedAt || payload?.annotation?.capturedAt || now || new Date().toISOString();
  const url = payload?.url || payload?.annotation?.url || '';
  const title = payload?.title || payload?.annotation?.title || '';
  const base = slugFromCapture({ capturedAt, url, title });
  const id = uniqueMemoryId(base, taken);
  const dir = join(inboxDir, id);

  return {
    id,
    inboxDir,
    dir,
    shot: join(dir, 'shot.png'),
    mtime: Date.now(),
    storage: 'memory',
    materialized: false,
    payload,
    shotBuffer,
    annotation: payload?.annotation || null,
    memo: payload?.memo || '',
    url: payload?.annotation?.url || payload?.url || '',
    title: payload?.annotation?.title || payload?.title || '',
    files: [],
  };
}

function uniqueMemoryId(base, taken) {
  let id = base;
  let n = 2;
  while (taken(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function trimMemory(memory, memoryLimit) {
  const limit = Math.max(1, Number(memoryLimit) || DEFAULT_MEMORY_LIMIT);
  if (memory.length > limit) memory.splice(limit);
}

function memoryMatches(memory, { urlContains, titleContains, limit = 20 } = {}) {
  const out = [];
  for (const entry of memory) {
    if (!matchesFilter(entry.annotation || entry, { urlContains, titleContains })) continue;
    out.push(entry);
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

function mergeEntries(memoryEntries, diskEntries, limit) {
  const seen = new Set();
  const merged = [];
  for (const entry of [...memoryEntries, ...diskEntries]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  merged.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? 1 : -1));
  return merged.slice(0, Math.max(1, limit));
}

export function wasMaterialized(entry) {
  return Boolean(entry?.materialized || (entry?.shot && existsSync(entry.shot)));
}
