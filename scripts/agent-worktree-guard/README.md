# Agent Worktree Guard

Agent Worktree Guard (`agent-worktree-guard`, short name `awtg`) prevents AI
sessions from abandoning or deleting Git worktrees that they do not own.

## Commands

Add this directory to `PATH`, or invoke the wrapper by path:

```bash
export PATH="$PWD/scripts/agent-worktree-guard:$PATH"
agent-worktree-guard init
awtg status
```

Supported commands:

```bash
agent-worktree-guard init
agent-worktree-guard add <path> [base]
agent-worktree-guard register <path>
agent-worktree-guard mark-done <path> --reason <commit|push|pr|manual>
agent-worktree-guard confirm-pr --confirmed
agent-worktree-guard mark-merged [path] [--pr <number-or-url>]
agent-worktree-guard audit
agent-worktree-guard cleanup --confirmed
agent-worktree-guard status
```

`add` wraps `git worktree add`, records only the current session ledger, writes
`.tmp/.agent_worktree_owner.json` inside the new worktree, and adds a pending
line to `.tmp/.worktree_status.md`.

Successful standard worktree creation commands such as `make wt.new
BR=feature/x` and `worktree-new.mjs --branch feature/x` are also registered from
the PostToolUse hook. That keeps the cleanup ledger aligned with the normal
Claude/Codex/Antigravity worktree entrypoint.

`confirm-pr --confirmed` is the deterministic marker the AI must run only after
it has briefed the work and the human answered Yes / 進行 to PR creation.

`mark-merged` is a recovery command for cases where a successful `gh pr merge`
was not observed by the PostToolUse hook. Normal Claude/Codex/Antigravity
sessions record merge automatically after a successful `gh pr merge`.

`cleanup` refuses to run without `--confirmed`, and it also refuses to remove a
worktree until PR merge is recorded. It removes only ledger entries whose owner
marker matches the same session and ledger root. It uses `git worktree remove`
first; `--force` is a separate explicit Git worktree removal flag, not a policy
bypass. After the worktree is removed it also tidies the work it left behind:
the now-merged local branch is force-deleted (`git branch -D`, safe because
cleanup only runs after the PR merge is recorded) and any stash whose entry is
based on that branch (`WIP on <branch>` / `On <branch>`) is dropped. Stashes on
other branches are never touched, and every deleted branch / dropped stash is
reported on stderr plus the `cleaned N worktree(s)` summary line
(`branches deleted: N`, `stashes dropped: N`).

## Runtime Files

The guard creates local runtime state and keeps it ignored:

```text
.tmp/.worktree_status.md
.tmp/worktree-guard-ledger/<session_id>.json
.tmp/.agent_worktree_owner.json
```

Each ledger contains only worktrees registered by that session. Other users,
other AI sessions, and unregistered worktrees are inspected only enough to avoid
deleting or blocking them by accident.

## Hook Coverage

Claude Code is wired through `.claude/scripts/lib/hook-registry.mjs`; run
`node .claude/scripts/regen-hooks-settings.mjs` after registry edits. The
generated `.claude/settings.json` includes:

- `SessionStart`: inject ledger state.
- `PreToolUse` for Bash: block raw `git worktree add/remove`, `rm -rf` aimed at
  Git worktree roots, `git push --no-verify`, and `gh pr create/merge` before
  the human PR confirmation marker exists.
- `PostToolUse` for Bash: mark ledger worktrees done after successful
  `git commit`, `git push`, or `gh pr create`; record merge after successful
  `gh pr merge`; register successful standard worktree creation commands so
  cleanup is scoped to the current CLI session.
- `Stop`: if every ledger worktree is done, continue the agent with a generated
  work briefing and the exact PR question until `confirm-pr --confirmed`; after
  confirmation it continues until merge is recorded; after merge it continues
  until `cleanup --confirmed` removes the worktree and prints `# PR 承認後の完了報告`.
  The briefing surfaces each worktree's full 11-section approval review
  (`REVIEW.md`: 承認依頼 / 状態サマリー / コミット情報 / PR Draft / 修正ファイル /
  変更内容 / なぜ / トレードオフ / リスク・Rollback / 残タスク / セッション改善) so
  the PR question is answered from the review content, not a bare yes/no — and
  when `REVIEW.md` is missing it points at the scaffold command (the
  `worktree-review-report-guard` Stop hook still blocks until that report is
  complete).
- `WorktreeCreate` / `WorktreeRemove`: route Claude `--worktree` lifecycle
  through the same ledger and owner-marker checks.

Codex is wired in `.codex/hooks.json` with the same SessionStart, PreToolUse,
PostToolUse, and Stop behavior. Codex project hooks still require the normal
Codex trust review, and shell interception is not a complete security boundary,
so the wrapper CLI and Git hook are kept as additional layers.

Antigravity is wired in `.agents/hooks.json` with the same shared guard for
`run_command` SessionStart/PreToolUse/PostToolUse coverage, plus the same
Stop-time shipping/review report gates via Antigravity adapters. Local
`.agents/config.json` remains ignored because `worktree-init.mjs` writes
per-machine `GIT_WORK_TREE` / `GIT_DIR` values there.

## Git Hook

`.githooks/pre-push` checks ledger-owned worktrees before push:

- if a registered worktree is being pushed but `.tmp/.worktree_status.md` is
  missing, the push is rejected;
- if the pushed branch corresponds to an incomplete ledger entry, the push is
  rejected and the user is asked to update the checklist.

This repository does not set `core.hooksPath` automatically. To enable the
tracked Git hook for this repo only:

```bash
git config core.hooksPath .githooks
```

Do not set `core.hooksPath` globally without reviewing existing hooks. Git hooks
can also be bypassed with options such as `--no-verify`, so Claude/Codex hooks
block `git push --no-verify` in AI tool calls.

## Safety Notes

- Cleanup never touches a path absent from the current session ledger.
- Cleanup never touches a path without a matching owner marker.
- Cleanup never touches an owned worktree until PR merge is recorded.
- Branch deletion targets only the cleaned worktree's own branch (never `main`),
  and stash drop targets only stashes based on that exact branch — work on other
  branches is never destroyed, and every removal is reported (no silent drop).
- Standard `make wt.new` worktrees enter the ledger from the successful hook
  event, so cleanup removes only worktrees created or registered by that session.
- Worktree inspection uses `git worktree list --porcelain -z`.
- Hook command parsing uses `shlex` tokenization and Git argument structure for
  common shell command forms, but shell hooks remain defense in depth rather
  than the only enforcement layer.
- If all registered worktrees are complete, the required approval prompt begins:

```text
以下の worktree 作業は完了状態です。
内容を確認し、merge / cleanup に進めてよいか承認してください。
```

The hook output must also include the 11-section `REVIEW.md` approval review
before that human decision, so the user can answer from evidence instead of a
bare yes/no prompt.
