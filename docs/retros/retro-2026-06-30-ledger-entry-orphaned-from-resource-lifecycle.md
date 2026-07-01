# Retro 2026-06-30 — Ledger entry orphaned from its resource's own lifecycle

## Trigger
near-miss / bypassed-prevention: a stale `agent-worktree-guard` ledger entry
(`feature/bag-memo-skill`) permanently blocked bare `cleanup --confirmed`, forcing a
`--path`-scoped workaround while closing an unrelated PR.

## Facts
- `scripts/agent-worktree-guard/guard.py`'s `verify_owner_marker(item, session_id, root)`
  authorizes `mark-merged` and the internal `_remove_worktree_item()` (called by `cleanup`) by
  reading an "owner marker" JSON file that lives INSIDE the worktree's own directory:
  `<worktree>/.tmp/.agent_worktree_owner.json`.
- The `feature/bag-memo-skill` entry: PR #63, genuinely merged 2026-06-29T02:26:17Z (confirmed
  via `gh pr view 63 --json state,mergedAt`; both local and remote branches already gone). Its
  worktree directory had already been removed by an earlier `cleanup` run, but the ledger entry
  itself was left with `status:"done", done_reason:"commit", pr_merged_at:null` in
  `.tmp/worktree-guard-ledger/manual.json` (the shared ledger used when `session_id` resolves to
  "manual" — e.g. running from the main checkout).
- Because the directory (and the marker file inside it) no longer existed,
  `verify_owner_marker()` hard-failed with `Owner marker missing or invalid: <path>` on every
  `mark-merged <path>` attempt. Since `pr_merged_at` could therefore never be set, a bare
  `cleanup --confirmed` (the primary no-`--path` invocation) refused with "not yet merged" for
  the WHOLE ledger, not just this entry — blocking cleanup of every other open worktree sharing
  `manual.json`.
- Workaround at the time: `cleanup --confirmed --path <worktree>` scoped to only the entries
  that could still resolve their own marker.
- All downstream git-mutating steps inside `_remove_worktree_item` (`delete_local_branch`,
  `delete_remote_branch`, `drop_branch_stashes`) are already best-effort/idempotent (no-op if the
  branch/stash is already gone), independent of this incident.

## 5 Whys → Root Cause
1. Why did `cleanup --confirmed` refuse forever for this entry? → `pr_merged_at` was never set,
   because `mark-merged` always failed.
2. Why did `mark-merged` always fail? → `verify_owner_marker()` requires reading a JSON file that
   lives inside the worktree's own directory, and that directory no longer existed.
3. Why does the authorization check live inside the resource it authorizes? → the marker's
   purpose is to record which session owns a *live* worktree, so co-locating it with that
   worktree is the natural, simplest placement for the common case.
4. Why didn't the design account for the directory being removed some other way? → nothing else
   in this repo removes a worktree directory except this guard's own `cleanup`, in the common
   case — but a plain `git worktree remove` run outside the guard, or a PR merged via the GitHub
   web UI (skipping the local flow entirely), are both realistic in a repo whose designed mode is
   many concurrent human + AI sessions.
5. Why did this go undetected until it actually blocked something? → there was no test exercising
   "worktree directory already gone before `mark-merged`/`cleanup` is attempted" — only the
   still-live-directory paths (normal cleanup, cross-session resolution via a still-readable
   marker) were covered.

**Root cause(s) (the class-blocking point(s)):**
occurrence: an authorization/bookkeeping invariant (the owner marker) is physically co-located
inside a resource (the worktree directory) whose deletion is not exclusively managed by the code
that reads that invariant — so once the resource is gone by any other path, the invariant becomes
permanently unreadable and the code that requires it (`verify_owner_marker`) treated "unreadable"
as an unconditional hard failure rather than a resolvable case · detection: no test exercised the
"resource already gone before the guard's own cleanup runs" precondition.

## Class
ledger-entry-orphaned-from-resource-lifecycle
recurrence_of: none
not a true one-off — the underlying mechanism (an authorization marker co-located inside a
directory that routine tooling and humans both regularly delete out-of-band) can recur any time a
worktree is removed by something other than this guard's own `cleanup`, which this repo's designed
concurrent-worktree usage makes plausible; classified as a recurring class with its first
observed/cured instance. Blast radius: local governance tooling only
(`.tmp/worktree-guard-ledger/*.json` is gitignored, per-machine runtime state — not tracked
source, not shared/remote infrastructure). Reversibility: fully reversible — the worst-case
failure mode (a permanently-open ledger entry blocking bare `cleanup --confirmed`) is annoying but
safe: it does not corrupt data or take a wrong destructive action, and was already recoverable via
a `--path`-scoped workaround even before this fix.

This is distinct from the existing `orphaned-guard-trigger` class
(`retro-2026-06-20-orphaned-ship-gate.md`, `retro-2026-06-20-dead-trigger-detector.md`): that
class is a HOOK's TRIGGER PATTERN matching nothing after a command implementation was deleted (a
string-coupling failure mode). This incident is a DATA AVAILABILITY invariant — bookkeeping state
physically co-located with a resource that can be destroyed out-of-band by something else's
independent lifecycle.

## Decision
- Tier: **① (Eliminate)** combined with **③ (regression test gate)**.
- **Why this tier:** the fix changes the underlying authorization MODEL so the invalid
  "zombie, can-never-be-resolved" state is no longer representable: `verify_owner_marker()` now
  treats "the worktree directory does not exist" as a valid, always-resolvable case (an absent
  resource has nothing left to protect from cross-session hijacking) rather than an error
  condition — a structural elimination of the invalid state, not a hook/gate bolted on top of the
  old behavior. `_remove_worktree_item()` mirrors this: when the path is already gone, it skips
  both the marker unlink/restore dance and the `git worktree remove` call (which would fail
  anyway, since git no longer tracks a removed worktree) and simply reconciles the ledger status
  to `"cleaned"`, logging an informational line. This is paired with tier ③: a new regression
  test (`test_mark_merged_and_cleanup_reconcile_stale_entry_after_directory_already_gone`) pins
  the contract so a future refactor of these two functions cannot silently reintroduce the
  hard-fail. Tier ① is the ceiling of the taxonomy — no higher tier applies, and tier ⑤/⑥ would
  be under-powered (a rule/reminder cannot fix a function's behavior; this is a code defect
  affecting every session sharing a ledger, not a "remember to do X" situation). No new tier-②
  hook is warranted — there is no new tool call to gate; the fix is internal to an existing CLI's
  authorization logic, already covered by the test suite going forward.
- Rejected tiers + reason: an independent adversarial Critic (opus, run in a separate context)
  evaluated this proposal against the full C1–C6 checklist and APPROVED at round 1 with no
  REVISE — no alternative tier was proposed or rejected in this loop.
- (tier ② only) hook failure mode: N/A — no new hook was added.

## Cure (existing instances)
- [x] The one live production instance — `feature/bag-memo-skill` in the real
  `.tmp/worktree-guard-ledger/manual.json` (not a test fixture) — was reconciled using the fixed
  script directly: `guard.py --repo <main> --session-id manual mark-merged <path>` then
  `cleanup --confirmed --path <path>`. Backed up first to
  `.tmp/manual.json.bak-before-reconcile`. Confirmed via `agent-worktree-guard status`: the entry
  now shows `cleaned (commit) / pr-merged`.
- [x] No other live instances found: `agent-worktree-guard status` shows every other tracked
  worktree entry already at `status: cleaned`.

## Prevent (prevention mechanism)
- `scripts/agent-worktree-guard/guard.py` — `verify_owner_marker()` returns `{}` (skips the
  marker check) when `Path(item["path"]).exists()` is `False`; `_remove_worktree_item()` skips the
  marker unlink/restore dance and the `git worktree remove` call in the same case, reconciling the
  ledger status to `"cleaned"` directly (this PR, commit `5b17765`).
- `scripts/agent-worktree-guard/test_guard.py` —
  `test_mark_merged_and_cleanup_reconcile_stale_entry_after_directory_already_gone` (this PR).
- negative test (EXECUTED): running the new test against the PRE-fix code fails with the exact
  real production error:
  ```
  AssertionError: 1 != 0 : stdout=
  stderr=agent-worktree-guard: Owner marker missing or invalid: <tmp>/.worktrees/feature/goneexternally/.tmp/.agent_worktree_owner.json
  ```
  Running it against the POST-fix code passes (`ok`).
- positive test (blocking gate = the test suite): the full 13-test suite is green post-fix
  (`Ran 13 tests ... OK`) — the 12 pre-existing tests (live-worktree cleanup, cross-session
  resolution, unmerged-worktree warn-and-refuse, branch/remote/stash deletion) all continue to
  pass unchanged, i.e. 0 regressions on legitimate lifecycle paths.

## Verify cmd
```bash
cd scripts/agent-worktree-guard
python3 -m unittest test_guard.AgentWorktreeGuardTest.test_mark_merged_and_cleanup_reconcile_stale_entry_after_directory_already_gone -v
python3 -m unittest test_guard -v   # full suite, expect 13/13
```

## Next
- none
