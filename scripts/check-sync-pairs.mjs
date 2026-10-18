#!/usr/bin/env node
// check-sync-pairs.mjs — files that must agree with a counterpart in another MV3 context or npm project.
// Each pair used to be a prose rule ("keep X and Y in sync"), and the recipe pair had no check at all.
// Run by `npm run check:sync` and, after an edit to either side, by .claude/hooks/post-edit-invariants.mjs.
// Pure text parsing on purpose: the hook must not import daemon modules (and their deps) to compare lists.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The quoted strings of the first `[...]` after `marker` (null when the marker is gone). */
export function stringList(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return null;
  const open = src.indexOf('[', i);
  const close = src.indexOf(']', open);
  if (open < 0 || close < 0) return null;
  return [...src.slice(open + 1, close).matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function sameList(a, b, nameA, nameB, { ordered }) {
  if (!a) return `${nameA} not found`;
  if (!b) return `${nameB} not found`;
  const [x, y] = ordered ? [a, b] : [[...a].sort(), [...b].sort()];
  if (x.length === y.length && x.every((v, i) => v === y[i])) return null;
  const onlyA = a.filter((v) => !b.includes(v));
  const onlyB = b.filter((v) => !a.includes(v));
  const diff = onlyA.length || onlyB.length ? `only in ${nameA}: [${onlyA}] · only in ${nameB}: [${onlyB}]` : 'same verbs, different order';
  return `${nameA} and ${nameB} differ (${diff})`;
}

export const SYNC_PAIRS = [
  {
    id: 'slug',
    files: ['lib/slug.js', 'daemon/src/slug.js'],
    check: ([ext, daemon]) =>
      ext === daemon ? null : 'must stay byte-identical (the folder name is the daemon entry id); copy the edited file over the other',
  },
  {
    id: 'recipe-verbs',
    files: ['options/options.js', 'background/service-worker.js'],
    check: ([options, sw]) =>
      sameList(stringList(options, 'const SAFE_RECIPE_VERBS'), stringList(sw, 'const RECIPE_VERBS'), 'SAFE_RECIPE_VERBS', 'RECIPE_VERBS', { ordered: false }),
  },
  {
    id: 'agent-verbs',
    files: ['content/content-script.js', 'daemon/src/server.js'],
    check: ([content, server]) =>
      sameList(stringList(content, 'const AGENT_ALLOWED_VERBS'), stringList(server, 'const EXECUTE_ACTIONS_VERBS'), 'AGENT_ALLOWED_VERBS', 'EXECUTE_ACTIONS_VERBS', { ordered: true }),
  },
];

/** Problems across all pairs, or only the pairs that include one of `touched` (repo-relative paths). */
export function checkSyncPairs(root, { touched } = {}) {
  const errors = [];
  for (const pair of SYNC_PAIRS) {
    if (touched && !pair.files.some((f) => touched.includes(f))) continue;
    let srcs;
    try {
      srcs = pair.files.map((f) => readFileSync(join(root, f), 'utf8'));
    } catch (e) {
      errors.push(`${pair.files.join(' ⇔ ')}: cannot read (${e.code || e.message})`);
      continue;
    }
    const problem = pair.check(srcs);
    if (problem) errors.push(`${pair.files.join(' ⇔ ')}: ${problem}`);
  }
  return errors;
}

// realpath: Node resolves symlinks for the main module, so a plain path compare would skip main (and pass) silently.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const errors = checkSyncPairs(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  console.log(`sync pairs OK — ${SYNC_PAIRS.map((p) => p.id).join(', ')}`);
}
