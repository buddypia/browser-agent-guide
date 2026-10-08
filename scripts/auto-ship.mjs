#!/usr/bin/env node
// auto-ship: test → AI review → PR → (small changes only) squash merge → worktree cleanup.
//
// Run from inside a finished, fully committed worktree: `make ship` (or `node scripts/auto-ship.mjs`).
// Large or guardrail-touching changes, a failed review, or any error stop at an open PR for a human.
// --dry-run runs checks + review and prints the decision without pushing.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAX_FILES = 15;
const MAX_LINES = 400;
// Changes here alter the agents' own guardrails, permissions, or this script — always a human call.
const PROTECTED = [/^\.claude\//, /^\.codex\//, /^\.agents\/hooks\.json$/, /^\.github\//, /^scripts\/agent-worktree-guard\//, /^scripts\/auto-ship\.mjs$/, /^manifest\.json$/, /^Makefile$/];
const MAX_DIFF_CHARS = 150_000;

const dryRun = process.argv.includes('--dry-run');
const log = (msg) => console.error(`[auto-ship] ${msg}`);
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status === 0;
const finish = (status, msg) => { console.log(`AUTO_SHIP ${status}: ${msg}`); process.exit(status === 'FAILED' ? 1 : 0); };

const wt = sh('git', ['rev-parse', '--show-toplevel'], process.cwd());
const mainRoot = dirname(resolve(wt, sh('git', ['rev-parse', '--git-common-dir'], wt)));
const branch = sh('git', ['branch', '--show-current'], wt);
if (wt === mainRoot || !branch || branch === 'main') finish('FAILED', 'run this from a feature worktree, not main');
if (sh('git', ['status', '--porcelain'], wt)) finish('FAILED', 'worktree has uncommitted changes; commit first');

sh('git', ['fetch', '-q', 'origin', 'main'], wt);
const range = 'origin/main...HEAD';
if (sh('git', ['rev-list', '--count', 'origin/main..HEAD'], wt) === '0') finish('FAILED', 'no commits ahead of origin/main');

// 1. Deterministic scope gate.
const numstat = sh('git', ['diff', '--numstat', range], wt).split('\n').filter(Boolean).map((l) => l.split('\t'));
const files = numstat.map((c) => c[2]);
const lines = numstat.reduce((n, c) => n + (Number(c[0]) || 0) + (Number(c[1]) || 0), 0);
const reasons = [];
if (files.length > MAX_FILES) reasons.push(`${files.length} files > ${MAX_FILES}`);
if (lines > MAX_LINES) reasons.push(`${lines} changed lines > ${MAX_LINES}`);
const touched = files.filter((f) => PROTECTED.some((re) => re.test(f)));
if (touched.length) reasons.push(`protected paths: ${touched.join(', ')}`);
log(`${files.length} files, ${lines} lines changed`);

// 2. Tests (failure = nothing is pushed).
const ensureDeps = (dir) => existsSync(join(dir, 'node_modules')) || run('npm', ['install', '--no-audit', '--no-fund'], dir);
const daemon = join(wt, 'daemon'); // UI specs import daemon modules, so it needs deps either way
if (!ensureDeps(wt) || !ensureDeps(daemon)) finish('FAILED', 'npm install failed');
if (!run('npm', ['run', 'check'], wt)) finish('FAILED', 'npm run check failed');
if (files.some((f) => f.startsWith('daemon/')) && !run('npm', ['test'], daemon)) finish('FAILED', 'daemon tests failed');

// 3. AI review in a hook-free, read-only headless Claude session. Any failure fails closed (human review).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'scope', 'summary', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    scope: { type: 'string', enum: ['small', 'large'] },
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' } },
  },
};
const log1 = sh('git', ['log', '--format=- %s', 'origin/main..HEAD'], wt);
let diff = sh('git', ['diff', range], wt);
if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]`;
const prompt = `You are reviewing an AI-authored change to this repository before it is auto-merged to main.
Read AGENTS.md and any files you need. Judge:
- verdict "request_changes" for real bugs, regressions, security problems, broken invariants from AGENTS.md, or missing tests for risky logic. Ignore style nits.
- scope "large" for a big refactor, a large new feature, architecture/data-format changes, or anything a human owner should decide; otherwise "small".
Write summary and issues in Japanese.

Commits:
${log1}

Diff (${range}):
${diff}`;
let review;
const r = spawnSync('claude', ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA)], { cwd: wt, input: prompt, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 15 * 60_000 });
try {
  review = JSON.parse(r.stdout).structured_output;
  if (!review?.verdict) throw new Error('no structured_output');
} catch (e) {
  review = { verdict: 'request_changes', scope: 'large', summary: `AI review failed: ${e.message} ${r.stderr ?? ''}`.trim(), issues: [] };
}
if (review.verdict !== 'approve') reasons.push('AI review requested changes');
if (review.scope !== 'small') reasons.push('AI review judged the change large');
const auto = reasons.length === 0;
const body = `## AI review (auto-ship)\n\n- verdict: ${review.verdict} / scope: ${review.scope}\n- size: ${files.length} files, ${lines} lines\n- decision: ${auto ? 'auto-merge' : `human review — ${reasons.join('; ')}`}\n\n${review.summary}\n${review.issues.map((i) => `- ${i}`).join('\n')}\n`;
console.error(body);
if (dryRun) finish(auto ? 'WOULD_MERGE' : 'NEEDS_HUMAN', reasons.join('; ') || 'all gates passed');

// 4. Push + PR.
const guard = join(mainRoot, 'scripts/agent-worktree-guard/agent-worktree-guard');
spawnSync(guard, ['mark-done', wt, '--reason', 'push'], { cwd: wt, stdio: 'ignore' });
if (!run('git', ['push', '-u', 'origin', 'HEAD'], wt)) finish('FAILED', 'git push failed');
let pr;
try {
  pr = JSON.parse(sh('gh', ['pr', 'view', branch, '--json', 'number,url'], wt));
} catch {
  const subjects = log1.split('\n');
  const title = subjects.length === 1 ? subjects[0].slice(2) : branch;
  sh('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body], wt);
  pr = JSON.parse(sh('gh', ['pr', 'view', branch, '--json', 'number,url'], wt));
}
if (!auto) finish('NEEDS_HUMAN', `${pr.url} — ${reasons.join('; ')}`);

// 5. Merge (no --delete-branch: cleanup deletes the remote branch) + verify + cleanup.
run('gh', ['pr', 'merge', String(pr.number), '--squash'], wt);
if (JSON.parse(sh('gh', ['pr', 'view', String(pr.number), '--json', 'state'], wt)).state !== 'MERGED') finish('FAILED', `merge did not complete: ${pr.url}`);
const owner = join(wt, '.tmp/.agent_worktree_owner.json');
if (!existsSync(owner)) finish('MERGED', `${pr.url} (worktree not guard-registered; clean it up manually)`);
const cleaned = run(guard, ['mark-merged', wt, '--pr', String(pr.number)], wt) && run(guard, ['--repo', mainRoot, 'cleanup', '--confirmed', '--path', wt], mainRoot);
// Keep the main checkout in step with origin when it can fast-forward cleanly.
if (!sh('git', ['status', '--porcelain', '--untracked-files=no'], mainRoot)) spawnSync('git', ['merge', '--ff-only', '-q', 'origin/main'], { cwd: mainRoot, stdio: 'ignore' });
finish('MERGED', `${pr.url}${cleaned ? ' (worktree cleaned up)' : ' (cleanup failed; run agent-worktree-guard cleanup --confirmed)'}`);
