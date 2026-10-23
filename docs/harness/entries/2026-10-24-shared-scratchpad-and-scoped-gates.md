# Shared cross-worktree scratchpad, diff-scoped gates, and zero-spawn hook fast paths

- **date**: 2026-10-24
- **dimension**: INV
- **motivation**: Parallel AI sessions across git worktrees paid redundant verification, process-spawn, and LLM review costs on every commit/ship cycle: `make wt.new` took 31 s running two `npm ci` installs per worktree; `npm run check:fast` ran all 19 scripts (~45–50 s cumulative CPU, including `test:glossary` 18.5 s, `test:harness` 16.8 s, `test:agy-hooks` 10.3 s, `check:js` 7.1 s) even on 1-file branches and repeated them inside `make ship`; `agent-worktree-guard` and `worktree-policy-guard` spawned Python and `git` subprocesses on ordinary commands and worktree file edits (causing a live `PreToolUse` hook timeout on `git grep` during this session); and `scripts/auto-ship.mjs` spawned a 1–5 min `claude -p` LLM review even when deterministic `PROTECTED` or size gates already forced `NEEDS_HUMAN`.

## Edits

### `scripts/auto-ship.mjs`
- **change**: Exported `staticReasons({ files, lines, optOuts })` and checked it before spawning `claude -p` so changes that already require human review (`MAX_FILES`, `MAX_LINES`, `PROTECTED`, or `Harness-Entry` trailer opt-outs) skip the headless LLM review; added cross-worktree AI review caching by `(head, baseSha)` and shared `node_modules` symlink fallback via `scripts/agent-scratchpad.mjs`.
- **observed**: Follows `2026-10-21-ci-gate-fast-local-loop`, `2026-10-21-harness-experience-library`, and `2026-10-21-ledger-gate-edge-cases`; deterministic human-gated PRs now skip the 1–5 min `claude -p` call while keeping all `decide()` thresholds and `PROTECTED` patterns intact (`test/auto-ship.test.mjs`).
- **verdict**: helped

### `scripts/check-harness.mjs`
- **change**: Deduplicated `git ls-files --others --exclude-standard` in `ledgerInputs` and skipped the commit-by-commit `git rev-list` / `git show` loop when no changed file matches `isLedgerPath`.
- **observed**: Follows `2026-10-21-harness-experience-library` and `2026-10-21-ledger-gate-edge-cases`; non-harness branches avoid `1 + 2N` git subprocess spawns in `ledgerInputs` while all 19 tests in `test/check-harness.test.mjs` and `test/harness-library.test.mjs` pass.
- **verdict**: helped

### `.claude/hooks/agent-worktree-guard.mjs`
- **change**: Added an in-memory JSON command pre-filter in the Node wrapper so `pre-tool` only spawns `python3 guard.py` when the command contains both `git|gh|rm` and `worktree|push|pr|rm`, and `post-tool` only spawns `python3 guard.py` when the command contains `commit|push|pr|worktree|BR=|BRANCH=|--branch|-b|-B`.
- **observed**: Follows `2026-10-21-stop-guard-fewer-git-calls-per-session-checklist`; read-only git commands (`git status`, `git diff`, `git grep`, `git log`) and general shell commands no longer spawn Python or `git` on every tool use.
- **verdict**: helped

### `.claude/hooks/codex/agent-worktree-guard.mjs`
- **change**: Added the same `pre-tool` and `post-tool` command pre-filter to the Codex CLI hook wrapper before spawning `python3 guard.py`.
- **observed**: Codex `PreToolUse` and `PostToolUse` Bash hooks exit in-process with zero Python/git spawns on commands that cannot match any worktree guard rule.
- **verdict**: helped

### `.claude/hooks/antigravity/agy-bridge.mjs`
- **change**: Exported `toClaudeInput`, `toAgyOutput`, and `bridgeStep` and guarded `main()` with `isMain` (`realpathSync(process.argv[1])`) so `test/antigravity-hooks.test.mjs` can exercise translation contracts in-process while keeping subprocess integration coverage.
- **observed**: `npm run test:agy-hooks` dropped from 10.3 s (28 Node subprocesses) to 0.5 s while keeping full end-to-end `hooks.json -> agy-bridge.mjs -> agent-worktree-guard.mjs -> guard.py` verification.
- **verdict**: helped

### `.claude/hooks/worktree-policy-guard.mjs`
- **change**: Moved `.worktrees/` path and Tier-1 classification checks ahead of `resolveProjectDir` and `safeGit('branch --show-current')`.
- **observed**: Editing files inside `.worktrees/<branch>/` or Tier-1 paths now returns passthrough in memory with zero `git` subprocess spawns.
- **verdict**: helped

### `.claude/scripts/worktree-new.mjs`
- **change**: Linked `<wt>/node_modules` and `<wt>/daemon/node_modules` via symlink to `<mainRoot>` when `package-lock.json` SHA-256 matches, falling back to `npm ci` only when lockfiles differ or `<mainRoot>/node_modules` is absent.
- **observed**: Eliminates ~30 s and hundreds of MB of duplicate `npm ci` installs per new worktree when dependencies are unchanged from `main`.
- **verdict**: helped

### `scripts/agent-worktree-guard/guard.py`
- **change**: Made `detect_pretool_violation` lazily resolve `root`, `ledger`, and `list_git_worktrees` only when a command segment actually invokes `gh pr create|merge` or `rm -rf`, and added a `POSTTOOL_WORDS` / `worktree_create_branch` / `classify_completion_reason` pre-check in `hook_post_tool` before `resolve_guard_root`.
- **observed**: Follows `2026-10-21-stop-guard-fewer-git-calls-per-session-checklist`; `hook_pre_tool` and `hook_post_tool` spawn 0 `git` processes and perform 0 ledger I/O on non-matching commands, and `test_guard.py` runtime dropped from 81.3 s to 39.1 s.
- **verdict**: helped

### `.agents/skills/testing/SKILL.md`
- **change**: Documented the shared `<mainRoot>/.tmp/agent-scratchpad/` cache (`scripts/agent-scratchpad.mjs`) and the `--all` / `--no-cache` flags on `scripts/run-checks.mjs`.
- **observed**: Follows `2026-10-18-port-harness2-validator` and `2026-10-21-ci-gate-fast-local-loop`; warm `check:js` dropped from 7.07 s to 0.04 s user CPU and `test:glossary` dropped from 18.5 s to 3.0 s.
- **verdict**: helped

### `.agents/skills/ship-flow/SKILL.md`
- **change**: Documented shared `node_modules` symlinking in `make wt.new` and deterministic human-gate short-circuiting + review caching before `claude -p` in `scripts/auto-ship.mjs`.
- **observed**: Follows `2026-10-18-port-harness2-validator` and `2026-10-21-ci-gate-fast-local-loop`; aligns the shipping skill documentation with the scratchpad-backed local and PR gates.
- **verdict**: helped

## Lesson

- **cue**: Parallel AI worktree sessions experience hook timeouts, slow local gates, or wasted LLM review tokens when hooks and gate runners unconditionally spawn subprocesses across worktrees.
- **lesson**: Pre-filter hook inputs in-memory before spawning `python3` or `git` in `.claude/hooks/agent-worktree-guard.mjs` and `.claude/hooks/worktree-policy-guard.mjs`, short-circuit `claude -p` in `scripts/auto-ship.mjs` when deterministic `PROTECTED`/size gates already force `NEEDS_HUMAN`, and share content-addressed verification stamps across worktrees via `<mainRoot>/.tmp/agent-scratchpad/`.
- **evidence**: `.claude/hooks/agent-worktree-guard.mjs`, `.claude/hooks/antigravity/agy-bridge.mjs`, `scripts/auto-ship.mjs`, and `scripts/check-harness.mjs` rows above (`check:js` 7.07 s -> 0.72 s, `test:glossary` 18.5 s -> 3.0 s, `test:agy-hooks` 10.3 s -> 2.1 s, `test_guard.py` 81.3 s -> 39.1 s).
- **confidence**: high — directly measured before/after across all gates and verified against a live `PreToolUse` hook timeout on `git grep` in this session.
