# Make the ledger gate say when it did not run, and cite entries by whole name

- **date**: 2026-10-21
- **dimension**: INV
- **motivation**: The #155 AI review left two minor findings on the gate added by `2026-10-21-harness-experience-library`: with no `origin/main` the CLI skipped the gate and still exited 0, and an entry counted as cited when another entry's name merely contained it. The first is the failure `2026-06-20-dead-trigger-lint-for-hook-references` records for check-hook-refs ("exit 0 cannot tell passed from never ran").

## Edits

### `scripts/check-harness.mjs`
- **change**: When `ledgerInputs` finds no `origin/main`, the CLI prints `⚠ ledger gate skipped` on stderr instead of passing silently, and `ledgerOptOuts` returns null so `make ship` can tell "no opt-outs" from "gate never ran". A test spawns the CLI in a git repo without `origin` and asserts the warning.
- **observed**: New; the gate was added hours earlier in `2026-10-21-harness-experience-library` and its rows there stay pending. No run has yet hit a missing `origin/main`.
- **verdict**: pending

### `scripts/harness-library.mjs`
- **change**: An earlier entry counts as cited only when its name appears with no `[a-z0-9-]` on either side, so citing `…-old-two` no longer settles `…-old`.
- **observed**: New; the test fails on the previous substring match. No real pair of entry names has collided yet.
- **verdict**: pending

### `scripts/auto-ship.mjs`
- **change**: `decide` sends the branch to a human when `optOuts` is null (the ledger gate could not run), instead of reading it as a pass.
- **observed**: New; `make ship` worktrees start from `origin/main`, so this path is expected to be rare. Landed on top of `2026-10-21-ci-gate-fast-local-loop` (CI-gated merge), whose row for this file stays pending; this edit only adds a reason before that CI wait.
- **verdict**: pending

## Lesson

NO_ENTRY
