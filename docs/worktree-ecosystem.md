# Worktree Safety Ecosystem

This repo includes a mostly direct transplant of the brief2dev worktree safety
ecosystem from:

```text
~/dev/buddypia/brief2dev/.tmp/worktree-ecosystem-transplant
```

Installed groups:

- Agent Worktree Guard CLI under `scripts/agent-worktree-guard/`
- Claude hooks under `.claude/hooks/`
- Codex adapters and `.codex/hooks.json`
- Worktree scripts under `.claude/scripts/`
- Additional support scripts required by import closure:
  `archive-and-reset.mjs`, `followup-debt-tracker.mjs`, and
  `memory-curator.mjs`
- Worktree policy under `.claude/config/worktree-policy.json`
- Worktree rules and supporting Claude skills
- Worktree feature docs under `docs/features/004-agent-worktree-guard/`

Target adaptations:

- `Makefile` is new for this repo and exposes `wt.new`, `wt.run`, `q.check`,
  and `q.ci-mirror`.
- `q.check` maps to the existing root extension gate plus daemon tests:
  `npm run check` and `cd daemon && npm test`.
- `.claude/settings.json` registers only hooks that are present in this
  transplant. The donor settings file had brief2dev-only hooks and was not
  copied wholesale.
- `.brief2dev/system` is git-ignored and shared across worktrees via a symlink
  to the main worktree (`worktree-init.mjs` uses `symlinkSync`, not a copy), so
  its runtime cache state stays machine-local instead of being committed.
- `.agents/` is ignored because donor worktree scripts use it for
  machine-local CLI config.
- `worktree-new.mjs` resolves companion scripts from the checkout containing
  `worktree-new.mjs`. This keeps the transplant verifiable from this linked
  worktree before the new files are merged into `main`, while preserving normal
  post-merge behavior.
- The optional donor Vitest suite is not installed because this repo does not
  use Vitest. Target verification uses syntax checks, import closure checks,
  the Python guard lifecycle test, hook smoke checks, and worktree dry-run.

Local additions (not in the donor transplant):

- **Worktree Review Report Gate** — a `Stop` hook
  `.claude/hooks/worktree-review-report-guard.mjs` (+ `codex/` adapter) that enforces a
  human-reviewable `REVIEW.md` (9 sections, HEAD-stamped) for owned worktrees with
  committed work, closing the "marker without panel body" bypass that R-CM-030's
  `pre-ship-review-guard` documents. Validation SSOT is
  `.claude/scripts/lib/review-report.mjs`; the helper CLI is
  `.claude/scripts/mark-worktree-reviewed.mjs`; tests are dependency-free `node:test`
  under `.claude/scripts/lib/__tests__/` (run `node --test .claude/scripts/lib/__tests__/*.test.mjs`).
  Because this repo has no `regen-hooks-settings.mjs`, the hook is registered by hand in
  `.claude/settings.json` and `.codex/hooks.json` (the `hook-registry.mjs` entry only
  drives profile enablement).

Normal usage:

```bash
make wt.new BR=feature/<task>
cd .worktrees/feature/<task>
npm install
cd daemon && npm install && cd ..
make q.check
```
