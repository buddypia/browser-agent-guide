# Project: Bidirectional Browser Control and Fallback Bridge

## Architecture
This project lets AI coding CLIs act on the user's tabs through the extension, and adds fallback tools:
1. **Primary Bidirectional WebSocket Relay**:
   - The node daemon (`daemon/src/ws.js`) is the bridge. The MCP tool `execute_actions` (`daemon/src/server.js`) hands a list of verbs + args to every connected extension instance.
   - The extension service worker (`background/service-worker.js`) keeps the WebSocket open (reconnects when it drops, pings every 20 s so the MV3 worker stays alive), finds the target tab, runs the verbs through the content script's `RUN_ACTIONS` with `source:'execute_actions'`, and sends the results back.
   - The verbs are a deny-by-default allow-list (`AGENT_ALLOWED_VERBS` in the content script = `EXECUTE_ACTIONS_VERBS` in the daemon, which is also the MCP `verb` enum; `test/agent-verbs.test.mjs` checks they match). It has no `inject*`, `navigateTo`, `removeElement` or `submitForm`. `setStyle` may only change colour, border, text, spacing and size properties, and values may not reference anything external (`url()` and similar). Clicks on confirm/purchase/delete buttons and on unnamed buttons come back `held:true`, so a person has to click them; other buttons and links can still be clicked, so a click can still submit a form or navigate. The service worker sets the source itself and ignores any `source` in the daemon's message.
2. **Fallback CDP Bridge CLI (`scripts/cdp-bridge.mjs`)**:
   - A standalone Node script that connects to the Chrome DevTools Protocol (CDP) port of an open browser.
   - It finds the tab matching URL/title substrings and runs the verbs through the extension with `source:'cdp_bridge'`, under the same allow-list and click guard.
3. **Clipboard Hook**:
   - `content/clipboard-hook.js` runs in the MAIN world at `document_start` and records the text the page passes to `navigator.clipboard.writeText` (nonce-checked) in `clipboardLog`, so a copied token or environment variable is not lost when user-activation checks block reading the clipboard.
   - The text stays out of `COLLECT_CONTEXT` and `exportContext` (it can hold secrets and is page-controlled). Only an explicit `readSignals` returns it.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| 1 | M1: Exploration & Proposal | Analyze existing WebSocket & background structures, propose exact schemas/interfaces. | None | DONE |
| 2 | M2: Integrated Implementation & Verification | Implement the Bidirectional WebSocket Relay, Fallback CDP Bridge CLI, Clipboard Interceptor, and Test Verification. | M1 | DONE |
| 3 | M3: Agent allow-list | Limit `execute_actions` / CDP bridge to an allow-list and hold irreversible clicks. | M2 | DONE |
| 4 | M4: Done state | `resolve_feedback` marks a capture handled; the extension shows the memo as done and stops resending it. | M2 | DONE |

## Interface Contracts
### WebSocket Command Protocol (Primary Relay)
- **Push Command (Daemon -> Extension)**. The tab filters are top-level fields, all optional:
  ```json
  {
    "type": "run_actions",
    "requestId": "unique-id",
    "tabId": 123,
    "windowId": 1,
    "urlContains": "substring",
    "titleContains": "substring",
    "actions": [
      {
        "verb": "setStyle",
        "args": { "selector": "button#submit", "styles": { "backgroundColor": "#c00000" } },
        "reason": "fix the button the memo points at"
      }
    ]
  }
  ```
- **Response Command (Extension -> Daemon)**. One result per action, in order:
  ```json
  {
    "type": "run_actions_result",
    "requestId": "unique-id",
    "ok": true,
    "results": [
      { "verb": "setStyle", "ok": true, "reason": "fix the button the memo points at", "result": { "styled": true } },
      { "verb": "clickElement", "ok": false, "held": true, "label": "Buy now", "error": "Held: ..." }
    ]
  }
  ```
  `ok:false` at the top level means the request itself failed (no matching tab, content script unreachable); the message is in `error`.
- **Generic requests**. `wss.request(type, params)` sends `{...params, type, requestId}` to every connected extension and resolves on the first `<type>_result` with `ok:true`; an extension that has nothing to act on answers `ok:false`, and the request rejects only when every extension did. `resolve_feedback` uses it as `mark_annotations_done`:
  ```json
  { "type": "mark_annotations_done", "requestId": "unique-id", "tabId": 123, "url": "https://…", "ids": ["note-…", "drawing-…"] }
  { "type": "mark_annotations_done_result", "requestId": "unique-id", "ok": true, "marked": ["note-…"] }
  ```
  The service worker matches by annotation id only (ids are unique across pages; `tabId`/`url` are informational). It patches the stored annotations once (`doneAt`, `forAI:false`) and then tells every open tab to update its in-memory copy, so a tab holding a stale list cannot write it back over another tab's memo.

## Code Layout
- `background/service-worker.js`: WebSocket relay client; finds the tab and forwards `RUN_ACTIONS`.
- `content/content-script.js`: runs the verbs; `AGENT_ALLOWED_VERBS` and the click guard for external agents.
- `content/clipboard-hook.js`: MAIN-world hook that records clipboard writes.
- `daemon/src/ws.js`: WebSocket server; `request(type, params)` sends a command to the extension and resolves the matching result.
- `daemon/src/server.js`: MCP server; the `execute_actions` tool and `EXECUTE_ACTIONS_VERBS`, and `resolve_feedback`.
- `daemon/src/http.js`: passes the actions executor and the generic extension request to the MCP server.
- `daemon/src/index.js`: wires the WebSocket server's executor and request into the HTTP server.
- `manifest.json`: registers the clipboard hook in the MAIN world.
- `scripts/cdp-bridge.mjs`: fallback CLI that drives the extension over CDP.
- `test/m2-integration.spec.mjs`, `test/agent-verbs.test.mjs`, `daemon/test/mcp.test.mjs`: relay, allow-list and parity tests.
