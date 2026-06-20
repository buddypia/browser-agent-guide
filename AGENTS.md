## What this is

Browser Agent Guide is a **working Chrome Manifest V3 side-panel extension** (not a guide doc), plus a separate local Node daemon. The extension lets an LLM operate *any* web page through a **closed, deterministic verb registry** instead of free-form DOM access: the user chats in the side panel, the service worker collects page context and calls an LLM with Structured Outputs to get a fixed list of verbs + args, and the content script executes them deterministically.

The repo is **two independent npm projects** that are installed and tested separately:
- **Repo root** — the extension. Vanilla JS, ES modules, **no build step, no bundler, no linter, no CI**.
- **`daemon/`** — a separate ESM Node service (`bag-visual-feedback-daemon`) that bridges drawn-annotation screenshots from the browser to AI coding CLIs over MCP. Has its own `package.json` / `node_modules`.

UI strings are bilingual JP/EN by design (e.g. `お描き/Draw`); `README.md` is the authoritative English source and `README.ja/ko/zh.md` are translations.

## Commands

### Worktree workflow
```bash
make wt.new BR=feature/<task>     # create a fresh worktree from origin/main
make wt.run CMD="npm run check"   # run a command in the active worktree
make q.check                      # root npm run check + daemon npm test
```
Tracked source changes should be made in an owned worktree, normally
`.worktrees/<branch>`. Do not commit directly on `main`, do not use raw
`git worktree add` as the normal entrypoint, and do not edit or commit another
session's worktree.

### Extension (repo root)
```bash
npm install                      # root devDeps (@playwright/test, @axe-core/playwright)
npx playwright install chromium  # one-time; required before ANY browser-driven test
npm run check                    # FULL gate: check:js && test && test:vf && test:ui  (does NOT run daemon tests)
npm run check:js                 # node --check over the hardcoded source-file list in package.json (closest thing to a linter)
npm test                         # node test/anchor.playwright-cli.mjs — drives browser via playwright-cli
npm run test:vf                  # node test/visual-feedback/compositor.test.mjs  (bare node script, not node:test)
npm run test:ui                  # playwright test -c playwright.config.mjs  (only **/*.spec.mjs)
npm run debug:playground         # headed Chromium with the unpacked extension loaded, serving test/fixtures/playground.html
npm run zip                      # the ONLY build/package step: zip source dirs into browser-agent-guide.zip
```
Single test:
```bash
npx playwright test -c playwright.config.mjs test/ui-quality.spec.mjs    # one spec file
npx playwright test -c playwright.config.mjs -g "title substring"        # one test by title
```

### Daemon (`cd daemon` first)
```bash
npm install                      # daemon deps (@modelcontextprotocol/sdk, ws, zod)
npm start                        # node src/index.js  (default inbox = <auto-detected Downloads>/ai-inbox, port 8765, host 127.0.0.1)
npm test                         # node --test 'test/*.test.mjs'  (node:test)
node --test test/inbox.test.mjs  # single daemon test file
node scripts/e2e-smoke.mjs       # real-binary E2E: spawn daemon, WS push -> MCP get, on a temp inbox
curl -s http://127.0.0.1:8765/healthz
```
Override via flags `--inbox/--port/--host/--token` or env `BAG_VF_INBOX/BAG_VF_PORT/BAG_VF_HOST/BAG_VF_TOKEN`.

> There is **no CI** and **no linter/formatter**. Run `npm run check` (root) and `cd daemon && npm test` manually before packaging — `npm run check` does **not** cover the daemon.

## Extension architecture

Five MV3 contexts, each with a distinct job (they all share `chrome.runtime.onMessage`):

- **Service worker** (`background/service-worker.js`, `type:module`) — the orchestrator, holds no DOM. The **only** context that calls the LLM (`lib/ai-client.js`) and the only one allowed privileged APIs: `chrome.userScripts.execute`, `chrome.tabs.captureVisibleTab`, `chrome.offscreen`, `chrome.downloads`. Routes messages, auto-applies saved recipes on navigation, relays every page action to the content script.
- **Content script** (`content/content-script.js`) — a plain (non-module) IIFE injected into `<all_urls>`, guarded by `window.__AI_ADVISOR_INSTALLED__`. It **is the verb registry**: the `AI_VERBS` object (~40 verbs), the element resolver, deterministic affordance annotation (assigns stable `data-bag-id` like `button#3`), and the persistent user-annotation/drawing system. No LLM/network access of its own.
- **Side panel** (`sidepanel/sidepanel.js`) — the chat UI. Stateless about pages; talks only to the service worker via `chrome.runtime.sendMessage`. Per-page chat/prompt history in `chrome.storage.local`.
- **Options page** (`options/options.js`) — settings editor (AI provider/key, site rules, recipes JSON, daemon). Reads/writes the single settings blob via `lib/storage.js`.
- **Offscreen document** (`offscreen/offscreen.js`) — exists **solely** because the MV3 service worker has no DOM/Canvas; it composites annotations onto screenshots with `OffscreenCanvas` + Canvas 2D. Only one offscreen doc may exist (`ensureOffscreen()` guards creation); it ignores any message where `msg.target !== 'offscreen'`.

The `lib/` modules are the "brains" — pure-ish ES modules with no global state, consumed by the service worker and offscreen doc, hence unit-testable in Node:
- `lib/ai-client.js` — provider-agnostic LLM call, **always** Structured Outputs. `'openai'` and `'custom'` share `callOpenAICompatible` (json_schema strict); `'anthropic'` forces structure via a single tool + `tool_choice`; `'gemini'` uses `responseJsonSchema` + injected `propertyOrdering`. Each provider reads a *different* model field (`ai.model` / `ai.anthropicModel` / `ai.geminiModel`).
- `lib/prompt.js` — `buildSystemPrompt` assembles the (Japanese) system prompt from the live verb catalog + page affordances/targets + human annotations + a drawing workflow, and encodes the safety/determinism policy.
- `lib/storage.js` — single settings blob under `chrome.storage.local` key `aiAdvisorSettings`. `DEFAULT_SETTINGS` is the schema source of truth; `getSettings` deep-merges defaults per sub-object.
- `lib/site-matcher.js` — pure URL matching (`all/domain/page/prefix/regex`) deciding extension + recipe activation.
- `lib/visual-feedback/compositor.js` — Canvas-2D-only annotation compositor.

### Main chat flow (page action), end to end
1. Side panel → `CHAT{tabId,text,history,rememberScope}` to SW.
2. SW `runChat`: `getSettings` → `COLLECT_CONTEXT` to content (returns verb catalog + affordances/targets + annotations) → `buildSystemPrompt` → `callAI`.
3. SW → `RUN_ACTIONS` to content; content executes each verb deterministically in document order (with a source-based blocklist — destructive verbs are rejected on the `'chat'` path).
4. SW `rememberSuccessfulChanges` persists successful recipe verbs as a learned site rule + recipe; on later navigation `syncTab`/`ACTIVATE` re-applies them once. **SPA internal navigation** (no full reload) is covered too: the content script detects the `location.href` change (`MutationObserver` + `popstate`/`hashchange` via `handleUrlChange`), resets `appliedRecipeSig`, and sends `SPA_NAVIGATED{url}` → SW re-runs `syncTab`. Recipe actions accept optional `waitFor:{selector,timeoutMs}` (defer until the element appears, 5s default; failure if it never does) and `when:{urlContains,selectorExists,selectorAbsent}` (skip unless matched). `runActions` evaluates them whenever present, but **only recipe (ACTIVATE) actions can actually carry them** — the chat-path Structured Outputs schema only emits `{verb,argsJson,reason}`, so chat-driven actions never have `when`/`waitFor`. Learned-recipe persistence (`mergeRecipeActions`) does **not** carry `waitFor`/`when` yet — hand-edit the recipe JSON (Options → Recipes) for per-screen SPA targeting.

Visual-feedback (capture): SW captures the tab → offscreen composites drawings onto the PNG → if the daemon is enabled, WebSocket push to `ws://127.0.0.1:8765/ws?token=…`; else `chrome.downloads` to `<browser download dir>/ai-inbox/<slug>/{shot.png,raw.png,annotation.json,memo.md}`. The `<slug>` is `{localYYYYMMDD-HHMMSS}__{host}__{title}__{id}` (see `lib/slug.js`). On the download path the SW then resolves the **absolute** on-disk path via `chrome.downloads.search` (`DownloadItem.filename`), surfaces it in the side panel, and caches the discovered downloads dir; on the daemon path the SW sends that dir as `payload.downloadsDir` so the daemon can adopt it.

## Daemon architecture

One `http.Server` on one loopback port (default 8765) serves three surfaces: `/healthz` (JSON probe), `/mcp` (MCP Streamable HTTP), and a WebSocket `upgrade` on `/ws` (extension push). The flow: extension pushes annotated PNG + metadata over WS → `writer.js` atomically writes `<inbox>/<slug>/` → an AI CLI POSTs to `/mcp` and first calls `get_latest_visual_feedback_context`, getting lightweight text/structured metadata (`@agent:`, selector, testid, anchorLabel) without image tokens. It calls `get_latest_visual_feedback` only when vision is needed, passing the context `id` as `contextId` plus a concrete `imageReason`, then gets the image as MCP vision content **plus** an absolute `file_path` (the image fallback invariant). Image tools refuse to return image content when the supplied `contextId` does not match the current entry.

- `src/index.js` wires the http server (`http.js`) + WS server (`ws.js`) + token; prints MCP/WS urls + token to **stderr** (stdout stays clean).
- `src/http.js` — Node built-in `http` (not express/hono). MCP is **stateless**: a fresh `McpServer` + `StreamableHTTPServerTransport` per POST, so all CLIs can hit one endpoint concurrently. 8MB body cap.
- `src/ws.js` — token-checked WS receive (constant-time compare; 401 + destroy on mismatch). 64MB payload cap (composite PNG base64 is large).
- `src/server.js` — MCP server `bag-visual-feedback` with 5 tools: `list_visual_feedback`, `get_latest_visual_feedback_context`, `get_visual_feedback_context`, `get_latest_visual_feedback`, `get_visual_feedback`. All filters are optional case-insensitive substring matches. The two image tools require `contextId` + `imageReason` so callers cannot skip the lightweight `@agent:`/selector pass by accident.
- `src/inbox.js` / `src/writer.js` — read (newest-first scan, skips `done/`) and write (server-side slug via `src/slug.js` from `capturedAt`+`url`+`title`, tmp→rename atomic, 0600/0700, rollback on failure) sides. `inbox.js` also owns `resolveDownloadsDir()` (Win32 registry / Linux XDG / macOS `~/Downloads`) used by `defaultInboxDir()`.
- **`inboxDir` is runtime-mutable**: `index.js` holds `inboxState.dir` and passes a getter (not a string) to `http.js`/`ws.js`. When the extension reports `downloadsDir` over WS, `index.js` `adoptDownloadsDir` switches the inbox to `<downloadsDir>/ai-inbox` — UNLESS `--inbox`/`BAG_VF_INBOX` pinned it. So tests/callers may pass `inboxDir` as a string **or** a `() => dir` function.
- `src/token.js` — shared secret at `~/.bag-vf/token`; precedence flag > env > persisted file > newly generated.

## Conventions & gotchas

- **The verb registry is a CLOSED set.** The LLM can only emit verbs that exist in `AI_VERBS` (`content/content-script.js`), enforced by an enum in `buildResponseSchema` (`lib/ai-client.js`), generated from the live catalog returned by `COLLECT_CONTEXT`. Add a capability = add one verb entry; it auto-flows into both the prompt and the schema.
- **Action args travel as `argsJson` (a JSON *string*), not a nested object** — deliberately, because strict Structured Outputs requires every property required + `additionalProperties:false`, impossible for verbs with heterogeneous arg shapes. `callAI` re-parses `argsJson`. Don't try to put a typed args object in the schema.
- **`compositor.js` must stay Canvas-2D-only** — no SVG/`foreignObject`/`createElementNS`/`new Image`/`drawImage` in the module body (SVG foreignObject taints the canvas → `convertToBlob()` throws SecurityError). A banned-token scan in `compositor.test.mjs` **fails the build** if you add them. `drawImage` is allowed only in `offscreen.js` (the screenshot background).
- **Coordinates are layered**: drawings stored as 0..1 fractions of the anchored element's rect (survive reflow/scroll); at composite time `factor = dpr × outputScale` converts CSS px → output px; `computeOutputSize` caps the long edge at 2000px (vision APIs reject larger). Apply `factor` uniformly to every coordinate and line width.
- **Determinism is load-bearing**: temperature defaults to 0, affordance `aiId`s assigned in document order, recipes re-applied on revisit (and on SPA internal navigation via `SPA_NAVIGATED`→`syncTab`). Annotations persist per `origin+pathname` under `chrome.storage.local` key `aiAdvisorAnnotations`.
- **API key lives in `chrome.storage.local`, NOT `sync`** (it's a secret) — keep it that way. Always read/write settings via `lib/storage.js` so defaults merge.
- **Two recipe allow-lists must stay in sync**: `SAFE_RECIPE_VERBS` (`options/options.js`) and `RECIPE_VERBS` (`background/service-worker.js`) — both = `injectHtml/injectCss/injectScript/outlineElement/injectButton/injectPanel`. Only these get persisted and auto-replayed.
- **Security boundary**: high-risk verbs (`setStyle`, `removeElement`, `defineMarker`) are hidden from chat and rejected on chat/auto-recipe paths; page text/attributes are treated as **untrusted** (prompt-injection defense in `prompt.js`). Don't widen verb exposure casually.
- **`injectScript` runs via the User Scripts API in the service worker**, not the content script (content sends `EXECUTE_USER_SCRIPT` to SW → `chrome.userScripts.execute`). Requires Chrome 135+ and the user manually enabling "Allow User Scripts" in `chrome://extensions`.
- **If you add a source JS file**, add it to the `check:js` file list in `package.json` (an explicit `node --check` loop — no glob). Packaging (`npm run zip` → `package-extension.sh`) uses an **exclude-list** (`zip -r . -x …`), so new source files are bundled automatically; only new dev/test/doc directories need a new `-x` exclude there.
- **The slug generator is DUPLICATED in two independent npm projects with no shared import**: `lib/slug.js` (extension) and `daemon/src/slug.js` (daemon) must stay **byte-identical** — `test/slug.test.mjs` imports both and fails if they drift. Folder name = `{localYYYYMMDD-HHMMSS}__{host}__{title}__{id}`; id is a **synchronous** FNV-1a hash (NOT `crypto.subtle`, which is async-only in the SW). The folder name **is** the daemon entry `id` (`inbox.js` `id: d.name`), so changing the scheme invalidates previously-emitted ids; old timestamp-named folders still list fine (scan reads arbitrary names). Embedding host/title in the name is a human/AI **skim aid only** — `annotation.json` stays the authority for `urlContains`/`titleContains` (the sanitized name is lossy, so name-matching would false-negative).
- **The `chrome.downloads` save path is the browser's configured download dir, NOT necessarily `~/Downloads`** (user-moved, Edge/Brave, or "ask where to save"). Never assume `~/Downloads/ai-inbox` for the FILE fallback: the SW resolves the real absolute path (`chrome.downloads.search` → `DownloadItem.filename`) and the daemon auto-detects + adopts the reported `downloadsDir`. With the daemon ON the path is owned end-to-end (no mismatch); the mismatch only exists on the daemon-OFF fallback.
- **Three test runners, easy to confuse**: Playwright Test runs `*.spec.mjs` (`testMatch` excludes `.test.mjs`); `npm test` runs `test/anchor.playwright-cli.mjs`, which shells out to `playwright-cli run-code` rather than importing Playwright directly; compositor `*.test.mjs` (root) is a bare node script; daemon `*.test.mjs` run via `node --test`.
- **Daemon MCP registration uses alias `bag_visual_feedback` and a different JSON key per CLI**: Claude Code / Codex use `url`, Antigravity uses `serverUrl` — all pointing at `http://127.0.0.1:8765/mcp` (see `daemon/README.md`). Auth is WS-only; `/mcp` relies on loopback binding.
- **The shared `~/Downloads/ai-inbox`** means `bag_visual_feedback:get_latest_visual_feedback_context` can return another project's last capture — pass `urlContains`/`titleContains` to scope it. A non-matching filter returns text-only (no image) on purpose.
- **UI is bilingual JP/EN**; keep new user-facing strings bilingual. The anti-slop UI quality workflow (`docs/ui-quality-workflow.md`) requires generated UI changes to be backed by a repeatable Playwright/axe test or screenshot, verified at side-panel width.
- **The Stop-time worktree staleness guard measures a *never-refreshed* local `origin/main` ref** (`worktree-shipping-guard.mjs` `measureStaleness`, network-free by design — `worktree-new.mjs` fetches only at creation) and only flags `behind>20`/`age>7d`. So it is **blind to remote `origin/main` divergence that lands *after* worktree creation**, and the `behind` count never predicts an upstream file *deletion/rewrite* that collides with your change (a 2-commit drift can still be a guaranteed modify/delete conflict). Before shipping a long-lived worktree in this multi-session-concurrent repo, `git fetch origin main` then `git diff --name-status origin/main...HEAD`, and re-scope if upstream removed/changed files your work depends on. See `docs/retros/retro-2026-06-20-worktree-base-remote-divergence.md`.

## Skills (bundled Claude Code skills)

- **`bag-workflow`** (`.claude/skills/bag-workflow/`) — project-scoped, **user-invoked** skill (`/bag-workflow [urlContains]`, `disable-model-invocation: true` so this side-effecting flow never auto-fires). The name uses the project's `bag` namespace (`bag` ≈ **B**rowser **A**gent **G**uide; cf. `data-bag-id`, `BAG_VF_*`), giving a playwright→playwright-cli style parent/child: project `browser-agent-guide` → skill `/bag-workflow`. Its job is to **teach a browser-operation workflow to the AI and have it carried out from the cues the user leaves on the page** — お描き is just ONE cue, not the whole story (other cues: live DOM/a11y, extension `data-bag-id`, `@agent:` markers, recorded steps). Common uses: point at a bug in the UI and have it fixed; record steps so the AI stops repeating a mistake. Pipeline = preflight → read cues → read live page → locate target → operate/edit → verify:
  - **Cues** (= WHAT to do): daemon MCP `bag_visual_feedback:get_latest_visual_feedback_context` first (scoped by `urlContains`) to read `@agent:`/selector/testid without image tokens; call `bag_visual_feedback:get_latest_visual_feedback` only if visual interpretation is needed, with `contextId` set to the context `id` and `imageReason` explaining why metadata is insufficient. Fallback = direct read of `~/Downloads/ai-inbox/<slug>/{shot.png,raw.png,annotation.json,memo.md}`.
  - **Target** (= WHERE): `rg -n 'data-agent-id="@agent:' -g '!*.md' -g '!.claude'` (ALWAYS attribute-anchored; bare `@agent:` grep forbidden; exclude `.md`/`.claude` so docs examples aren't matched). **Core controls now carry `@agent:` markers** (`sidepanel.html` 5 + `options.html` 8 = 13; most other elements don't), so prefer markers when present and otherwise map `annotation.json` `selector`/`anchorLabel`/`url(file://)` to source; more markers are an opt-in bootstrap (`references/agent-markers.md`, lint via `npm run check:markers`).
  - **Live browser** (locate + verify): order is `playwright-cli` (installed, zero-setup, reads `data-bag-id`/`data-agent-id` via `eval`) → `claude --chrome` (login-gated) → chrome-devtools-mcp / @playwright/mcp. For `playwright-cli`, always use a named per-workflow session derived from the target host/task (for example `-s=bag-<host>`), never rely on a site-specific hard-coded name, verify `location.href` before side-effecting clicks, and treat snapshot refs like `e123` as ephemeral to that session/page/snapshot. **Codex `codex:rescue`/`codex exec` have NO browser** (escape hatch only; Codex's browser lives in the desktop app's `@chrome`).
  - **Structure**: `scripts/preflight.sh` is a deterministic daemon/MCP/inbox/browser probe printing a `STATUS … source_branch=MCP|FILE|NONE` line; volume lives one level deep in `references/{daemon-mcp,browser-tools,agent-markers,fallbacks}.md` so SKILL.md stays <500 lines. `Edit`/`Write` are intentionally LEFT OUT of `allowed-tools` so code changes still hit the user's approval prompt. New skill is recognized after a Claude Code session restart.

## Git workflow

- **GitHub Flow** — never commit straight to `main`. Branch from `main` (`feat/…`, `fix/…`), commit, push, open a PR, then merge.
- **Commit messages in English**, imperative mood (e.g. "Add @agent: marker lint"); subject ≤ ~72 chars, body explains the *why* when non-trivial.
- **Shipping goes through `gh` directly** (the `create-pr` skill + `ops.mjs` were removed in the brief2dev cleanup): commit in the worktree (`git -C <wt>`), `gh pr create`, then — before `gh pr merge` (the irreversible main merge) — present the 7-section Pre-Ship Human Review Panel, get explicit user confirmation, and run `node .claude/scripts/mark-pre-ship-confirmed.mjs <branch> --quality <label>` (labels: `agent_go` / `self_review_pass` / `trivial_skip`). `pre-ship-review-guard` (PreToolUse) **blocks `gh pr merge` until that marker is fresh** (10 min) — run `gh pr merge` from the worktree so it infers the branch from cwd (else pass `--staged`). Only `gh pr merge` is gated; `gh pr create`/`view`/`list`/`diff` are not. Separately, `worktree-review-report-guard` (Stop) requires a HEAD-stamped `REVIEW.md`. See `docs/retros/retro-2026-06-20-orphaned-ship-gate.md`.
