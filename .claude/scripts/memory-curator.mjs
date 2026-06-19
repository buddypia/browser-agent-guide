#!/usr/bin/env node

/**
 * memory-curator.mjs — Memory/Learnings Lifecycle Curator
 *
 * R-CM-027 Memory Lifecycle 강제 메커니즘. 사용자 호출형 정리 도구.
 *
 * 4-state lifecycle:
 *   staging  — 신규 추가, 아직 1회 미주입
 *   active   — 1회 이상 주입됨 (가치 검증)
 *   review   — N sessions 후에도 미주입 + age > THRESHOLD_DAYS → 인간 결정 대기
 *   archived — 사용자 결정으로 정리됨 (jsonl/json 에서 제거 + audit trail 보존)
 *
 * SSOT:
 *   .brief2dev/system/memory-curation.json — lifecycle 메타데이터 (이 스크립트만 갱신)
 *   .brief2dev/system/pipeline-memory.json — fact append-only (lifecycle 필드 추가 안 함)
 *   .brief2dev/system/learnings.jsonl     — entry append-only (lifecycle 필드 추가 안 함)
 *
 * 외부 사례:
 *   - Claude Code 공식 "Auto Memory works better when accurate and small than comprehensive and stale"
 *   - Letta 2026 방향 — server-side memory 도구 → filesystem + skill 위임
 *   - RAG governance (Atlan, Pryon medical study) — freshness signals
 *
 * Source: brief2dev internal (R-CM-021 사이클 2026-05-01).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { resolveSystemFile, resolveArchiveDir } from './lib/layout-resolver.mjs';
import { atomicWriteJson } from './lib/utils.mjs';
import { classifyLesson } from './lib/pipeline-memory-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..', '..');

// ─── lifecycle config ─────────────────────────────────────────────────
const REVIEW_TRIGGER_SESSIONS = 5;
const REVIEW_TRIGGER_AGE_DAYS = 7;
const STALE_REVIEW_DAYS = 14; // R-CM-027 audit L1 임계값

const VALID_STAGES = ['staging', 'active', 'review', 'archived'];

// 전이 규칙: from → allowed to set
const VALID_TRANSITIONS = {
  staging: ['active', 'review', 'archived'],
  active: ['review', 'archived'],
  review: ['active', 'archived'],
  archived: [], // 종료 상태
};

// ─── path resolvers ───────────────────────────────────────────────────
function curationPath() {
  return resolveSystemFile('memory-curation.json');
}
function memoryPath() {
  return resolveSystemFile('pipeline-memory.json');
}
function learningsPath() {
  return resolveSystemFile('learnings.jsonl');
}

// ─── curation store ────────────────────────────────────────────────────
function loadCuration() {
  const path = curationPath();
  if (!existsSync(path)) {
    return {
      schema_version: '1.0',
      last_curated_at: null,
      curation_count: 0,
      fact_lifecycle: {},     // FACT-XXXX → { stage, changed_at, reason?, history[] }
      learning_lifecycle: {}, // entry.key → 동일 구조
    };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {
      schema_version: '1.0',
      last_curated_at: null,
      curation_count: 0,
      fact_lifecycle: {},
      learning_lifecycle: {},
    };
  }
}

function saveCuration(curation) {
  curation.last_curated_at = new Date().toISOString();
  atomicWriteJson(curationPath(), curation);
}

// ─── inventory ─────────────────────────────────────────────────────────
function loadFacts() {
  const path = memoryPath();
  if (!existsSync(path)) return { facts: [], metadata: {} };
  try {
    const m = JSON.parse(readFileSync(path, 'utf-8'));
    return { facts: m.facts || [], metadata: m.metadata || {} };
  } catch {
    return { facts: [], metadata: {} };
  }
}

function loadLearnings() {
  const path = learningsPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return { ...JSON.parse(line), _line: i + 1 };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ─── lifecycle stage 추론 (자동 분류 후보 생성용) ──────────────────────
function inferStage(item, curationEntry, sessionCount) {
  // 사용자가 이미 archived 로 결정 → 그대로 보존
  if (curationEntry?.stage === 'archived') return 'archived';

  // access_count > 0 → active
  const access = item.access_count ?? item._access ?? 0;
  if (access > 0) return 'active';

  // 신규 (age < 7d AND session_count < REVIEW_TRIGGER_SESSIONS) → staging
  const createdAt = item.created_at || item.ts;
  const ageMs = createdAt ? Date.now() - Date.parse(createdAt) : Infinity;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);

  if (ageDays < REVIEW_TRIGGER_AGE_DAYS && sessionCount < REVIEW_TRIGGER_SESSIONS) {
    return 'staging';
  }

  // 그 외 → review
  return 'review';
}

// ─── diagnose ──────────────────────────────────────────────────────────
export function diagnose() {
  const curation = loadCuration();
  const { facts, metadata } = loadFacts();
  const learnings = loadLearnings();
  const sessionCount = metadata.session_count ?? 0;

  const factDiag = facts.map((f) => {
    const cur = curation.fact_lifecycle[f.id];
    const inferred = inferStage(f, cur, sessionCount);
    const recorded = cur?.stage;
    return {
      id: f.id,
      category: f.category || 'unknown',
      access_count: f.access_count || 0,
      age_days: f.created_at ? ((Date.now() - Date.parse(f.created_at)) / 86400000).toFixed(1) : '?',
      content: typeof f.content === 'string' ? f.content.slice(0, 80) : JSON.stringify(f.content).slice(0, 80),
      recorded_stage: recorded || '(unset)',
      inferred_stage: inferred,
      drift: recorded && recorded !== inferred ? `${recorded}→${inferred}` : null,
    };
  });

  const learnDiag = learnings.map((e) => {
    const cur = curation.learning_lifecycle[e.key];
    const inferred = inferStage({ created_at: e.ts, _access: 0 }, cur, sessionCount);
    const recorded = cur?.stage;
    return {
      key: e.key,
      type: e.type,
      source: e.source,
      confidence: e.confidence,
      age_days: e.ts ? ((Date.now() - Date.parse(e.ts)) / 86400000).toFixed(1) : '?',
      insight: (e.insight || '').slice(0, 80),
      recorded_stage: recorded || '(unset)',
      inferred_stage: inferred,
    };
  });

  return {
    summary: {
      total_facts: facts.length,
      total_learnings: learnings.length,
      session_count: sessionCount,
      last_curated: curation.last_curated_at,
      curation_count: curation.curation_count || 0,
      facts_by_inferred: groupCount(factDiag, 'inferred_stage'),
      learnings_by_inferred: groupCount(learnDiag, 'inferred_stage'),
      facts_review_candidates: factDiag.filter((d) => d.inferred_stage === 'review').length,
      learnings_review_candidates: learnDiag.filter((d) => d.inferred_stage === 'review').length,
    },
    facts: factDiag,
    learnings: learnDiag,
  };
}

function groupCount(arr, key) {
  return arr.reduce((acc, d) => {
    acc[d[key]] = (acc[d[key]] || 0) + 1;
    return acc;
  }, {});
}

// ─── apply plan ────────────────────────────────────────────────────────
/**
 * Plan 형식:
 *   {
 *     fact_actions: [{ id, action: 'keep'|'archive'|'mark_review', reason? }],
 *     learning_actions: [{ key, action, reason? }]
 *   }
 *
 * action:
 *   keep         — 현재 inferred 그대로 lifecycle 기록 (active/staging)
 *   mark_review  — review 단계로 명시 표시 (인간 결정 대기)
 *   archive      — pipeline-memory.json / learnings.jsonl 에서 제거 + curation 에 archived 기록
 */
export function applyPlan(plan, opts = {}) {
  const dryRun = opts.dryRun ?? false;
  const reason = opts.reason || 'manual';

  const curation = loadCuration();
  const { facts: allFacts, metadata } = loadFacts();
  const allLearnings = loadLearnings();

  const result = {
    dry_run: dryRun,
    timestamp: new Date().toISOString(),
    fact_changes: [],
    learning_changes: [],
    archived_facts: [],
    archived_learnings: [],
  };

  // facts
  let factsKept = [...allFacts];
  for (const action of plan.fact_actions || []) {
    const fact = allFacts.find((f) => f.id === action.id);
    if (!fact) {
      result.fact_changes.push({ id: action.id, status: 'not_found' });
      continue;
    }

    const before = curation.fact_lifecycle[action.id]?.stage || '(unset)';
    let next;
    if (action.action === 'archive') {
      next = 'archived';
      factsKept = factsKept.filter((f) => f.id !== action.id);
      result.archived_facts.push({ id: fact.id, content: fact.content, category: fact.category, archived_at: result.timestamp, reason: action.reason });
    } else if (action.action === 'mark_review') {
      next = 'review';
    } else if (action.action === 'keep') {
      next = inferStage(fact, curation.fact_lifecycle[action.id], metadata.session_count ?? 0);
    } else {
      result.fact_changes.push({ id: action.id, status: 'invalid_action', action: action.action });
      continue;
    }

    if (!validateTransition(before, next)) {
      result.fact_changes.push({ id: action.id, status: 'invalid_transition', from: before, to: next });
      continue;
    }

    if (!dryRun) {
      const prev = curation.fact_lifecycle[action.id] || { history: [] };
      curation.fact_lifecycle[action.id] = {
        stage: next,
        changed_at: result.timestamp,
        reason: action.reason || reason,
        history: [...(prev.history || []), { from: before, to: next, at: result.timestamp, reason: action.reason || reason }].slice(-10),
      };
    }
    result.fact_changes.push({ id: action.id, from: before, to: next, action: action.action });
  }

  // learnings
  let learningsKept = [...allLearnings];
  for (const action of plan.learning_actions || []) {
    const entry = allLearnings.find((e) => e.key === action.key);
    if (!entry) {
      result.learning_changes.push({ key: action.key, status: 'not_found' });
      continue;
    }

    const before = curation.learning_lifecycle[action.key]?.stage || '(unset)';
    let next;
    if (action.action === 'archive') {
      next = 'archived';
      learningsKept = learningsKept.filter((e) => e.key !== action.key);
      result.archived_learnings.push({ key: entry.key, type: entry.type, insight: entry.insight, archived_at: result.timestamp, reason: action.reason });
    } else if (action.action === 'mark_review') {
      next = 'review';
    } else if (action.action === 'keep') {
      next = inferStage({ created_at: entry.ts, _access: 0 }, curation.learning_lifecycle[action.key], metadata.session_count ?? 0);
    } else {
      result.learning_changes.push({ key: action.key, status: 'invalid_action', action: action.action });
      continue;
    }

    if (!validateTransition(before, next)) {
      result.learning_changes.push({ key: action.key, status: 'invalid_transition', from: before, to: next });
      continue;
    }

    if (!dryRun) {
      const prev = curation.learning_lifecycle[action.key] || { history: [] };
      curation.learning_lifecycle[action.key] = {
        stage: next,
        changed_at: result.timestamp,
        reason: action.reason || reason,
        history: [...(prev.history || []), { from: before, to: next, at: result.timestamp, reason: action.reason || reason }].slice(-10),
      };
    }
    result.learning_changes.push({ key: action.key, from: before, to: next, action: action.action });
  }

  if (!dryRun) {
    // 1. memory-curation.json 갱신
    curation.curation_count = (curation.curation_count || 0) + 1;
    saveCuration(curation);

    // 2. pipeline-memory.json 갱신 (archived facts 제거)
    if (result.archived_facts.length > 0) {
      const memPath = memoryPath();
      const mem = JSON.parse(readFileSync(memPath, 'utf-8'));
      mem.facts = factsKept;
      atomicWriteJson(memPath, mem);
    }

    // 3. learnings.jsonl 갱신 (archived entries 제거)
    if (result.archived_learnings.length > 0) {
      const lp = learningsPath();
      const newContent = learningsKept
        .map(({ _line, ...rest }) => JSON.stringify(rest))
        .join('\n') + (learningsKept.length > 0 ? '\n' : '');
      writeFileSync(lp, newContent, 'utf-8');
    }

    // 4. archive trail (raw history is archive-only, not active governance context)
    const month = result.timestamp.slice(0, 7);
    const trailDir = join(resolveArchiveDir('governance/audits'), month);
    if (!existsSync(trailDir)) {
      mkdirSync(trailDir, { recursive: true });
    }
    const trailPath = join(trailDir, `memory-curation-${result.timestamp.replace(/[:.]/g, '-')}.json`);
    writeFileSync(trailPath, JSON.stringify(result, null, 2), 'utf-8');
    result.audit_trail = trailPath;
  }

  return result;
}

function validateTransition(from, to) {
  if (from === '(unset)') return true; // 처음 설정
  if (!VALID_STAGES.includes(to)) return false;
  return VALID_TRANSITIONS[from]?.includes(to) || false;
}

// ─── interactive mode ──────────────────────────────────────────────────
/**
 * 인터랙티브 큐레이션 — 진단 후 review candidates 에 대해 사용자가
 * 각 항목별로 keep/archive/mark_review 결정. plan 파일 작성 부담 제거.
 *
 * stdin/stdout DI 로 테스트 가능. 응답 파싱:
 *   k (keep), a (archive), m (mark_review), s (skip)
 *   q (quit, 누적된 결정 폐기)
 *
 * @param {{ stdin?, stdout?, dryRun?: boolean, autoConfirm?: boolean }} opts
 * @returns {Promise<{ plan, applied?: object, aborted?: boolean }>}
 */
export async function runInteractive(opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;
  const dryRun = opts.dryRun ?? false;
  const autoConfirm = opts.autoConfirm ?? false;

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });

  // Line queue 기반 ask. stream end 이후에도 누적된 line 을 소비 가능.
  // rl.question 은 close 후 reject 되어 mock stdin (Readable.from) 케이스에서 실패한다.
  const lineQueue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift()(line);
    else lineQueue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()('');
  });
  const ask = (prompt) => {
    stdout.write(prompt);
    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift());
    if (closed) return Promise.resolve('');
    return new Promise((resolve) => waiters.push(resolve));
  };

  const write = (line) => stdout.write(line + '\n');

  const diag = diagnose();
  write('Memory Curator — Interactive Mode');
  write('==================================');
  write(`facts: ${diag.summary.total_facts} | learnings: ${diag.summary.total_learnings} | session_count: ${diag.summary.session_count}`);
  write('');

  const factCandidates = diag.facts.filter((d) => d.inferred_stage === 'review' && d.recorded_stage !== 'archived');
  const learnCandidates = diag.learnings.filter((d) => d.inferred_stage === 'review' && d.recorded_stage !== 'archived');

  if (factCandidates.length === 0 && learnCandidates.length === 0) {
    write('Review candidates: 0 (정리할 항목 없음)');
    rl.close();
    return { plan: { fact_actions: [], learning_actions: [] }, aborted: false };
  }

  write(`Review candidates: facts=${factCandidates.length}, learnings=${learnCandidates.length}`);
  write('');
  write('각 항목에 대해 입력하세요: [k]eep / [a]rchive / [m]ark-review / [s]kip / [q]uit');
  write('');

  const factActions = [];
  const learnActions = [];

  for (let i = 0; i < factCandidates.length; i++) {
    const d = factCandidates[i];
    write(`[${i + 1}/${factCandidates.length}] FACT ${d.id} (${d.category}) age=${d.age_days}d access=${d.access_count}`);
    write(`  ${d.content}`);
    if (d.category === 'lesson_learned') {
      write(`  [classify: ${classifyLesson(d.content)}]`);
    }
    const ans = (await ask('  > action: ')).trim().toLowerCase();
    if (ans === 'q') {
      rl.close();
      return { plan: { fact_actions: [], learning_actions: [] }, aborted: true };
    }
    const action = parseAction(ans);
    if (action === 'skip' || action === null) {
      write('  → skipped');
      continue;
    }
    const reason = action === 'archive' ? await ask('  > reason (Enter=manual): ') : '';
    factActions.push({ id: d.id, action, reason: reason.trim() || undefined });
    write(`  → ${action}`);
  }

  for (let i = 0; i < learnCandidates.length; i++) {
    const d = learnCandidates[i];
    write(`[${i + 1}/${learnCandidates.length}] LEARN ${d.key} (${d.type}) age=${d.age_days}d`);
    write(`  ${d.insight}`);
    write(`  [classify: ${classifyLesson(d.insight)}]`);
    const ans = (await ask('  > action: ')).trim().toLowerCase();
    if (ans === 'q') {
      rl.close();
      return { plan: { fact_actions: factActions, learning_actions: [] }, aborted: true };
    }
    const action = parseAction(ans);
    if (action === 'skip' || action === null) {
      write('  → skipped');
      continue;
    }
    const reason = action === 'archive' ? await ask('  > reason (Enter=manual): ') : '';
    learnActions.push({ key: d.key, action, reason: reason.trim() || undefined });
    write(`  → ${action}`);
  }

  const plan = { fact_actions: factActions, learning_actions: learnActions };
  const archiveCount = factActions.filter((a) => a.action === 'archive').length + learnActions.filter((a) => a.action === 'archive').length;

  write('');
  write('=== Summary ===');
  write(`fact_actions: ${factActions.length} (archive=${factActions.filter((a) => a.action === 'archive').length}, mark_review=${factActions.filter((a) => a.action === 'mark_review').length}, keep=${factActions.filter((a) => a.action === 'keep').length})`);
  write(`learning_actions: ${learnActions.length} (archive=${learnActions.filter((a) => a.action === 'archive').length}, mark_review=${learnActions.filter((a) => a.action === 'mark_review').length}, keep=${learnActions.filter((a) => a.action === 'keep').length})`);

  if (factActions.length === 0 && learnActions.length === 0) {
    write('No actions to apply.');
    rl.close();
    return { plan, aborted: false };
  }

  if (archiveCount > 0 && !autoConfirm) {
    const confirm = (await ask(`\n${archiveCount}개 항목 archive 진행? (y/N): `)).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes') {
      write('Aborted by user.');
      rl.close();
      return { plan, aborted: true };
    }
  }

  rl.close();
  const applied = applyPlan(plan, { dryRun, reason: 'interactive' });
  return { plan, applied, aborted: false };
}

export function parseAction(input) {
  switch (input) {
    case 'k':
    case 'keep':
      return 'keep';
    case 'a':
    case 'archive':
      return 'archive';
    case 'm':
    case 'mark':
    case 'mark_review':
    case 'review':
      return 'mark_review';
    case 's':
    case 'skip':
    case '':
      return 'skip';
    default:
      return null;
  }
}

// ─── auto-review (staging → review 자동 전이 후보) ─────────────────────
export function autoReviewPlan() {
  const diag = diagnose();
  const factActions = diag.facts
    .filter((d) => d.inferred_stage === 'review' && d.recorded_stage !== 'review' && d.recorded_stage !== 'archived')
    .map((d) => ({ id: d.id, action: 'mark_review', reason: 'auto_review_session_threshold' }));
  const learningActions = diag.learnings
    .filter((d) => d.inferred_stage === 'review' && d.recorded_stage !== 'review' && d.recorded_stage !== 'archived')
    .map((d) => ({ key: d.key, action: 'mark_review', reason: 'auto_review_session_threshold' }));
  return { fact_actions: factActions, learning_actions: learningActions };
}

// ─── CLI ───────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  const json = flag('--json');
  const dryRun = flag('--dry-run');

  if (flag('--interactive')) {
    runInteractive({ dryRun })
      .then((res) => {
        if (json) {
          console.log(JSON.stringify(res, null, 2));
        } else if (res.aborted) {
          console.log('Interactive curation aborted (no changes).');
        } else if (res.applied) {
          console.log(`memory-curator interactive ${dryRun ? '(DRY RUN)' : ''}:`);
          console.log(`  fact changes: ${res.applied.fact_changes.length}`);
          console.log(`  learning changes: ${res.applied.learning_changes.length}`);
          console.log(`  archived facts: ${res.applied.archived_facts.length}`);
          console.log(`  archived learnings: ${res.applied.archived_learnings.length}`);
          if (res.applied.audit_trail) console.log(`  audit trail: ${res.applied.audit_trail}`);
        } else {
          console.log('No actions selected.');
        }
        process.exit(0);
      })
      .catch((e) => {
        console.error('Interactive mode error:', e.message);
        process.exit(1);
      });
  } else if (flag('--diagnose') || (!flag('--apply') && !flag('--auto-review'))) {
    const diag = diagnose();
    if (json) {
      console.log(JSON.stringify(diag, null, 2));
    } else {
      printDiagnose(diag);
    }
    process.exit(0);
  } else if (flag('--auto-review')) {
    const plan = autoReviewPlan();
    if (json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log('Auto-review plan (staging → review):');
      console.log('  fact_actions:', plan.fact_actions.length);
      console.log('  learning_actions:', plan.learning_actions.length);
      for (const a of plan.fact_actions) console.log('  fact', a.id, '→', a.action);
      for (const a of plan.learning_actions) console.log('  learn', a.key, '→', a.action);
    }
    process.exit(0);
  } else if (flag('--apply')) {
    const planPath = value('--apply');
    if (!planPath || !existsSync(planPath)) {
      console.error('Error: --apply <plan-file> required');
      process.exit(2);
    }
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const result = applyPlan(plan, { dryRun });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`memory-curator apply ${dryRun ? '(DRY RUN)' : ''}:`);
      console.log(`  fact changes: ${result.fact_changes.length}`);
      console.log(`  learning changes: ${result.learning_changes.length}`);
      console.log(`  archived facts: ${result.archived_facts.length}`);
      console.log(`  archived learnings: ${result.archived_learnings.length}`);
      if (result.audit_trail) console.log(`  audit trail: ${result.audit_trail}`);
    }
    process.exit(0);
  }
}

function printDiagnose(diag) {
  const s = diag.summary;
  console.log('Memory Curator Diagnose');
  console.log('========================');
  console.log(`facts: ${s.total_facts} | learnings: ${s.total_learnings}`);
  console.log(`session_count: ${s.session_count} | last_curated: ${s.last_curated || '(never)'} | curation_count: ${s.curation_count}`);
  console.log();
  console.log('Facts by inferred lifecycle:');
  for (const [k, v] of Object.entries(s.facts_by_inferred)) console.log(`  ${k.padEnd(10)}: ${v}`);
  console.log();
  console.log('Learnings by inferred lifecycle:');
  for (const [k, v] of Object.entries(s.learnings_by_inferred)) console.log(`  ${k.padEnd(10)}: ${v}`);
  console.log();
  console.log(`Review candidates: facts=${s.facts_review_candidates}, learnings=${s.learnings_review_candidates}`);
  console.log();
  if (s.facts_review_candidates > 0) {
    console.log('--- Facts in review (first 10) ---');
    diag.facts.filter((d) => d.inferred_stage === 'review').slice(0, 10).forEach((d) => {
      console.log(`  ${d.id} | ${d.category.padEnd(20)} | access=${d.access_count} | age=${d.age_days}d | ${d.content}`);
    });
    console.log();
  }
  if (s.learnings_review_candidates > 0) {
    console.log('--- Learnings in review (first 10) ---');
    diag.learnings.filter((d) => d.inferred_stage === 'review').slice(0, 10).forEach((d) => {
      console.log(`  ${d.key.slice(0, 50).padEnd(50)} | conf=${d.confidence} | age=${d.age_days}d`);
    });
  }
}

export const _internal = { REVIEW_TRIGGER_SESSIONS, REVIEW_TRIGGER_AGE_DAYS, STALE_REVIEW_DAYS, VALID_STAGES, VALID_TRANSITIONS, validateTransition, inferStage };
