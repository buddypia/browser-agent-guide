---
name: testing
description: Which runner covers what, single-test commands, live checks and the evidence a UI change needs. Read before running, writing or debugging tests, or verifying a UI change.
---

# Testing the extension

There is no linter/formatter. CI (`.github/workflows/ci.yml`: jobs `fast`, `daemon`, `e2e`) runs every gate on clean runners, and `make ship` merges only after all three pass on the pushed HEAD. Root `npm run check` is the full local gate (`check:fast` + `test:guard` + `test:e2e`); it does **not** run the daemon tests (`cd daemon && npm test`, see the daemon-mcp skill). `make q.check` runs both.

**Local loop: `npm run check:fast` plus the spec(s) your change touches**, not the full `npm run check`. Many AI sessions share this machine; each full run starts several extension-loaded Chromiums, and under that load clean `main` failed 3 E2E tests on timeouts and a run took 7+ minutes (2026-10-21, load average 100–300). `scripts/run-checks.mjs` and `scripts/check-js.mjs` share a cross-worktree verification cache in `<mainRoot>/.tmp/agent-scratchpad/` (`scripts/agent-scratchpad.mjs`: JS syntax SHA-256 cache, per-check input-digest cache, and full-gate tree stamps) and skip untouched subsystem checks in feature worktrees against `origin/main` (pass `--all` / `RUN_ALL_CHECKS=1` to force all checks, or `--no-cache` / `BAG_DISABLE_SCRATCHPAD=1` to bypass the scratchpad). Run the full suite locally only to debug an E2E failure CI reported. Browser tests must not use fixed ports or shared paths (use `listen(0)`, `--remote-debugging-port=0` + `DevToolsActivePort`, `mkdtemp`): concurrent runs in other worktrees would collide. Tests that build throwaway git repos must drop `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` from the environment first (`worktree-init` injects them into CLI settings, and a leaked one points `git add -A`/`commit` at the real worktree).

## Commands (repo root)
```bash
npm install                      # root devDeps (@playwright/test, @axe-core/playwright)
npx playwright install chromium  # one-time; required before ANY browser-driven test
npm run check:fast               # node-only steps in parallel via scripts/run-checks.mjs (~20 s) — the default local gate
npm run check                    # FULL gate: check:fast + test:guard + test:e2e (CI runs the same)
npm run test:e2e                 # npm test (playwright-cli) + test:ui (Playwright specs)
npm run test:guard               # scripts/agent-worktree-guard/test_guard.py (~1 min; CI + full check only)
npm run check:js                 # node --check over every source .js/.mjs (scripts/check-js.mjs finds them)
npm run check:sync               # paired files agree (slug copies, recipe and agent verb allow-lists)
npm run check:harness            # AGENTS.md cap, skill triggers, hook files (harness2 rules)
npm test                         # node test/anchor.playwright-cli.mjs — drives browser via playwright-cli
npm run test:pf                  # node test/page-feedback/compositor.test.mjs  (bare node script, not node:test)
npm run test:ui                  # playwright test -c playwright.config.mjs  (only **/*.spec.mjs)
npm run debug:playground         # headed Chromium with the unpacked extension loaded, serving test/fixtures/playground.html
npm run zip                      # the ONLY build/package step: zip source dirs into browser-agent-guide.zip
node scripts/live/workflow-wikipedia.mjs  # opt-in live checks on real sites / CLIs (not in check or CI) — scripts/live/README.md
```

Single test:
```bash
npx playwright test -c playwright.config.mjs test/ui-quality.spec.mjs    # one spec file
npx playwright test -c playwright.config.mjs -g "title substring"        # one test by title
```

## Several test runners
- Playwright Test runs `*.spec.mjs` (`testMatch` excludes `.test.mjs`).
- `npm test` shells out to `playwright-cli`.
- Root `test/*.test.mjs` are bare node scripts or `node --test` — see each `test:*` script in package.json before adding one. Add a new node-only test to the `check:fast` list; a browser test belongs under `test:e2e`.
- Daemon tests use `node --test`.

## UI changes
The anti-slop UI quality workflow (`docs/ui-quality-workflow.md`) requires generated UI changes to be backed by a repeatable Playwright/axe test or screenshot, verified at side-panel width. Keep new user-facing strings bilingual JP/EN.
