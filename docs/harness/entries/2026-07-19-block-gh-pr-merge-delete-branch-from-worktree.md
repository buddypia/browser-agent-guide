# Block gh pr merge --delete-branch from a worktree

- **date**: 2026-07-19
- **dimension**: INV
- **motivation**: `docs/retros/retro-2026-07-19-gh-pr-merge-delete-branch-from-worktree.md`: `gh pr merge 84 --squash --delete-branch` run from a linked worktree merged on the remote, then its local post-step failed ("failed to run git: 'main' is already used by worktree") and still exited 0, leaving the remote branch undeleted; an agent could misread it as a failed merge. The REVIEW.md scaffold (`review-report.mjs:265`) had recommended the flag. Commit `8ac3a5f` (#85).

## Edits

### `.claude/scripts/merge-guard.mjs`
- **change**: PreToolUse deny for `gh pr merge` with `--delete-branch`/`-d` only when the default branch is checked out in another worktree (`git worktree list --porcelain`); passes through from the main checkout; the deny reason reaches the model and redirects to `gh pr merge --squash` + `agent-worktree-guard cleanup`. New 6-test contract `merge-guard.test.mjs`.
- **observed**: The retro exercised the deny and the main-checkout passthrough by hand; no later retro, commit or PR records the deny firing or the footgun recurring, which fits both "agents stopped adding the flag" and "the guard never had a chance to fire". Watch for a deny citing `--delete-branch` in a transcript, or `already used by worktree` output after a `gh pr merge`.
- **verdict**: pending

### `.claude/scripts/lib/review-report.mjs`
- **change**: The REVIEW.md scaffold stopped recommending `--delete-branch` and says cleanup deletes the remote branch.
- **observed**: Removed the one place that recommended the flag; the scaffold's Stop gate was itself removed in #120, and it is not isolated from the hook.
- **verdict**: confounded

### `AGENTS.md`
- **change**: Clause at the ship instruction: no `--delete-branch`/`-d` from a worktree; verify an exit-0 outcome with `gh pr view`.
- **observed**: #145 moved the rule into `.agents/skills/ship-flow/SKILL.md`, and `scripts/auto-ship.mjs` merges without the flag; hook, scaffold, skill text and auto-ship changed together, so the prose is not isolated.
- **verdict**: confounded

## Lesson

- **cue**: A tool command that exits 0 while partly failing in one execution context, so the agent can read its output as plain success or plain failure.
- **lesson**: Block that exact call with a PreToolUse deny hook narrowed by a context predicate so it never fires where the command works; use deny rather than a user-only warning so the reason reaches the model, and correct any harness text that recommends the call.
- **evidence**: `.claude/scripts/merge-guard.mjs` row (pending) and the retro's two-round argument that a warning never reaches the model; no run yet shows the deny preventing a misread.
- **confidence**: low — every supporting row is pending or confounded.
