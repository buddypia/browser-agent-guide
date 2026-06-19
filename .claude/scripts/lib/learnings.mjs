#!/usr/bin/env node

/**
 * learnings.mjs — Learnings JSONL Store (gstack Round 11 adapted)
 *
 * .brief2dev/learnings.jsonl append-only 학습 이력 저장소.
 *
 * Source: oss/gstack (scripts/resolvers/learnings.ts, bin/gstack-learnings-log, bin/gstack-learnings-search)
 * Adaptation: adapted — bun 인라인 JS → Node.js ESM, gstack-slug 제거 (단일 프로젝트),
 *   ~/.gstack/projects/$SLUG/ → .brief2dev/ 경로, cross-project 제거.
 *
 * Schema (JSONL line):
 *   { ts, skill, type, key, insight, confidence, source, trusted, branch?, commit?, files[] }
 *
 * Types: pattern | pitfall | preference | architecture | tool | operational
 * Sources: observed | user-stated | inferred | cross-model
 * Confidence: 1-10 (integer)
 *   - observed + 검증 = 8-9
 *   - user-stated = 10 (유저 선언)
 *   - inferred = 4-5
 * Trust: source === 'user-stated' → trusted=true (cross-project 허용용 유지)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveSystemFile } from './layout-resolver.mjs';

export const VALID_TYPES = ['pattern', 'pitfall', 'preference', 'architecture', 'tool', 'operational'];
export const VALID_SOURCES = ['observed', 'user-stated', 'inferred', 'cross-model'];
export const KEY_RE = /^[a-zA-Z0-9_-]+$/;

// 정확도 자동 검증 (R-CM-020 Rule 3 보강): 코드 관련 learning(pattern/architecture/tool)이
// observed 인데 files[] 검증 증거가 없으면 effective_confidence 상한을 6 으로 제한한다
// (R-CM-020 Rule 3 "observed 단일 관찰" 수준). operational/preference/pitfall 은 files 무관이라 면제.
// stored confidence 는 불변 — 자기신고 투명성 유지, 주입에 쓰이는 effective 만 자동 보정.
export const CODE_RELATED_TYPES = new Set(['pattern', 'architecture', 'tool']);
export const UNVERIFIED_OBSERVED_CAP = 6;

// P18 (2026-04-27): export로 격상 — audit-learnings-injection.mjs 가 import 사용.
// P22-A (2026-04-27): 4 패턴 추가 (10 → 14). ASCII Tag smuggling + BIDI override +
//   Anthropic chat template 흉내 + developer mode jailbreak.
// R-CM-020 Rule 4 Enforced 메커니즘. logLearning() write-time 강제 + audit-learnings-injection.mjs 회귀 검증.
export const INJECTION_PATTERNS = [
  // 직접 명령어 우회 (P18 baseline 10)
  /ignore\s+(all\s+)?previous\s+(instructions|context|rules)/i,
  /you\s+are\s+now\s+/i,
  /new\s+(task|role|persona):/i,
  /system\s*:\s*you/i,
  /<\|im_start\|>/,
  /\[INST\]/,
  /forget\s+(everything|all)/i,
  /disregard\s+(the\s+)?(above|previous)/i,
  /act\s+as\s+(a\s+)?(different|new)/i,
  /override\s+(instructions|rules|system)/i,
  // P22-A 추가 (4)
  // ASCII smuggling — Unicode Tag chars (U+E0000~U+E007F).
  // 평문 사이에 invisible Tag char 로 숨겨진 명령어를 인코딩하는 기법.
  // legit 사용 사례 거의 없음 (이모지 깃발 시퀀스 일부 예외이나 learnings entry 에 부적합).
  /[\u{E0000}-\u{E007F}]/u,
  // BIDI override — U+202D (LRO), U+202E (RLO).
  // 시각적 텍스트 순서를 뒤집어 사용자 인지 우회. CVE-2021-42574 (Trojan Source) 동치 기법.
  /[‭‮]/,
  // Anthropic / OpenAI chat template 흉내. <|im_start|> 외의 변형.
  /<\|(system|human|assistant|user)\|>/i,
  // Jailbreak — developer mode / DAN 표현.
  // 평문에 우연히 포함되는 case 회피: "enabled|on|activated" 동사 결합 형태만 차단.
  /\bdeveloper\s+mode\s+(enabled|on|activated)\b/i,
];

export function findInjectionMatch(text) {
  if (typeof text !== 'string') return null;
  for (const pat of INJECTION_PATTERNS) {
    const m = pat.exec(text);
    if (m) return { pattern: pat.toString(), matched: m[0] };
  }
  return null;
}

/**
 * 모든 INJECTION_PATTERNS 매치를 반환한다 (SSOT 통합용).
 *
 * R-CM-020 Rule 4 의 14 패턴이 learnings 외 영역(handoff-consistency-guard 등)에서도
 * 동일하게 적용되도록 학습소스 단일 진입점. 기존 findInjectionMatch 는 첫 매치만 반환하므로
 * 다중 위협 감지에는 부족.
 *
 * @param {string} text - 검사 대상 문자열
 * @returns {{ index: number, pattern: string, matched: string }[]} 매치된 패턴 목록
 */
export function findAllInjectionMatches(text) {
  if (typeof text !== 'string') return [];
  const results = [];
  for (let i = 0; i < INJECTION_PATTERNS.length; i++) {
    const pat = INJECTION_PATTERNS[i];
    const m = pat.exec(text);
    if (m) results.push({ index: i, pattern: pat.toString(), matched: m[0] });
  }
  return results;
}

/**
 * learnings.jsonl 파일 경로 (R-CM-026 layout SSOT, system 카테고리).
 *
 * R-CM-030 worktree 통일: projectDir 미명시 시 system_persistent root
 * (git common-dir 의 부모) 를 사용하여 모든 worktree 가 동일한 learnings 파일을
 * 공유한다. projectDir 명시는 테스트 격리용 (sandbox).
 *
 *   - projectDir 명시 → <projectDir>/.brief2dev/system/learnings.jsonl
 *   - projectDir 미명시 → resolveSystemFile 이 system_persistent root 자동 해결
 *
 * @param {string} [projectDir]
 * @returns {string}
 */
export function learningsPath(projectDir) {
  return resolveSystemFile('learnings.jsonl', projectDir);
}

function validate(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('entry must be an object');
  }
  if (!VALID_TYPES.includes(entry.type)) {
    throw new Error(`invalid type: ${entry.type}. valid: ${VALID_TYPES.join(', ')}`);
  }
  if (typeof entry.key !== 'string' || !KEY_RE.test(entry.key)) {
    throw new Error(`invalid key: must match ${KEY_RE}`);
  }
  if (typeof entry.insight !== 'string' || entry.insight.length === 0) {
    throw new Error('insight must be non-empty string');
  }
  const conf = Number(entry.confidence);
  if (!Number.isInteger(conf) || conf < 1 || conf > 10) {
    throw new Error('confidence must be integer 1-10');
  }
  if (!VALID_SOURCES.includes(entry.source)) {
    throw new Error(`invalid source: ${entry.source}. valid: ${VALID_SOURCES.join(', ')}`);
  }
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(entry.insight)) {
      throw new Error(`insight rejected by anti-injection filter: ${pat}`);
    }
  }
}

export function logLearning(projectDir, entry) {
  validate(entry);
  const now = new Date().toISOString();
  const record = {
    ts: entry.ts || now,
    skill: entry.skill || 'manual',
    type: entry.type,
    key: entry.key,
    insight: entry.insight,
    confidence: Number(entry.confidence),
    source: entry.source,
    trusted: entry.source === 'user-stated',
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.commit ? { commit: entry.commit } : {}),
    files: Array.isArray(entry.files) ? entry.files : [],
  };
  const path = learningsPath(projectDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n');
  return record;
}

export function readLearnings(projectDir) {
  const path = learningsPath(projectDir);
  if (!existsSync(path)) return [];
  const out = [];
  const raw = readFileSync(path, 'utf-8');
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 손상된 줄은 건너뜀 (append-only 정책상 과거 줄은 수정하지 않음)
    }
  }
  return out;
}

function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / (1000 * 60 * 60 * 24)));
}

export function applyConfidenceDecay(entries, now = Date.now()) {
  return entries.map((e) => {
    let conf = Number(e.confidence) || 0;
    if (e.source === 'observed' || e.source === 'inferred') {
      const days = daysSince(e.ts, now);
      conf = Math.max(0, conf - Math.floor(days / 30));
    }
    // 정확도 자동 검증: 코드 관련 observed learning 이 files[] 증거 없으면 effective 상한 제한.
    // stored confidence 불변 — effective 만 보정 (시간 감쇠와 동일 레이어, 중복 없음).
    if (
      e.source === 'observed' &&
      CODE_RELATED_TYPES.has(e.type) &&
      (!Array.isArray(e.files) || e.files.length === 0)
    ) {
      conf = Math.min(conf, UNVERIFIED_OBSERVED_CAP);
    }
    return { ...e, effective_confidence: conf };
  });
}

export function deduplicate(entries) {
  // 입력 순서대로 latest winner per key+type
  const seen = new Map();
  for (const e of entries) {
    const dk = `${e.key}|${e.type}`;
    const prev = seen.get(dk);
    if (!prev || Date.parse(e.ts) >= Date.parse(prev.ts)) {
      seen.set(dk, e);
    }
  }
  return Array.from(seen.values());
}

export function searchLearnings(projectDir, opts = {}) {
  const {
    type = null,
    query = null,
    limit = 20,
    crossProject = false,
    now = Date.now(),
    minEffectiveConfidence = 0,
  } = opts;

  let entries = readLearnings(projectDir);
  if (crossProject) {
    entries = entries.filter((e) => e.trusted === true);
  }
  if (type) {
    entries = entries.filter((e) => e.type === type);
  }
  if (query) {
    const q = String(query).toLowerCase();
    entries = entries.filter(
      (e) =>
        String(e.key || '').toLowerCase().includes(q) ||
        String(e.insight || '').toLowerCase().includes(q),
    );
  }

  entries = applyConfidenceDecay(entries, now);
  entries = deduplicate(entries);

  if (minEffectiveConfidence > 0) {
    entries = entries.filter(
      (e) => Number(e.effective_confidence ?? e.confidence) >= minEffectiveConfidence,
    );
  }

  entries.sort((a, b) => {
    const ca = Number(a.effective_confidence ?? a.confidence) || 0;
    const cb = Number(b.effective_confidence ?? b.confidence) || 0;
    if (cb !== ca) return cb - ca;
    return Date.parse(b.ts) - Date.parse(a.ts);
  });

  return entries.slice(0, limit);
}

export function formatForContext(entries) {
  if (entries.length === 0) return '';
  const counts = {};
  for (const e of entries) counts[e.type] = (counts[e.type] || 0) + 1;
  const summary = Object.entries(counts)
    .map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`)
    .join(', ');

  const grouped = {};
  for (const e of entries) {
    (grouped[e.type] = grouped[e.type] || []).push(e);
  }

  const lines = [`LEARNINGS: ${entries.length} loaded (${summary})`, ''];
  for (const t of VALID_TYPES) {
    const group = grouped[t];
    if (!group || group.length === 0) continue;
    lines.push(`## ${t}`);
    for (const e of group) {
      const conf = e.effective_confidence ?? e.confidence;
      lines.push(`- [${e.key}] (confidence=${conf}, source=${e.source}) ${e.insight}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// ─────────────────────────────────────────────
// CLI (optional): node learnings.mjs log|search ...
// ─────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[k] = next;
        i++;
      } else {
        args[k] = true;
      }
    }
  }
  return args;
}

async function cliMain() {
  const [, , sub, ...rest] = process.argv;
  const args = parseArgs(rest);
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (sub === 'log') {
    const entry = {
      type: args.type,
      key: args.key,
      insight: args.insight,
      confidence: args.confidence ? Number(args.confidence) : undefined,
      source: args.source,
      skill: args.skill,
      files: args.files ? String(args.files).split(',').filter(Boolean) : [],
    };
    const rec = logLearning(projectDir, entry);
    process.stdout.write(`LEARNING_LOGGED: ${rec.key} (${rec.type}, confidence=${rec.confidence}, source=${rec.source})\n`);
    return;
  }

  if (sub === 'search') {
    const entries = searchLearnings(projectDir, {
      type: args.type || null,
      query: args.query || null,
      limit: args.limit ? Number(args.limit) : 20,
      crossProject: !!args['cross-project'],
      minEffectiveConfidence: args['min-effective-confidence']
        ? Number(args['min-effective-confidence'])
        : 0,
    });
    process.stdout.write(formatForContext(entries) + '\n');
    return;
  }

  process.stderr.write('Usage:\n');
  process.stderr.write('  node learnings.mjs log --type TYPE --key KEY --insight TEXT --confidence N --source SOURCE [--skill S] [--files f1,f2]\n');
  process.stderr.write('  node learnings.mjs search [--type TYPE] [--query Q] [--limit N] [--min-effective-confidence N]\n');
  process.exit(1);
}

// 이 파일이 직접 실행될 때만 CLI 실행. import된 경우 라이브러리로만 사용.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  cliMain().catch((err) => {
    process.stderr.write(`ERROR: ${err.message || err}\n`);
    process.exit(2);
  });
}
