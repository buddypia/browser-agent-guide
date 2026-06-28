#!/usr/bin/env node

/**
 * mark-worktree-reviewed.mjs — Worktree Review Report (REVIEW.md) scaffold / 검증 / HEAD stamp CLI
 *
 * Why (R-CM-030 Worktree Review Report Gate 보조):
 *   worktree-review-report-guard (Stop hook) 가 검증하는 REVIEW.md 를 AI/사용자가 결정론적으로
 *   생성·갱신하기 위한 단일 진입점. mark-pre-ship-confirmed.mjs 와 동형 — cwd 어디서 호출돼도
 *   git common-dir 로 main root 를 resolve 하여 올바른 worktree 의 `.tmp/` 에 쓴다.
 *
 * Usage:
 *   node .claude/scripts/mark-worktree-reviewed.mjs <branch | worktree-path> [--scaffold]
 *     --scaffold : REVIEW.md 부재 시 11 섹션 승인依頼レビュー 템플릿을 생성 (현재 HEAD 로 stamp). 존재 시 미변경.
 *     (default)  : REVIEW.md 를 검증 + 현재 HEAD 로 stamp 갱신.
 *                  · 미작성 섹션 있으면 exit 1 + 목록 출력
 *                  · 전부 작성됐으면 stamp 갱신 후 exit 0
 *
 * Exit codes:
 *   0 — scaffold 생성 / 검증 통과 (+ stamp 갱신)
 *   1 — 인자 누락 / git resolve 실패 / worktree·REVIEW 부재 / 미작성 섹션
 *
 * Boundary (R-CM-028): 관점 1 (본 transplant) 전용.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inferBranchFromWorktreePath, safeBranchKey } from './lib/worktree-plan-path.mjs';
import {
  HEAD_MARKER_RE,
  REQUIRED_SECTIONS,
  renderTemplate,
  resolveReviewReportPath,
  validateReport,
} from './lib/review-report.mjs';

/** git common-dir 의 부모 = main project root. worktree cwd 든 main cwd 든 동일. */
export function resolveMainRoot(cwd = process.cwd()) {
  try {
    const out = execSync('git rev-parse --git-common-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    if (!out) return null;
    const abs = resolve(cwd, out);
    return abs === cwd ? cwd : dirname(abs);
  } catch {
    return null;
  }
}

export function resolveBranch(arg) {
  if (!arg) return null;
  if (arg.includes('.worktrees/') || arg.includes('.worktrees\\')) {
    return inferBranchFromWorktreePath(arg);
  }
  return arg;
}

/** branch → 실재하는 worktree 경로 (slash variant 우선, escape variant fallback). */
export function resolveWorktreePath(mainRoot, branch) {
  for (const cand of [join(mainRoot, '.worktrees', branch), join(mainRoot, '.worktrees', safeBranchKey(branch))]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** worktree HEAD full sha. 실패 → null. */
export function worktreeHead(worktreePath) {
  try {
    const out = execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return /^[0-9a-f]{7,40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * 본문의 HEAD 앵커를 sha 로 갱신/삽입. 기존 마커 있으면 치환, 없으면 첫 heading 다음 줄에 삽입.
 */
export function stampHead(content, sha) {
  const marker = `<!-- bag-review: head=${sha} -->`;
  if (HEAD_MARKER_RE.test(content)) return content.replace(HEAD_MARKER_RE, marker);
  const lines = content.split('\n');
  const hIdx = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+\S/.test(l));
  if (hIdx === -1) return `${marker}\n\n${content}`;
  lines.splice(hIdx + 1, 0, '', marker);
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const scaffold = args.includes('--scaffold');
  const arg = args.find((a) => !a.startsWith('--'));
  if (!arg) {
    process.stderr.write('Usage: node mark-worktree-reviewed.mjs <branch | worktree-path> [--scaffold]\n');
    process.exit(1);
  }

  const mainRoot = resolveMainRoot();
  if (!mainRoot) {
    process.stderr.write('[mark-worktree-reviewed] git common-dir resolve 실패 (git repo 아님?)\n');
    process.exit(1);
  }

  const branch = resolveBranch(arg);
  const wtPath = resolveWorktreePath(mainRoot, branch);
  if (!wtPath) {
    process.stderr.write(`[mark-worktree-reviewed] worktree 부재: ${branch} (.worktrees/ 하위 없음)\n`);
    process.exit(1);
  }

  const reportPath = resolveReviewReportPath(wtPath, branch);
  const head = worktreeHead(wtPath);

  if (scaffold) {
    if (existsSync(reportPath)) {
      process.stdout.write(`${reportPath}\n(이미 존재 — 미변경)\n`);
      process.exit(0);
    }
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, renderTemplate({ branch, headSha: head }));
    process.stdout.write(`${reportPath}\n(11 섹션 승인依頼レビュー 템플릿 생성 — 각 섹션을 실내용으로 채운 뒤 인자 없이 재실행하여 검증/stamp)\n`);
    process.exit(0);
  }

  if (!existsSync(reportPath)) {
    process.stderr.write(
      `[mark-worktree-reviewed] REVIEW.md 부재: ${reportPath}\n` +
        `  먼저 작성하거나 --scaffold 로 템플릿 생성:\n` +
        `    node .claude/scripts/mark-worktree-reviewed.mjs ${branch} --scaffold\n`,
    );
    process.exit(1);
  }

  let content;
  try {
    content = readFileSync(reportPath, 'utf-8');
  } catch (e) {
    process.stderr.write(`[mark-worktree-reviewed] REVIEW.md 읽기 실패: ${e.message}\n`);
    process.exit(1);
  }

  // 섹션 검증 (stamp 전 — 미작성 섹션은 stamp 해도 hook 이 차단하므로 먼저 거른다)
  const pre = validateReport(content, {});
  if (pre.missing.length) {
    const titles = pre.missing.map((k) => {
      const s = REQUIRED_SECTIONS.find((x) => x.key === k);
      return s ? s.title : k;
    });
    process.stderr.write(
      `[mark-worktree-reviewed] 미작성 섹션 ${pre.missing.length}건: ${titles.join(', ')}\n` +
        `  REVIEW: ${reportPath}\n`,
    );
    process.exit(1);
  }

  // HEAD stamp 갱신 (현재 HEAD 와 일치시켜 staleness 해소)
  if (head) {
    const stamped = stampHead(content, head);
    if (stamped !== content) {
      try {
        writeFileSync(reportPath, stamped);
      } catch (e) {
        process.stderr.write(`[mark-worktree-reviewed] stamp 쓰기 실패: ${e.message}\n`);
        process.exit(1);
      }
    }
  }

  const post = validateReport(head ? stampHead(content, head) : content, { headSha: head });
  process.stdout.write(
    `${reportPath}\n` +
      `OK — 11 섹션 승인依頼レビュー 작성 완료${head ? ` + HEAD ${head.slice(0, 12)} stamp` : ''}${post.ok ? '' : ' (경고: 검증 미통과)'}\n`,
  );
  process.exit(post.ok ? 0 : 1);
}

// CLI entry (import 시 미실행)
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
