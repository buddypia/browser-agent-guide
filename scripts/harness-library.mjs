// harness-library.mjs — the harness experience library: harness2's harnessing-level recursion, applied to this repo.
// harness2 (Google Research) keeps, per domain, every adopted harness with an EXPERIENCE.md ("what each edit did",
// with a verdict, plus at most one lesson that transfers) and an INDEX.md that every later improvement reads first
// (harness2/core/library.py, prompts.py `experience`). Here:
//   docs/harness/entries/<YYYY-MM-DD>-<slug>.md   one harness change: motivation, per-component edit rows, lesson
//   docs/harness/INDEX.md                         generated from the entries (`npm run harness:index`)
// validateLibrary() checks entry shape and INDEX freshness (part of check-harness.mjs, so the post-edit hook runs it).
// checkLedgerGate() is the ship-time rule "every harness edit traces to evidence": a branch that changes the harness
// surface must add or update an entry naming each changed component; a commit carrying a `Harness-Entry: none — <reason>`
// trailer exempts only the paths that commit changed. Like harness2's sequential recursion (each round reads every
// earlier round), a branch that touches a component with an open (pending/confounded) verdict must edit that entry or
// cite it from its own, so verdicts get settled by the next change rather than left open forever.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIBRARY_DIR = 'docs/harness';
export const ENTRIES_DIR = `${LIBRARY_DIR}/entries`;
export const INDEX = `${LIBRARY_DIR}/INDEX.md`;
export const VERDICTS = ['helped', 'hurt', 'no observed effect', 'confounded', 'pending'];
const SETTLED = new Set(['helped', 'hurt', 'no observed effect']);
const DIMENSIONS = new Set(['INV', 'DOM', 'INV+DOM']);
const ENTRY_NAME = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9-]*\.md$/;
export const TRAILER = /^Harness-Entry:\s*none\s*[—–-]+\s*\S/im;

/**
 * Paths whose change alters what agents read or what fires in their tool loop (harness2's editable surface).
 * `hookTargets` adds the scripts hook files run outside .claude/hooks/ (e.g. .claude/scripts/merge-guard.mjs).
 */
export function isLedgerPath(rel, hookTargets = new Set()) {
  return (
    hookTargets.has(rel) ||
    rel === 'AGENTS.md' ||
    rel === 'CLAUDE.md' ||
    rel.startsWith('.agents/skills/') ||
    rel.startsWith('.claude/agents/') ||
    rel.startsWith('.claude/hooks/') ||
    [
      '.claude/settings.json',
      '.codex/hooks.json',
      '.agents/hooks.json',
      'scripts/check-harness.mjs',
      'scripts/harness-library.mjs',
      'scripts/auto-ship.mjs',
    ].includes(rel)
  );
}

// `- **field**: value` lines, the record shape harness2 writes into EXPERIENCE.md.
function fields(block) {
  const out = {};
  for (const m of block.matchAll(/^- \*\*([\w ]+)\*\*:[ \t]*(.*)$/gm)) out[m[1].trim()] = m[2].trim();
  return out;
}

function section(src, heading) {
  const m = new RegExp(`^## ${heading}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(src);
  return m ? m[1] : null;
}

export function parseEntry(src) {
  const title = /^# (.+)$/m.exec(src)?.[1].trim() || '';
  const head = src.split(/^## /m)[0];
  const edits = [];
  for (const m of (section(src, 'Edits') || '').matchAll(/^### `([^`]+)`[ \t]*\n([\s\S]*?)(?=^### |(?![\s\S]))/gm)) {
    edits.push({ component: m[1], ...fields(m[2]) });
  }
  const lessonSrc = section(src, 'Lesson');
  const lesson = lessonSrc === null ? null : /^NO_ENTRY\s*$/m.test(lessonSrc) ? 'NO_ENTRY' : fields(lessonSrc);
  return { title, ...fields(head), edits, lesson };
}

export function validateEntry(name, src) {
  const rel = `${ENTRIES_DIR}/${name}`;
  const errs = [];
  const e = parseEntry(src);
  const nameDate = ENTRY_NAME.exec(name)?.[1];
  if (!nameDate) errs.push(`${rel}: name it <YYYY-MM-DD>-<kebab-slug>.md`);
  if (!e.title) errs.push(`${rel}: needs a "# <title>" line`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) errs.push(`${rel}: needs "- **date**: YYYY-MM-DD"`);
  else if (nameDate && e.date !== nameDate) errs.push(`${rel}: date ${e.date} differs from the file name's ${nameDate}`);
  if (!DIMENSIONS.has(e.dimension)) errs.push(`${rel}: "- **dimension**:" must be INV (how agents work), DOM (what they must know about this repo) or INV+DOM`);
  if (!e.motivation) errs.push(`${rel}: "- **motivation**:" must name the moment that showed the need (a retro, PR, commit or transcript); an edit you cannot trace to one is speculation`);
  if (!e.edits.length) errs.push(`${rel}: "## Edits" needs one "### \`<component path>\`" block per changed component`);
  for (const ed of e.edits) {
    for (const f of ['change', 'observed', 'verdict']) {
      if (!ed[f]) errs.push(`${rel}: edit \`${ed.component}\` needs "- **${f}**:"`);
    }
    if (ed.verdict && !VERDICTS.includes(ed.verdict)) {
      errs.push(`${rel}: edit \`${ed.component}\` verdict "${ed.verdict}" must be one of: ${VERDICTS.join(', ')}`);
    }
  }
  if (e.lesson === null) {
    errs.push(`${rel}: needs "## Lesson" with cue/lesson/evidence/confidence, or the single line NO_ENTRY`);
  } else if (e.lesson !== 'NO_ENTRY') {
    for (const f of ['cue', 'lesson', 'evidence', 'confidence']) {
      if (!e.lesson[f]) errs.push(`${rel}: lesson needs "- **${f}**:" (or replace the lesson with NO_ENTRY)`);
    }
    const level = /^(high|medium|low)\b/.exec(e.lesson.confidence || '')?.[1];
    if (e.lesson.confidence && !level) errs.push(`${rel}: lesson confidence must start with high, medium or low`);
    if (level && level !== 'low' && !e.edits.some((ed) => SETTLED.has(ed.verdict))) {
      errs.push(`${rel}: a lesson resting only on confounded or pending rows is a guess; set confidence to low, narrow it, or write NO_ENTRY`);
    }
    if (e.lesson.lesson && !/AGENTS\.md|skill|script|subagent|hook|check|`/i.test(e.lesson.lesson)) {
      errs.push(`${rel}: the lesson must name the harness component it concerns (AGENTS.md, a skill, script, subagent, hook or check)`);
    }
  }
  return errs;
}

export function readEntries(root) {
  const dir = join(root, ENTRIES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((name) => ({ name, src: readFileSync(join(dir, name), 'utf8') }));
}

const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderIndex(entries) {
  const parsed = entries.map(({ name, src }) => ({ name, ...parseEntry(src) })).sort((a, b) => b.name.localeCompare(a.name));
  const rows = parsed.map((e) => {
    const verdicts = e.edits.map((ed) => `\`${ed.component}\` ${ed.verdict || '?'}`).join('; ');
    const cue = e.lesson && e.lesson !== 'NO_ENTRY' ? e.lesson.cue : '—';
    return `| [${cell(e.title)}](entries/${e.name}) | ${e.date || ''} | ${e.dimension || ''} | ${cell(verdicts)} | ${cell(cue)} |`;
  });
  const pending = parsed.filter((e) => e.edits.some((ed) => ed.verdict === 'pending' || ed.verdict === 'confounded'));
  return [
    '# Harness experience library',
    '',
    `Generated from \`${ENTRIES_DIR}/\` by \`npm run harness:index\`; do not edit by hand.`,
    'Read this before changing the harness: each entry records what one harness change did, per component, with a',
    'verdict, and at most one lesson that transfers. Reuse what helped; do not repeat what had no observed effect.',
    'How to write and settle entries: `.agents/skills/harness-rules/SKILL.md`.',
    '',
    '| entry | date | dim | component → verdict | cue (when the lesson applies) |',
    '|---|---|---|---|---|',
    ...(rows.length ? rows : ['| _(empty)_ | | | | |']),
    '',
    '## Verdicts still open',
    '',
    'Settle these when later evidence (a recurrence, a retro, a PR) isolates the edit.',
    '',
    ...(pending.length
      ? pending.map((e) => `- [${e.name}](entries/${e.name}): ${e.edits.filter((ed) => ed.verdict === 'pending' || ed.verdict === 'confounded').map((ed) => `\`${ed.component}\` ${ed.verdict}`).join(', ')}`)
      : ['- none']),
    '',
  ].join('\n');
}

/** Entry shape + INDEX freshness. Returns error strings (empty = OK). */
export function validateLibrary(root) {
  const entries = readEntries(root);
  const errs = entries.flatMap(({ name, src }) => validateEntry(name, src));
  const index = existsSync(join(root, INDEX)) ? readFileSync(join(root, INDEX), 'utf8') : null;
  if ((entries.length || index !== null) && index !== renderIndex(entries)) {
    errs.push(`${INDEX} is out of date with ${ENTRIES_DIR}/; run \`npm run harness:index\``);
  }
  return errs;
}

/**
 * Ship-time rule: changed harness paths must each be named by an edit component of an entry this branch adds or
 * changes (a component ending in "/" covers what is under it). `changed` are repo-relative paths; `entries` are
 * {name, src} for entry files the branch touched; `exempt` are paths changed by commits carrying the opt-out trailer.
 */
const covers = (c, path) => c === path || (c.endsWith('/') && c.split('/').length >= 3 && path.startsWith(c));
const OPEN = new Set(['pending', 'confounded']);

export function checkLedgerGate({ changed, entries, exempt = new Set(), hookTargets, library = [] }) {
  const harness = changed.filter((p) => isLedgerPath(p, hookTargets) && !exempt.has(p));
  if (!harness.length) return [];
  const errs = [];
  const components = entries.flatMap(({ src }) => parseEntry(src).edits.map((ed) => ed.component));
  const missing = harness.filter((p) => !components.some((c) => covers(c, p)));
  if (missing.length) {
    errs.push(
      `this branch changes the harness (${missing.join(', ')}) but no entry in ${ENTRIES_DIR}/ it adds or edits names ` +
        'those components. Record why (the evidence that motivated it) and what each edit changed, as "Writing the entry" in ' +
        '.agents/skills/harness-rules/SKILL.md says, then `npm run harness:index`. ' +
        'For a commit with nothing to learn (typo, rename), add the trailer `Harness-Entry: none — <reason>` to it; ' +
        'it exempts only the paths that commit changes, and `make ship` then asks a human.'
    );
  }
  const touched = new Set(entries.map((e) => e.name));
  const cited = entries.map((e) => e.src).join('\n');
  // Whole names only: citing 2026-01-01-old-two must not count as citing 2026-01-01-old.
  const cites = (name) => new RegExp(`(?<![a-z0-9-])${name.replace(/\.md$/, '')}(?![a-z0-9-])`).test(cited);
  for (const { name, src } of library) {
    if (touched.has(name) || cites(name)) continue;
    const open = parseEntry(src).edits.filter((ed) => OPEN.has(ed.verdict) && harness.some((p) => covers(ed.component, p)));
    if (open.length) {
      errs.push(
        `${ENTRIES_DIR}/${name} has open verdicts on components this branch changes (${open.map((ed) => `\`${ed.component}\` ${ed.verdict}`).join(', ')}). ` +
          'Read it: settle a verdict there if this change brings evidence, or cite the entry by name in your own entry ' +
          '(e.g. in the row\'s observed) so the next reader sees the two together.'
      );
    }
  }
  return errs;
}

// `npm run harness:index`: rewrite INDEX.md from the entries (validation lives in check-harness.mjs).
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const entries = readEntries(root);
  mkdirSync(join(root, LIBRARY_DIR), { recursive: true });
  writeFileSync(join(root, INDEX), renderIndex(entries));
  const errs = entries.flatMap(({ name, src }) => validateEntry(name, src));
  for (const e of errs) console.error(`✗ ${e}`);
  console.log(`${INDEX}: ${entries.length} entries`);
  process.exit(errs.length ? 1 : 0);
}
