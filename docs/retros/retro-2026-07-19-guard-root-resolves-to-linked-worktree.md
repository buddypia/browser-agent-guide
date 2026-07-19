# Retro 2026-07-19 — Guard resolves its ledger root to the linked worktree, not the main repo

## Trigger
repeated-friction + AI self-correction: `agent-worktree-guard confirm-pr` run from INSIDE a worktree
failed with "Ledger does not exist: <worktree>/.tmp/…/manual.json", forcing every guard command to be
re-run from the main checkout. While diagnosing, a prior ledger's "verified" root cause
(retro-2026-07-19-gh-pr-merge-delete-branch-from-worktree.md, `## Next` #1) was found to be FALSE.

## Facts
- `resolve_guard_root(cwd)` (`scripts/agent-worktree-guard/guard.py`): `root = git_root(cwd)`
  (`git rev-parse --show-toplevel`) which, from inside a LINKED worktree, returns the worktree's own
  toplevel. If that worktree has an owner marker, a redirect reads `ledger_root` from it (→ main). With
  NO owner marker (unregistered worktree), the function `return root` — the linked worktree — so the
  ledger is looked for at `<worktree>/.tmp/worktree-guard-ledger/…` which does not exist.
- Reproduced deterministically: `git worktree add --detach /tmp/bag-oldtest`; PRE-fix
  `resolve_guard_root(/tmp/bag-oldtest)` → `/private/tmp/bag-oldtest` (the worktree, NOT the main root).
  `agent-worktree-guard status` from inside it → `Ledger does not exist: /private/tmp/bag-oldtest/.tmp/…`.
- Two separate frictions were conflated in the prior ledger:
  (A) this root-resolution bug ("Ledger does not exist" from inside an unregistered worktree), and
  (B) the post-tool auto-registration not firing in this cmux-wrapped environment.
- **Correction of a prior "verified" claim**: the prior ledger's `## Next` #1 stated "`make wt.new`
  worktrees are never registered … (verified: `worktree-new.mjs` has no register call; `post-tool` hook
  does not auto-register)". The second clause is FALSE. `guard.py` `hook_post_tool` calls
  `maybe_register_created_worktree()` which DOES auto-register; `worktree_create_branch("make wt.new
  BR=x")` correctly returns `x`; and feeding a correct PostToolUse payload to `guard.py hook post-tool`
  registers the worktree. The false "verified" came from grepping the DISPATCHER
  (`.claude/hooks/agent-worktree-guard.mjs`, which only shells out to guard.py) instead of the
  IMPLEMENTATION (`guard.py`). (B) is therefore an environment issue (the live PostToolUse hook not
  delivering / not carrying the literal command in cmux), not a missing-logic bug.

## 5 Whys → Root Cause
1. Why did `confirm-pr` from inside the worktree fail "Ledger does not exist"? → `resolve_guard_root`
   returned the worktree path, so the ledger was sought in the worktree's `.tmp`.
2. Why did it return the worktree path? → `git_root` = `rev-parse --show-toplevel` = the linked
   worktree's toplevel, and the no-owner-marker fallback returned it verbatim.
3. Why was there no owner marker to redirect to main? → the worktree was unregistered (auto-registration
   had not fired — issue B).
4. Why did the design assume an owner marker would always exist? → in the common case (registered
   worktree) the marker redirect handles it; the "unregistered worktree, run from inside it" path was
   never exercised — the ledger ALWAYS lives under the main worktree, so `git_root` was the wrong base.
5. Why was issue B initially mis-diagnosed as "no auto-registration logic"? → the claim was "verified"
   against the dispatcher `.mjs` (which only forwards to guard.py) rather than the guard.py
   implementation, so the existing `maybe_register_created_worktree` was missed.

**Root cause(s) (the class-blocking point(s)):**
occurrence: `resolve_guard_root` bases the ledger root on `git_root` (the linked worktree's toplevel)
instead of the MAIN worktree, so a guard command run from inside an unregistered linked worktree resolves
to a non-existent per-worktree ledger. · detection: no test exercised "guard command run from inside an
unregistered linked worktree". · process: a root cause was written as "verified" from checking a
dispatcher shim rather than the implementation it forwards to.

## Class
worktree-context-command-footgun
recurrence_of: retro-2026-07-19-gh-pr-merge-delete-branch-from-worktree.md
Same broad class as the prior same-day ledger (a command misbehaving SPECIFICALLY because it runs from a
linked worktree), but a DIFFERENT mechanism (our own guard's ledger-root resolution vs gh's post-merge
checkout) — NOT a failed-prevention recurrence: #85's merge-guard deny neither covers nor was expected to
cover this. Recorded as a 2nd instance of the class. Blast radius: local governance tooling only
(`.tmp/worktree-guard-ledger/*` is gitignored per-machine runtime state). Reversibility: fully reversible
— the failure was a recoverable "Ledger does not exist" (worked around by running from the main checkout).

## Decision
- Tier: **① (Eliminate)** + **③ (regression test)**.
- **Why this tier:** the ledger ALWAYS lives under the main worktree, so "resolve to a linked worktree"
  is an invalid state. The fix makes it unrepresentable: a new `git_main_root(cwd)` resolves to the main
  repo via `git rev-parse --git-common-dir` (its parent), and `resolve_guard_root`'s no-owner-marker
  fallback returns `git_main_root(base)` instead of `git_root(base)`. From the main checkout this is
  identical to before (`--git-common-dir` → `.git` → parent = main); only the "from inside a worktree"
  case changes, and it now correctly lands on main. The registered-worktree owner-marker redirect is
  UNCHANGED (behavior preserved). Paired with ③: a regression test pins "resolve_guard_root from an
  unregistered linked worktree == main root". Tier ⑤/⑥ would be under-powered (a code defect, not a
  "remember to run it from main" advisory — the guard should just work from anywhere). No new hook (②)
  — the fix is internal to an existing function, covered by the test suite.
- Rejected tiers + reason (lightweight inner loop — clear code defect, Critic C2 only): ⑤ "document: run
  guard from the main checkout" REVISED(C2) — it leaves the footgun live and shifts the burden to memory;
  a structural resolution is cheap and correct. No new hook considered (no new tool call to gate).
- (tier ② only) hook failure mode: N/A — no hook added.

## Cure (existing instances)
- [x] `scripts/agent-worktree-guard/guard.py` — `resolve_guard_root` no-marker fallback now returns the
  main root; added `git_main_root()`. — this PR
- [x] The stale prior-ledger claim is CORRECTED in this ledger's Facts/5-Whys (append-only: the prior
  ledger is not rewritten; this ledger is the authoritative correction and is linked via `recurrence_of`).
- [x] No other caller resolves a ledger root off `git_root`; grep confirms `resolve_guard_root` is the
  single entry point used by hooks/CLI.

## Prevent (prevention mechanism)
- `scripts/agent-worktree-guard/guard.py` — `git_main_root()` + `resolve_guard_root` fallback. — this PR
- `scripts/agent-worktree-guard/test_guard.py` —
  `test_resolve_guard_root_from_unregistered_worktree_returns_main_root` (this guard suite's 14th test). — this PR
- negative test (EXECUTED against PRE-fix code): `resolve_guard_root(<unregistered linked worktree>)` →
  `/private/tmp/bag-oldtest` (the worktree, ≠ main root); `status` from inside it →
  `Ledger does not exist: /private/tmp/bag-oldtest/.tmp/worktree-guard-ledger/manual.json`.
  POST-fix: `resolve_guard_root(...)` == main root; `status` resolves to main's ledger.
- positive test (no regression on legitimate paths): full `test_guard.py` suite `14/14 OK` (the 13
  pre-existing tests — registered-worktree lifecycle, owner-marker redirect, cross-session, cleanup —
  all still pass; from the main checkout `git_main_root` == the old `git_root` result).

## Verify cmd
```bash
cd scripts/agent-worktree-guard
python3 -m unittest test_guard.AgentWorktreeGuardTest.test_resolve_guard_root_from_unregistered_worktree_returns_main_root -v
python3 -m unittest test_guard -v   # full suite, expect 14/14
```

## Next
- [ ] (issue B, environment) The live PostToolUse `agent-worktree-guard.mjs post-tool` hook does not
  auto-register `make wt.new` worktrees in this cmux-wrapped setup, even though the guard.py logic is
  correct (verified by direct payload injection). Diagnose whether cmux delivers PostToolUse with a
  wrapped/shimmed `tool_input.command` that `worktree_create_branch` can't parse, or does not fire the
  hook at all — this is upstream of guard.py (hook delivery), so no guard.py change is warranted until
  the delivery gap is confirmed. With this PR's fix, the manual recovery (`register` / ship commands) now
  works from inside the worktree too, so the friction is much reduced.
- Process note (long-term memory for C6): a root cause must be verified against the IMPLEMENTATION, not a
  dispatcher/wrapper that merely forwards to it — "verified" was written from grepping the `.mjs`
  dispatcher, not `guard.py`. Confirm the artifact actually contains the logic before claiming "verified".
