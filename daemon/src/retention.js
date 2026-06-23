// retention.js — 共有 inbox の堆積を掃除する「庭師」。副作用は archive(rename)/purge(rm) のみ。
//
// 課題: ~/Downloads/ai-inbox は複数プロジェクトが共有するため、同一ページの古い世代が積み上がり
// （例: slide-studio を9回キャプチャ）、14日前の化石も残り続け、最新取得や一覧の見通しを汚す。
//
// 方針: 既に listEntries が読み飛ばす <inbox>/done/ を「墓場」として再利用し、古い entry を
// 「削除でなく atomic rename で退避」する。2つの判定軸はどちらも「単一 entry の事実」だけで決まり、
// 別プロジェクトの未読キャプチャを巻き込まない:
//   1) MAX-AGE          : shot.png mtime が maxAgeMs より古い（14日前は全プロジェクトで陳腐）
//   2) SAME-FAMILY cap  : 同一ページ族 {host}__{title} の新しい maxPerFamily 件だけ残す
// 安全ガード GRACE FLOOR: mtime が graceWindowMs(既定30分)以内の entry は何があっても触らない
// （別 CLI が今 push して直後に読む未読を保護）。maxAge/doneTtl は grace 未満にクランプされる。
//
// archive されても findEntry(inbox.js) は id 指定なら done/ を解決するので、in-flight な contextId /
// /shot/<id>.png は壊れない（latest/list は done/ を除外し続ける）。
//
// 注意: familyKey は末尾 hash だけでなく先頭 stamp も外す。slug = {stamp}__{host}__{title}__{hash} で
// stamp(時刻)は世代ごとに変わるため、hash だけ外すと各世代が別キーになり cap が一切効かない。

import { existsSync, readdirSync, renameSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { listEntries } from './inbox.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const DEFAULTS = {
  graceWindowMs: 30 * MINUTE,
  maxAgeMs: 14 * DAY,
  maxPerFamily: 5,
  doneTtlMs: 7 * DAY,
  sweepIntervalMs: 60 * MINUTE,
};

const UNIT_MS = { ms: 1, s: 1000, m: MINUTE, h: 60 * MINUTE, d: DAY };

// '30m' / '14d' / '7d' / '1h' / '500ms' / 純数値(ms) を ms へ。不正は fallback。
export function coerceDuration(value, fallbackMs) {
  if (value == null || value === '') return fallbackMs;
  const m = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.round(n * UNIT_MS[m[2] || 'ms']);
}

function coerceCount(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

// on/1/true/yes → true、それ以外(off/0/false/未指定) → false。
function parseEnabled(value) {
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'on' || s === '1' || s === 'true' || s === 'yes';
}

// 同一ページ族キー。{stamp}__{host}__{title}__{hash}（衝突時は末尾が {hash}-N）から
// stamp(先頭) と hash(末尾) を外した {host}__{title} を返す。旧 timestamp 形式など
// '__' 区切りでないものは null（= family cap 対象外、age のみで掃除）。
export function familyKey(id) {
  const parts = String(id || '').split('__');
  if (parts.length >= 4) return parts.slice(1, -1).join('__');
  return null;
}

// フラグ/環境変数/既定の優先順で retention ポリシーを解決する（flag > env > default）。
// maxAgeMs/doneTtlMs は graceWindowMs 未満にならないようクランプ（grace floor をどの設定でも破れない）。
export function resolveRetentionPolicy({ args = {}, env = {} } = {}) {
  const enabled = parseEnabled(args.retention ?? env.BAG_VF_RETENTION);
  const graceWindowMs = coerceDuration(args.retentionGrace ?? env.BAG_VF_RETENTION_GRACE, DEFAULTS.graceWindowMs);
  let maxAgeMs = coerceDuration(args.retentionMaxAge ?? env.BAG_VF_RETENTION_MAX_AGE, DEFAULTS.maxAgeMs);
  let doneTtlMs = coerceDuration(args.retentionDoneTtl ?? env.BAG_VF_RETENTION_DONE_TTL, DEFAULTS.doneTtlMs);
  const sweepIntervalMs = coerceDuration(args.retentionInterval ?? env.BAG_VF_RETENTION_INTERVAL, DEFAULTS.sweepIntervalMs);
  const maxPerFamily = coerceCount(args.retentionMaxPerFamily ?? env.BAG_VF_RETENTION_MAX_PER_FAMILY, DEFAULTS.maxPerFamily);
  maxAgeMs = Math.max(maxAgeMs, graceWindowMs);
  doneTtlMs = Math.max(doneTtlMs, graceWindowMs);
  return { enabled, graceWindowMs, maxAgeMs, doneTtlMs, sweepIntervalMs, maxPerFamily };
}

function isUnsafeName(name) {
  return !name || /[\\/]/.test(name) || name === '.' || name === '..';
}

// <inbox>/<slug> を <inbox>/done/<slug> へ atomic rename で退避する。
// 既に done/ に同名があれば -2,-3… を付けて世代を潰さない。失敗(EBUSY/EXDEV 等)は false を返し
// sweep 全体は止めない。退避先 dir の mtime を「今」に更新し、done-TTL を「退避時刻」基準にする
// （age で退避した直後に doneTtl 超過で即削除されるのを防ぐ）。
export function archiveOne(inboxDir, slug) {
  if (isUnsafeName(slug)) return false;
  const src = join(inboxDir, slug);
  const doneDir = join(inboxDir, 'done');
  try {
    if (!existsSync(src)) return false;
    mkdirSync(doneDir, { recursive: true, mode: 0o700 });
    let name = slug;
    let n = 2;
    while (existsSync(join(doneDir, name))) {
      name = `${slug}-${n}`;
      n += 1;
    }
    const dest = join(doneDir, name);
    renameSync(src, dest);
    try {
      const t = new Date();
      utimesSync(dest, t, t);
    } catch {
      /* mtime 更新失敗は致命的でない（最悪、退避が少し早く purge されるだけ） */
    }
    return true;
  } catch {
    return false;
  }
}

// <inbox>/done/ 配下で dir mtime（= 退避時刻）が cutMs より古いものを削除する。
function purgeDone(inboxDir, cutMs) {
  const doneDir = join(inboxDir, 'done');
  if (!existsSync(doneDir)) return 0;
  let dirents;
  try {
    dirents = readdirSync(doneDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let purged = 0;
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = join(doneDir, d.name);
    let mtime = 0;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutMs) {
      try {
        rmSync(dir, { recursive: true, force: true });
        purged += 1;
      } catch {
        /* 削除失敗は skip（次回 sweep で再試行） */
      }
    }
  }
  return purged;
}

// inbox を1回掃除する。enabled でない/inbox が無い時は no-op。{archived,purged} を返す。
// 安全則: graceWindowMs 以内の entry は MAX-AGE でも FAMILY cap でも絶対に archive しない。
// FAMILY cap の「新しい世代」カウントには grace 内 entry も含める（残すべき最新世代として数える）が、
// archive 対象にはしない。
export function pruneInbox(inboxDir, policy) {
  if (!policy?.enabled || !inboxDir || !existsSync(inboxDir)) return { archived: 0, purged: 0 };
  const now = Date.now();
  const floor = now - policy.graceWindowMs; // これ以上に新しい mtime は保護
  const ageCut = now - policy.maxAgeMs; // これより古い mtime は MAX-AGE 対象
  const entries = listEntries(inboxDir, 10000); // done/ 除外・mtime 降順
  const toArchive = new Map(); // id -> entry（重複排除）
  const familySeen = new Map(); // familyKey -> これまでに見た（=より新しい）世代数
  for (const e of entries) {
    const isYoung = e.mtime >= floor; // grace 内（保護）
    if (!isYoung && e.mtime < ageCut) toArchive.set(e.id, e); // MAX-AGE
    const key = familyKey(e.id);
    if (key != null) {
      const seen = familySeen.get(key) || 0;
      familySeen.set(key, seen + 1);
      // 既により新しい世代を maxPerFamily 件見ている かつ grace 外 → cap 超過として退避
      if (seen >= policy.maxPerFamily && !isYoung) toArchive.set(e.id, e);
    }
  }
  let archived = 0;
  for (const e of toArchive.values()) {
    if (archiveOne(inboxDir, e.id)) archived += 1;
  }
  const purged = purgeDone(inboxDir, now - policy.doneTtlMs);
  return { archived, purged };
}
