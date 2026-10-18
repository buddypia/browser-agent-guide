---
name: testing
description: Which runner covers what, single-test commands, live checks and the evidence a UI change needs. Read before running, writing or debugging tests, or verifying a UI change.
---

# Testing the extension

There is no linter/formatter, and CI only checks the glossary — everything else is gated locally. Root `npm run check` is the full gate (the exact list is package.json `"check"`); it does **not** run the daemon tests (`cd daemon && npm test`, see the daemon-mcp skill). `make q.check` runs both.

## Commands (repo root)
```bash
npm install                      # root devDeps (@playwright/test, @axe-core/playwright)
npx playwright install chromium  # one-time; required before ANY browser-driven test
npm run check                    # FULL gate (includes glossary:staleness and the Playwright specs)
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
- Root `test/*.test.mjs` are bare node scripts or `node --test` — see each `test:*` script in package.json before adding one, and add a new test to the `check` chain.
- Daemon tests use `node --test`.

## UI changes
The anti-slop UI quality workflow (`docs/ui-quality-workflow.md`) requires generated UI changes to be backed by a repeatable Playwright/axe test or screenshot, verified at side-panel width. Keep new user-facing strings bilingual JP/EN.
