# Retro 2026-07-19 — `gh pr merge --delete-branch` from a worktree exits 0 while partially failing

## Trigger
repeated-friction / near-miss during the mandated ship flow: `gh pr merge 84 --squash --delete-branch`
run from a linked worktree merged the PR on the remote but its local post-step aborted with
"failed to run git", exited 0, and left the remote branch undeleted — an output an AI can misread
as "the merge failed".

## Facts
- Command: `cd <main>/.worktrees/refactor/bag-skill-efficiency && gh pr merge 84 --squash --delete-branch`.
- Observed stdout: `failed to run git: fatal: 'main' is already used by worktree at '<main checkout>'`
  followed by `---exit=0---`.
- `gh pr view 84 --json state,mergedAt,mergeCommit` → `state:MERGED`, `mergeCommit:5f3b8d6…`,
  `mergedAt:2026-07-19T09:08:47Z` — the REMOTE merge succeeded.
- `git ls-remote --heads origin refactor/bag-skill-efficiency` → the branch still existed (the
  `--delete-branch` remote deletion never ran because the local checkout step aborted first).
- Recovery: `agent-worktree-guard cleanup --confirmed --path <wt>` deleted the remote branch via its
  own idempotent `git push origin --delete` (Remote branch cleanup: deleted).
- The repo's REVIEW.md scaffold generator recommended the flag: `.claude/scripts/lib/review-report.mjs`
  `renderTemplate` line 265 — "`gh pr merge --squash` で PR を merge（`--delete-branch` を付ければ remote も即削除）".

## 5 Whys → Root Cause
1. Why was the remote branch left undeleted? → `gh pr merge --delete-branch` deletes the remote branch
   AFTER its local post-merge step, and that local step aborted first.
2. Why did the local step abort? → `gh` switches the local repo off the merged head branch to the
   default branch (`git checkout main`) before deleting the local branch; `main` is checked out in the
   PRIMARY worktree, so from a LINKED worktree `git checkout main` is refused
   ("'main' is already used by worktree").
3. Why was `--delete-branch` used from a worktree at all? → the REVIEW.md scaffold
   (`review-report.mjs:265`) actively recommended it; and `--delete-branch`/`-d` is a widely-known gh
   flag an AI may add from general knowledge without reading any doc.
4. Why is the flag redundant even when it works? → `agent-worktree-guard cleanup` (the mandated
   post-merge step) ALREADY deletes the remote branch (`git push origin --delete`, best-effort/idempotent).
5. Why did the exit-0-but-errored outcome go undetected as an AI-misunderstanding risk? → no tool-time
   signal distinguished this case; `exit 0` + "failed to run git" is ambiguous, so an AI could report
   "merge failed" or retry rather than verify state.

**Root cause(s) (the class-blocking point(s)):**
occurrence: the ship flow (mandated to run FROM a worktree) recommended/permitted
`gh pr merge --delete-branch`, which structurally fails its local post-step whenever `main` is checked
out in another worktree, exiting 0 with a partial failure. · detection: no tool-time interceptor warned
that this exact command from a linked worktree is a footgun, and the exit code masks the partial failure.

## Class
worktree-context-command-footgun
recurrence_of: none
Recurring class (fires on every worktree ship that includes `--delete-branch`/`-d`; the project MANDATES
merging from a worktree), with this as its first observed/cured instance. Blast radius: local + one
externally-visible action — but the merge itself SUCCEEDS; the only residue is a leftover remote branch.
Reversibility: fully reversible — the leftover remote branch is auto-recovered by `cleanup`; the risk is
AI MISUNDERSTANDING (reading exit-0 "failed to run git" as merge failure), not data loss.
Distinct from `ledger-entry-orphaned-from-resource-lifecycle` (2026-06-30, a guard-ledger DATA
AVAILABILITY invariant) and from `orphaned-guard-trigger` (a hook TRIGGER string-coupling failure): this
class is a CLI command whose behavior is wrong SPECIFICALLY because it runs from a linked worktree, and
whose exit code hides the partial failure.

## Decision
- Tier: **②-deny (blocking PreToolUse deny)** + **⑤ (doc cure)**, hosted in the existing `merge-guard.mjs`.
- **Why this tier:** the user's goal is "a mechanism so the AI does NOT misunderstand."
  `HookOutput.allowWithWarning`'s reason is surfaced to the USER ONLY (`hook-output.mjs`: "사용자에게만
  표시됨 (Claude에게는 비노출)"), so a ②-warn structurally CANNOT reach the AI → it cannot achieve the
  goal. `HookOutput.deny`'s `permissionDecisionReason` DOES reliably reach the AI, AND deny blocks the
  command BEFORE it runs, so the ambiguous exit-0/"failed to run git" is never emitted at all — deny
  PREVENTS the misread instead of hoping the AI decodes a user-only banner. Tier stays ② (existing hook);
  the correct STRENGTH is deny. Zero false-block is EARNED by a tightened predicate: deny ONLY when the
  default branch (main/master) is checked out in a worktree OTHER than the command's cwd
  (`defaultBranchHeldByAnotherWorktree` via `git worktree list --porcelain`) — the exact condition under
  which gh's post-merge `git checkout main` always fails. From the main checkout (or a lone worktree
  where main is held nowhere else) it does NOT deny (verified: `--delete-branch` from the primary →
  passthrough). ① is unavailable (can't structurally un-type a flag without a tool-time interceptor);
  ⑤ is layered for the doc vector.
- Inner Generator–Critic loop (independent opus Critic, separate context) — TWO rounds:
  - Round 1: Critic APPROVED ②-warn (proportionate, zero false-block).
  - Round 2 (new evidence fed: `allowWithWarning` is user-only; `deny` reaches the AI): Critic FLIPPED to
    **②-deny** — a warn cannot reach the AI so it fails the stated goal; deny reaches the AI AND prevents
    the confusing failure, with zero false-block PROVIDED the predicate confirms main is held by another
    worktree, and the flag match includes gh's `-d` alias.
- Rejected tiers + reason:
  - **②-warn** — REVISE (round 2, C2/goal): its reason is USER-ONLY (`allowWithWarning`), so it never
    reaches the AI → cannot satisfy "AI does not misunderstand". (This is why round-1's approval was
    superseded within the same loop.)
  - **① eliminate** — REVISE(C1): an AI-typed flag cannot be structurally forbidden without a tool-time
    interceptor.
  - **⑤ doc-only** — REVISE(C2): misses the general-knowledge vector (AI adds `--delete-branch`
    unprompted, never reading the scaffold).
  - Critic C5 caveat adopted: predicate matches BOTH `--delete-branch` and gh's short alias `-d`.
  - Critic C3 condition adopted: predicate additionally confirms the default branch is held by ANOTHER
    worktree (`git worktree list --porcelain`), earning TRUE zero-false-block (from the main checkout it
    does not fire).
  - Implementation deviation from the Critic's C2 refinement (fold into `agent-worktree-guard.mjs`):
    hosted in `merge-guard.mjs` instead — a simpler self-contained JS hook, vs editing the delicate
    `guard.py` (4 prior retros). Same "existing infra, near-zero cost" intent.
- (tier ②) hook failure mode: **fail-open accepted** — `main()`'s try/catch returns passthrough on any
  error, and `defaultBranchHeldByAnotherWorktree` returns `false` whenever git state can't be determined,
  so a broken predicate stops DENYING (it never false-blocks legitimate work). Trade: a drift could
  silently stop protecting — acceptable because the blocked command is a guaranteed failure anyway.

## Cure (existing instances)
- [x] `.claude/scripts/lib/review-report.mjs:265` — the one place that RECOMMENDED `--delete-branch`;
  rewritten to warn against it from a worktree and to note `cleanup` deletes the remote branch. — this PR
- [x] `AGENTS.md:142` — appended a surgical clause at the exact ship instruction ("run `gh pr merge` from
  the worktree") warning not to add `--delete-branch`/`-d` and how to read the exit-0 outcome. — this PR
- [x] Exhaustive grep of `--delete-branch` across the repo: the only other occurrences
  (`AGENTS.md` cleanup-idempotency note, `scripts/agent-worktree-guard/{guard.py,README.md}`) are NEUTRAL
  descriptions of `cleanup` detecting an already-absent branch — not recommendations, no cure needed.

## Prevent (prevention mechanism)
- `.claude/scripts/merge-guard.mjs` — new exported predicate `shouldDenyDeleteBranchFromWorktree()`
  (`isGhPrMerge` + `hasDeleteBranchFlag` matching `--delete-branch|-d` + `defaultBranchHeldByAnotherWorktree`
  via `git worktree list --porcelain`) → `HookOutput.deny(GH_PR_MERGE_WORKTREE_DENY_REASON)` (the reason
  reaches the AI); bottom `main()` now guarded by `__HOOK_ORCHESTRATOR__` for testability. — this PR
- `.claude/scripts/lib/__tests__/merge-guard.test.mjs` — new 6-test contract (this guard had none). — this PR
- negative test (EXECUTED, from a REAL linked worktree where `main` is held by the primary): PreToolUse
  JSON `{"tool_input":{"command":"cd <this worktree> && gh pr merge 85 --squash --delete-branch"}}` piped
  into `node .claude/scripts/merge-guard.mjs` →
  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
   "permissionDecisionReason":"🚫 BLOCKED: worktree からの `gh pr merge --delete-branch`/`-d`…"}}
  ```
  the short-alias variant (`… -d`) also → `permissionDecision:"deny"`.
- positive test (no false-block on legitimate inputs — all passthrough `{}`): (a) worktree + no flag;
  (b) **`--delete-branch` from the PRIMARY main checkout** (`main` held by the current worktree → NOT
  denied — the zero-false-block proof); (c) existing `git merge --ff-only origin/main`. Governance suite
  `63/63` pass, `check-hook-refs` OK.

## Verify cmd
```bash
# unit contract
node --test .claude/scripts/lib/__tests__/merge-guard.test.mjs   # 6/6
# end-to-end deny (run from a LINKED worktree while main is in the primary; expect "deny")
printf '%s' '{"tool_input":{"command":"cd <a linked worktree> && gh pr merge 9 --squash --delete-branch"}}' \
  | node .claude/scripts/merge-guard.mjs
# end-to-end passthrough from the MAIN checkout (expect {} — zero false-block)
printf '%s' '{"tool_input":{"command":"cd <main checkout> && gh pr merge 9 --squash --delete-branch"}}' \
  | node .claude/scripts/merge-guard.mjs
# full governance suite
node --test .claude/scripts/lib/__tests__/*.test.mjs             # 63/63
```

## Next
Deferred (distinct classes, higher uncertainty — not fixed in this single-purpose PR):
- [ ] `make wt.new` worktrees are never registered with `agent-worktree-guard` (verified:
  `worktree-new.mjs` has no register call; `post-tool` hook does not auto-register), so
  `confirm-pr`/`mark-merged`/`cleanup` fail with "Ledger does not exist" until a manual
  `agent-worktree-guard register <path>` — investigate integrating registration into `worktree-new.mjs`
  (blocked on the guard's session-id model: a subprocess resolves session to "manual", which may not
  match a real session's ledger — needs the guard owner's design input). Class candidate:
  `worktree-created-out-of-band-unregistered`.
- [ ] `agent-worktree-guard confirm-pr` refuses ("Cannot confirm PR while ledger worktrees are still
  incomplete") due to stale entries in the shared `manual.json`, yet the `pre-tool` hook did NOT block
  `gh pr create` — so the AGENTS.md "run `confirm-pr` before `gh pr create`" step is misleading about
  being required. Reconcile the doc with actual enforcement, and/or add ledger hygiene. Related to
  `ledger-entry-orphaned-from-resource-lifecycle`.
