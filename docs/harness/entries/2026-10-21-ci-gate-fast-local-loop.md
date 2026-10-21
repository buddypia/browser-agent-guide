# Move the full gate to CI and keep only fast node checks local

- **date**: 2026-10-21
- **dimension**: INV
- **motivation**: The owner reported that small fixes took very long to ship and that parallel worktrees interfered with each other. Measured on 2026-10-21 with about 40 `claude` sessions on a 16-core machine (load average 100–316): the serial `npm run check` took about 7.5 minutes (`test:ui` alone 293 s), and on a clean `main` (26a9bf2) `test:ui` failed 3 extension-loaded E2E tests on timeouts. Re-running only those specs failed 2 again; `m2-integration` failed 2 tests on one run and passed all 8 on the next with no code change. #94 (4fa870e, "Fix flaky workflow e2e and canvas readback under parallel load") had already fixed E2E flakiness under load, and `playwright.config.mjs` raised the expect timeout to 15 s for the same reason. Each `npm run` start cost about 1.5 s under this load, and the chain started 21 of them in sequence. `test/m2-integration.spec.mjs` used fixed CDP port 9888, so a second concurrent run's `cdp-bridge` could attach to the other worktree's Chrome. The three temp-repo tests (`test/glossary/staleness.test.mjs`, `test/antigravity-hooks.test.mjs`, `test/harness-library.test.mjs`) failed when `GIT_DIR`/`GIT_WORK_TREE` were set, because their `git add -A`/`commit` acted on the repo those variables named. `worktree-init` writes those variables into each worktree's CLI settings. CI (`glossary.yml`) ran only the glossary checks, and `scripts/agent-worktree-guard/test_guard.py` ran in no gate at all.

## Edits

### `scripts/auto-ship.mjs`
- **change**: The local gate is `npm run check:fast`, not `npm run check` plus daemon tests. The script pushes and opens the PR before the AI review so CI runs during it, then writes the review into the PR body. Before `gh pr merge` it waits for every job in `CI_JOBS` (`fast`, `daemon`, `e2e` in `.github/workflows/ci.yml`) to pass. It reads check runs by commit SHA, so a previous push's green checks cannot count. A missing job keeps the state pending, so it fails closed at a 30-minute timeout. A test keeps `CI_JOBS` in step with the job names in `ci.yml`. This extends the review and trailer routing recorded in `2026-10-21-harness-experience-library.md` (its `scripts/auto-ship.mjs` row stays pending: this change does not touch the reviewer prompt).
- **observed**: New. Watch three things: wall time from `make ship` to merge, how often CI fails a change whose `check:fast` passed (that is the E2E coverage moved off the machine), and whether E2E flakes come back on CI, where `retries: 2` applies.
- **verdict**: pending

### `.agents/skills/testing/`
- **change**: The skill now says CI runs every gate. The local loop is `check:fast` plus the specs you touched, and the full local suite is only for debugging an E2E failure CI reported. Browser tests must not use fixed ports or shared paths, and temp-repo tests must drop `GIT_*` first. The command list gains `check:fast`, `test:e2e` and `test:guard`.
- **observed**: New. Watch whether agents still run the full `npm run check` as their routine gate.
- **verdict**: pending

### `.agents/skills/ship-flow/`
- **change**: Describes the new `make ship` order (check:fast → PR → review + CI → merge) and how to act on `CI failed`. The manual path checks `gh pr checks` before the Pre-Ship panel. Its row in `2026-10-21-harness-experience-library.md` stays pending: this is a different edit.
- **observed**: New.
- **verdict**: pending

### `AGENTS.md`
- **change**: Replaced the false line "CI only checks the glossary; everything else is gated locally" with the CI-plus-fast-local split, and added `npm run check:fast` to the commands block (+92 characters, now 5,708 of 8,000).
- **observed**: New. The old line was a stale fact in always-on text, so this corrects it rather than adding a rule. It adds no evidence on the open `AGENTS.md` rows in `2026-07-19-block-gh-pr-merge-delete-branch-from-worktree.md` or `2026-10-18-port-harness2-validator.md`, so those stay confounded. The same applies to the open `.agents/skills/` row in `2026-10-18-port-harness2-validator.md`.
- **verdict**: pending

### `scripts/agent-worktree-guard/`
- **change**: `hook_pre_tool` returns before the guard root lookup, the ledger load and `git worktree list` when the command has no `git`, `gh` or `rm` word. Every rule it enforces needs one of those tokens. `test_guard.py` drops inherited `GIT_*` variables, and `npm run test:guard` now runs it in CI and in the full `npm run check`.
- **observed**: The hook runs on every Bash call. For `ls -la` it went from 0.30–0.32 s to 0.10–0.12 s, measured from the worktree's copy. A raw `git worktree add` is still denied. `test_guard.py` passes 13/13 with a bogus `GIT_DIR` set.
- **verdict**: pending

## Lesson

- **cue**: A gate that runs heavy or timing-sensitive checks on a machine that many agent sessions share.
- **lesson**: Run that suite in CI on clean runners. Make the shipping script wait for CI by commit SHA, and keep only the fast, load-independent checks local. Do not raise timeouts or add retries locally to absorb the load.
- **evidence**: Every row is `pending`. The contrast so far is the measurement in the motivation: clean `main` failed E2E only under load, and the same tests passed alone moments later.
- **confidence**: low — every row is pending, and no CI run has been compared with a local run over time yet.
