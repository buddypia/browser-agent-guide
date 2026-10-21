# Cap AGENTS.md, move knowledge into skills, and port harness2's validator

- **date**: 2026-10-18
- **dimension**: INV+DOM
- **motivation**: PR #145 — AGENTS.md was 34,265 chars: always on in every CLI, past Codex's silent 32 KiB truncation (the post-merge cleanup rules at its end were cut off for Codex), and full of advisory lines a retro had already shown do not prevent recurrences. Skill `allowed-tools` had pre-approved `Edit`/`Write` (bag-memo) despite a documented ban.

## Edits

### `AGENTS.md`
- **change**: 34,265 → 5,535 chars: every-task invariants, core commands and one trigger line per skill.
- **observed**: Codex now receives the whole file, including the cleanup rules it used to lose. Whether sessions since deliver more often is not measured, and the skills moved at the same time.
- **verdict**: confounded

### `.agents/skills/`
- **change**: Seven on-demand skills hold the moved knowledge (extension-architecture, daemon-mcp, workflow-steps, glossary, testing, ship-flow, harness-rules), each with a trigger line.
- **observed**: Not isolated from the AGENTS.md cut.
- **verdict**: confounded

### `.agents/skills/bag-memo/SKILL.md`
- **change**: Stopped pre-approving `Edit`/`Write`; `scripts/check-harness.mjs` now fails any skill that does, and the post-edit hook runs it on every harness edit.
- **observed**: As prose, the ban was already broken (bag-memo). As a check, the tree has had zero violations through PRs #147–#154, but none of those PRs touched a skill's `allowed-tools` and no run shows the check blocking a violation, so the absence does not isolate the check.
- **verdict**: confounded

### `.claude/hooks/post-edit-invariants.mjs`
- **change**: New PostToolUse hook (Claude Code + Codex) runs check-harness, check-sync-pairs and check-hook-refs on the edited checkout and blocks with the reason.
- **observed**: New at the time; it surfaces violations right after the edit rather than at `npm run check`.
- **verdict**: pending

## Lesson

- **cue**: A rule about file contents (frontmatter, allow-lists, sizes, paired files) that agents keep breaking although it is written down.
- **lesson**: Encode it in `scripts/check-harness.mjs` or `scripts/check-sync-pairs.mjs`, run by the post-edit hook, instead of restating it in AGENTS.md or a skill.
- **evidence**: `.agents/skills/bag-memo/SKILL.md` row — the prose ban was broken; the check-enforced ban has not been tested by a violating edit yet.
- **confidence**: low — the only contrast is "broken as prose"; settle the row when a post-edit block or check failure on `allowed-tools` is recorded.
