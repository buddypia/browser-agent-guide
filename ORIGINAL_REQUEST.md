# Original User Request

## Initial Request — 2026-07-14T17:03:29+09:00

<USER_REQUEST>
Implement a dual-path browser control system: a primary WebSocket relay path (CDP-free, bidirectional extension-daemon bridge) and a fallback standalone CDP bridge CLI, with built-in clipboard interception in the extension.

Working directory: /Users/a13973/dev/buddypia/browser-agent-guide
Integrity mode: benchmark

## Requirements

### R1. Bidirectional WebSocket Relay (Primary Path)
Upgrade the extension and daemon communication:
1. Make the daemon's WebSocket server (`daemon/src/ws.js`) bidirectional, allowing it to push action commands (verbs + args) to connected extension clients.
2. In the extension Service Worker (`background/service-worker.js`), handle action requests from the daemon WebSocket, target the active tab (matching URL or tab metadata), execute actions via content script `RUN_ACTIONS`, and send results back via WebSocket.

### R2. Fallback CDP Bridge CLI (`scripts/cdp-bridge.mjs`)
Implement a standalone fallback CLI tool that:
1. Connects to local Chrome CDP (default port 9333/9222).
2. Direct-WebSocket connects to a targeted tab matching given URL/title substrings, executing actions without terminal prompt locks.

### R3. Permanent Clipboard Hook in `content/content-script.js`
Permanently hook `navigator.clipboard.writeText` in the extension content script to intercept copied text (like token environment variables) during automated actions, logging it to `signalLog` to guarantee recovery even when blocked by browser User Activation rules.

### R4. Test Verification
Develop tests in the test suite to verify:
1. Action execution and result recovery via the WebSocket relay path.
2. Action execution and result recovery via the fallback CDP bridge CLI.

## Acceptance Criteria

### Execution Paths
- [ ] Active tabs can be controlled via WebSocket push (primary path) without open CDP ports.
- [ ] Active tabs can be controlled via direct CDP WebSocket attach (fallback CLI) when debugging port is open.
- [ ] Both paths return action results and successfully recover intercepted copy commands.

### Extension Integrity
- [ ] Extension works normally (checked with `npm run check`).
</USER_REQUEST>
