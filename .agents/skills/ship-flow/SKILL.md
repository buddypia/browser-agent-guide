---
name: ship-flow
description: Worktree, make ship gates, manual gh flow with the Pre-Ship panel, and mandatory post-merge cleanup. Read before committing, opening or merging a PR, or cleaning up a worktree.
---

# Ship flow

GitHub Flow: never commit straight to `main`. Branch from `main` (`feat/…`, `fix/…`), commit, push, open a PR, then merge. Commit messages in English, imperative mood (e.g. "Add @agent: marker lint"); subject ≤ ~72 chars, body explains the *why* when non-trivial.

## Worktree workflow
```bash
make wt.new BR=feature/<task>     # create a fresh worktree from origin/main
make wt.run CMD="npm run check"   # run a command in the active worktree
make q.check                      # root npm run check + daemon npm test
make -C <worktree> ship           # finished work: check:fast → PR → AI review + CI → auto-merge if small → cleanup (DRY=1 = decide only, no CI)
make clean.branches               # clean up all local branches already merged into origin/main (DRY=1 = decide only)
make setup.skills                 # interactive setup of skills across agent CLI environments (with overwrite prompt)
make setup.mcp                    # interactive setup of MCP daemon & registration to Claude Code
```
Tracked source changes are made in an owned worktree, normally `.worktrees/<branch>`. Do not use raw `git worktree add` as the normal entrypoint, and do not edit or commit another session's worktree. `make wt.new` runs `npm ci` where `node_modules` is missing (skip: `node .claude/scripts/worktree-new.mjs --branch <br> --no-install`).

## Default: `make -C <worktree> ship` (all CLIs: Claude Code / Codex / Antigravity)

When the task's work is committed in its worktree, run it instead of asking the PR question. `scripts/auto-ship.mjs` runs `npm run check:fast` locally (a failure pushes nothing), pushes and opens the PR so CI starts, runs a read-only headless `claude -p` review meanwhile and writes it into the PR body, then waits for the CI jobs in `CI_JOBS` (`fast`, `daemon`, `e2e`) to pass on that exact HEAD (check runs by SHA, 30 min timeout, a missing job fails closed), and — only if every gate passes — squash-merges and runs `agent-worktree-guard` `mark-merged` + `cleanup --confirmed`. Browser E2E and daemon tests run only in CI here; a CI failure is `AUTO_SHIP FAILED: CI failed: <pr>/checks` — read the failing job's log (`gh run view --log-failed`), fix, commit, re-run. If the log shows a flake unrelated to the change (a timeout in a spec you did not touch), `gh run rerun --failed <run-id>` and re-run `make ship` on the same HEAD; it reads the newest runs for that SHA. The repo owner authorized auto-merge for changes that pass these gates (2026-10-08); the hooks only see `make ship`, so the script itself is the merge gate for this path.

Gates that stop at an open PR (`AUTO_SHIP NEEDS_HUMAN`): size or protected paths (`MAX_FILES`/`MAX_LINES`/`PROTECTED` in `scripts/auto-ship.mjs` are the source of truth), review verdict `request_changes`, or review scope `large` (big refactor / large feature / architecture or data-format change); review failure fails closed. On `NEEDS_HUMAN` report the PR URL + reasons and fall back to the manual flow below (which then still requires the Pre-Ship panel + human confirmation before merge). On `FAILED` fix and re-run (a harness change without a `docs/harness/` entry fails `npm run check:harness`: see the harness-rules skill). Do not loosen the thresholds or the protected list to get a merge through.

## Manual shipping (for `NEEDS_HUMAN`, or when the user asks to review first)

Goes through `gh` directly:
1. Commit in the worktree (`git -C <wt>`).
2. After the human agrees to a PR, run `agent-worktree-guard confirm-pr --confirmed`, then `gh pr create`.
3. Before `gh pr merge` (irreversible), check CI is green (`gh pr checks <n>`), present the 7-section Pre-Ship Human Review Panel, get explicit user confirmation, and run `node .claude/scripts/mark-pre-ship-confirmed.mjs <branch> --quality <agent_go|self_review_pass|trivial_skip>` as a separate command; `pre-ship-review-guard` blocks the merge until that marker is fresh (10 min) and its deny message lists the panel sections.
4. Run `gh pr merge` from the worktree **without `--delete-branch`/`-d`** (gh would fail its local `main` checkout yet exit 0 — verify with `gh pr view <n> --json state`; `merge-guard.mjs` denies the flag).
5. Right after the merge, run `make -C <wt> ship` again. It finds the merged PR for this HEAD, skips tests and review, and only cleans up (below). The merge is not finished until it prints `AUTO_SHIP MERGED: … (worktree cleaned up)`.

The guard CLI is the wrapper `scripts/agent-worktree-guard/agent-worktree-guard` (`confirm-pr`/`mark-merged`/`cleanup`/`status`); `.claude/hooks/agent-worktree-guard.mjs` only dispatches hooks. Background: `docs/retros/` (`orphaned-ship-gate`, `ledger-entry-orphaned-from-resource-lifecycle`, `gh-pr-merge-delete-branch-from-worktree`).

## Before shipping a long-lived worktree

Run `git fetch origin main && git diff --name-status origin/main...HEAD` and re-scope if upstream removed or rewrote files you depend on: the Stop-time staleness guard reads a never-refreshed local `origin/main`, and a small `behind` count can still hide a modify/delete conflict. `mark-pre-ship-confirmed.mjs` also warns (stderr) on same-file overlap; `make ship` fetches by itself. History: `docs/retros/retro-2026-06-30-worktree-base-remote-divergence-recurrence.md`.

## Mandatory post-merge cleanup (all CLIs)

When a PR is merged — through `make ship`, manual `gh pr merge`, or GitHub Web review — clean up the worktree and branches before reporting completion or ending the session:
1. **Primary path, every merge route**: `make -C <wt> ship`. On the auto path it cleans up after its own merge. After a manual or GitHub Web merge, re-running it finds the merged PR whose head is this HEAD (`gh pr list --state merged`; a squash merge still looks "ahead" of main to git) and runs `mark-merged` → `cleanup --confirmed` → main fast-forward. A failed cleanup is `AUTO_SHIP FAILED: … is merged, but cleanup failed`: fix it and re-run, never report the merge as done. If commits were added on GitHub before the merge (applied suggestions, web edits), HEAD is not the merged head and it would ship again: `git -C <wt> pull` first, then re-run.
2. **By hand** (when `make ship` cannot run): for worktrees tracked by the guard, run `scripts/agent-worktree-guard/agent-worktree-guard cleanup --confirmed` from the main checkout. It removes the worktree, force-deletes the merged local branch (`git branch -D`), removes the remote branch and branch-specific stashes, and reconciles ledger entries whose directory is already gone. If the worktree was created outside the guard ledger, ensure the PR is merged, then `agent-worktree-guard register <path>` → `mark-merged <path>` → `cleanup --confirmed` (raw `git worktree remove` is blocked by the guard hook).
3. **Verification**: sync main (`git pull --ff-only origin main`) and verify with `git branch` and `git worktree list` (or `make clean.branches`) that no stale worktrees or feature/fix branches linger.

Reporting a successful merge while leaving the local branch behind is prohibited.

## Session root

Claude Code reads `.claude/settings.json` only from the launch directory (CLAUDE.md/AGENTS.md *are* read from parents, which masks the gap); `daemon/.claude/settings.json` emits a SessionStart WARNING when launched there. If you see it, ask the user to `/cd ..` (or restart at the root) before editing/committing/shipping; don't mirror the root hooks into `daemon/` (drift). If you must continue, nothing blocks a merge, so chain each gate on its exit status (`node .claude/scripts/mark-pre-ship-confirmed.mjs <br> --quality <label> && gh pr merge …`) — #108 was merged after the marker script had refused.
