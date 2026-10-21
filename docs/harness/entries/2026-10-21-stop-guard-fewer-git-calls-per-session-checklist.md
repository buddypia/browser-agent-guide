# Cut the Stop guard's per-worktree git calls and give each session its own checklist

- **date**: 2026-10-21
- **dimension**: INV
- **motivation**: This is the handoff list after PR #157 ("Run the full gate in CI and keep only fast node checks local"). The load figures (about 40 concurrent agent sessions, load average 100–300 on 16 cores, measured 2026-10-21) are the ones recorded in the `ci.yml` comment and in `2026-10-21-ci-gate-fast-local-loop.md`. Two problems were named. (1) On every Stop, `worktree-shipping-guard` ran `git rev-parse` (isGitRepo), `git status --porcelain --untracked-files=all` and `git rev-list --count` for every worktree. The number of git processes therefore grew with the worktree count of all sessions, although only the stopping session's own worktrees can block. (2) `.tmp/.worktree_status.md` was one file shared by all sessions, so only the last writer's checklist survived. During this session's test run, the new bulk `for-each-ref` call hit the hook's 3 s `safeGit` timeout under load. It passed when run alone and failed in the parallel run. In production a timeout falls back to per-worktree `rev-list`.

## Edits

### `.claude/hooks/worktree-shipping-guard.mjs`
- **change**: Unmerged counts now come from one `git for-each-ref '--format=%(refname:short)%09%(ahead-behind:<base>)' refs/heads` call. The new `unmergedCommitsByBranch` tries `origin/main`, then `main`, then returns an empty Map. `evaluate()` falls back to per-worktree `countUnmergedCommits` for any branch missing from the Map. `evaluate()` also classifies ownership, which is a file read, before it runs `git status`. A worktree that is not owned now costs no per-worktree git call. The not-owned notice lists only worktrees with unmerged commits (`uncommitted: 0` is recorded). Uncommitted-only work in another session's worktree is no longer reported; that session's own Stop blocks on it. The change adds tests in `.claude/scripts/lib/__tests__/worktree-shipping-guard.test.mjs`.
- **observed**: New. No run since the change has been observed. The only runtime evidence is this session's test run, where the bulk call timed out at 3 s under load. It passed alone and failed in the parallel run, so the fallback path matters in practice on this machine. Watch for four things:
  - Stop latency under the ~40-session load.
  - How often `unmergedCommitsByBranch` returns an empty Map and the per-worktree fallback runs. `ahead-behind` needs git 2.41 or later.
  - Whether anyone misses the dropped "uncommitted-only, not owned" notice.
  - Fail-open regressions. `2026-10-14-remove-self-attested-ship-gates.md` (verdict `hurt`) recorded that an edit inside `evaluate()` threw and the hook failed open. This change edits the same function and the same ownership path.
- **verdict**: pending

### `scripts/agent-worktree-guard/`
- **change**: `guard.py` writes the checklist to `.tmp/worktree-guard-ledger/<session>.md`, next to that session's `.json` ledger. `status_path(root, session_id)` takes the session id, and the `STATUS_REL` constant and the `.tmp/.worktree_status.md` `.gitignore` entry are gone. `_clear_status` now takes a session id, and `cmd_cleanup` clears the checklists of every session it touched, including cross-session merged cleanups, not just the current one. The `git-hook pre-push` subcommand checks the session's own checklist file. `test_guard.py` adds `test_status_checklist_is_per_session`: two sessions each add a worktree, and each file lists only its own. The README and the `docs/features/004-agent-worktree-guard/` BRIEF and SPEC are updated to match. This is a different edit from the `hook_pre_tool` early return recorded in `2026-10-21-ci-gate-fast-local-loop.md`. That entry's `scripts/agent-worktree-guard/` row stays `pending` because this change brings no evidence about its latency claim.
- **observed**: New. The only check is `test_guard.py`, which includes the per-session test. No git pre-push hook calls `git-hook pre-push` in this repo (no `.githooks/` or `.husky/`), so a session that started before the change cannot be rejected for a missing checklist. Watch for two things:
  - Whether stale `<session>.md` files pile up for sessions that never run cleanup.
  - Whether the old shared `.tmp/.worktree_status.md` is still read by anything.
- **verdict**: pending

## Lesson

- **cue**: A hook or guard that runs on every turn or Stop and loops over shared state owned by many concurrent sessions, such as all worktrees or all ledgers.
- **lesson**: In the hook body (here `.claude/hooks/worktree-shipping-guard.mjs`), order the checks so the cheapest filter, a file read for ownership, runs before any per-item process spawn. Batch what remains into one call. Keep a per-item fallback for when the batch call fails or times out under load. Give each session its own state file instead of one shared file.
- **evidence**: This rests on the two `pending` rows above and on one observation: the bulk `for-each-ref` timed out in the parallel test run. No post-merge latency or correctness measurement exists yet.
- **confidence**: low — both rows are `pending` and no later run has shown the effect. The cost is a plausible mechanism, not a measurement.
