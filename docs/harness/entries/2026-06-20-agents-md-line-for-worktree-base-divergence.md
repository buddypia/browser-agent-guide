# Answer worktree base divergence with an AGENTS.md gotcha line

- **date**: 2026-06-20
- **dimension**: INV
- **motivation**: PR #14 — a concurrent session merged `4a425a0` (deleting files the branch depended on) while the worktree's local `origin/main` was never re-fetched; the Stop-time staleness guard reported "fresh" and the conflict surfaced only at merge (`docs/retros/retro-2026-06-20-worktree-base-remote-divergence.md`).

## Edits

### `AGENTS.md`
- **change**: Tier-5 prevention: one "Conventions & gotchas" line describing the staleness guard's blind spot and prescribing `git fetch origin main && git diff --name-status origin/main...HEAD` before shipping.
- **observed**: The class recurred ten days later in PR #67: a 2-commit drift let `git add -A` sweep in unrelated `.gitignore`/`guard.py` diffs and `.pyc` files, although the line was present at incident time (`docs/retros/retro-2026-06-30-worktree-base-remote-divergence-recurrence.md`, Why 3). The follow-up moved the check into code (`mark-pre-ship-confirmed.mjs` warning, #68 squash `9f252aa`; `make ship` fetches by itself, #93 squash `cfcd7a0`).
- **verdict**: no observed effect

## Lesson

- **cue**: A failure that lives in tool or git state (a stale ref, a command's side effect) and that an agent only notices by running a command at the right moment.
- **lesson**: Do not answer it with an AGENTS.md line; put the check where the command runs (a hook, or the ship script) so it fires without the agent remembering.
- **evidence**: `AGENTS.md` row — the line was in context and the same class recurred in PR #67.
- **confidence**: medium — one recurrence, but the recurrence retro confirmed the line was active at the time.
