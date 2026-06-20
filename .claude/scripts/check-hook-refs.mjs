#!/usr/bin/env node
/**
 * check-hook-refs.mjs — dead-dependency / dead-trigger lint (orphaned-guard-trigger ③ detection)
 *
 * Why: a hook silently fails OPEN when a module it imports — or a `.claude` script it
 * references by concrete path — is deleted/renamed. `safeHookMainWithProfile` catches the
 * load error and passes through, so the guard goes inert with NO signal. That is exactly how
 * `pre-ship-review-guard` / `mark-pre-ship-confirmed` were left dangling by the brief2dev
 * removal (see docs/retros/retro-2026-06-20-orphaned-ship-gate.md). This lint makes such a
 * removal fail loudly instead of silently.
 *
 * Checks over `.claude/hooks/**` + `.claude/scripts/**` (*.mjs/*.js, excludes node_modules):
 *   (a) every relative import / `export … from` / dynamic `import('…')` specifier resolves
 *       to an existing file (.mjs/.js/index resolution).
 *   (b) every concrete `.claude/…/<x>.mjs` path string-literal points to an existing file
 *       (skips `${template}` and regex-escaped `\.` forms — those are not concrete paths).
 *
 * NOT covered (by design — a regex-semantics analyzer would be over-engineering): a regex
 * command pattern naming a removed binary/script (e.g. the original SHIP_PATTERN `ops.mjs`).
 * That trigger-liveness vector is covered by per-guard contract tests — see
 * `.claude/scripts/lib/__tests__/pre-ship-review-guard.test.mjs` (feed the canonical command,
 * assert the gate still fires). Pair (a)/(b) here with a contract test per gating guard.
 *
 * Exit 0 = OK · 1 = dangling reference(s) found.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // .claude/scripts
const CLAUDE_DIR = resolve(HERE, '..'); // .claude
const REPO_ROOT = resolve(CLAUDE_DIR, '..'); // repo root

export function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.git') || name === '__tests__') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    // Skip test files: they legitimately embed synthetic import/command strings as fixtures,
    // and a broken test import fails loudly on its own — not a silent fail-open vector.
    else if (name.endsWith('.test.mjs')) continue;
    else if (name.endsWith('.mjs') || name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

// Light comment strip so commented-out imports / prose mentioning a removed file do not
// false-positive. Over-stripping only causes a missed check (safe), never a false alarm.
// `[^:]` before `//` avoids nuking `://` inside URL string literals.
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function resolvesTo(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  return [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs'), join(base, 'index.js')].some(
    (c) => existsSync(c),
  );
}

const IMPORT_FROM_RE = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"`]([^'"`]+)['"`]/g;
const DYN_IMPORT_RE = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s*['"`]([^'"`]+)['"`]\s*;?/g;
// Opening quote anchors the match inside a string literal (low false-positive); the path may
// be embedded mid-string (e.g. `'node .claude/scripts/x.mjs --foo'`), so we do not require the
// closing quote to be flush against `.mjs`. The `.claude/…` tail is sliced out below.
const CLAUDE_PATH_RE = /['"`]([^'"`\n]*?\.claude\/[\w./-]+\.mjs)/g;

/** Pure scanner — exported for unit testing against fixture trees. */
export function collectProblems(scanDirs, repoRoot) {
  const problems = [];
  for (const file of scanDirs.flatMap((d) => (existsSync(d) ? walk(d) : []))) {
    const rel = file.slice(repoRoot.length + 1);
    const src = stripComments(readFileSync(file, 'utf-8'));

    for (const re of [IMPORT_FROM_RE, DYN_IMPORT_RE, SIDE_EFFECT_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (!spec.startsWith('.') || spec.includes('${')) continue; // bare/builtin/template
        if (!resolvesTo(file, spec)) problems.push(`${rel}: unresolved import '${spec}'`);
      }
    }

    CLAUDE_PATH_RE.lastIndex = 0;
    let m;
    while ((m = CLAUDE_PATH_RE.exec(src))) {
      const p = m[1];
      if (p.includes('${') || p.includes('\\')) continue; // template / regex-escaped — not concrete
      const relPath = p.slice(p.indexOf('.claude/'));
      if (!existsSync(join(repoRoot, relPath))) {
        problems.push(`${rel}: dangling .claude path literal '${p}'`);
      }
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = collectProblems([join(CLAUDE_DIR, 'hooks'), join(CLAUDE_DIR, 'scripts')], REPO_ROOT);
  if (problems.length) {
    console.error(
      '[check-hook-refs] dangling reference(s) — a removed dependency/script silently fail-opens a hook:',
    );
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\n${problems.length} problem(s). Re-point or remove the dead reference.`);
    process.exit(1);
  }
  console.log('[check-hook-refs] OK — all .claude hook/script imports + .claude path literals resolve.');
}
