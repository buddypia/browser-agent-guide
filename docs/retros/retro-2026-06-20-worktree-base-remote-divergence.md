# Retro 2026-06-20 — Worktree base blind to post-creation remote divergence

## Trigger
near-miss / bypassed-prevention: while building PR #14 in a long-lived worktree, a concurrent session merged `4a425a0 "Remove brief2dev leftovers"` to remote `origin/main`, deleting files the in-flight change depended on; the installed worktree staleness guard did not surface this and the collision became visible only at merge time.

## Facts
- The worktree was created at time T, fetching the local `origin/main` ref as it stood before `4a425a0`.
- During the session, remote `origin/main` advanced by `4a425a0` (Jun 20 13:01, −30,467 lines, removing `.claude/rules/common/worktree-auto-ship.md`, `.claude/hooks/MULTI-CLI.md`, `create-pr/ops.mjs`, etc.) and `1b68d6b` (#16). The local `origin/main` ref was not re-fetched.
- `worktree-shipping-guard.mjs` `measureStaleness()` computes `behind = git rev-list --count HEAD..origin/main` with **no network call** (`worktree-shipping-guard.mjs:118` — "네트워크 호출 안 함 — 이미 fetch 된 ref 기준"). The baseline is fresh only at creation (`worktree-new.mjs` fetches once).
- Against the un-refreshed local ref, `behind` resolved small; `evaluateStaleness()` returned `[]` because thresholds are `behind>20` / `age>7d` (`worktree-shipping-guard.mjs:67-68,149-154`). The Stop guard therefore reported "fresh".
- The real remote had deleted dependency files. The conflict surfaced during `git merge -X theirs origin/main` (the first operation that actually fetched), forcing modify/delete resolution on 3 docs, re-application of registration entries, and scope reduction (the doc/rule layer was dropped — user approved "適応して ship").
- PR #14 ultimately merged as squash `6e96bc1` with runtime feature only.

## 5 Whys → Root Cause
1. Why was the collision invisible until merge? → No step between worktree creation and `gh pr merge` re-fetched remote `origin/main` and re-compared.
2. Why did the staleness guard not catch it? → It measures the local `origin/main` ref captured at creation and never refreshed (no-network by design).
3. Why the no-network design? → To avoid a `git fetch` cost on every Stop hook — a deliberate, reasonable trade-off; the baseline is assumed fresh at creation and "goes stale visibly" over time.
4. Why did the thresholds not help even conceptually? → Real `behind` was ~2; threshold is 20. The true collision predictor is not commit-count but "did upstream delete/rewrite a file this branch touches" — no metric captures that.
5. Why uncaught by the ship path? → The ship/PR flow has no "fetch then `git diff --name-status origin/main...HEAD`" step; `pre-ship-review-guard` panel guidance also uses the local-ref `diff origin/main...HEAD` (`pre-ship-review-guard.mjs:222-225`).

**Root cause(s) (the class-blocking point(s)):**
occurrence: worktree staleness is measured against a creation-time, never-refreshed local `origin/main` ref, so mid-session remote divergence — especially upstream deletion/rewrite of depended-on files — is unrepresentable · detection: no ship-time step re-fetches remote and compares `--name-status` to flag upstream modify/delete before merge.

## Class
worktree-base-remote-divergence
recurrence_of: none
recurring class (multi-session-concurrent work is this repo's designed mode, so base drift is not rare); blast radius: governance / ship flow (extension runtime code untouched); reversibility: reversible (merge conflicts are recoverable) but at a rework + scope-loss cost.

## Decision
- Tier: ⑤ (lightweight advisory) — one `## Conventions & gotchas` line in `AGENTS.md` (the stable agent-memory survivor after the brief2dev rule files were removed) + this ledger as long-term memory.
- **Why this tier:** The blind spot is a non-obvious, reusable insight in a repo whose standard mode is concurrent sessions, so it warrants a standing note rather than record-only (⑥). It is captured at near-zero maintenance cost (a doc line, no code path to rot). A higher tier is not appropriate *now*: ① cannot make "remote divergence during a session" unrepresentable; ② would require a Stop-time `git fetch` (network — the cost the guard deliberately avoids) and the real predictor (upstream-deletes-a-file-I-touch) would false-block ordinary safe drift; ③ is the right *future* upgrade but the ship/create-pr machinery was just gutted by `4a425a0`, so wiring a new gate into a flow in flux is premature (negative maintenance ROI today).
- Rejected tiers + reason (inner-loop REVISE reasons: violated C# + redirection): ② new hook — C3 false-block of legitimate safe drift + C1 needs network at Stop time → redirect to ⑤ now / ③ later; ③ ship-time gate — C4 maintenance cost against a ship flow currently being gutted → deferred to `## Next`; ⑥ record-only — under-powered for a recurring designed-mode class → upgrade to ⑤.
- (tier ② only) hook failure mode: N/A (no hook added).
- Superseded-by: retro-2026-06-30-worktree-base-remote-divergence-recurrence.md (the class
  recurred with this tier-5 prevention active; escalated to tier ③).

## Cure (existing instances)
- [x] The triggering instance (PR #14) was already resolved at incident time via user-approved adaptation (`git merge -X theirs origin/main` + manual modify/delete resolution); runtime feature shipped at `6e96bc1`.
- [x] No other live instances to cure: 0 active worktrees besides this retro worktree (agent-worktree-guard ledger). The merged squash `6e96bc1` body overstates "docs updated" (those upstream-deleted docs were dropped); a merged commit cannot be amended under GitHub Flow — recorded here for the audit trail rather than rewritten.

## Prevent (prevention mechanism)
- `AGENTS.md` `## Conventions & gotchas` — added a gotcha line documenting the staleness-guard blind spot + the `git fetch origin main && git diff --name-status origin/main...HEAD` pre-ship habit (this PR).
- negative test: N/A — tier ⑤ has no executable gate. Per the ⑤ protocol, verified the rule line LANDED:
  ```
  $ grep -n 'never-refreshed.*local .origin/main. ref' AGENTS.md
  110:- **The Stop-time worktree staleness guard measures a *never-refreshed* local `origin/main` ref** ...
  ```
- positive test (blocking gates only): N/A — not a blocking gate.

## Verify cmd
```bash
grep -n 'never-refreshed' AGENTS.md
grep -n 'worktree-base-remote-divergence' docs/retros/retro-2026-06-20-worktree-base-remote-divergence.md
```

## Next
- [ ] Add a ③ ship-time freshness gate once the create-pr/ship flow stabilizes after the brief2dev removal — done-condition: a check that runs `git fetch origin main` and fails/warns on `git diff --name-status origin/main...HEAD` showing upstream deletion/rewrite of files the branch touches, with an observable override path.
- [ ] Revisit `STALENESS_BEHIND_THRESHOLD`/age vs an upstream-touched-files signal (the `behind` count is a weak collision predictor) — done-condition: the guard or ship gate keys on file-overlap, not commit distance.
