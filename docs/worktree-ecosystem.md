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
- `.brief2dev/system` is copied into the worktree when the donor init path is a
  symlink so its current cache state can be tracked explicitly.
- `.agents/` is ignored because donor worktree scripts use it for
  machine-local CLI config.
- `worktree-new.mjs` resolves companion scripts from the checkout containing
  `worktree-new.mjs`. This keeps the transplant verifiable from this linked
  worktree before the new files are merged into `main`, while preserving normal
  post-merge behavior.
- The optional donor Vitest suite is not installed because this repo does not
  use Vitest. Target verification uses syntax checks, import closure checks,
  the Python guard lifecycle test, hook smoke checks, and worktree dry-run.

Normal usage:

```bash
make wt.new BR=feature/<task>
cd .worktrees/feature/<task>
npm install
cd daemon && npm install && cd ..
make q.check
```
