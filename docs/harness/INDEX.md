# Harness experience library

Generated from `docs/harness/entries/` by `npm run harness:index`; do not edit by hand.
Read this before changing the harness: each entry records what one harness change did, per component, with a
verdict, and at most one lesson that transfers. Reuse what helped; do not repeat what had no observed effect.
How to write and settle entries: `.agents/skills/harness-rules/SKILL.md`.

| entry | date | dim | component → verdict | cue (when the lesson applies) |
|---|---|---|---|---|
| [Add the harness experience library, its ledger gate and the reflector subagent](entries/2026-10-21-harness-experience-library.md) | 2026-10-21 | INV | `.agents/skills/harness-rules/` pending; `.agents/skills/ship-flow/` pending; `.claude/agents/harness-reflector.md` pending; `scripts/check-harness.mjs` pending; `.claude/hooks/post-edit-invariants.mjs` pending; `scripts/auto-ship.mjs` pending | — |
| [Cap AGENTS.md, move knowledge into skills, and port harness2's validator](entries/2026-10-18-port-harness2-validator.md) | 2026-10-18 | INV+DOM | `AGENTS.md` confounded; `.agents/skills/` confounded; `.agents/skills/bag-memo/SKILL.md` confounded; `.claude/hooks/post-edit-invariants.mjs` pending | A rule about file contents (frontmatter, allow-lists, sizes, paired files) that agents keep breaking although it is written down. |
| [Remove the PLAN.md checkbox gate and the REVIEW.md Stop gate](entries/2026-10-14-remove-self-attested-ship-gates.md) | 2026-10-14 | INV | `.claude/scripts/mark-pre-ship-confirmed.mjs` confounded; `.claude/hooks/worktree-review-report-guard.mjs` confounded; `.claude/hooks/worktree-shipping-guard.mjs` hurt | A gate whose evidence is produced by the same agent it gates (a checkbox, a self-written report, a self-stamped marker). |
| [Block gh pr merge --delete-branch from a worktree](entries/2026-07-19-block-gh-pr-merge-delete-branch-from-worktree.md) | 2026-07-19 | INV | `.claude/scripts/merge-guard.mjs` pending; `.claude/scripts/lib/review-report.mjs` confounded; `AGENTS.md` confounded | A tool command that exits 0 while partly failing in one execution context, so the agent can read its output as plain success or plain failure. |
| [Lint hook references so a removed dependency cannot silently disable a guard](entries/2026-06-20-dead-trigger-lint-for-hook-references.md) | 2026-06-20 | INV | `.claude/scripts/check-hook-refs.mjs` confounded | A check script whose CLI entry point decides by itself whether to run, so "exit 0" cannot tell "passed" from "never ran". |
| [Answer worktree base divergence with an AGENTS.md gotcha line](entries/2026-06-20-agents-md-line-for-worktree-base-divergence.md) | 2026-06-20 | INV | `AGENTS.md` no observed effect | A failure that lives in tool or git state (a stale ref, a command's side effect) and that an agent only notices by running a command at the right moment. |

## Verdicts still open

Settle these when later evidence (a recurrence, a retro, a PR) isolates the edit.

- [2026-10-21-harness-experience-library.md](entries/2026-10-21-harness-experience-library.md): `.agents/skills/harness-rules/` pending, `.agents/skills/ship-flow/` pending, `.claude/agents/harness-reflector.md` pending, `scripts/check-harness.mjs` pending, `.claude/hooks/post-edit-invariants.mjs` pending, `scripts/auto-ship.mjs` pending
- [2026-10-18-port-harness2-validator.md](entries/2026-10-18-port-harness2-validator.md): `AGENTS.md` confounded, `.agents/skills/` confounded, `.agents/skills/bag-memo/SKILL.md` confounded, `.claude/hooks/post-edit-invariants.mjs` pending
- [2026-10-14-remove-self-attested-ship-gates.md](entries/2026-10-14-remove-self-attested-ship-gates.md): `.claude/scripts/mark-pre-ship-confirmed.mjs` confounded, `.claude/hooks/worktree-review-report-guard.mjs` confounded
- [2026-07-19-block-gh-pr-merge-delete-branch-from-worktree.md](entries/2026-07-19-block-gh-pr-merge-delete-branch-from-worktree.md): `.claude/scripts/merge-guard.mjs` pending, `.claude/scripts/lib/review-report.mjs` confounded, `AGENTS.md` confounded
- [2026-06-20-dead-trigger-lint-for-hook-references.md](entries/2026-06-20-dead-trigger-lint-for-hook-references.md): `.claude/scripts/check-hook-refs.mjs` confounded
