#!/usr/bin/env node
/**
 * followup-debt-tracker.mjs
 *
 * R-CM-033 (followup-debt-tracking) SSOT 관리 도구.
 *
 * 목적: PR description 의 "별도 PR" / "후속 PR" / "follow-up" 등으로 의도적 deferred 된
 * 후속 작업을 추적하고, AI 가 "별도 PR scope" 라는 분류로 silently quality 누락하는 패턴을 차단한다.
 *
 * SSOT: .brief2dev/system/followup-debt.json
 * Schema: data/registry/followup-debt.schema.json
 *
 * Subcommands:
 *   register --pr <num> [--from-text "..."] [--from-file <path>] [--json]
 *     PR description 을 파싱하여 후속 부채 항목 자동 등록.
 *
 *   list [--status open|addressed|wontfix] [--severity HIGH|MEDIUM|LOW] [--json]
 *     등록된 부채 조회.
 *
 *   close --id DEBT-<n> [--addressed-pr <num>] [--wontfix --reason "..."]
 *     부채 항목 처리 완료 마킹.
 *
 *   audit [--max-age-days N] [--json]
 *     N 일 (default 30) 이상 open + HIGH severity 부채 발견 시 exit 1.
 *
 * 환경변수:
 *   BRIEF2DEV_FOLLOWUP_DEBT_PATH  SSOT 파일 경로 override (테스트용)
 *   GH_TOKEN                       gh API 호출용 (PR description fetch)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveSystemFile } from './lib/layout-resolver.mjs';
import { writeJsonAtomicSync } from './lib/atomic-fs.mjs';

const DEFAULT_MAX_AGE_DAYS = 30;
const CATEGORIES = new Set(['code_review_finding', 'code_reviewer_finding', 'general_followup']);
const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const KEYWORDS = [
  /별도\s*PR/g,
  /후속\s*PR/g,
  /follow[-\s]?up/gi,
  /scope\s*외/g,
  /후속\s*작업/g,
  /deferred/gi,
];

function getSsotPath() {
  if (process.env.BRIEF2DEV_FOLLOWUP_DEBT_PATH) {
    return resolve(process.env.BRIEF2DEV_FOLLOWUP_DEBT_PATH);
  }
  return resolveSystemFile('followup-debt.json');
}

function loadDebt() {
  const path = getSsotPath();
  if (!existsSync(path)) {
    return { version: '1.0.0', updated_at: new Date().toISOString(), items: [] };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`followup-debt.json parse failed: ${e.message}`);
  }
}

/**
 * SSOT 갱신. atomic write 실패 시 throw — 호출자가 fail-open 결정.
 * ship-worktree post-merge step 은 R-CM-033 본문의 try/catch + warnings 로 cover.
 * 직접 CLI 호출 (`register --pr` 등) 은 의도적으로 crash 하여 사용자에게 신호.
 */
function saveDebt(debt) {
  const path = getSsotPath();
  debt.updated_at = new Date().toISOString();
  writeJsonAtomicSync(path, debt);
}

/**
 * 단일 debt 항목을 close 한다 (open → addressed | wontfix).
 * Loom AI Memory 대시보드의 followup-debt 삭제가 호출하는 라이브러리 진입점.
 * @param {string} id - DEBT-N
 * @param {{ reason?: string, addressedPr?: number, now?: string }} [opts]
 *   reason 제공 시 wontfix (R-CM-033 #8 — 최소 10자), 없으면 addressed.
 * @returns {object} 변경된 item
 * @throws id 미존재 / 이미 close / wontfix reason < 10자
 */
export function closeDebt(id, opts = {}) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('closeDebt: id required');
  }
  const debt = loadDebt();
  const item = (debt.items || []).find((it) => it.id === id);
  if (!item) throw new Error(`closeDebt: debt not found: ${id}`);
  if (item.status && item.status !== 'open') {
    throw new Error(`closeDebt: debt already ${item.status}: ${id}`);
  }
  const now = opts.now || new Date().toISOString();
  if (opts.reason) {
    if (String(opts.reason).trim().length < 10) {
      throw new Error('closeDebt: wontfix reason ≥10 chars (R-CM-033 #8)');
    }
    item.status = 'wontfix';
    item.wontfix_reason = String(opts.reason).trim();
  } else {
    item.status = 'addressed';
    item.addressed_pr = opts.addressedPr || null;
  }
  item.addressed_at = now;
  saveDebt(debt);
  return item;
}

/**
 * Loom AI Memory archive/hard-delete 용 — debt 항목을 SSOT 에서 splice 제거하고 제거된 item 을 반환한다.
 * closeDebt(wontfix) 의 status 변경과 달리 items 배열에서 제거한다. 복구는 봉투(_archive/memory-deleted/
 * followup-debt/) + restoreDebtItem 으로 수행. R-CM-033 Rule 7/9 정합: 봉투가 audit history 를 대체하므로
 * "silently JSON 편집"(anti-pattern)이 아니라 사용자 명시 Loom 조작 + audit 보존이다.
 * @param {string} id - DEBT-N
 * @returns {object|null} 제거된 item (없으면 null — 호출자가 not_found 결정)
 */
export function removeDebtItem(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('removeDebtItem: id required');
  }
  const debt = loadDebt();
  const items = debt.items || [];
  const idx = items.findIndex((it) => it.id === id);
  if (idx === -1) return null;
  const [removed] = items.splice(idx, 1);
  debt.items = items;
  saveDebt(debt);
  return removed;
}

/**
 * Loom AI Memory restore 용 — 봉투에서 읽은 debt item 을 SSOT 에 복원한다.
 * 같은 id 가 이미 존재하면 중복 추가하지 않고 기존을 유지한다 (idempotent — 동시 2탭 안전).
 * @param {object} item - 봉투 payload (원본 debt item)
 * @returns {object} 복원(또는 기존 유지)된 item
 */
export function restoreDebtItem(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0) {
    throw new Error('restoreDebtItem: item with id required');
  }
  const debt = loadDebt();
  const items = debt.items || [];
  if (!items.some((it) => it.id === item.id)) {
    items.push(item);
    debt.items = items;
    saveDebt(debt);
  }
  return item;
}

function nextId(items) {
  let max = 0;
  for (const item of items) {
    const m = /^DEBT-(\d+)$/.exec(item.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `DEBT-${max + 1}`;
}

function normalizeDescription(value) {
  return value.toLowerCase().replace(/\s+/g, ' ');
}

function readOption(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

/**
 * PR description text 에서 후속 부채 항목을 추출한다.
 * - "별도 PR" / "후속 PR" / "follow-up" / "scope 외" / "deferred" 키워드 포함 섹션 검출
 * - 그 섹션 안의 bullet/numbered list (`- `, `* `, `1.`) 를 항목으로 파싱
 * - 본 시점에 같은 description 의 같은 텍스트는 dedup (description 동일 시 skip)
 *
 * @param {string} text PR description body
 * @returns {Array<{description: string, files: string[]}>} 추출된 항목
 */
export function parsePrDescription(text) {
  if (!text || typeof text !== 'string') return [];

  const lines = text.split(/\r?\n/);
  const items = [];
  let inDeferredSection = false;
  let sectionDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^#+\s/.test(line)) {
      const headingMatchesKeyword = KEYWORDS.some((rx) => {
        rx.lastIndex = 0;
        return rx.test(line);
      });
      if (headingMatchesKeyword) {
        inDeferredSection = true;
        sectionDepth = (line.match(/^#+/) || [''])[0].length;
        continue;
      }
      if (inDeferredSection) {
        const newDepth = (line.match(/^#+/) || [''])[0].length;
        if (newDepth <= sectionDepth) {
          inDeferredSection = false;
        }
      }
    }

    if (inDeferredSection) {
      const bullet = line.match(/^\s*[-*]\s+(.+)/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.+)/);
      const text = bullet ? bullet[1] : numbered ? numbered[1] : null;
      if (text) {
        const trimmed = text.trim();
        if (trimmed.length >= 10) {
          items.push({ description: trimmed, files: extractFiles(trimmed) });
        }
      }
    }
  }

  const seen = new Set();
  return items.filter((it) => {
    const key = normalizeDescription(it.description);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFiles(text) {
  const files = [];
  const addFile = (file) => {
    if (files.includes(file)) return;
    if (!file.startsWith('.') && files.includes(`.${file}`)) return;
    if (file.startsWith('.')) {
      const bare = file.slice(1);
      const bareIdx = files.indexOf(bare);
      if (bareIdx >= 0) {
        files.splice(bareIdx, 1, file);
        return;
      }
    }
    files.push(file);
  };
  const patterns = [
    /`([^\s`]+\.[a-z0-9]+)`/g,
    /([a-zA-Z_][\w./-]*\.(?:mjs|js|ts|tsx|jsx|json|md|py|go|rs))/g,
  ];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text))) {
      addFile(m[1]);
    }
  }
  return files;
}

function fetchPrBody(prNumber) {
  try {
    const json = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'body', '--jq', '.body'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return json.trim();
  } catch (e) {
    throw new Error(`gh pr view ${prNumber} failed: ${e.message}`);
  }
}

function cmdRegister(args) {
  const prIdx = args.indexOf('--pr');
  if (prIdx < 0 || !args[prIdx + 1]) {
    console.error('Error: --pr <num> required');
    process.exit(1);
  }
  const prNumber = parseInt(args[prIdx + 1], 10);
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    console.error('Error: --pr must be a positive integer');
    process.exit(1);
  }

  let body = '';
  const fromTextIdx = args.indexOf('--from-text');
  const fromFileIdx = args.indexOf('--from-file');
  if (fromTextIdx >= 0 && args[fromTextIdx + 1]) {
    body = args[fromTextIdx + 1];
  } else if (fromFileIdx >= 0 && args[fromFileIdx + 1]) {
    body = readFileSync(args[fromFileIdx + 1], 'utf8');
  } else {
    body = fetchPrBody(prNumber);
  }

  const parsed = parsePrDescription(body);
  if (parsed.length === 0) {
    if (args.includes('--json')) {
      console.log(JSON.stringify({ ok: true, registered: 0, items: [] }));
    } else {
      console.log(`PR #${prNumber}: no follow-up items detected`);
    }
    return 0;
  }

  const debt = loadDebt();
  const now = new Date().toISOString();
  const sourceUrl = `https://github.com/buddypia/brief2dev/pull/${prNumber}`;
  const category = readOption(args, '--category') || 'general_followup';
  const severity = readOption(args, '--severity') || 'LOW';

  if (!CATEGORIES.has(category)) {
    console.error(`Error: --category must be one of ${Array.from(CATEGORIES).join(', ')}`);
    process.exit(1);
  }
  if (!SEVERITIES.has(severity)) {
    console.error(`Error: --severity must be one of ${Array.from(SEVERITIES).join(', ')}`);
    process.exit(1);
  }

  const existingDescriptions = new Set(
    debt.items
      .filter((it) => it.source_pr === prNumber)
      .map((it) => normalizeDescription(it.description)),
  );

  const registered = [];
  for (const item of parsed) {
    const key = normalizeDescription(item.description);
    if (existingDescriptions.has(key)) continue;
    const entry = {
      id: nextId(debt.items),
      source_pr: prNumber,
      source_pr_url: sourceUrl,
      category,
      severity,
      description: item.description,
      files: item.files,
      added_at: now,
      status: 'open',
      addressed_pr: null,
      addressed_at: null,
      wontfix_reason: null,
    };
    debt.items.push(entry);
    registered.push(entry);
  }

  saveDebt(debt);

  if (args.includes('--json')) {
    console.log(
      JSON.stringify({ ok: true, registered: registered.length, items: registered }),
    );
  } else {
    console.log(`PR #${prNumber}: registered ${registered.length} follow-up debt items`);
    for (const it of registered) {
      console.log(`  ${it.id}: ${it.description.slice(0, 80)}${it.description.length > 80 ? '...' : ''}`);
    }
  }
  return 0;
}

function cmdList(args) {
  const debt = loadDebt();
  let items = debt.items;

  const statusIdx = args.indexOf('--status');
  if (statusIdx >= 0 && args[statusIdx + 1]) {
    items = items.filter((it) => it.status === args[statusIdx + 1]);
  }
  const sevIdx = args.indexOf('--severity');
  if (sevIdx >= 0 && args[sevIdx + 1]) {
    items = items.filter((it) => it.severity === args[sevIdx + 1]);
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: true, count: items.length, items }));
  } else {
    if (items.length === 0) {
      console.log('No follow-up debt items found.');
      return 0;
    }
    console.log(`Found ${items.length} follow-up debt item(s):`);
    for (const it of items) {
      const ageDays = Math.floor(
        (Date.now() - new Date(it.added_at).getTime()) / (1000 * 60 * 60 * 24),
      );
      console.log(
        `  ${it.id} [${it.status}/${it.severity}] PR #${it.source_pr} (${ageDays}d ago)`,
      );
      console.log(`    ${it.description.slice(0, 100)}${it.description.length > 100 ? '...' : ''}`);
    }
  }
  return 0;
}

function cmdClose(args) {
  const idIdx = args.indexOf('--id');
  if (idIdx < 0 || !args[idIdx + 1]) {
    console.error('Error: --id DEBT-<n> required');
    process.exit(1);
  }
  const id = args[idIdx + 1];

  const debt = loadDebt();
  const item = debt.items.find((it) => it.id === id);
  if (!item) {
    console.error(`Error: ${id} not found`);
    process.exit(1);
  }
  if (item.status !== 'open') {
    console.error(`Error: ${id} already ${item.status}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  if (args.includes('--wontfix')) {
    const reasonIdx = args.indexOf('--reason');
    if (reasonIdx < 0 || !args[reasonIdx + 1] || args[reasonIdx + 1].length < 10) {
      console.error('Error: --reason "..." required (min 10 chars) for --wontfix');
      process.exit(1);
    }
    item.status = 'wontfix';
    item.wontfix_reason = args[reasonIdx + 1];
    item.addressed_at = now;
  } else {
    const prIdx = args.indexOf('--addressed-pr');
    if (prIdx < 0 || !args[prIdx + 1]) {
      console.error('Error: --addressed-pr <num> required (or use --wontfix)');
      process.exit(1);
    }
    item.status = 'addressed';
    item.addressed_pr = parseInt(args[prIdx + 1], 10);
    item.addressed_at = now;
  }

  saveDebt(debt);
  console.log(`${id} → ${item.status}`);
  return 0;
}

function cmdAudit(args) {
  const maxIdx = args.indexOf('--max-age-days');
  const maxAge =
    maxIdx >= 0 && args[maxIdx + 1] ? parseInt(args[maxIdx + 1], 10) : DEFAULT_MAX_AGE_DAYS;
  if (!Number.isInteger(maxAge) || maxAge < 0) {
    console.error('Error: --max-age-days must be a non-negative integer');
    process.exit(1);
  }

  const debt = loadDebt();
  const now = Date.now();
  const stale = debt.items.filter((it) => {
    if (it.status !== 'open') return false;
    const ageDays = Math.floor((now - new Date(it.added_at).getTime()) / (1000 * 60 * 60 * 24));
    return ageDays >= maxAge && (it.severity === 'HIGH' || it.severity === 'CRITICAL');
  });

  const violations = stale.length;
  if (args.includes('--json')) {
    console.log(
      JSON.stringify({
        ok: violations === 0,
        violations,
        max_age_days: maxAge,
        items: stale,
      }),
    );
  } else if (violations > 0) {
    console.error(
      `[followup-debt-audit] ${violations} stale HIGH/CRITICAL item(s) > ${maxAge} days:`,
    );
    for (const it of stale) {
      const ageDays = Math.floor((now - new Date(it.added_at).getTime()) / (1000 * 60 * 60 * 24));
      console.error(`  ${it.id} [${it.severity}] PR #${it.source_pr} (${ageDays}d): ${it.description.slice(0, 80)}`);
    }
  } else {
    console.log(`[followup-debt-audit] OK (no stale HIGH/CRITICAL items, max_age_days=${maxAge})`);
  }
  return violations === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'register':
      return cmdRegister(args.slice(1));
    case 'list':
      return cmdList(args.slice(1));
    case 'close':
      return cmdClose(args.slice(1));
    case 'audit':
      return cmdAudit(args.slice(1));
    default:
      console.error('Usage: followup-debt-tracker.mjs <register|list|close|audit> [options]');
      console.error('  register --pr <num> [--from-text "..." | --from-file <path>] [--json]');
      console.error('           [--category code_review_finding|code_reviewer_finding|general_followup]');
      console.error('           [--severity LOW|MEDIUM|HIGH|CRITICAL]');
      console.error('  list [--status open|addressed|wontfix] [--severity HIGH|MEDIUM|LOW] [--json]');
      console.error('  close --id DEBT-<n> (--addressed-pr <num> | --wontfix --reason "...")');
      console.error('  audit [--max-age-days N] [--json]');
      process.exit(1);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.exit(main());
}
