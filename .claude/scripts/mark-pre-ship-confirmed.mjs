#!/usr/bin/env node

/**
 * mark-pre-ship-confirmed.mjs — Pre-Ship Review Panel 컨펌 마커 생성 CLI
 *
 * Why (R-CM-029 Rule 3.1 Proposal-stage 의무):
 *   (a) 위협: pre-ship-review-guard 의 deny 메시지가 절대 경로 substring 으로
 *       `mkdir -p /abs/main/.tmp && touch /abs/main/.tmp/pre-ship-review-confirmed-<key>`
 *       를 제시하면 AI 가 worktree cwd 에서 동작 중일 때 (1) 경로 truncation 또는
 *       (2) 무의식적 상대 경로 단축으로 wrong `.tmp/` (worktree-local) 에 마커
 *       생성 후 hook 이 부재 판정 → 무한 deny loop 위험.
 *   (b) 기존 갭: deny 메시지는 cwd-agnostic 절대 경로 substring 만 제공. AI 가
 *       cwd 컨텍스트 헤맬 때 안전망 부재.
 *   (c) 더 단순한 대안 비교: 절대 경로 substring 유지 (현행) 도 정상 동작하지만
 *       multi-worktree 환경에서 AI 인지 부담 비대칭적으로 큼. CLI 한 줄은
 *       cwd 어디서 호출돼도 동일 결과 보장 → AI 컨텍스트 헤맴 차단.
 *
 * Usage:
 *   node .claude/scripts/mark-pre-ship-confirmed.mjs <branch-or-worktree-path>
 *   node /abs/path/.claude/scripts/mark-pre-ship-confirmed.mjs feature/foo
 *   node /abs/path/.claude/scripts/mark-pre-ship-confirmed.mjs .worktrees/fix__bar
 *   node /abs/path/.claude/scripts/mark-pre-ship-confirmed.mjs --staged    # ship-feature 모드
 *
 * Behavior:
 *   - main project root 를 `git rev-parse --git-common-dir` 의 부모로 자동 resolve.
 *     (어떤 worktree cwd 에서 호출돼도 동일 main root.)
 *   - `<main>/.tmp/pre-ship-review-confirmed-<safeBranchKey>` 마커 생성 (mkdir -p + touch).
 *   - safeBranchKey / inferBranchFromWorktreePath 는 worktree-plan-path.mjs SSOT.
 *   - 결과 경로를 stdout 으로 출력.
 *
 * Exit codes:
 *   0 — 마커 생성 성공
 *   1 — 인자 누락 / git common-dir resolve 실패 / mkdir/touch 실패
 *
 * Boundary (R-CM-028): 관점 1 (brief2dev 자체) 전용. 관점 2 는 pre-ship-review-guard
 * 가 scaffold target 에 미배포 (R-CM-030 Rule 11 boundary-divergent).
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  inferBranchFromWorktreePath,
  preShipMarkerPath,
  resolveWorktreePlanPath,
  safeBranchKey,
} from './lib/worktree-plan-path.mjs';
import { VALID_QUALITY_LABELS } from './lib/quality-gate-labels.mjs';
import { parseUnchecked } from './create-pr/ops.mjs';

/**
 * git common-dir 의 부모를 main project root 로 resolve.
 * worktree cwd 든 main cwd 든 동일 root 반환.
 *
 * @param {string} cwd
 * @returns {string|null} 절대 경로 또는 null (git repo 아님)
 */
export function resolveMainRoot(cwd = process.cwd()) {
  try {
    const out = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    if (!out) return null;
    // common-dir 는 main 의 `.git` 디렉토리. parent = main root.
    // Edge case: bare repo / git 루트 자체에서 호출 시 `--git-common-dir` 가 `.`
    // 반환 → abs === cwd → dirname() 은 부모 디렉토리 (잘못된 main root) 반환.
    // 이 때는 cwd 자체가 main root.
    const abs = resolve(cwd, out);
    if (abs === cwd) return cwd;
    return dirname(abs);
  } catch {
    return null;
  }
}

/**
 * 인자에서 branch 명 추출. worktree path / branch / --staged 모두 수용.
 *
 * @param {string} arg
 * @returns {string|null}
 */
export function resolveBranch(arg) {
  if (!arg) return null;
  if (arg === '--staged' || arg === 'staged') return null; // ship-feature mode → safeBranchKey('') = 'staged'
  // worktree path (절대/상대 모두 .worktrees/ 포함) → inferBranchFromWorktreePath
  if (arg.includes('.worktrees/') || arg.includes('.worktrees\\')) {
    return inferBranchFromWorktreePath(arg);
  }
  return arg;
}

/**
 * 마커 파일 경로 산출 — SSOT: worktree-plan-path.mjs#preShipMarkerPath.
 * pre-ship-review-guard.mjs (hook) 와 동일 함수 공유 → marker create/check 정합성.
 */
export const markerPath = preShipMarkerPath;

/**
 * --quality 인자 검증 + 정규화 (trim). enum SSOT: `lib/quality-gate-labels.mjs`.
 *
 * 회고 #1 회귀 차단: marker 파일에 label 영속화 → pre-ship-review-guard 가
 * label 부재/무효 시 deny. silent skip 차단.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} 유효 label 또는 null
 */
export function parseQualityLabel(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return VALID_QUALITY_LABELS.has(trimmed) ? trimmed : null;
}

/**
 * 마커 생성 (mkdir -p + write). `content === ''` 시 기존 시그니처 호환 (empty
 * marker + mtime refresh). `content !== ''` 시 항상 overwrite (label 갱신).
 *
 * @param {string} path
 * @param {string} content
 */
export function createMarker(path, content = '') {
  mkdirSync(dirname(path), { recursive: true });
  if (content === '' && existsSync(path)) {
    const now = new Date();
    utimesSync(path, now, now);
  } else {
    writeFileSync(path, content);
  }
}

/**
 * PLAN.md 미완료 체크박스 사전 검사 — ops.mjs verify-plan 과 같은 SSOT (parseUnchecked) 재사용.
 *
 * Why (R-CM-029 Rule 3 Proposal-stage 의무):
 *   (a) 위협: PR #303 ship 단계에서 PLAN.md `- [ ]` 토글 누락으로 ops.mjs verify-plan
 *       차단 → 1 round-trip 발생. AI 가 verification 통과 → commit → marker 생성 → ship
 *       흐름에서 PLAN.md 토글 단계를 silently SKIP 가능.
 *   (b) 기존 갭: ops.mjs verify-plan 은 ship 호출 시점만 차단. 마커 생성 시점은
 *       검사 부재 → round-trip 발생 후 차단.
 *   (c) 더 단순한 대안: 본 함수가 한 phase 빠른 시점에 차단 + ops.mjs 의 parseUnchecked
 *       재사용으로 SSOT 1개 유지.
 *
 * 정책:
 *   - branch=null (staged 모드) → skip (ship-feature 모드, worktree 부재)
 *   - force=true → skip (의도적 우회, ops.mjs --force-plan 정합)
 *   - worktree path 후보 2개 자동 탐색: slash variant + escape variant
 *   - worktree / PLAN.md 부재 → skip (fail-open)
 *   - 미완료 체크박스 0건 → ok
 *   - 미완료 체크박스 1+건 → fail (unchecked 라인 + planPath 반환)
 *
 * @param {string} mainRoot — main project root 절대 경로
 * @param {string|null} branch — resolveBranch() 결과
 * @param {boolean} force — --force 플래그
 * @returns {{ok: boolean, skipped?: string, unchecked?: string[], planPath?: string}}
 */
export function checkPlanCheckboxes(mainRoot, branch, force) {
  if (!branch) return { ok: true, skipped: 'staged_mode' };
  if (force) return { ok: true, skipped: 'force_flag' };

  // worktree path 후보: slash variant (.worktrees/feature/foo) + escape variant (.worktrees/feature__foo)
  const safeKey = safeBranchKey(branch);
  const candidates = [
    join(mainRoot, '.worktrees', branch),
    join(mainRoot, '.worktrees', safeKey),
  ];
  const wtPath = candidates.find((c) => existsSync(c));
  if (!wtPath) return { ok: true, skipped: 'worktree_absent' };

  const planPath = resolveWorktreePlanPath(wtPath);
  if (!existsSync(planPath)) return { ok: true, skipped: 'plan_absent' };

  // readFileSync fail-open — 인코딩 / symlink / 동시 접근 예외 시 skip (R-CM-006 Rule 2).
  let content;
  try {
    content = readFileSync(planPath, 'utf-8');
  } catch {
    return { ok: true, skipped: 'plan_unreadable' };
  }
  const unchecked = parseUnchecked(content);
  if (unchecked.length === 0) return { ok: true };
  return { ok: false, unchecked, planPath };
}

/**
 * Unknown `--*` flag 검출. 회귀 차단 (본 세션 2026-05-15 10:23 `--worktree` orphan
 * marker): unknown `--<flag>` 가 positional 로 silently 수용되어 branch key `---<flag>`
 * 형태의 무의미한 marker 가 생성된 사례.
 *
 * known flag 정의:
 * - `--force` / `--quality` / `--staged` 만 known (현재 main() 처리 인자)
 * - `--quality` 다음 토큰은 value 로 분류 (parseQualityLabel 이 enum 검증 담당)
 *
 * @param {string[]} args — argv.slice(2)
 * @returns {string|null} 첫 unknown flag (있으면) / null (모두 known)
 */
export function validateUnknownFlags(args) {
  const KNOWN_FLAGS = new Set(['--force', '--quality', '--staged']);
  const qualityIdx = args.indexOf('--quality');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    if (qualityIdx >= 0 && i === qualityIdx + 1) continue; // --quality 의 value 슬롯 skip
    if (!KNOWN_FLAGS.has(a)) return a;
  }
  return null;
}

function main(argv) {
  // --force / --quality <label> 플래그 추출
  const args = argv.slice(2);

  // Unknown flag 검출 — silent positional 수용 차단 (회귀 차단)
  const unknown = validateUnknownFlags(args);
  if (unknown) {
    process.stderr.write(
      `[mark-pre-ship-confirmed] unknown flag: ${unknown}\n` +
        '  known flags: --force / --quality <label> / --staged\n' +
        '  사용법: node mark-pre-ship-confirmed.mjs <branch | worktree-path | --staged> --quality <label> [--force]\n',
    );
    process.exit(1);
  }

  const force = args.includes('--force');
  const qualityIdx = args.indexOf('--quality');
  const qualityRaw = qualityIdx >= 0 ? args[qualityIdx + 1] : null;
  const positional = args.filter(
    (a, i) =>
      a !== '--force' &&
      a !== '--quality' &&
      (qualityIdx < 0 || (i !== qualityIdx && i !== qualityIdx + 1)),
  );
  const arg = positional[0];

  if (!arg) {
    process.stderr.write(
      'Usage: node mark-pre-ship-confirmed.mjs <branch | worktree-path | --staged> --quality <label> [--force]\n',
    );
    process.exit(1);
  }

  // --quality 강제 검증 (회고 #1 회귀 차단 — silent skip 차단)
  const quality = parseQualityLabel(qualityRaw);
  if (!quality) {
    process.stderr.write(
      '[mark-pre-ship-confirmed] --quality <label> 필수.\n' +
        '  label 종류:\n' +
        '    agent_go         : /code-review --fix + code-reviewer agent 둘 다 Go (2026-05-27 — Claude Code 빌트인 /simplify 폐기 + simplifit 스킬 deprecate 후 /code-review 단일 진입점)\n' +
        '    self_review_pass : agent 호출 실패/skip 시 자가 점검 통과 (Panel Decisions 사유 명시)\n' +
        '    trivial_skip     : R-CM-030 Rule 10 trivial 면제 (≤2 파일 + ≤20 LOC + non-substantive)\n',
    );
    process.exit(1);
  }

  const mainRoot = resolveMainRoot();
  if (!mainRoot) {
    process.stderr.write(
      '[mark-pre-ship-confirmed] git common-dir resolve 실패 (git repo 아님?)\n',
    );
    process.exit(1);
  }
  const branch = resolveBranch(arg);

  // PLAN.md 사전 검사 — 미완료 체크박스 발견 시 마커 생성 차단 (round-trip 회피).
  const check = checkPlanCheckboxes(mainRoot, branch, force);
  if (!check.ok) {
    process.stderr.write(
      `[mark-pre-ship-confirmed] PLAN.md 미완료 체크박스 ${check.unchecked.length}건:\n` +
        check.unchecked.map((l) => `  ${l}`).join('\n') +
        `\n\n우회: --force 플래그 또는 항목에 (취소됨) / (dropped) / (deferred) / ~~취소선~~ 마커 추가.\n` +
        `PLAN: ${check.planPath}\n`,
    );
    process.exit(1);
  }

  const path = markerPath(mainRoot, branch);
  const payload = JSON.stringify({
    quality_gate: quality,
    confirmed_at: new Date().toISOString(),
  });
  try {
    createMarker(path, payload);
  } catch (e) {
    process.stderr.write(`[mark-pre-ship-confirmed] 마커 생성 실패: ${e.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${path}\n`);
}

// CLI entry (import 시 미실행)
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
