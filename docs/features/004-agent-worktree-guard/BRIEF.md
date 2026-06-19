# Agent Worktree Guard Brief

## Summary

Implement a ledgered worktree guard for AI sessions. The guard must record only
worktrees owned by the current session, block raw unsafe worktree operations in
Claude/Codex hooks, update a local checklist after completion events, and allow
cleanup only after explicit confirmation with matching owner markers.

## Why

Parallel AI sessions can leave behind or accidentally delete Git worktrees. A
natural-language rule is not enough because shell commands, PR creation, and
cleanup happen across tool boundaries. This feature adds deterministic guard
layers: wrapper CLI, Claude/Codex hooks, and a Git pre-push template.

## Scope

- `agent-worktree-guard` / `awtg` CLI wrappers.
- Per-session ledger under `.tmp/worktree-guard-ledger/`.
- Checklist under `.tmp/.worktree_status.md`.
- Per-worktree owner marker under `.tmp/.agent_worktree_owner.json`.
- Claude Code, Codex, and Git hook integration.
- Safety documentation and focused lifecycle tests.

## Out Of Scope

- Global installation or global `core.hooksPath` changes.
- Deleting worktrees created by other users or sessions.
- Treating shell interception as the only security boundary.
