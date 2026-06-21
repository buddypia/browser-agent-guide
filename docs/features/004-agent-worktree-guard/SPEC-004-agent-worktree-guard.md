# SPEC-004: Agent Worktree Guard

## 0. AI 구현 계약

### 0.0 Project Context

This feature changes this repository directly. The target is the repository
root, not a generated project under `output/<slug>`.

### 0.1 Target Files

| Path | Change |
| --- | --- |
| `scripts/agent-worktree-guard/guard.py` | Implement CLI, ledger, checklist, owner marker, hook, and Git hook logic. |
| `scripts/agent-worktree-guard/agent-worktree-guard` | Executable CLI wrapper. |
| `scripts/agent-worktree-guard/awtg` | Short-name executable wrapper. |
| `scripts/agent-worktree-guard/README.md` | Usage, hook coverage, activation, and bypass-risk docs. |
| `scripts/agent-worktree-guard/test_guard.py` | Temp-repo lifecycle regression test. |
| `.claude/hooks/agent-worktree-guard.mjs` | Claude Code wrapper around the Python guard. |
| `.claude/hooks/codex/agent-worktree-guard.mjs` | Codex adapter around the Python guard. |
| `.claude/hooks/MULTI-CLI.md` | Multi-CLI hook coverage documentation. |
| `.claude/scripts/lib/hook-registry.mjs` | Claude hook registry entries. |
| `.claude/scripts/ci/validators/validate-hooks.mjs` | Accept official worktree lifecycle events in hook validation. |
| `.claude/scripts/_migrations/generate-unified-registry.mjs` | Keep registry migration event allowlist aligned. |
| `.claude/settings.json` | Generated hook settings from registry. |
| `.codex/hooks.json` | Codex hook entries. |
| `.agents/hooks.json` | Antigravity hook entries. |
| `.githooks/pre-push` | Tracked Git pre-push template. |
| `.gitignore` | Runtime ledger/status/marker ignore entries. |
| `data/schemas/hook-registry.schema.json` | Accept official worktree lifecycle events in registry schema. |
| `tests/unit/hook-essential-set.test.mjs` | Assert intentional multi-event guard registrations. |
| `tests/unit/hook-system.test.mjs` | Accept official worktree lifecycle events in hook tests. |

### 0.2 State / Hook

Runtime state is local and ignored:

| Path | Purpose |
| --- | --- |
| `.tmp/.worktree_status.md` | Current session checklist. |
| `.tmp/worktree-guard-ledger/<session_id>.json` | Current session ledger. |
| `.tmp/.agent_worktree_owner.json` | Owner marker inside a registered worktree. |

Hook surfaces:

- Claude Code: SessionStart, PreToolUse/Bash, PostToolUse/Bash, Stop,
  WorktreeCreate, WorktreeRemove.
- Codex: SessionStart, PreToolUse/Bash aliases, PostToolUse/Bash aliases, Stop.
- Git: `.githooks/pre-push` template.

### 0.3 Error Handling

- Hook failures fail open unless the command is explicitly denied.
- Cleanup without `--confirmed` fails closed.
- Cleanup fails if the ledger entry is missing, the owner marker is missing, or
  the owner marker does not match the session and ledger root.
- Cleanup removes its own owner marker before `git worktree remove`, restores it
  if Git still refuses removal, and does not use `--force` unless requested.

### 0.4 Data Schema

| Record | Field | Type | Meaning |
| --- | --- | --- | --- |
| Ledger | `session_id` | string | Sanitized hook/session id. |
| Ledger | `pr_confirmation_prompted` | boolean | Whether the required PR prompt was already emitted. |
| Ledger | `pr_confirmation_confirmed` | boolean | Whether a human Yes/進行 was recorded after the briefing. |
| Ledger worktree | `path` | string | Absolute worktree path. |
| Ledger worktree | `branch` | string/null | Checked out branch. |
| Ledger worktree | `done` | boolean | Checklist completion state. |
| Ledger worktree | `done_reason` | enum/null | `commit`, `push`, `pr`, or `manual`. |
| Ledger worktree | `pr_merged_at` | string/null | UTC timestamp set only after successful PR merge or verified manual recovery. |
| Owner marker | `session_id` | string | Owning session. |
| Owner marker | `ledger_root` | string | Ledger root to prevent cross-repo cleanup. |
| Owner marker | `worktree_path` | string | Worktree path the marker belongs to. |

### 0.5 API Contract

No HTTP or application API changes.

### 0.6 NFR

| Category | Requirement |
| --- | --- |
| Safety | Never delete a worktree outside the current session ledger. |
| Safety | Never delete a worktree without a matching owner marker. |
| Determinism | Use wrapper CLI, Claude hooks, Codex hooks, and Git hooks instead of relying on natural-language rules only. |
| Git compatibility | Parse worktrees with `git worktree list --porcelain -z`. |
| Operability | Do not set global `core.hooksPath`; document repo-local activation. |

### 0.7 AI Logic & Prompts

When all ledger worktrees are complete and PR confirmation has not been
confirmed, the guard must emit a generated work briefing and include exactly:

```text
すべてのworktreeの作業が完了しました。PR（プルリクエスト）を作成しますか？
(모든 worktree 작업이 완료되었습니다. PR(풀 리퀘스트)을 생성하시겠습니까?)
```

### 0.8 Safety & Guardrails

PreToolUse blocks:

- raw `git worktree add`
- raw `git worktree remove`
- `rm -rf` aimed at a Git worktree root
- `git push --no-verify`
- `gh pr create` / `gh pr merge` before `confirm-pr --confirmed`

### 0.9 Observability

Evidence is local and inspectable through `agent-worktree-guard status`, the
ledger JSON, the checklist Markdown, and hook outputs.

### 0.10 Rollout

The CLI and hook definitions are committed. Codex users must review/trust the
project hook changes through the normal Codex hook browser. Git pre-push is
available after repo-local `git config core.hooksPath .githooks`.

### 0.11 Rollback

Rollback removes the CLI, hook registrations, generated settings changes, Git
hook template, tests, docs, and `.gitignore` additions. Runtime `.tmp` state is
local and ignored.

## 1. 개요

Agent Worktree Guard adds deterministic ownership tracking and cleanup controls
for AI-created Git worktrees. It combines a common CLI, Claude Code hooks, Codex
hooks, and a Git pre-push template so worktree safety does not depend only on
natural-language instructions.

## 2. 기능 요구사항

| ID | Requirement | Acceptance |
| --- | --- | --- |
| FR-00401 | Provide `agent-worktree-guard` and `awtg` CLI wrappers. | `init`, `add`, `register`, `mark-done`, `audit`, `cleanup --confirmed`, and `status` run from the wrapper path. |
| FR-00402 | Record only current-session worktrees. | Ledger entries are created only by `add`/`register`/hook-owned creation and include matching owner markers. |
| FR-00403 | Enforce unsafe-operation blocks through hooks. | Claude/Codex/Antigravity PreToolUse denies raw worktree add/remove, worktree-root `rm -rf`, `git push --no-verify`, and PR create/merge before confirmation. |
| FR-00404 | Update checklist after completion events. | `mark-done` and PostToolUse completion events set the Markdown item to `[x]`. |
| FR-00405 | Prompt for PR confirmation after all work is complete. | `audit`/Stop emits a generated work briefing plus the exact Japanese/Korean prompt until `confirm-pr --confirmed`. |
| FR-00406 | Cleanup only owned, merged ledger worktrees. | `cleanup --confirmed` verifies marker/session/root, requires `pr_merged_at`, and leaves unregistered worktrees alone. |
| FR-00407 | Support Antigravity CLI hooks. | `.agents/hooks.json` wires SessionStart/PreToolUse/PostToolUse/Stop for `run_command` through the shared guard. |

## 3. Verification

Required checks:

- `python3 -m py_compile scripts/agent-worktree-guard/guard.py scripts/agent-worktree-guard/test_guard.py`
- `python3 scripts/agent-worktree-guard/test_guard.py`
- `python3 -m json.tool .codex/hooks.json >/dev/null`
- `python3 -m json.tool .agents/hooks.json >/dev/null`
- `node .claude/scripts/regen-hooks-settings.mjs --check`
- Acceptance commands listed in the user request.

## 4. Risks

- Codex shell interception is incomplete, so the CLI wrapper and Git hook remain
  part of enforcement.
- Git hooks can be bypassed by users, so AI hook layers block `git push
  --no-verify` in tool calls.
- `WorktreeCreate` replaces Claude Code default behavior; this feature routes it
  into `.worktrees/feature/claude-<name>` and registers it in the ledger.
