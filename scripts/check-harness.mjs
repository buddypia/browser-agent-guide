#!/usr/bin/env node
// check-harness.mjs — validate the agent harness (AGENTS.md, .agents/skills, hook files) with the rules
// Google Research's harness2 hard-codes in its validator (harness2/core/tree.py `validate`,
// harness2/substrate/codex.py `CODEX_SURFACE`), applied to this repo:
//   1. AGENTS.md is the only always-on text: non-empty, at most 8,000 characters (every token of it
//      competes with the agent's own output budget; Codex also cuts it silently at 32 KiB), and free of
//      Jinja tags (harness2 renders always-on text with StrictUndefined before a run).
//   2. Every skill has a parseable frontmatter with a `description:`, and its `name:` (if any) equals its directory.
//   3. Every skill is named by a trigger line in AGENTS.md — an untriggered skill is never opened —
//      and every trigger line points to a skill that exists.
//   4. Every script, npm script and make target named in AGENTS.md or a SKILL.md exists.
//   5. .codex/hooks.json has the shape Codex dispatches, and every hook command's script exists.
//   6. Every subagent (.claude/agents/<name>.md) has `name: <name>` and a `description:`, and is named in AGENTS.md
//      or a SKILL.md (harness2 tree.py `_check_subagents`; an agent nobody is told to spawn is dead weight).
//   7. The harness experience library (scripts/harness-library.mjs; harness2 library.py) is well-formed and its
//      INDEX is fresh. Run as a CLI, it also applies the ledger gate: a branch that changes the harness must add or
//      update a library entry naming each changed component.
// Repo additions: CLAUDE.md stays the single `@AGENTS.md` import (so nothing bypasses the cap), and a
// skill's `allowed-tools` never pre-approves `Bash(bash *)`/`Bash(sh *)`, `Edit` or `Write`.
// Run by `npm run check:harness` and, after an edit, by .claude/hooks/post-edit-invariants.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES_DIR, LIBRARY_DIR, TRAILER, checkLedgerGate, isLedgerPath, readEntries, validateLibrary } from './harness-library.mjs';

export const ALWAYS_ON = 'AGENTS.md';
export const ALWAYS_ON_MAX = 8000;
export const SKILL_DIR = '.agents/skills';
export const AGENT_DIR = '.claude/agents';
export const CODEX_HOOKS = '.codex/hooks.json';
export const HOOK_FILES = ['.claude/settings.json', CODEX_HOOKS, '.agents/hooks.json'];

const CODEX_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact', 'PostCompact',
  'SessionStart', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit', 'Stop',
]);
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const UNSAFE_TOOL = /^(?:Bash\((?:bash|sh|zsh)\b.*\)|Edit|Write|MultiEdit)$/;

export const triggerLine = (name) => `- When <situation>, read ${SKILL_DIR}/${name}/SKILL.md and follow it.`;

/** Whether editing this repo-relative path can change the verdict (the post-edit hook's filter). */
export function isHarnessPath(rel) {
  return (
    rel === ALWAYS_ON ||
    rel === 'CLAUDE.md' ||
    rel.startsWith(`${SKILL_DIR}/`) ||
    rel.startsWith(`${AGENT_DIR}/`) ||
    rel.startsWith(`${LIBRARY_DIR}/`) ||
    HOOK_FILES.includes(rel)
  );
}

function read(root, rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

// Only code is scanned for invocations, so prose such as "make sure" is never read as a make target.
function codeSpans(md) {
  const spans = [];
  const rest = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    spans.push(body);
    return '';
  });
  for (const m of rest.matchAll(/`([^`\n]+)`/g)) spans.push(m[1]);
  return spans;
}

function packageScripts(root) {
  const names = new Set();
  for (const rel of ['package.json', 'daemon/package.json']) {
    try {
      for (const k of Object.keys(JSON.parse(read(root, rel) || '{}').scripts || {})) names.add(k);
    } catch {
      /* a broken package.json is reported by npm itself */
    }
  }
  return names;
}

function makeTargets(root) {
  return new Set([...(read(root, 'Makefile') || '').matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1]));
}

function checkInvocations(root, rel, src, baseDirs, ctx, errs) {
  for (const code of codeSpans(src)) {
    const text = code.replaceAll('${CLAUDE_SKILL_DIR}', baseDirs[1] ?? '');
    for (const m of text.matchAll(/(?:^|[\s;&|(!])(?:node|python3?|bash|sh)\s+(?:-{1,2}[\w-]+\s+)*([^\s"'`;|&)]+\.(?:mjs|cjs|js|py|sh))(?=$|[\s;|&)])/g)) {
      const ref = m[1];
      if (/[*<>${}]/.test(ref)) continue;
      // Daemon commands are documented after `cd daemon`, so they resolve under daemon/.
      if (![...baseDirs, 'daemon'].some((base) => existsSync(join(root, base, ref)))) {
        errs.push(`${rel} invokes \`${ref}\` but that file does not exist`);
      }
    }
    for (const m of text.matchAll(/\bnpm run ([\w:.-]+)/g)) {
      if (!ctx.scripts.has(m[1])) errs.push(`${rel} names \`npm run ${m[1]}\` but no package.json defines it`);
    }
    for (const m of text.matchAll(/\bmake\s+(?:-C\s+\S+\s+)?([a-z][\w.-]*)/g)) {
      if (!ctx.targets.has(m[1])) errs.push(`${rel} names \`make ${m[1]}\` but the Makefile has no such target`);
    }
  }
}

function frontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  return m ? m[1] : src.slice(0, 600);
}

function allowedTools(fm) {
  const m = /^allowed-tools:(.*(?:\n[ \t]+-.*)*)/m.exec(fm);
  return m ? [...m[1].matchAll(/[A-Za-z_]+(?:\([^)]*\))?/g)].map((t) => t[0]) : [];
}

function checkSkills(root, body, ctx, errs) {
  const dir = join(root, SKILL_DIR);
  const names = existsSync(dir)
    ? readdirSync(dir).filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isDirectory()).sort()
    : [];
  for (const name of names) {
    const rel = `${SKILL_DIR}/${name}/SKILL.md`;
    const src = read(root, rel);
    if (src === null) {
      errs.push(`${SKILL_DIR}/${name}/ has no SKILL.md, so it is not a skill; add one or remove the directory`);
      continue;
    }
    if (!SKILL_NAME.test(name)) errs.push(`skill directory "${name}" must match ${SKILL_NAME}`);
    const fm = frontmatter(src);
    for (const m of fm.matchAll(/^([\w-]+):[ \t]+([^"'>|[{\s].*)$/gm)) {
      if (/: |\s#/.test(m[2])) {
        errs.push(`${rel} frontmatter \`${m[1]}:\` is a plain YAML value containing ": " or " #", so the frontmatter fails to parse and the skill is dropped silently; quote it or reword`);
      }
    }
    if (!/^description:\s*\S/m.test(fm)) {
      errs.push(`${rel} needs a \`description:\` in its frontmatter, or the skill is dropped silently at load`);
    }
    const declared = /^name:\s*(\S+)\s*$/m.exec(fm)?.[1];
    if (declared && declared !== name) {
      errs.push(`${rel} frontmatter \`name: ${declared}\` overrides the directory name, so trigger lines naming \`${name}\` stop matching; make it \`name: ${name}\``);
    }
    for (const tool of allowedTools(fm)) {
      if (UNSAFE_TOOL.test(tool)) {
        errs.push(`${rel} pre-approves \`${tool}\` in allowed-tools; shell-in-shell slips past the \`Bash(rm *)\` deny and edits must keep hitting the approval prompt`);
      }
    }
    if (!body.includes(rel)) {
      errs.push(`skill "${name}" is never named in ${ALWAYS_ON}, so no agent will open it; add a trigger line: "${triggerLine(name)}"`);
    }
    checkInvocations(root, rel, src, ['.', `${SKILL_DIR}/${name}`], ctx, errs);
  }
  return names;
}

function checkSubagents(root, body, skills, errs) {
  const dir = join(root, AGENT_DIR);
  if (!existsSync(dir)) return [];
  const named = [body, ...skills.map((s) => read(root, `${SKILL_DIR}/${s}/SKILL.md`) || '')].join('\n');
  const names = readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).sort();
  for (const name of names) {
    const rel = `${AGENT_DIR}/${name}.md`;
    const fm = frontmatter(read(root, rel) || '');
    if (/^name:\s*(\S+)\s*$/m.exec(fm)?.[1] !== name) errs.push(`${rel} needs frontmatter \`name: ${name}\` matching its file name`);
    if (!/^description:\s*\S/m.test(fm)) errs.push(`${rel} needs a \`description:\` in its frontmatter`);
    if (!named.includes(name)) {
      errs.push(`subagent "${name}" is never named in ${ALWAYS_ON} or a SKILL.md, so no agent will spawn it; name it where its situation is described`);
    }
  }
  return names;
}

function hookCommands(node, acc = []) {
  if (Array.isArray(node)) node.forEach((n) => hookCommands(n, acc));
  else if (node && typeof node === 'object') {
    if (typeof node.command === 'string') acc.push(node.command);
    Object.values(node).forEach((n) => hookCommands(n, acc));
  }
  return acc;
}

// Mirrors harness2 tree.py `check_hooks`: a malformed hooks file never fires rather than erroring.
function checkCodexHooks(doc, errs) {
  const hf = CODEX_HOOKS;
  const hooks = doc && typeof doc === 'object' ? doc.hooks : null;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks) || !Object.keys(hooks).length) {
    errs.push(`${hf} needs a top-level {"hooks": {"<Event>": [...]}} object`);
    return;
  }
  for (const [event, entries] of Object.entries(hooks)) {
    if (!CODEX_EVENTS.has(event)) {
      errs.push(`${hf}: unknown event "${event}"; Codex dispatches ${[...CODEX_EVENTS].sort().join(', ')} (PascalCase)`);
      continue;
    }
    if (!Array.isArray(entries)) {
      errs.push(`${hf}: ${event} must map to a LIST of matcher entries`);
      continue;
    }
    entries.forEach((entry, i) => {
      if (!entry || !Array.isArray(entry.hooks)) {
        errs.push(`${hf}: ${event}[${i}] needs a \`hooks\` list`);
        return;
      }
      for (const h of entry.hooks) {
        if (!h || h.type !== 'command') errs.push(`${hf}: ${event}[${i}] hook type must be "command"`);
        else if (!String(h.command || '').trim()) errs.push(`${hf}: ${event}[${i}] has an empty \`command\``);
      }
    });
  }
}

// Every script a hook file runs, as [hook file, repo-relative path]; unparseable files are skipped (and reported).
function hookScripts(root, errs = []) {
  const out = [];
  for (const rel of HOOK_FILES) {
    const src = read(root, rel);
    if (src === null) continue;
    let doc;
    try {
      doc = JSON.parse(src);
    } catch (e) {
      errs.push(`${rel} is not valid JSON: ${e.message}`);
      continue;
    }
    if (rel === CODEX_HOOKS) checkCodexHooks(doc, errs);
    for (const cmd of hookCommands(rel === '.claude/settings.json' ? doc.hooks : doc)) {
      for (const m of cmd.matchAll(/(?:\.claude|\.agents|\.codex|scripts)\/[\w./-]+\.(?:mjs|js|py|sh)/g)) out.push([rel, m[0]]);
    }
  }
  return out;
}

function checkHookFiles(root, errs) {
  for (const [rel, script] of hookScripts(root, errs)) {
    if (!existsSync(join(root, script))) errs.push(`${rel} runs \`${script}\` but that file does not exist`);
  }
}

export function validateHarness(root) {
  const errs = [];
  const body = read(root, ALWAYS_ON) ?? '';
  const chars = [...body].length;
  if (!body.trim()) {
    errs.push(`${ALWAYS_ON} is missing or empty; it is the only always-on file, so trim it but never empty it`);
  }
  if (chars > ALWAYS_ON_MAX) {
    errs.push(`${ALWAYS_ON} is ${chars} chars, over the ${ALWAYS_ON_MAX} cap; move detail into a skill (with a trigger line) or a hook, and cut something to pay for any new line`);
  }
  if (/\{\{|\{%/.test(body)) errs.push(`${ALWAYS_ON} contains a Jinja tag ({{ or {%); use a single brace or words`);
  const claude = read(root, 'CLAUDE.md');
  if (claude !== null && claude.trim() !== `@${ALWAYS_ON}`) {
    errs.push(`CLAUDE.md must stay the single line \`@${ALWAYS_ON}\`; text there is always-on too and bypasses the cap`);
  }
  const ctx = { scripts: packageScripts(root), targets: makeTargets(root) };
  checkInvocations(root, ALWAYS_ON, body, ['.'], ctx, errs);
  const skills = checkSkills(root, body, ctx, errs);
  for (const ref of new Set(body.match(/\.agents\/skills\/[\w-]+\/SKILL\.md/g) || [])) {
    if (!existsSync(join(root, ref))) errs.push(`${ALWAYS_ON} points agents to ${ref}, which does not exist; restore the skill or drop the trigger line`);
  }
  const agents = checkSubagents(root, body, skills, errs);
  checkHookFiles(root, errs);
  errs.push(...validateLibrary(root));
  return { errors: errs, alwaysOnChars: chars, skills, agents };
}

/** What the ledger gate needs about this branch vs origin/main; null when there is no origin/main to diff. */
export function ledgerInputs(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let base;
  try {
    base = git('merge-base', 'origin/main', 'HEAD').trim();
  } catch {
    return null;
  }
  const lines = (s) => s.split('\n').filter(Boolean);
  const changed = [...new Set([...lines(git('diff', '--name-only', base)), ...lines(git('ls-files', '--others', '--exclude-standard'))])];
  const entries = changed
    .filter((p) => p.startsWith(`${ENTRIES_DIR}/`) && p.endsWith('.md') && existsSync(join(root, p)))
    .map((p) => ({ name: p.slice(ENTRIES_DIR.length + 1), src: read(root, p) }));
  const hookTargets = new Set(hookScripts(root).map(([, script]) => script));
  // A trailer exempts a path only if every change to it is in trailer commits: a later commit without the trailer,
  // or an uncommitted or untracked change, puts it back on the gate.
  const exempt = new Set();
  const gated = new Set([...lines(git('diff', '--name-only', 'HEAD')), ...lines(git('ls-files', '--others', '--exclude-standard'))]);
  for (const sha of lines(git('rev-list', `${base}..HEAD`))) {
    const paths = lines(git('show', '--name-only', '--format=', sha));
    const into = TRAILER.test(git('show', '-s', '--format=%B', sha)) ? exempt : gated;
    paths.forEach((p) => into.add(p));
  }
  gated.forEach((p) => exempt.delete(p));
  return { changed, entries, exempt, hookTargets, library: readEntries(root) };
}

export function ledgerGate(root) {
  const inputs = ledgerInputs(root);
  return inputs && checkLedgerGate(inputs);
}

/** Harness paths this branch exempts from the ledger with the trailer: self-attested, so `make ship` asks a human. */
export function ledgerOptOuts(root) {
  const inputs = ledgerInputs(root);
  return inputs ? [...inputs.exempt].filter((p) => inputs.changed.includes(p) && isLedgerPath(p, inputs.hookTargets)) : [];
}

// realpath: Node resolves symlinks for the main module, so a plain path compare would skip main (and pass) silently.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { errors, alwaysOnChars, skills } = validateHarness(root);
  errors.push(...(ledgerGate(root) ?? []));
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  console.log(`harness OK — ${ALWAYS_ON} ${alwaysOnChars}/${ALWAYS_ON_MAX} chars, ${skills.length} skills triggered`);
}
