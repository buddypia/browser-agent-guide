# Retro 2026-06-20 — Orphaned ship gate after create-pr removal

## Trigger
near-miss / bypassed-prevention: discovered while shipping the previous retro's PR (#17). `pre-ship-review-guard` (PreToolUse, the Pre-Ship Human Review Panel gate) matches only the deleted `ops.mjs ship-(worktree|feature)` command, so it can never fire on the current `gh`-based ship path — the gate is silently unenforced.

## Facts
- `4a425a0 "Remove brief2dev leftovers"` deleted the create-pr ship orchestration: `.claude/scripts/create-pr/ops.mjs` (1688 lines, the ship command), `.claude/skills/create-pr/` (SKILL.md + MANIFEST), and `.claude/rules/common/worktree-auto-ship.md` (270 lines, the R-CM-030 "Pre-Ship Human Review Panel" policy SSOT).
- It KEPT and adapted the partner machinery: `pre-ship-review-guard.mjs` (PreToolUse), `worktree-shipping-guard.mjs` (Stop), and the marker producer `mark-pre-ship-confirmed.mjs` — whose header comment was rewritten to "Used by the local pre-ship review guard to record explicit confirmation" and whose `parseUnchecked` helper was inlined (previously imported from the deleted ops.mjs). I.e. the review machinery was deliberately kept alive.
- `pre-ship-review-guard` `SHIP_PATTERN` matched only `node … ops.mjs ship-(worktree|feature)` (anchored). With `ops.mjs` gone, no command in the current tree can match → the hook always returns passthrough → the Pre-Ship Human Review Panel marker is unenforced. The trigger died SILENTLY (passthrough/fail-open, not an error).
- The sole writer of the `.tmp/create-pr-active` coordination marker (read as a passthrough/carve-out by 5 hooks) was the deleted ops.mjs, so those carve-outs are also dead — but they fail SAFE (the guards stay strict), unlike the pre-ship gate which fails OPEN.
- No ship process is documented anywhere (README.md / AGENTS.md / .claude/rules had zero mention of `gh pr create/merge`, `mark-pre-ship-confirmed`, or "Human Review Panel"). Shipping is ad-hoc manual `gh pr create` + `gh pr merge`.
- A separate newer Stop hook `worktree-review-report-guard` (PR #14) blocks session-Stop on a missing REVIEW.md but does NOT intercept the `gh pr merge` command, so it does not cover the at-the-moment-of-action merge.

## 5 Whys → Root Cause
1. Why is the Pre-Ship Panel gate ineffective? → `SHIP_PATTERN` targets the deleted `ops.mjs ship-*` command.
2. Why was it not re-pointed? → The brief2dev removal deleted the ship command implementation but did not update the guard's trigger to the new ship entrypoint (`gh pr merge`).
3. Why did this go unnoticed? → A trigger-pattern mismatch surfaces as passthrough (fail-open), not an error, so the guard silently became inert.
4. Why silent? → The guard's firing condition was bound to a specific implementation command string (`ops.mjs ship-*`) rather than to the abstract ship action.
5. Why is there no detection? → No mechanism flags a guard whose trigger pattern can never match anything in the current tree ("dead trigger"); no `ecosystem-health-guard` hook file exists.

**Root cause(s) (the class-blocking point(s)):**
occurrence: the guard's firing is coupled to a specific implementation command (`ops.mjs ship-*`); removing that command silently turned the gate into a permanent passthrough (the marker producer was kept, so the intent to enforce review survived) · detection: nothing detects a "dead trigger" — a guard whose pattern matches no command in the current tree.

## Class
orphaned-guard-trigger
recurrence_of: none
recurring class (large cleanups / dependency removals happen in this repo); blast radius: governance / ship; reversibility: **externally-visible** — the un-gated action is `gh pr merge` (irreversible merge to main) → high severity.

## Decision
- Tier: **② (re-point the existing PreToolUse hook)** + **⑤ (document the ship flow)**. The ③ dead-trigger detector is deferred to `## Next`.
- **Why this tier:** Step-3 class is irreversible/externally-visible (`gh pr merge`), which is exactly tier ②'s condition (high severity + exactly decidable + zero false-block). Re-pointing `SHIP_PATTERN` to `gh pr merge` restores the only at-the-moment-of-action block on the irreversible merge; the newer `worktree-review-report-guard` is Stop-time and does not intercept the merge command. The kept-alive marker producer confirms the maintainer intent to retain Pre-Ship review (vs retiring it). `merge` only — `gh pr create` is reversible (a PR can be closed) so it is out of scope, and read-only `gh pr view/list/checks/diff` must not be false-blocked. The missing ship documentation is the parallel ⑤.
- Rejected tiers + reason (inner-loop REVISE reasons: violated C# + redirection): the inner loop REVISEd round 1 on **C3** — the initial `gh pr (create|merge)` proposal false-blocks reversible `gh pr create`; redirected to `gh pr merge` only. **γ retire (⑥/① delete the dead hook)** was weighed under C2 but rejected: the marker producer was deliberately kept + adapted, signalling retain-intent (user confirmed α over γ at the Phase-4 gate). **② alone without ⑤** rejected: shipping is undocumented, so the gate is undiscoverable. A net-new ③ detector now was rejected under **C4** (build cost vs a one-line pattern fix) → deferred to Next.
- (tier ② only) hook failure mode: **fail-open accepted** (R-CM-006 Rule 2). Internal error / malformed stdin → passthrough (verified). Trade-off: a broken hook silently stops gating (the exact orphaned-guard-trigger failure mode), which is why a dead-trigger detector is tracked in Next; chosen over fail-closed because false-blocking every Bash call on a hook bug is worse.

## Cure (existing instances)
- [x] `pre-ship-review-guard.mjs` — `SHIP_PATTERN` re-pointed from `ops.mjs ship-*` to `gh pr merge`; branch inferred from `data.cwd` via `inferBranchFromCwd` (gh carries no `--worktree`); docstring + deny message updated off the deleted `ops.mjs`/R-CM-030 references; a COUPLING warning comment added at the pattern.
- [ ] Deferred to Next (separate sub-incident, different failure mode = fail-SAFE not fail-open): the `.tmp/create-pr-active` coordination-marker web — its sole producer (ops.mjs) is gone, leaving dead passthrough/carve-out references in `commit-guard`, `destructive-git-guard`, `worktree-session-owner-guard`, `worktree-shipping-guard`, `worktree-review-report-guard`, plus stale guidance in `worktree-new.mjs:336`. Not batched here (5+ hooks = multi-purpose; "one problem at a time").

## Prevent (prevention mechanism)
- `pre-ship-review-guard.mjs` now gates `gh pr merge` (the live ship entrypoint), with a code comment flagging the command-string coupling and pointing here for the dead-trigger-detector follow-up — PR (this).
- `AGENTS.md` "Git workflow" — documents the gh-based ship flow + the `mark-pre-ship-confirmed` step the guard requires (⑤; ship was previously undocumented).
- `pre-ship-review-guard.test.mjs` (new, node:test) — locks the gate to `gh pr merge` and pins the no-false-block contract.
- negative test (gate fires): `printf '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 17 --squash"},"cwd":"/tmp/bag-x/.worktrees/fix/foo"}' | node .claude/hooks/pre-ship-review-guard.mjs` →
  ```
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
   "permissionDecisionReason":"[pre-ship-review-guard] ship 호출 차단 ... 대상 branch: fix/foo ..."}}
  ```
  (deny, with branch `fix/foo` inferred from cwd). Exit 0 — this repo signals deny via `permissionDecision` JSON, not exit 2.
- positive test (no false-block on legitimate history): `gh pr view 17` → `{}`; `gh pr create --title x` → `{}`; malformed stdin (fail-open) → `{}`. All passthrough, 0 false-blocks.

## Verify cmd
```bash
node --test .claude/scripts/lib/__tests__/pre-ship-review-guard.test.mjs
# and the live gate:
printf '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 1 --squash"},"cwd":"/tmp/x/.worktrees/fix/foo"}' | node .claude/hooks/pre-ship-review-guard.mjs
printf '{"tool_name":"Bash","tool_input":{"command":"gh pr view 1"},"cwd":"/tmp/x/.worktrees/fix/foo"}' | node .claude/hooks/pre-ship-review-guard.mjs
```

## Next
- [ ] Add a ③ dead-trigger / orphaned-guard detector — done-condition: a check (CI-time or a periodic audit) that flags any hook whose trigger pattern cannot match any plausible command / references a path absent from the tree, so a future dependency removal cannot silently inert a guard.
- [ ] Resolve the `.tmp/create-pr-active` marker web (separate sub-incident): decide per guard whether to drop the dead carve-out or re-introduce a producer in the gh-based flow; fix `worktree-new.mjs:336` stale "/create-pr ship-worktree" guidance. Lower urgency (fails safe).
- [ ] Sweep remaining historical `R-CM-030` references in `pre-ship-review-guard.mjs` (quality-gate rationale comment) now that the policy doc is deleted — cosmetic.
