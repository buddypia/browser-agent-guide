#!/usr/bin/env node

/**
 * lint-skill-portability.mjs — SKILL.md 의 CLI-portability 결정론적 감사 (머신 가드)
 *
 * Agent Skills 는 오픈 표준이라 SKILL.md 본문은 이미 portable. "똑같은 수준"을 깨는 것은
 * 본문이 (a) Claude 전용 tool/빌트인을 *유일 경로*로 지시(=portability-blocker, fixable),
 * 또는 (b) brief2dev Claude-Code 런타임(hooks/Saga/gate)에 의존(=runtime-coupling-signal,
 * 런타임 포팅 필요)하는 것뿐이다. 본 린터가 두 부류를 정규식으로 검출한다.
 *
 * 룰 출처: skills-portability-audit (16-agent 워크플로 → 12 룰). SSOT: ../references/cross-cli-skill-mapping.md §6-7.
 * durability: 신규/수정 스킬이 Claude 전용 가정을 추가하면 즉시 가시화 → CI/pre-commit 연동 가능.
 *
 * Usage:
 *   node lint-skill-portability.mjs --all [--json]        # 전 스킬 전수 감사
 *   node lint-skill-portability.mjs --skill <name> [--json]
 *   node lint-skill-portability.mjs --file <path/SKILL.md> [--json]
 *   --strict : blocker(fixable) 1+ 검출 시 exit 1 (runtime-signal 은 경고만)
 *
 * 분류:
 *   portable        : blocker 0 + runtime-signal 0
 *   fixable         : blocker 1+ (CLI-agnostic 대안으로 수정 가능 — ../references/cross-cli-skill-mapping.md §6)
 *   runtime-coupled : runtime-signal 1+ (blocker 유무 무관. 런타임 포팅 필요 — §7)
 *
 * Boundary: 관점 1 (brief2dev 자체) 전용 — R-CM-028.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** type: 'blocker' (Claude 전용 — fixable) | 'runtime' (brief2dev 런타임 결합) */
const RULES = [
  { id: 'SKILL-PORT-001-askuserquestion', type: 'blocker', re: /\bAskUserQuestion\b/, msg: 'AskUserQuestion 은 Claude 전용 tool. 의도(사용자 선택 질문) 기술 + per-CLI 분기(Codex: Decision Exchange / BRIEF2DEV_DECISION_MODE=file)' },
  { id: 'SKILL-PORT-002-task-tool', type: 'blocker', re: /\bTask\s*(?:도구|tool)\b|subagent_type\s*[:=]|\bmodel\s*:\s*(?:sonnet|opus|haiku)\b/, msg: 'Task tool / 모델 라우팅은 Claude 전용. LLMInvoke 추상화 + per-CLI 매핑, 또는 skip-and-record graceful degrade' },
  { id: 'SKILL-PORT-003-agent-call', type: 'blocker', re: /\bAgent\s*\(\s*subagent_type/, msg: 'Agent(subagent_type) 는 Claude 전용 dispatch. 역할 문자열 + per-CLI 서브에이전트 매핑, 비-Claude 는 fallback' },
  { id: 'SKILL-PORT-004-webfetch', type: 'blocker', re: /\bWebFetch\b/, msg: 'WebFetch 는 Claude 전용. WebSearch/curl wrapper + 비-Claude fallback' },
  { id: 'SKILL-PORT-005-builtin-slash', type: 'blocker', re: /(?:^|[^\w/])\/(?:code-review|simplify|create-pr|deep-research)\b/, msg: 'Claude 빌트인 슬래시 명령을 유일 경로로 지시. CLI 분기(Codex: codex review / pre-quality-gate Bash fallback). R-CM-030 의 CLI-agnostic verdict 참조' },
  { id: 'SKILL-PORT-006-brief2dev-runtime-path', type: 'runtime', re: /\.brief2dev\/|\bactive-run\.json\b|\bpipeline-progress\.json\b|\bpipeline-memory\.json\b|\bsaga-manager\b|\blearnings\.jsonl\b/, msg: 'brief2dev 런타임 상태(.brief2dev/Saga) 의존 — Claude-Code 런타임에서만 강제. 런타임 포팅 필요' },
  { id: 'SKILL-PORT-007-hook-dependency', type: 'runtime', re: /\bPreToolUse\b|\bPostToolUse\b|[a-z-]+-guard\b|\.codex\/hooks\.json\b|\bskill-structure-check\b/, msg: 'hook 자동 강제 의존. hooks 는 CLI별 등록 필요(multi-cli-hooks 영역)' },
  { id: 'SKILL-PORT-008-pipeline-gate', type: 'runtime', re: /\bpipeline-boundary-guard\b|\bpipeline-validator\b|\bpipeline-drift-guard\b|\boutput-gate\b|\bEvidence Gate\b|\b_esp-whitelist\b/, msg: '파이프라인 게이트/검증 의존 — brief2dev 강제 메커니즘' },
  { id: 'SKILL-PORT-009-deep-research-binding', type: 'runtime', re: /\bdeep_research_sessions\b|\bBRIEF2DEV_DEEP_RESEARCH\b/, msg: 'deep-research 바인딩(brief2dev 세션 영속) 의존' },
  { id: 'SKILL-PORT-010-mcp-required', type: 'runtime', re: /\bget_design_context\b|\bcodex mcp add\b|MCP server (?:setup|required)/, msg: 'MCP 서버 필수 — CLI별 MCP 설정 필요' },
  { id: 'SKILL-PORT-011-worktree-lifecycle', type: 'runtime', re: /\.worktrees\/|\bgit worktree\b|\bcommon-dir\b/, msg: 'worktree lifecycle 의존(git common-dir 가정) — 격리 workspace 추상화 필요' },
  { id: 'SKILL-PORT-012-governance-policy-ref', type: 'runtime', re: /\bconfidence_ratchet\b|\barchive-index\b|\bR-CM-0(?:14|27|32)\b/, msg: 'brief2dev 거버넌스 정책 의존(archive/ratchet) — multi-idea lifecycle 가정' },
];

function parseArgs(argv) {
  const a = { json: false, strict: false, all: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--strict') a.strict = true;
    else if (k === '--all') a.all = true;
    else if (k === '--skill') a.skill = argv[++i];
    else if (k === '--file') a.file = argv[++i];
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function repoRoot() {
  try { return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim(); }
  catch { return join(SCRIPT_DIR, '..', '..', '..', '..'); }
}

/** SKILL.md body(프론트matter 제외)를 라인별로 룰 매칭. frontmatter 의 description 은 제외(트리거 키워드 오탐 회피). */
function lintFile(path) {
  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n'); // CRLF 정규화 (frontmatter strip + 라인번호 정확성)
  // strip frontmatter (--- ... ---)
  let body = raw;
  const fm = raw.match(/^---\n[\s\S]*?\n---\n/);
  const fmLines = fm ? fm[0].split('\n').length - 1 : 0;
  if (fm) body = raw.slice(fm[0].length);
  const lines = body.split('\n');
  const findings = [];
  lines.forEach((line, idx) => {
    // 코드펜스/인용 안의 부정 예시도 매칭하나, 린터는 surface 가 목적이라 허용(검토 유도).
    for (const r of RULES) {
      if (r.re.test(line)) findings.push({ rule: r.id, type: r.type, line: idx + 1 + fmLines, text: line.trim().slice(0, 100), msg: r.msg });
    }
  });
  const blockers = findings.filter((f) => f.type === 'blocker');
  const runtime = findings.filter((f) => f.type === 'runtime');
  const classification = runtime.length ? 'runtime-coupled' : (blockers.length ? 'fixable' : 'portable');
  return { findings, blockers: blockers.length, runtime: runtime.length, classification };
}

function listSkills(root) {
  const dir = join(root, '.claude', 'skills');
  return readdirSync(dir)
    .filter((n) => { try { return statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'SKILL.md')); } catch { return false; } })
    .sort();
}

function resolveTargets(args, root) {
  if (args.file) { const abs = resolve(args.file); return [{ name: basename(dirname(abs)), path: abs }]; }
  if (args.skill) return [{ name: args.skill, path: join(root, '.claude', 'skills', args.skill, 'SKILL.md') }];
  if (args.all) return listSkills(root).map((s) => ({ name: s, path: join(root, '.claude', 'skills', s, 'SKILL.md') }));
  return null;
}

function printHuman(results, counts) {
  process.stdout.write(`\n[skill-portability] ${results.length} skills | portable=${counts.portable} fixable=${counts.fixable} runtime-coupled=${counts['runtime-coupled']}\n\n`);
  for (const r of results) {
    if (r.classification === 'portable') continue;
    process.stdout.write(`■ ${r.name} [${r.classification}] blockers=${r.blockers} runtime=${r.runtime}\n`);
    for (const f of (r.findings || [])) process.stdout.write(`    ${f.type === 'blocker' ? '✗' : '~'} L${f.line} ${f.rule}: ${f.text}\n`);
  }
  process.stdout.write(`\nportable(${counts.portable}): 생략 (blocker/signal 0)\n`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('Usage: node lint-skill-portability.mjs (--all | --skill <name> | --file <path>) [--json] [--strict]\n');
    process.exit(0);
  }
  const root = repoRoot();
  const targets = resolveTargets(args, root);
  if (!targets) { process.stderr.write('--all | --skill | --file 중 하나 필요\n'); process.exit(1); }

  const results = targets.map((t) => (existsSync(t.path)
    ? { name: t.name, ...lintFile(t.path) }
    : { name: t.name, error: 'SKILL.md 부재', classification: 'unknown', blockers: 0, runtime: 0, findings: [] }));

  const counts = { portable: 0, fixable: 0, 'runtime-coupled': 0, unknown: 0 };
  for (const r of results) counts[r.classification] = (counts[r.classification] || 0) + 1;

  if (args.json) process.stdout.write(`${JSON.stringify({ counts, total: results.length, results }, null, 2)}\n`);
  else printHuman(results, counts);

  const totalBlockers = results.reduce((s, r) => s + (r.blockers || 0), 0);
  process.exit(args.strict && totalBlockers > 0 ? 1 : 0);
}

main();
