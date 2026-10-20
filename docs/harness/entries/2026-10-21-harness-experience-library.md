# Add the harness experience library, its ledger gate and the reflector subagent

- **date**: 2026-10-21
- **dimension**: INV
- **motivation**: Retros recorded causes but not whether each harness edit worked: the 06-20 AGENTS.md line was found ineffective only by a recurrence ten days later, and check-hook-refs' inert CLI was found by accident four months later in #145. harness2's harnessing-level recursion (`core/library.py`, `prompts.experience`) keeps per-edit verdicts and transferable lessons that every later change reads first.

## Edits

### `.agents/skills/harness-rules/`
- **change**: "Before you change the harness" (read INDEX, name the evidence, split INV/DOM, KEEP_BASE) and the entry format; the skill names the reflector subagent.
- **observed**: New; watch whether later harness PRs cite library entries and settle open verdicts.
- **verdict**: pending

### `.agents/skills/ship-flow/`
- **change**: Notes that `npm run check:harness` fails a harness change without a library entry.
- **observed**: New; watch for `make ship` FAILED runs that this note resolves without a human.
- **verdict**: pending

### `.claude/agents/harness-reflector.md`
- **change**: Subagent that turns a diff, retros and transcripts into one entry plus verdict updates (large input, small answer).
- **observed**: New; watch whether its entries pass `check:harness` without rework and avoid invented attributions.
- **verdict**: pending

### `scripts/check-harness.mjs`
- **change**: Validates subagents and the library; as a CLI, applies the ledger gate against `origin/main` (opt-out: `Harness-Entry: none — <reason>` trailer).
- **observed**: New; watch how often the trailer is used and for what.
- **verdict**: pending

### `.claude/hooks/post-edit-invariants.mjs`
- **change**: Through `isHarnessPath`, now re-validates right after edits to `.claude/agents/` and `docs/harness/` (entry shape, INDEX freshness).
- **observed**: New; watch for blocks on malformed entries or a stale INDEX.
- **verdict**: pending

### `scripts/auto-ship.mjs`
- **change**: The headless reviewer checks settled verdicts and lessons in new entries against the evidence they cite, and requests changes for an invented attribution (harness2: merging an edit does not launder it).
- **observed**: New; watch for review rounds that reject an entry.
- **verdict**: pending

## Lesson

NO_ENTRY
