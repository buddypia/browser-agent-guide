# Remove the PLAN.md checkbox gate and the REVIEW.md Stop gate

- **date**: 2026-10-14
- **dimension**: INV
- **motivation**: PR #118 — `mark-pre-ship-confirmed` refused the merge marker until placeholder PLAN.md boxes were ticked, which forced post-hoc form filling on the manual path only. PR #120 — the Stop gate blocked every turn with committed, unshipped work until the agent wrote an 11-section REVIEW.md that the same agent stamped, and its `gh pr create → merge` instructions contradicted `make ship`.

## Edits

### `.claude/scripts/mark-pre-ship-confirmed.mjs`
- **change**: Dropped the PLAN.md checkbox requirement (with the PLAN template and its parser).
- **observed**: The marker now depends only on the Pre-Ship panel confirmation; no retro since reports a ship without verification. `npm run check`, the auto-ship review and the panel already covered what the boxes claimed.
- **verdict**: confounded

### `.claude/hooks/worktree-review-report-guard.mjs`
- **change**: Removed the REVIEW.md Stop gate in all three CLIs (`.claude/settings.json`, `.codex/hooks.json`, `.agents/hooks.json`); the guard briefing lists branch, commits and files from git instead.
- **observed**: Stop turns no longer loop on a self-written report; the briefing comes from git facts. No later incident attributes a missed review to the removal.
- **verdict**: confounded

### `.claude/hooks/worktree-shipping-guard.mjs`
- **change**: While removing the PLAN helpers, `readSessionOwner`/`classifyOwnership` were cut as well.
- **observed**: `evaluate()` threw ReferenceError and the hook failed open; found in the PR's own review round and fixed with a test that runs `evaluate()` on a real temp repo without injected helpers (#118 second commit).
- **verdict**: hurt

## Lesson

- **cue**: A gate whose evidence is produced by the same agent it gates (a checkbox, a self-written report, a self-stamped marker).
- **lesson**: Remove the gate or replace it with a check or hook that reads facts the agent cannot author (git state, test exit codes, a separate reviewer session); when deleting code from a hook, run its `evaluate()` on a real repo without injected helpers before merging.
- **evidence**: Both removal rows show the gates added turns without independent evidence; the `worktree-shipping-guard.mjs` row (hurt) shows a deletion inside a hook fails open unless a real-repo test covers it.
- **confidence**: medium — the hurt row is a direct observation; the benefit of removal is confounded.
