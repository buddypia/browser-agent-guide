// 視覚フィードバック entry の保存・検索境界。
// disk は従来どおり <inbox>/<slug>/... を即時保存し、hybrid はまずメモリに保持して
// image/file_path が必要になった時だけ <inbox> へ materialize する。
// memory は inbox を一切作らず、image/file_path 要求時だけ OS tmp へ一時 materialize し
// プロセス終了時に破棄する（inbox 完全撤去・既定）。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  return createMemoryBackedStore({ inboxDir, mode, memoryLimit });
}

// hybrid / memory 共通のメモリ優先 store。差は materialize 先だけ:
//   - hybrid: image/file_path 要求時に <inbox>/<id>/ へ保存する（従来どおり）。
//   - memory: ユーザーの inbox を一切作らず、要求時だけプロセス専用の OS tmp へ
//             一時 materialize する（cleanup で破棄）。→ inbox 完全撤去。
function createMemoryBackedStore({ inboxDir, mode, memoryLimit }) {
  const currentInbox = () => (typeof inboxDir === 'function' ? inboxDir() : inboxDir);
  const memory = [];
  // memory モードの一時 materialize 先（初回 materialize で遅延作成し、cleanup で丸ごと消す）。
  let tmpRoot = null;
  const memoryMaterializeRoot = () => {
    if (!tmpRoot) tmpRoot = mkdtempSync(join(tmpdir(), 'bag-vf-'));
    return tmpRoot;
  };

  return {
    kind: mode,
    getInboxDir: currentInbox,
    info() {
      return { storage: mode, inboxDir: currentInbox(), memoryEntries: memory.length };
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
      // hybrid は inbox、memory は OS tmp に書く（後者はユーザーの ai-inbox を作らない）。
      const root = mode === 'memory' ? memoryMaterializeRoot() : entry.inboxDir || currentInbox();
      const written = writeEntry(root, entry.payload, { id: entry.id });
      entry.dir = written.dir;
      entry.shot = join(written.dir, 'shot.png');
      entry.files = written.files;
      entry.materialized = true;
      return entry;
    },
    // memory モードの一時 materialize 先を破棄する（プロセス終了時に index.js が呼ぶ）。
    cleanup() {
      if (!tmpRoot) return;
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* tmp 後始末失敗は無視 */
      }
      tmpRoot = null;
    },
  };
}

export function normalizeStorageMode(value) {
  const mode = String(value || 'disk').toLowerCase();
  if (mode === 'memory') return 'memory';
  if (mode === 'hybrid') return 'hybrid';
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
    capturedAt,
    storage: 'memory',
    materialized: false,
    payload,
    shotBuffer,
    annotation: payload?.annotation || null,
    memo: payload?.memo || '',
    url: payload?.annotation?.url || payload?.url || '',
    title: payload?.annotation?.title || payload?.title || '',
    tab: payload?.annotation?.tab || payload?.tab || null,
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

function memoryMatches(memory, { urlContains, titleContains, tabId, windowId, limit = 20 } = {}) {
  const out = [];
  for (const entry of memory) {
    if (!matchesFilter(entry.annotation || entry, { urlContains, titleContains, tabId, windowId })) continue;
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
