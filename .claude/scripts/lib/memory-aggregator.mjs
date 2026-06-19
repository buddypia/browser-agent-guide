/**
 * memory-aggregator.mjs — Loom 'AI Memory' 탭용 read-only 집계기.
 *
 * ai-memory-catalog.json(정적 메타: 어디/어떻게/왜/관련) + 각 메모리 파일의 실제 항목을
 * 결합하여 단일 스냅샷으로 반환한다.
 *
 * R-CM-035 invariant: read-only. 본 모듈은 write/unlink/mkdir 등 mutation 호출을 하지 않는다.
 * 모든 reader 는 projectDir 인자 기반으로 자족하여 전역 PROJECT_DIR 에 비의존한다
 * (테스트 격리 가능). 파일/디렉토리 부재 시 fail-open(빈 배열).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSystemFile,
  resolveSessionHistoryDir,
  resolveGovernanceDir,
} from './layout-resolver.mjs';
import { readLearnings, applyConfidenceDecay } from './learnings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, '..', '..', '..', 'data', 'registry', 'ai-memory-catalog.json');

const DAY_MS = 86_400_000;

function loadCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
}

function ageDays(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / DAY_MS));
}

function safeReadJson(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function safeListJson(dir) {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

// --- per-type item readers (각각 fail-open, projectDir 자족) ---

function readLearningsItems(projectDir, now) {
  let entries = [];
  try {
    entries = applyConfidenceDecay(readLearnings(projectDir) || [], now);
  } catch {
    entries = [];
  }
  return entries.map((e) => ({
    id: e.key,
    title: e.key,
    summary: e.insight || '',
    attributes: {
      type: e.type,
      source: e.source,
      skill: e.skill || null,
      files: Array.isArray(e.files) ? e.files.length : 0,
    },
    confidence: e.confidence ?? null,
    effective_confidence: e.effective_confidence ?? e.confidence ?? null,
    age_days: ageDays(e.ts, now),
  }));
}

function readPipelineMemoryItems(projectDir, now) {
  // loadMemory() 는 getMemoryPath(_projectDir) 가 인자를 무시하고 전역 PROJECT_DIR 을 쓰므로
  // (테스트 격리 불가) resolveSystemFile 로 직접 읽는다.
  const mem = safeReadJson(resolveSystemFile('pipeline-memory.json', projectDir));
  const facts = (mem && Array.isArray(mem.facts) ? mem.facts : []).filter((f) => !f.superseded_by);
  return facts.map((f) => ({
    id: f.id,
    title: (f.content || f.id || '').slice(0, 80),
    summary: f.content || '',
    attributes: {
      category: f.category,
      source_skill: f.source_skill || null,
      source_stage: f.source_stage ?? null,
      access_count: f.access_count ?? 0,
    },
    confidence: typeof f.confidence === 'number' ? f.confidence : null,
    age_days: ageDays(f.created_at, now),
  }));
}

// idea-memory(run_scoped)는 active run 일 때만 노출. active.json 의 run_id 해결 후
// .brief2dev/runs/<run_id>/idea-memory.json 직접 읽기 (projectDir 자족 — readActiveRunItems 와
// 동일 패턴, 전역 PROJECT_DIR 비의존으로 테스트 격리). idle(run 없음) 시 빈 배열 →
// Loom 스냅샷에서 count=0. injector(pipeline-memory-injector)와 동일하게 source_run_id 격리.
function readIdeaMemoryItems(projectDir, now) {
  // worktree-local active-run, projectDir 직접 join 으로 테스트 격리 (getActiveRunId 는 전역 PROJECT_DIR 의존, read-only)
  // audit-layout-hardcode 마커는 같은 라인 끝만 인식하므로 각 join 라인에 명시 (#623 마커 위치 정정).
  const active = safeReadJson(join(projectDir, '.brief2dev', 'run', 'active.json')); // @layout-resolver-allow
  const runId = active && active.run_id;
  // run_id 가 non-empty string 일 때만 노출 (빈 문자열/0 이 경로에 새는 것 차단). idle 도 빈 배열.
  if (typeof runId !== 'string' || runId.length === 0 || active.status === 'idle') return [];
  const mem = safeReadJson(join(projectDir, '.brief2dev', 'runs', runId, 'idea-memory.json')); // @layout-resolver-allow
  // superseded_by 조기 제외 — injector 는 selectFactsForInjection 에서 후처리, 여기선 Loom 표시
  // 레벨에서 선제 제외 (의도적 위치 차이, 중복 방어). source_run_id 격리는 injector 와 동일.
  const facts = (mem && Array.isArray(mem.facts) ? mem.facts : []).filter(
    (f) => !f.superseded_by && (!f.source_run_id || f.source_run_id === runId),
  );
  return facts.map((f) => ({
    id: f.id,
    title: (f.content || f.id || '').slice(0, 80),
    summary: f.content || '',
    attributes: {
      category: f.category,
      source_run_id: f.source_run_id || runId,
      access_count: f.access_count ?? 0,
    },
    confidence: typeof f.confidence === 'number' ? f.confidence : null,
    age_days: ageDays(f.created_at, now),
  }));
}

// ISO ended_at → "2026-05-30 18:38 세션" (TZ 무관 — ISO 문자열 slice). 파싱 실패 시 파일명.
function formatSessionTitle(iso, fn) {
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) {
    return `${iso.slice(0, 16).replace('T', ' ')} 세션`;
  }
  return fn.replace(/\.json$/, '');
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// session-history 원시 JSON → 정규화 필드 (복잡도 분리).
// 비용(cost_summary)은 읽지 않는다 — cost-tracker dead hook 제거로 더 이상 기록되지 않는다
// (사용자 결정 2026-06-01: dead source 제거. 네이티브 /cost 와 중복이라 관점 1 미유지).
function sessionFields(s) {
  const ps = s.pipeline_state && typeof s.pipeline_state === 'object' ? s.pipeline_state : {};
  return {
    ps,
    status: ps.status || 'idle',
    patterns: arr(s.detected_patterns),
    stagesDone: arr(ps.stages_completed),
    ctx: String(s.session_context || s.transcript_summary || '').trim(),
  };
}

// 정규화 필드 → detail 행 배열 (UI 가 humanize 공통 로직으로 렌더; 배열 값은 리스트).
// 파이프라인 진행(current_stage 또는 완료 단계)이 없는 idle 세션은 '파이프라인' 행을 생략해
// 빈 스냅샷 노이즈를 줄인다 — 패턴/메모가 모두 없으면 detail 은 빈 배열(블록 미표시).
function buildSessionDetail(f) {
  const hasProgress = Boolean(f.ps.current_stage) || f.stagesDone.length > 0;
  const pipeLine = hasProgress
    ? [f.status, f.ps.current_stage, f.stagesDone.length ? `완료 ${f.stagesDone.length}단계` : null]
        .filter(Boolean)
        .join(' · ')
    : '';
  return [
    pipeLine && { label: '파이프라인', value: pipeLine },
    f.patterns.length && { label: '감지 패턴', value: f.patterns },
    f.ctx && { label: '세션 메모', value: f.ctx },
  ].filter(Boolean);
}

function buildSessionItem(fn, s, now) {
  const f = sessionFields(s);
  // 비용 제거 + 0 값 항목 생략 — idle 빈 세션은 "상태 idle" 만 (노이즈 최소화).
  const summary = [
    `상태 ${f.status}`,
    f.patterns.length ? `패턴 ${f.patterns.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: fn,
    title: formatSessionTitle(s.ended_at, fn),
    summary,
    attributes: {
      session_id: s.session_id ? String(s.session_id).slice(0, 8) : null,
      status: f.status,
    },
    detail: buildSessionDetail(f),
    age_days: ageDays(s.ended_at, now),
  };
}

function readSessionHistoryItems(projectDir, now) {
  const dir = resolveSessionHistoryDir(projectDir);
  return safeListJson(dir).map((fn) => buildSessionItem(fn, safeReadJson(join(dir, fn)) || {}, now));
}

// files[] 중 count 최대 항목 (없으면 null). 복잡도 분리.
function pickTopFile(files) {
  let top = null;
  for (const f of files) {
    if (f && typeof f === 'object' && typeof f.count === 'number') {
      if (!top || f.count > top.count) top = f;
    }
  }
  return top;
}

// 후보 1건 → "repeated-fix — 9개 파일 (최다 oss-transplant-phase-gate.mjs 35회)"
function describeCandidate(c) {
  if (!c || typeof c !== 'object') return String(c ?? '');
  const files = arr(c.files);
  const name = c.pattern || c.name || '(이름 없음)';
  if (!files.length) return name;
  const top = pickTopFile(files);
  const topName = top && top.file ? String(top.file).split('/').pop() : null;
  return `${name} — ${files.length}개 파일${topName ? ` (최다 ${topName} ${top.count}회)` : ''}`;
}

// wisdom-candidate 의 title/summary 산출. 복잡도 분리.
function wisdomHeadline(w, candidates, fn) {
  const names = candidates.map((c) => c && (c.pattern || c.name)).filter(Boolean);
  const title = names.length
    ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` 외 ${names.length - 3}종` : ''}`
    : w.pattern || fn.replace(/\.json$/, '');
  const meta = [w.source && `출처 ${w.source}`, w.status].filter(Boolean).join(' · ');
  const summary = candidates.length
    ? `${candidates.length}종 패턴 후보${meta ? ` · ${meta}` : ''}`
    : w.note || w.pattern || '';
  return { title, summary };
}

// wisdom-candidate 파일 1개 → 가독성 항목. 실제 구조: { generated_at, source, status, note, candidates[] }
// (candidates[] = { pattern, files[]{file,count} }). 이전엔 top-level w.pattern 만 봐서 빈 값이 났다.
function buildWisdomItem(fn, w, now) {
  const candidates = arr(w.candidates);
  const { title, summary } = wisdomHeadline(w, candidates, fn);
  const detail = [
    w.note && { label: '안내', value: String(w.note) },
    candidates.length && { label: '패턴 후보', value: candidates.map(describeCandidate) },
  ].filter(Boolean);
  return {
    id: fn,
    title,
    summary,
    attributes: {
      source: w.source || null,
      status: w.status || null,
      candidates: candidates.length || null,
    },
    detail,
    confidence: typeof w.confidence === 'number' ? w.confidence : null,
    age_days: ageDays(w.generated_at || w.promoted_at, now),
  };
}

function readWisdomCandidateItems(projectDir, now) {
  const dir = resolveGovernanceDir('wisdom-candidates', projectDir);
  return safeListJson(dir).map((fn) => buildWisdomItem(fn, safeReadJson(join(dir, fn)) || {}, now));
}

function readFollowupDebtItems(projectDir, now) {
  const data = safeReadJson(resolveSystemFile('followup-debt.json', projectDir)) || {};
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((d) => ({
    id: d.id,
    title: (d.description || d.id || '').slice(0, 80),
    summary: d.description || '',
    attributes: {
      category: d.category || null,
      severity: d.severity || null,
      source_pr: d.source_pr ?? null,
      status: d.status || 'open',
    },
    age_days: ageDays(d.added_at, now),
  }));
}

function formatLock(lock) {
  if (lock && typeof lock === 'object') {
    // raw JSON 대신 "key=value · key=value" 가독 포맷 (사람이 읽게 — code-reviewer MEDIUM).
    const parts = Object.entries(lock)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`);
    return parts.length ? parts.join(' · ') : null;
  }
  return lock ?? null;
}

function readTaskPassportItems(projectDir, now) {
  const p = safeReadJson(resolveSystemFile('current-task-passport.json', projectDir));
  if (!p) return [];
  const obj = p.active_objective || {};
  const sha = obj.sha256 || p.objective_sha256 || '';
  return [
    {
      id: 'current',
      title: '현재 작업 Passport',
      summary: obj.excerpt || p.objective_excerpt || '',
      attributes: {
        project_role: p.project_role || null,
        current_lock: formatLock(p.current_lock),
        objective_sha256: sha ? String(sha).slice(0, 12) : null,
      },
      age_days: ageDays(p.generated_at, now),
    },
  ];
}

function readActiveRunItems(projectDir, now) {
  // active.json 은 run_worktree_local (R-CM-028 데이터 분리). projectDir 직접 join.
  const a = safeReadJson(join(projectDir, '.brief2dev', 'run', 'active.json')); // @layout-resolver-allow — worktree-local active-run, projectDir 직접 join 으로 테스트 격리 (getActiveRunPath 는 전역 PROJECT_DIR 의존, read-only)
  if (!a) return [];
  return [
    {
      id: 'active',
      title: `Saga: ${a.status || 'idle'}`,
      summary: `stage=${a.stage || a.current_stage || 'none'} · skill=${a.skill || a.current_skill || 'none'}`,
      attributes: {
        status: a.status || 'idle',
        run_id: a.run_id || null,
        updated_at: a.updated_at || null,
      },
      age_days: ageDays(a.updated_at, now),
    },
  ];
}

const READERS = {
  learnings: readLearningsItems,
  'pipeline-memory': readPipelineMemoryItems,
  'idea-memory': readIdeaMemoryItems,
  'session-history': readSessionHistoryItems,
  'wisdom-candidates': readWisdomCandidateItems,
  'followup-debt': readFollowupDebtItems,
  'task-passport': readTaskPassportItems,
  'active-run': readActiveRunItems,
};

/**
 * 8종 메모리의 read-only 스냅샷을 반환한다.
 * @param {string} projectDir - 프로젝트 루트 (Loom 서버는 main root 전달).
 * @param {number} [now] - 기준 시각 ms (테스트 결정성용; 기본 Date.now()).
 * @returns {{version:string, generated_at:string, types:Array}}
 */
export function readMemorySnapshot(projectDir, now = Date.now()) {
  const catalog = loadCatalog();
  const types = catalog.memory_types.map((meta) => {
    const reader = READERS[meta.id];
    let items = [];
    if (reader) {
      try {
        items = reader(projectDir, now);
      } catch {
        items = [];
      }
    }
    return {
      id: meta.id,
      label: meta.label,
      memory_class: meta.memory_class || 'cognitive',
      file: meta.file,
      lifecycle: meta.lifecycle,
      boundary: meta.boundary,
      why: meta.why,
      injection_kind: meta.injection_kind || null,
      injection_summary: meta.injection_summary || null,
      solves: meta.solves || null,
      injected_at: meta.injected_at || [],
      persisted_by: meta.persisted_by || [],
      consumed_by: meta.consumed_by || [],
      related: meta.related || [],
      delete_policy: meta.delete_policy,
      delete_engine: meta.delete_engine || null,
      delete_reason: meta.delete_reason || null,
      metrics: meta.metrics || [],
      count: items.length,
      items,
    };
  });
  return { version: catalog.version, generated_at: new Date(now).toISOString(), types };
}

// CLI 직접 실행 — 디버깅용 JSON 출력
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || join(__dirname, '..', '..', '..');
  process.stdout.write(JSON.stringify(readMemorySnapshot(projectDir), null, 2) + '\n');
}
