---
name: harness-rules
description: Google harness2 rules for this repo's agent harness — AGENTS.md budget, skill > script > subagent > hook > AGENTS.md, trigger lines. Read before editing AGENTS.md or adding a skill or hook.
---

# Harness rules

Source: harness2 (Google Research) — `harness2/core/prompts.py` (`_SURFACE_CODEX`), `harness2/core/tree.py` (`validate`, `check_hooks`), `harness2/substrate/codex.py` (`CODEX_SURFACE`). `scripts/check-harness.mjs` ports the validator to this repo.

## What each component costs

| component | when it is in context |
|---|---|
| `AGENTS.md` (Claude Code imports it via `CLAUDE.md`) | ALWAYS ON — every turn, every CLI; every token competes with the agent's own output budget. Codex also truncates it silently at 32 KiB |
| `.agents/skills/<name>/SKILL.md` | name + description advertised; the body is read on demand |
| `.agents/skills/<name>/scripts/*`, `scripts/*.mjs` | run on demand |
| subagent | its own context; returns text |
| hooks (`.claude/settings.json`, `.codex/hooks.json`, `.agents/hooks.json`) | fire inside the tool loop on every matching call; cost no always-on budget |

The costliest failure is a run that reasons until its budget is gone and delivers nothing. More always-on prose makes that more likely.

## Where new knowledge goes, in this order
1. **Skill** — anything with a recognisable trigger (a subsystem, a procedure, a recurring situation). The default.
2. **Script** — a deterministic operation agents hand-rolled, got wrong or did slowly (e.g. `scripts/check-js.mjs` replaced a file list agents forgot to update).
3. **Subagent** — a bounded investigation whose input is large and whose answer is small. None exist here yet: add one only when a task has that shape.
4. **Hook** — a recurring mechanical problem in the tool loop: block a known-bad call with a reason that teaches the fix, verify a write right after it happens, or add a hint after an error signature that keeps recurring.
5. **AGENTS.md** — last, and only for a short rule that applies to every run. Cut something to pay for it.

If agents keep ignoring a rule, do not restate it louder: move it into a hook or a check. Evidence from this repo: an AGENTS.md advisory line did not stop a recurrence (`docs/retros/retro-2026-06-30-worktree-base-remote-divergence-recurrence.md`), and the `Edit`/`Write` ban for skill `allowed-tools` was violated within days until `check:harness` checked it.

## What `npm run check:harness` enforces
(Also run by the post-edit hook whenever AGENTS.md, CLAUDE.md, a skill or a hook file changes.)
- `AGENTS.md` non-empty, ≤ 8,000 characters, no Jinja tags (`{{` / `{%`).
- `CLAUDE.md` is exactly `@AGENTS.md` — text there would be always-on too and bypass the cap.
- Every `.agents/skills/<name>/` has a `SKILL.md` whose frontmatter parses (no unquoted `: ` or ` #` inside a plain value) and has a `description:`; `name:` (if present) equals the directory.
- Every skill path `.agents/skills/<name>/SKILL.md` appears in AGENTS.md — an unnamed skill is never opened — and every such path in AGENTS.md exists.
- Every `node|python|bash <file>`, `npm run <script>` and `make <target>` named in code spans of AGENTS.md or a SKILL.md exists.
- `.codex/hooks.json` has the Codex hook shape (known PascalCase events, matcher entries with a `hooks` list of `type: "command"` entries); every script any hook file runs exists.
- No skill pre-approves `Bash(bash *)`/`Bash(sh *)` (shell-in-shell slips past the `Bash(rm *)` deny) or `Edit`/`Write` (code changes must keep hitting the approval prompt).

## Adding a skill
1. Create `.agents/skills/<name>/SKILL.md` with frontmatter `name: <name>` (equal to the directory) and a one-sentence `description:` saying what it covers and when to read it.
2. In the same change, add a trigger line to the Skills list in AGENTS.md: `- When <situation>, read .agents/skills/<name>/SKILL.md and follow it.`
3. Ship helpers inside the skill at `.agents/skills/<name>/scripts/` and invoke them by that path.
4. Run `node .claude/scripts/setup-skills.mjs` to link it into `.claude/skills/` and `.codex/skills/` (both gitignored; `npm install` runs it as postinstall, so every checkout needs it once).
5. User-invoked-only skills set `disable-model-invocation: true` and still need their trigger line.

## Adding a hook
- Body `.claude/hooks/<id>.mjs` exports `run(data)` (Claude stdin shape `{tool_name, tool_input, cwd}`) and keeps the standalone `safeHookMainWithProfile('<id>', …)` main. Register `<id>` in `.claude/scripts/lib/hook-registry.mjs`: an unregistered id is disabled by `isHookEnabled`.
- Claude Code: entry in `.claude/settings.json`. Codex: adapter `.claude/hooks/codex/<id>.mjs` (`runAdapter`) plus an entry in `.codex/hooks.json` (Codex edits arrive as `apply_patch`). Antigravity: `.agents/hooks.json` through `.claude/hooks/antigravity/agy-bridge.mjs` (wired for `run_command` only today).
- PostToolUse `{decision: "block", reason}` sends the reason to the model (the edit already happened); PreToolUse `deny` stops the call. Keep commands fast and non-interactive; put real logic in `scripts/`.
- Hooks fail OPEN on a broken import (`safeHookMainWithProfile` passes through on load errors). After changing `.claude/hooks` or `.claude/scripts`, `node .claude/scripts/check-hook-refs.mjs` must pass (the post-edit hook runs it) and so must `node --test .claude/scripts/lib/__tests__/*.test.mjs`. History: `docs/retros/retro-2026-06-20-orphaned-ship-gate.md`.

## Existing post-edit hook
`.claude/hooks/post-edit-invariants.mjs` (Claude Code `Edit|Write|MultiEdit`, Codex `apply_patch` via `.claude/hooks/codex/post-edit-invariants.mjs`) runs, on the checkout that holds the edited file: `scripts/check-harness.mjs` for harness files, `scripts/check-sync-pairs.mjs` for either side of a sync pair, and `check-hook-refs.mjs` for `.claude/hooks|scripts`. To enforce a new paired-file rule, add an entry to `SYNC_PAIRS` instead of a sentence in AGENTS.md.
