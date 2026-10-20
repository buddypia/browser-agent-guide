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
- **observed**: First trial (on #85, now `2026-07-19-block-gh-pr-merge-delete-branch-from-worktree.md`) passed `check:harness` with only wording trimmed, kept every unproven row `pending`/`confounded` and its lesson `low`. One run; keep watching.
- **verdict**: pending

### `scripts/check-harness.mjs`
- **change**: Validates subagents and the library; as a CLI, applies the ledger gate against `origin/main` to AGENTS.md, skills, subagents, hook files, `.claude/hooks/` and every script a hook file runs plus the checker and `scripts/auto-ship.mjs` themselves (opt-out: a `Harness-Entry: none — <reason>` trailer, which exempts only its own commit's paths). The #155 reviews found `.claude/scripts/merge-guard.mjs` outside the gate and one trailer exempting a whole branch; both were fixed before merge.
- **observed**: New; watch how often the trailer is used and for what.
- **verdict**: pending

### `scripts/harness-library.mjs`
- **change**: Entry parser and validator (evidence required, verdict enum, a lesson on confounded/pending rows must be low), INDEX renderer (`npm run harness:index`) and the gate predicate.
- **observed**: While this PR was built, the gate blocked it until this row existed, so it fires on its own author. Watch for false blocks on legitimate harness PRs.
- **verdict**: pending

### `.claude/hooks/post-edit-invariants.mjs`
- **change**: Through `isHarnessPath`, now re-validates right after edits to `.claude/agents/` and `docs/harness/` (entry shape, INDEX freshness).
- **observed**: New; watch for blocks on malformed entries or a stale INDEX.
- **verdict**: pending

### `scripts/auto-ship.mjs`
- **change**: The headless reviewer checks settled verdicts and lessons in new entries against the evidence they cite, and requests changes for an invented attribution (harness2: merging an edit does not launder it).
- **observed**: On this PR's first `make ship` (#155) the reviewer flagged the seed row `.agents/skills/bag-memo/SKILL.md` `helped` as unsupported (no run showed the check blocking anything); the row was downgraded to `confounded`. The reviewer also reads harness-rules, so the prompt line is not isolated from the skill.
- **verdict**: pending

## Lesson

NO_ENTRY
