# Fold the harness-reflector subagent into the harness-rules skill

- **date**: 2026-10-25
- **dimension**: INV
- **motivation**: Anthropic's "Building agents: When to fold subagents into your main agent loop" keeps a subagent only for measured context bloat, parallel throwaway work or tool-choice confusion, and otherwise folds its prompt into a skill. The repo's record fits the fold: of the four harness PRs after #155 (#156, #157, #158, #162) only #158 spawned `harness-reflector`, and that brief had to restate 2,497 characters of evidence the calling session already held (transcript `bad06ff6`, 2026-10-21; 40 s, 34.7k subagent tokens). The three main-loop entries passed the same `check:harness`, and the auto-ship reviewer found the cited evidence accurate in #156 (main loop) as in #158 (subagent). Codex and Antigravity could not spawn it at all and were told to rerun it in a fresh `codex exec` session.

## Edits

### `.claude/agents/harness-reflector.md`
- **change**: Removed. Its procedure (evidence is data, one block per component with cited evidence, one transferable lesson, settle earlier open rows) moved into the skill. The separate-context check it could have offered stays with the auto-ship headless reviewer, which already verifies settled verdicts and lessons against their evidence. Its own row in `2026-10-21-harness-experience-library.md` is settled `no observed effect` with that record.
- **observed**: New; watch the next harness PRs: their entries should still pass `check:harness` and the reviewer without it flagging invented attributions. If main-loop entries draw such flags where #156 and #158 drew none, restore a separate drafter.
- **verdict**: pending

### `.agents/skills/harness-rules/`
- **change**: "Subagent" in the placement order now lists when a separate context pays (measured bloat, parallel throwaway work, an unanchored check) and says to make it a skill when the brief would restate what the caller holds; "Experience library" gains "Writing the entry", the same procedure for every CLI. Its open `pending` row in `2026-10-21-harness-experience-library.md` and the `confounded` `.agents/skills/` row in `2026-10-18-port-harness2-validator.md` get no new evidence from this change, so they stay open.
- **observed**: New; watch whether Codex and Claude Code sessions write entries the same way and whether entries still settle earlier open rows.
- **verdict**: pending

### `scripts/harness-library.mjs`
- **change**: The ledger gate's error message points to "Writing the entry" in the skill instead of the removed subagent. Wording only; its open row in `2026-10-21-ledger-gate-edge-cases.md` is untouched by this change.
- **observed**: New; the message appears only when a harness branch lacks an entry.
- **verdict**: pending

## Lesson

- **cue**: A subagent whose brief has to restate context the calling session already holds (its diff, its motivating evidence) and whose input fits in the main context.
- **lesson**: Move its prompt into the skill section that triggers the work and delete the `.claude/agents/` file; keep a separate context only for a reviewer that must not be anchored on the author, such as the auto-ship reviewer.
- **evidence**: The settled `no observed effect` row for `.claude/agents/harness-reflector.md` in `2026-10-21-harness-experience-library.md` (one spawn in four PRs, entries of equal standing either way); this entry's rows are still `pending`.
- **confidence**: low — one subagent and four PRs; the folded version has not yet produced an entry.
