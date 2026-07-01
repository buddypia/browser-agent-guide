# Retro 2026-06-30 — Worktree base-remote-divergence recurs despite the tier-5 advisory

## Trigger
merged bug (recovered pre-merge) / recurrence of a documented class: while shipping PR #67
(`fix/note-to-daemon`, merged as `830f6b7`), `git add -A` swept in unrelated files that did not
belong to the PR's actual change.

## Facts
- `git add -A` in the worktree picked up: a 6-line `.gitignore` diff, an 82-line `guard.py` diff,
  a 29-line `test_guard.py` diff, `README.md` changes, and 2 new `__pycache__/*.pyc` files.
- Root cause: the worktree was created from a stale local `origin/main` ref — base was commit
  `f0122fa` (PR #64), but by ship time real `main` had already advanced 2 commits to `31d5f84`:
  PR #65 "Stop tracking Python bytecode cache; ignore `__pycache__/*.pyc`" (added the `.gitignore`
  rule) and PR #66 (a `guard.py` cleanup fix). Because the worktree's own `.gitignore` predated
  the PR #65 ignore rule, Python test runs inside the worktree produced `__pycache__/*.pyc` files
  that git saw as untracked (not ignored), and `git add -A` picked them up along with stale diffs
  against the outdated base.
- Recovery: `git checkout origin/main -- <4 files>` + `git rm --cached` the 2 `.pyc` files, then a
  SECOND corrective commit (not amend — this repo's `destructive-git-guard` blocks amend in a
  multi-session environment), then squash-merge (which collapses commits, so the final PR #67
  diff against `main` was verified as exactly 17 files, no guard-tooling files leaked through).
- This is a RECURRENCE of the class documented in
  `docs/retros/retro-2026-06-20-worktree-base-remote-divergence.md`. That ledger's tier-5
  prevention — one `## Conventions & gotchas` line in `AGENTS.md` describing the Stop-time
  staleness guard's blind spot and prescribing `git fetch origin main && git diff --name-status
  origin/main...HEAD` before shipping — has remained live, unchanged, through the present
  incident. The incident recurred with the exact predicted mechanism: a small "behind" count
  invisible to the guard's `behind>20`/`age>7d` thresholds.
- Since that retro, two follow-on retros closed the "ship/create-pr machinery in flux"
  precondition that justified deferring a tier-3 gate at the time:
  `retro-2026-06-20-orphaned-ship-gate.md` (re-pointed `pre-ship-review-guard.mjs` to the current
  `gh pr merge` entrypoint) and `retro-2026-06-20-dead-trigger-detector.md` (dangling-reference
  lint). The gh-based ship flow has been stable since, used across many subsequent PRs
  (#31, #63–#67, ...) with no further churn.

## 5 Whys → Root Cause
1. Why did `git add -A` sweep in unrelated files? → the worktree's own committed baseline
   (`.gitignore` without the `.pyc` rule, an old `guard.py`) differed from true `main`, so files
   that were actually already-resolved upstream still looked locally relevant/untracked.
2. Why was the worktree's baseline stale? → it was created from a local `origin/main` ref that was
   never re-fetched after creation, and real `main` advanced by 2 commits during the session.
3. Why didn't the tier-5 advisory line catch this? → an advisory line in `AGENTS.md` has no
   enforcement point; it depends on being manually recalled at exactly the right moment (right
   before `git add`/`gh pr merge`), and in this instance it was not consulted.
4. Why wasn't it consulted? → there is no step in the ship flow that surfaces it — the guidance
   exists only as prose a session must remember to re-read.
5. (detection chain) Why did this go uncaught until `git add -A` had already staged the wrong
   files? → the Stop-time staleness guard (`worktree-shipping-guard.mjs`) measures `behind` against
   a never-refreshed local ref and only fires past `behind>20`/`age>7d` — a 2-commit drift is
   invisible to it by design (documented in the prior retro), and no OTHER step re-fetches and
   compares before the irreversible `gh pr merge`.

**Root cause(s) (the class-blocking point(s)):**
occurrence: a worktree's base can silently diverge from real `origin/main` mid-session, and
nothing re-fetches/re-compares before the ship-time `git add`/merge · detection: the only existing
prevention (a tier-5 advisory line) has no enforcement point and was not consulted at the moment it
mattered; the Stop-time staleness guard's `behind`/`age` thresholds are structurally blind to small
drifts.

## Class
worktree-base-remote-divergence
recurrence_of: `retro-2026-06-20-worktree-base-remote-divergence.md`
recurring class (multi-session-concurrent work is this repo's designed mode, so base drift is not
rare — this is the 2nd confirmed occurrence in roughly 10 days); blast radius: governance/ship flow
(this occurrence additionally polluted the local pre-merge diff, requiring a corrective second
commit); reversibility: the worst-case tail is a wrong-scope commit landing on `origin/main` via
squash-merge — irreversible/externally-visible (public history can only be reverted-forward, not
rewritten), even though THIS occurrence was caught and fixed pre-merge.

**Recurrence check:** the prior ledger installed tier 5. (i) this incident falls inside that
ledger's class definition — confirmed, identical mechanism (stale local `origin/main` ref, small
commit-count drift invisible to the `behind>20`/`age>7d` staleness guard). (ii) the tier-5
prevention was implemented and active at incident time — confirmed, the `AGENTS.md` line has been
live throughout. Both hold: **the tier-5 decision is falsified by this recurrence.**
`Superseded-by:` recorded on the old ledger (see below).

## Decision
- Tier: **③ (check/gate at ship time)**, layered on the EXISTING tier-② `gh pr merge` hook rather
  than a new hook file.
- **Why this tier:** per the recurrence rule, the tier-5 decision cannot be silently reused —
  it must escalate, with an explanation of the tier-5 failure: an advisory line that must be
  manually recalled before every merge has no enforcement point, and in fact was not consulted
  before this merge (no step surfaces it). Tier ① is inapplicable ("remote divergence during a
  live session" cannot be made structurally unrepresentable). A hard tier-② block was
  considered and rejected: file-overlap between a branch's own changes and upstream's changes
  since their merge-base is a heuristic, not a certain-conflict predictor (two branches can touch
  the same file in non-conflicting ways, e.g. appending to different sections) — hard-blocking
  would create real false-positive risk on legitimate, non-conflicting concurrent work, which
  this repo's designed mode (many concurrent worktrees) makes common. Tier ③ — a warning
  surfaced at the one mandatory pre-merge step, reviewed by the human as part of the existing
  Pre-Ship Human Review Panel — is the proportionate response. The prior ledger's own `## Next`
  had already named this exact upgrade, deferred only until the ship/create-pr flow stabilized;
  that precondition is now closed (see Facts).
  - Implementation: `.claude/scripts/mark-pre-ship-confirmed.mjs` (the CLI run right after a human
    confirms the Review Panel and right before `gh pr merge`) gained a new best-effort step,
    `checkBaseFreshness()`, run immediately before marker creation: fetches `origin/main` (10s
    timeout, fails open on any git/network error), computes `git merge-base HEAD origin/main`,
    then diffs the branch's own touched files (`merge-base..HEAD`) against upstream's touched
    files (`merge-base..origin/main`); if they overlap, prints a stderr warning listing the
    overlapping paths. This does NOT block marker creation (no hard exit 1) — advisory output
    attached to a step that is already mandatory (marker creation is required for `gh pr merge`
    to pass the existing tier-② hook), so the check cannot be silently skipped the way a
    memorized manual habit can.
- Rejected tiers + reason (independent Critic's C1–C6 pass, round 1, APPROVE with no REVISE): the
  Critic explicitly verified tier ① is inapplicable and a hard tier ② would false-block legitimate
  non-conflicting concurrent work, confirming tier ③ as the ceiling given the false-block
  constraint. One imprecision was flagged and accepted as non-blocking: the round-1 proposal
  referenced "the branch's recorded `base` field" from ledger/worktree metadata as an alternate
  range source, but that field is frequently `null` in the live ledger; the implementation uses
  `git merge-base HEAD origin/main` exclusively (base-independent, always computable), which the
  Critic confirmed reproduces the named violating input correctly.
- (tier ② only) hook failure mode: N/A — this is additive advisory logic inside an existing CLI,
  not a new PreToolUse hook; it fails open (silent skip) on any git/network error, consistent
  with this project's established R-CM-006 Rule 2 convention.

## Cure (existing instances)
- [x] The triggering instance (PR #67) was already resolved at incident time: `git checkout
  origin/main -- <4 files>` + `git rm --cached` the 2 `.pyc` files + a second corrective commit;
  squash-merge collapsed it. Verified the final PR #67 diff against `main` is exactly 17 files,
  no guard-tooling files.

## Prevent (prevention mechanism)
- `.claude/scripts/mark-pre-ship-confirmed.mjs` — new `checkBaseFreshness()` +
  `resolveWorktreePath()` shared helper (this PR, commit `a2d7970`).
- `.claude/scripts/lib/__tests__/mark-pre-ship-confirmed.test.mjs` — new tests (this PR).
- negative test (EXECUTED, real temp git repos with a bare "origin"): branched a worktree from
  `origin/main`, committed a change to `FOO.txt` on the branch, then advanced the bare origin's
  `main` with an upstream commit that ALSO changes `FOO.txt` (reproducing the PR #67 shape) and
  called `checkBaseFreshness()` — observed output:
  ```
  [mark-pre-ship-confirmed] base freshness 경고: origin/main 이 이 branch 와 같은 파일을 이미 변경했습니다:
    - FOO.txt
    re-check: git diff --name-status origin/main...HEAD 로 겹침을 재확인하고 scope 를 재점검하세요.
    (경고일 뿐 marker 생성은 차단하지 않습니다)
  ```
  `result.warned === true`, `result.overlap === ['FOO.txt']`.
- positive test (blocking-adjacent, since this is a warning not a block; run on legitimate
  history): a worktree current with `origin/main` that adds an unrelated new file — 0 warnings
  (`result.warned === false`, empty stderr). Also verified staged mode / `--force` / absent
  worktree all skip silently (no false warnings, no false blocks).
- `node --test .claude/scripts/lib/__tests__/*.test.mjs` — 57/57 pass (54 pre-existing + 3 new),
  0 regressions across the full `.claude` governance suite.
- `AGENTS.md` — updated the existing worktree-base-remote-divergence gotcha line to mention the
  new tier-3 mechanism, so agent memory reflects that this is now partially mechanized (not pure
  advisory prose) (this PR).

## Verify cmd
```bash
node --test .claude/scripts/lib/__tests__/mark-pre-ship-confirmed.test.mjs
node --test .claude/scripts/lib/__tests__/*.test.mjs   # full suite, expect 57/57
grep -n 'checkBaseFreshness' .claude/scripts/mark-pre-ship-confirmed.mjs
grep -n 'Superseded-by: retro-2026-06-30-worktree-base-remote-divergence-recurrence.md' \
  docs/retros/retro-2026-06-20-worktree-base-remote-divergence.md
```

## Next
- [ ] Revisit the Stop-time staleness guard's `behind`/`age` thresholds vs an
  upstream-touched-files overlap signal (carried forward from the prior ledger's still-open
  `## Next` item — genuinely different mechanism: this PR's gate runs at ship time inside
  `mark-pre-ship-confirmed.mjs`, not inside `worktree-shipping-guard.mjs`'s Stop-time check) —
  done-condition: the Stop-time guard itself keys on file-overlap, not commit distance, so a
  long-lived worktree gets an EARLIER (Stop-time, not just ship-time) signal.
