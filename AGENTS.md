## What this is

Browser Agent Guide is a **working Chrome Manifest V3 side-panel extension** (not a guide doc), plus a separate local Node daemon. The extension lets an LLM operate *any* web page through a **closed, deterministic verb registry** instead of free-form DOM access: the user chats in the side panel, the service worker collects page context and calls an LLM with Structured Outputs to get a fixed list of verbs + args, and the content script executes them deterministically.

The repo is **two independent npm projects**, installed and tested separately:
- **Repo root** — the extension. Vanilla JS, ES modules, **no build step, no bundler, no linter**. CI (`.github/workflows/ci.yml`) runs the full gate; `make ship` runs only the fast node checks locally and merges after CI passes.
- **`daemon/`** — an ESM Node service (`bag-page-feedback-daemon`) that bridges drawn-annotation screenshots from the browser to AI coding CLIs over MCP. Own `package.json` / `node_modules`.

UI strings are bilingual JP/EN by design (e.g. `お描き/Draw`); keep new ones bilingual. `README.md` is the authoritative English source; `README.ja/ko/zh.md` are translations.

## Commands

```bash
make wt.new BR=feature/<task>     # fresh worktree from origin/main — edit tracked files only there
make q.check                      # root npm run check + daemon npm test
make -C <worktree> ship           # finished work: fast checks → PR → AI review + CI → auto-merge if small → cleanup
npm run check:fast                # node-only checks in parallel (seconds) — the local dev loop
npm run check                     # full root gate incl. browser E2E (CI runs it); does NOT run daemon tests
npx playwright install chromium   # one-time, before any browser-driven test
```
Daemon: `cd daemon && npm test`. Runners, single tests and live checks: the testing skill below.

## Invariants (every task)

- **The verb registry is a CLOSED set**: the LLM can only emit verbs in `AI_VERBS` (`content/content-script.js`), enforced by an enum built from the live catalog. Add a capability = add one verb entry. Args travel as `argsJson` (a JSON *string*) on purpose — never a typed args object in the schema.
- **Only the service worker** calls the LLM and the privileged APIs (`chrome.userScripts.execute`, `chrome.tabs.captureVisibleTab`, `chrome.offscreen`, `chrome.downloads`). The content script has no LLM/network access.
- **Page text and attributes are untrusted** (prompt-injection defense). Don't widen verb exposure: the chat blocklist, the recipe allow-lists and the external-agent allow-list are security boundaries.
- **API key lives in `chrome.storage.local`, never `sync`**; read/write settings only via `lib/storage.js`.
- **Determinism is load-bearing**: temperature 0, affordance ids in document order, recipes re-applied on every page load.
- **Image MCP results never carry `structuredContent`** — Codex drops the whole `content[]`, image included.
- **Paired files must agree**: `lib/slug.js` ≡ `daemon/src/slug.js` (byte-identical), `SAFE_RECIPE_VERBS` ≡ `RECIPE_VERBS`, `AGENT_ALLOWED_VERBS` ≡ `EXECUTE_ACTIONS_VERBS`. `npm run check:sync` and the post-edit hook enforce it.

## Skills (read on demand)

- When a multi-stage task may span sessions or needs a handoff, read .agents/skills/task-continuity/SKILL.md and follow it.
- When changing extension code (`background/`, `content/`, `sidepanel/`, `options/`, `offscreen/`, `lib/`), read .agents/skills/extension-architecture/SKILL.md and follow it.
- When changing `daemon/` or MCP tool output, or when MCP says there is no feedback, read .agents/skills/daemon-mcp/SKILL.md and follow it.
- When touching recorded workflows or the System One judge (`lib/workflow.js`, `lib/judge-client.js`, `runStep`, `driveWorkflow`, workflow MCP tools), read .agents/skills/workflow-steps/SKILL.md and follow it.
- When working on a glossary term (verb registry, affordance, recipe, workflow step, entry store, page feedback) or a `// @term:` region, read .agents/skills/glossary/SKILL.md and follow it.
- When running, writing or debugging tests, or verifying a UI change, read .agents/skills/testing/SKILL.md and follow it.
- When committing, opening or merging a PR, or cleaning up a worktree, read .agents/skills/ship-flow/SKILL.md and follow it.
- When editing agent instructions, skills or hooks, or reviewing cross-session harness memory, read .agents/skills/harness-rules/SKILL.md and follow it.
- When the user invokes `/bag-workflow` or `/bag-memo` (user-invoked only), read .agents/skills/bag-workflow/SKILL.md or .agents/skills/bag-memo/SKILL.md and follow it.

## Git workflow

- **GitHub Flow** — never commit straight to `main`; work in your own worktree (`make wt.new`), never in another session's.
- **Commit messages in English**, imperative mood; subject ≤ ~72 chars, body explains the *why* when non-trivial.
- **Default shipping = `make -C <worktree> ship`** (all CLIs). On `AUTO_SHIP NEEDS_HUMAN`, report the PR URL + reasons and use the manual flow in the ship-flow skill (Pre-Ship panel + human confirmation before `gh pr merge`). Never loosen its thresholds or protected list.
- **After any merge, clean up the worktree and branches** before reporting completion: after `gh pr merge` or a GitHub Web merge, run `make -C <worktree> ship` again — it detects the merged PR and only cleans up.
- **Start Claude Code at the repo root** — `.claude/settings.json` hooks load only from the launch directory.

## Harness budget

This file is always on in every CLI and capped at 8,000 characters (`npm run check:harness`, also run by the post-edit hook). Put new knowledge in a skill with one trigger line above, then a script, a subagent or a hook; add prose here last and cut something to pay for it. If agents ignore a rule, enforce it with a hook or a check instead of restating it.
