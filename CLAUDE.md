# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Browser Agent Guide is a **working Chrome Manifest V3 side-panel extension** (not a guide doc), plus a separate local Node daemon. The extension lets an LLM operate *any* web page through a **closed, deterministic verb registry** instead of free-form DOM access: the user chats in the side panel, the service worker collects page context and calls an LLM with Structured Outputs to get a fixed list of verbs + args, and the content script executes them deterministically.

The repo is **two independent npm projects** that are installed and tested separately:
- **Repo root** — the extension. Vanilla JS, ES modules, **no build step, no bundler, no linter, no CI**.
- **`daemon/`** — a separate ESM Node service (`bag-visual-feedback-daemon`) that bridges drawn-annotation screenshots from the browser to AI coding CLIs over MCP. Has its own `package.json` / `node_modules`.

UI strings are bilingual JP/EN by design (e.g. `お描き/Draw`); `README.md` is the authoritative English source and `README.ja/ko/zh.md` are translations.

## Commands

### Extension (repo root)
```bash
npm install                      # root devDeps (@playwright/test, @axe-core/playwright)
npx playwright install chromium  # one-time; required before ANY browser-driven test
npm run check                    # FULL gate: check:js && test && test:vf && test:ui  (does NOT run daemon tests)
npm run check:js                 # node --check over the hardcoded source-file list in package.json (closest thing to a linter)
npm test                         # python3 test/anchor.test.py  — Python, not Node (needs `pip install playwright`)
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
npm start                        # node src/index.js  (default inbox ~/Downloads/ai-inbox, port 8765, host 127.0.0.1)
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
4. SW `rememberSuccessfulChanges` persists successful recipe verbs as a learned site rule + recipe; on later navigation `syncTab`/`ACTIVATE` re-applies them once.

Visual-feedback (capture): SW captures the tab → offscreen composites drawings onto the PNG → if the daemon is enabled, WebSocket push to `ws://127.0.0.1:8765/ws?token=…`; else `chrome.downloads` to `~/Downloads/ai-inbox/<slug>/{shot.png,raw.png,annotation.json,memo.md}`.

## Daemon architecture

One `http.Server` on one loopback port (default 8765) serves three surfaces: `/healthz` (JSON probe), `/mcp` (MCP Streamable HTTP), and a WebSocket `upgrade` on `/ws` (extension push). The flow: extension pushes annotated PNG + metadata over WS → `writer.js` atomically writes `<inbox>/<slug>/` → an AI CLI POSTs to `/mcp` and calls `get_latest_visual_feedback`, getting the image as MCP vision content **plus** an absolute `file_path` (the dual return is a core design invariant).

- `src/index.js` wires the http server (`http.js`) + WS server (`ws.js`) + token; prints MCP/WS urls + token to **stderr** (stdout stays clean).
- `src/http.js` — Node built-in `http` (not express/hono). MCP is **stateless**: a fresh `McpServer` + `StreamableHTTPServerTransport` per POST, so all CLIs can hit one endpoint concurrently. 8MB body cap.
- `src/ws.js` — token-checked WS receive (constant-time compare; 401 + destroy on mismatch). 64MB payload cap (composite PNG base64 is large).
- `src/server.js` — MCP server `bag-visual-feedback` with 3 tools: `list_visual_feedback`, `get_latest_visual_feedback`, `get_visual_feedback`. All filters are optional case-insensitive substring matches.
- `src/inbox.js` / `src/writer.js` — read (newest-first scan, skips `done/`) and write (server-side slug from `capturedAt`, tmp→rename atomic, 0600/0700, rollback on failure) sides.
- `src/token.js` — shared secret at `~/.bag-vf/token`; precedence flag > env > persisted file > newly generated.

## Conventions & gotchas

- **The verb registry is a CLOSED set.** The LLM can only emit verbs that exist in `AI_VERBS` (`content/content-script.js`), enforced by an enum in `buildResponseSchema` (`lib/ai-client.js`), generated from the live catalog returned by `COLLECT_CONTEXT`. Add a capability = add one verb entry; it auto-flows into both the prompt and the schema.
- **Action args travel as `argsJson` (a JSON *string*), not a nested object** — deliberately, because strict Structured Outputs requires every property required + `additionalProperties:false`, impossible for verbs with heterogeneous arg shapes. `callAI` re-parses `argsJson`. Don't try to put a typed args object in the schema.
- **`compositor.js` must stay Canvas-2D-only** — no SVG/`foreignObject`/`createElementNS`/`new Image`/`drawImage` in the module body (SVG foreignObject taints the canvas → `convertToBlob()` throws SecurityError). A banned-token scan in `compositor.test.mjs` **fails the build** if you add them. `drawImage` is allowed only in `offscreen.js` (the screenshot background).
- **Coordinates are layered**: drawings stored as 0..1 fractions of the anchored element's rect (survive reflow/scroll); at composite time `factor = dpr × outputScale` converts CSS px → output px; `computeOutputSize` caps the long edge at 2000px (vision APIs reject larger). Apply `factor` uniformly to every coordinate and line width.
- **Determinism is load-bearing**: temperature defaults to 0, affordance `aiId`s assigned in document order, recipes re-applied on revisit. Annotations persist per `origin+pathname` under `chrome.storage.local` key `aiAdvisorAnnotations`.
- **API key lives in `chrome.storage.local`, NOT `sync`** (it's a secret) — keep it that way. Always read/write settings via `lib/storage.js` so defaults merge.
- **Two recipe allow-lists must stay in sync**: `SAFE_RECIPE_VERBS` (`options/options.js`) and `RECIPE_VERBS` (`background/service-worker.js`) — both = `injectHtml/injectCss/injectScript/outlineElement/injectButton/injectPanel`. Only these get persisted and auto-replayed.
- **Security boundary**: high-risk verbs (`setStyle`, `removeElement`, `defineMarker`) are hidden from chat and rejected on chat/auto-recipe paths; page text/attributes are treated as **untrusted** (prompt-injection defense in `prompt.js`). Don't widen verb exposure casually.
- **`injectScript` runs via the User Scripts API in the service worker**, not the content script (content sends `EXECUTE_USER_SCRIPT` to SW → `chrome.userScripts.execute`). Requires Chrome 135+ and the user manually enabling "Allow User Scripts" in `chrome://extensions`.
- **If you add a source JS file**, add it to BOTH the `check:js` file list and the `zip` file list in `package.json` (no glob — explicit lists).
- **Three test runners, easy to confuse**: Playwright runs `*.spec.mjs` (`testMatch` excludes `.test.mjs`); compositor `*.test.mjs` (root) is a bare node script; daemon `*.test.mjs` run via `node --test`; `test/anchor.test.py` is Python.
- **Daemon MCP registration uses a different JSON key per CLI**: Claude Code / Codex use `url`, Antigravity uses `serverUrl` — all pointing at `http://127.0.0.1:8765/mcp` (see `daemon/README.md`). Auth is WS-only; `/mcp` relies on loopback binding.
- **The shared `~/Downloads/ai-inbox`** means `get_latest_visual_feedback` can return another project's last capture — pass `urlContains`/`titleContains` to scope it. A non-matching filter returns text-only (no image) on purpose.
- **UI is bilingual JP/EN**; keep new user-facing strings bilingual. The anti-slop UI quality workflow (`docs/ui-quality-workflow.md`) requires generated UI changes to be backed by a repeatable Playwright/axe test or screenshot, verified at side-panel width.
