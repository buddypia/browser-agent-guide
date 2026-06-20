# Retro 2026-06-20 — Dead-trigger detector (permanent ③ for orphaned-guard-trigger)

## Trigger
user-explicit ("恒久対応で直して"): build the structural ③ detection layer deferred by `retro-2026-06-20-orphaned-ship-gate.md` (## Next item 1), so the `orphaned-guard-trigger` class cannot silently recur. The ② re-point (PR #18) fixed the one guard but re-introduced command-string coupling (C4) — this adds the missing detection.

## Facts
- Root cause is established in the parent ledger `retro-2026-06-20-orphaned-ship-gate.md`: a guard goes inert with NO signal when a dependency/command it references is removed, because `safeHookMainWithProfile` catches the load error and passes through (fail-open, R-CM-006 Rule 2).
- The brief2dev removal (`4a425a0`) deleted `create-pr/ops.mjs`; `mark-pre-ship-confirmed.mjs` had `import { parseUnchecked } from './create-pr/ops.mjs'` (hand-inlined during the removal) and `pre-ship-review-guard`'s SHIP_PATTERN string-referenced `ops.mjs`. No check flagged either dependency.
- The class spans two vectors: (i) a removed **imported module** (silent fail-open at load), and (ii) a removed **command/script named in a trigger pattern** (silent passthrough at match).

## 5 Whys → Root Cause
(Full chain in the parent ledger.) The detection-specific Why: no mechanism asserts that the dependencies a hook references still exist, so a removal PR cannot be told it just inertly disabled a guard.

**Root cause(s) (the class-blocking point(s)):**
detection: nothing verifies hook/script reference integrity, so a deleted import or referenced `.claude` script silently fail-opens a guard. (occurrence vectors are addressed per-incident: ② re-point for the regex trigger, contract tests for trigger-liveness.)

## Class
orphaned-guard-trigger
recurrence_of: none
implements: retro-2026-06-20-orphaned-ship-gate.md ## Next item 1 (deferred ③ detector). Recurring class (large cleanups / dependency removals happen here); blast radius: governance hooks; reversibility: detection-only lint (no runtime effect).

## Decision
- Tier: **③ (detection lint + test gate)**. The parent's ② prevention + this ③ detection form the prevention/detection pair the irreversible/externally-visible class requires (Swiss-cheese).
- **Why this tier:** ① cannot make "a referenced file was deleted" structurally unrepresentable without a build/bundler this repo deliberately lacks. ② (a new blocking hook) is wrong — there is no per-tool-call decision point and a false block would be costly; integrity is checkable at test/lint time. So ③ — a deterministic lint, enforced by a test that scans the live tree. Scoped to the **tractable, near-zero-false-positive** subset: (a) relative import resolution and (b) concrete `.claude/…*.mjs` path-literal existence. A full regex-semantics analyzer (to catch a pattern naming a removed binary like the original `ops.mjs` SHIP_PATTERN) was rejected as over-engineering (C2) — that trigger-liveness vector is covered by per-guard contract tests (`pre-ship-review-guard.test.mjs`).
- Rejected tiers + reason (inner-loop REVISE reasons: violated C# + redirection): ② new hook — C3 (false-block risk, no tool-call decision point) → ③ test-time lint; ⑤ advisory only — under-powered, a doc line does not detect a future removal; ⑥ do-nothing — explicitly overridden by the user's 恒久対応 request. C2 kept the lint minimal (import + concrete-path only; no regex analyzer).
- (tier ② only) hook failure mode: N/A (not a hook).

## Cure (existing instances)
- [x] The live tree currently has **0 dangling references** (the lint passes) — verified, no existing instances to cure.
- [x] Closes `retro-2026-06-20-orphaned-ship-gate.md` ## Next item 1 (dead-trigger detector). Item 2 (the `.tmp/create-pr-active` marker web, fail-safe) and item 3 (cosmetic R-CM-030 sweep) remain open there — carried below.

## Prevent (prevention mechanism)
- `.claude/scripts/check-hook-refs.mjs` (new) — lints `.claude/hooks` + `.claude/scripts` (excludes `__tests__`): (a) every relative import / `export … from` / dynamic `import()` resolves; (b) every concrete `.claude/…*.mjs` path literal exists. Comment-stripped to avoid prose false-positives. CLI exits 1 on any dangling ref.
- `.claude/scripts/lib/__tests__/check-hook-refs.test.mjs` (new) — its POSITIVE test scans the **live tree** and asserts 0 dangling refs, so the governance suite fails if a future change introduces one (this is the enforcement point); plus negative/edge fixtures.
- `AGENTS.md` "Conventions & gotchas" — documents the lint + the governance-suite pre-ship step.
- negative test (lint catches the class): synthetic fixture `import { x } from './ghost.mjs'` + `'node .claude/scripts/deleted-thing.mjs --foo'` →
  ```
  detected: [
    "hooks/bad.mjs: unresolved import './ghost.mjs'",
    "hooks/bad.mjs: dangling .claude path literal '.claude/scripts/deleted-thing.mjs'"
  ]
  ```
  And the actual brief2dev break reproduced: `import { parseUnchecked } from './create-pr/ops.mjs'` →
  `detected: [ "hooks/guard.mjs: unresolved import './create-pr/ops.mjs'" ]` (would have been caught).
- positive test (no false-block on legitimate history): `node .claude/scripts/check-hook-refs.mjs` on the live tree → `OK` (exit 0); full governance suite → 38 pass / 0 fail (5 new). Commented-out imports and multi-line import heads handled without false positives (fixtures).

## Verify cmd
```bash
node .claude/scripts/check-hook-refs.mjs                              # live tree → OK / exit 0
node --test .claude/scripts/lib/__tests__/check-hook-refs.test.mjs    # 5 pass (incl. live-tree no-FP)
node --test .claude/scripts/lib/__tests__/*.test.mjs                  # full governance suite
```

## Next
- [ ] Resolve the `.tmp/create-pr-active` marker web (from parent ledger) — producer-less across 5 hooks; decide drop-carve-out vs re-introduce a producer in the gh flow; fix `worktree-new.mjs:336` stale guidance. Lower urgency (fails safe).
- [ ] Cosmetic: sweep remaining historical `R-CM-030` references in `pre-ship-review-guard.mjs` now the policy doc is deleted.
- [ ] Optional hardening: add per-guard contract tests (canonical-command-still-fires) for the other command-gating hooks (`commit-guard`, `destructive-git-guard`, `worktree-*-guard`) to cover the regex-trigger-liveness vector the lint intentionally does not.
