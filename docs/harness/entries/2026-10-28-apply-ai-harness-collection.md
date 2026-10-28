# Apply task continuity, experiment checks and cross-session memory review

- **date**: 2026-10-28
- **dimension**: INV
- **motivation**: User explicitly requested sequential reading and broad application of three local harness sources. The continuity record preserves that ordered deliverable, without claiming a historical lost-context incident. Repository evidence for the testing/memory guidance: `docs/retros/retro-2026-07-19-guard-root-resolves-to-linked-worktree.md` corrects a false “verified” claim based on a dispatcher and an untested worktree case; `docs/retros/retro-2026-06-30-worktree-base-remote-divergence-recurrence.md` records a second incident despite retained advice; `docs/retros/retro-2026-06-20-orphaned-ship-gate.md` shows a retained guard going inert after entrypoint removal. These motivate checking coverage, counterexamples and stale memory against implementation. Existing report gates were removed after failures in `2026-10-14-remove-self-attested-ship-gates.md`; no such gate is restored. PR #165's initial independent review requested stronger evidence, optional record storage, retention and sanitized summaries; this revision addresses those points while leaving acceptance to human review.

## Edits

### `AGENTS.md`
- **change**: Adds a single on-demand trigger for multi-session task continuity and extends the existing harness-rules trigger to cross-session memory review.
- **observed**: New; watch whether later resumed tasks find their existing record without adding always-on planning prose. Earlier open/confounded rows in `2026-10-18-port-harness2-validator.md`, `2026-10-21-ci-gate-fast-local-loop.md` and `2026-07-19-block-gh-pr-merge-delete-branch-from-worktree.md` remain unisolated.
- **verdict**: pending

### `.agents/skills/task-continuity/`
- **change**: Adds a bounded recovery procedure covering the original contract, ordered units, decisions, verification, live handles and a final receipt, without authorizing shipping or adding a checkbox gate. Reuses existing records/issues; tracked storage is optional, with sanitized summaries and closure/retention guidance.
- **observed**: First application is `docs/plans/ai-harness-adoption.md`; actual cross-session recovery has not yet been observed. The broad `.agents/skills/` row in `2026-10-18-port-harness2-validator.md` remains confounded.
- **verdict**: pending

### `.agents/skills/testing/`
- **change**: Adapts `hanakoxbt_article`'s coverage scout, parameter sweep, held-out checks, skeptic, negative-result memory and paper-before-live sequence to repository experiments. Distinguishes executed, cached and skipped checks and uses existing library verdicts.
- **observed**: The July 19 guard-root retro supplies a concrete missed execution path and false verification against a wrapper; new guidance targets that type of weak evidence but has not yet isolated an improvement. Open rows in `2026-10-18-port-harness2-validator.md` and `2026-10-21-ci-gate-fast-local-loop.md` remain unisolated; `2026-10-24-shared-scratchpad-and-scoped-gates.md` supplies the existing cache behavior rather than a reason to disable it globally.
- **verdict**: pending

### `.agents/skills/harness-rules/`
- **change**: Adapts the supplied `kyr0stack_video` transcript (08:50, 12:10, 18:27, 22:10, Q&A) into an on-demand cross-session memory review: bounded authorized corpus, recurrence denominators, counterexamples, stale-fact checks, proposed edits, provenance, owned-worktree promotion and real concurrency semantics. Shortens the discovery description to include the new trigger.
- **observed**: The current library has open rows and retained retros across sessions; its old writing procedure covered the current edit but offered no batch-review method or audience-scope check. No cross-session improvement or cost reduction is claimed. Earlier open rows in `2026-10-25-fold-harness-reflector-into-skill.md`, `2026-10-21-harness-experience-library.md` and `2026-10-18-port-harness2-validator.md` remain unisolated; the removed reflector is not restored.
- **verdict**: pending

## Lesson

NO_ENTRY
