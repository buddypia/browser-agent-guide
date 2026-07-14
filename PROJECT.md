# Project: Bidirectional Browser Control and Fallback Bridge

## Architecture
This project enhances the Browser Agent Guide (BAG) by establishing a bidirectional control pathway and fallback tools:
1. **Primary Bidirectional WebSocket Relay**:
   - The permanent node daemon (`daemon/src/ws.js`) acts as a bridge. It allows clients (e.g. AI CLI tools) to push action commands (verbs + args) to connected extension instances.
   - The extension Service Worker (`background/service-worker.js`) connects to the daemon, listens for action commands, locates the targeted/active tab, executes commands via the content script's `RUN_ACTIONS` pathway, and relays back the execution results.
2. **Fallback CDP Bridge CLI (`scripts/cdp-bridge.mjs`)**:
   - A standalone Node script that connects directly to the Chrome DevTools Protocol (CDP) port of an open browser.
   - It attaches to a target tab matching URL/title substrings and executes action commands directly over the DevTools Protocol without terminal prompt locks.
3. **Permanent Clipboard Hook**:
   - Injected in the content script (`content/content-script.js`), it intercepts calls to `navigator.clipboard.writeText` to capture clipboard text (like tokens or environment variables) and log them to `signalLog` to prevent loss when User Activation checks block reading.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| 1 | M1: Exploration & Proposal | Analyze existing WebSocket & background structures, propose exact schemas/interfaces. | None | DONE |
| 2 | M2: Integrated Implementation & Verification | Implement the Bidirectional WebSocket Relay, Fallback CDP Bridge CLI, Clipboard Interceptor, and Test Verification. | M1 | DONE |

## Interface Contracts
### WebSocket Command Protocol (Primary Relay)
- **Push Command (Daemon -> Extension)**:
  ```json
  {
    "type": "run_actions",
    "requestId": "unique-uuid",
    "tabFilter": {
      "urlContains": "substring",
      "titleContains": "substring",
      "tabId": 123
    },
    "actions": [
      {
        "verb": "clickElement",
        "args": { "selector": "button#submit" },
        "reason": "submit form"
      }
    ]
  }
  ```
- **Response Command (Extension -> Daemon)**:
  ```json
  {
    "type": "run_actions_result",
    "requestId": "unique-uuid",
    "ok": true,
    "results": [
      {
        "ok": true,
        "value": "...",
        "error": null
      }
    ]
  }
  ```

## Code Layout
- `background/service-worker.js`: Background script managing WebSocket relay client and tab message execution.
- `content/content-script.js`: Content script executing the verbs, handles clipboard hooks and runs verbs.
- `content/clipboard-hook.js`: Hook running in the MAIN world to intercept clipboard calls.
- `daemon/src/ws.js`: WebSocket server handling inbound push requests from control clients and out to extension.
- `daemon/src/server.js`: MCP server registration for `execute_actions` tool.
- `daemon/src/http.js`: Wiring the HTTP server to pass actions executor down.
- `daemon/src/index.js`: Exposing actions executor from ws server to HTTP server.
- `manifest.json`: Registering the clipboard hook in the MAIN world.
- `scripts/cdp-bridge.mjs`: Fallback CLI tool to connect to Chrome via CDP.
- `test/`: Verification test suites.
