#!/usr/bin/env node

/**
 * CDP Bridge CLI: executes action registry commands on a target tab using the Chrome DevTools Protocol.
 * Useful as a fallback execution pathway when the WebSocket daemon is unreachable.
 */

import { parseArgs } from 'node:util';

// Helper to wait for a WebSocket to be ready
function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1) return resolve();
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
  });
}

function connectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let messageId = 0;
    const pending = new Map();

    ws.onopen = () => {
      resolve({
        send(method, params = {}, sessionId = undefined) {
          return new Promise((res, rej) => {
            const id = ++messageId;
            pending.set(id, { res, rej });
            const msg = { id, method, params };
            if (sessionId) msg.sessionId = sessionId;
            ws.send(JSON.stringify(msg));
          });
        },
        close() {
          ws.close();
        }
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            res(msg.result);
          }
        }
      } catch (e) {
        // ignore
      }
    };

    ws.onerror = (err) => {
      reject(err);
    };

    ws.onclose = () => {
      for (const { rej } of pending.values()) {
        rej(new Error('WebSocket closed'));
      }
      pending.clear();
    };
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      actions: { type: 'string' },
      tabId: { type: 'string' },
      windowId: { type: 'string' },
      urlContains: { type: 'string' },
      titleContains: { type: 'string' },
      port: { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    strict: false,
  });

  const verbose = values.verbose;

  let actions = [];
  try {
    if (values.actions) {
      actions = JSON.parse(values.actions);
    } else if (positionals[0]) {
      actions = JSON.parse(positionals[0]);
    }
  } catch (e) {
    if (values.json) {
      console.log(JSON.stringify({ ok: false, error: 'Failed to parse actions JSON: ' + e.message }));
    } else {
      console.error('Failed to parse actions JSON:', e.message);
    }
    process.exit(1);
  }

  // 1) Probe ports (default 9333, 9222)
  let port = null;
  let webSocketDebuggerUrl = null;
  const ports = values.port ? [Number(values.port)] : [9333, 9222];

  for (const p of ports) {
    try {
      if (verbose) console.error(`Probing port ${p}...`);
      const res = await fetch(`http://127.0.0.1:${p}/json/version`);
      if (res.ok) {
        const data = await res.json();
        webSocketDebuggerUrl = data.webSocketDebuggerUrl;
        port = p;
        if (verbose) console.error(`Found active Chrome remote debugger on port ${p}`);
        break;
      }
    } catch (e) {
      // ignore
    }
  }

  if (!port || !webSocketDebuggerUrl) {
    const msg = 'Could not connect to Chrome debugger on ports: ' + ports.join(', ');
    if (values.json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  try {
    // 2) Find extension ID from target list
    if (verbose) console.error('Querying Chrome target list...');
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await listRes.json();
    if (verbose) {
      console.error('All targets:');
      for (const t of targets) {
        console.error(`  - type=${t.type} id=${t.id} url=${t.url}`);
      }
    }

    const extTarget = targets.find(t => t.url && t.url.startsWith('chrome-extension://'));
    if (!extTarget) {
      throw new Error('No target starting with chrome-extension:// found in Chrome.');
    }
    const match = extTarget.url.match(/chrome-extension:\/\/([a-p]{32})\//);
    if (!match) {
      throw new Error('Failed to extract extension ID from target URL.');
    }
    const extensionId = match[1];
    if (verbose) console.error(`Discovered extension ID: ${extensionId}`);

    // Search for any existing target of our extension (options, background, offscreen, etc.)
    let target = targets.find(t => t.url && t.url.startsWith(`chrome-extension://${extensionId}`));
    const browserClient = await connectCDP(webSocketDebuggerUrl);

    if (!target) {
      if (verbose) console.error('Extension target not found. Creating a new options page target...');
      const createRes = await browserClient.send('Target.createTarget', {
        url: `chrome-extension://${extensionId}/options/options.html`
      });
      target = { id: createRes.targetId };
    }

    const targetId = target.id || target.targetId;
    if (verbose) console.error(`Attaching to target ${targetId}...`);

    const attachRes = await browserClient.send('Target.attachToTarget', {
      targetId,
      flatten: true
    });
    const sessionId = attachRes.sessionId;

    // Wait for chrome.tabs to be available (up to 5 seconds)
    if (verbose) console.error('Waiting for extension context (chrome.tabs) to be ready...');
    let ok = false;
    for (let i = 0; i < 50; i++) {
      try {
        const checkUrl = await browserClient.send('Runtime.evaluate', {
          expression: 'window.location.href',
          returnByValue: true
        }, sessionId);
        const checkChrome = await browserClient.send('Runtime.evaluate', {
          expression: 'typeof chrome !== "undefined" ? Object.keys(chrome) : null',
          returnByValue: true
        }, sessionId);
        if (verbose) {
          console.error(`Attempt ${i}: URL = ${checkUrl.result?.value}, chrome keys = ${JSON.stringify(checkChrome.result?.value)}`);
        }

        const checkRes = await browserClient.send('Runtime.evaluate', {
          expression: 'typeof chrome !== "undefined" && typeof chrome.tabs !== "undefined"',
          returnByValue: true
        }, sessionId);
        if (checkRes.result?.value === true) {
          ok = true;
          break;
        }
      } catch (e) {
        if (verbose) console.error('Error during check:', e.message);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!ok) {
      throw new Error('chrome.tabs is not available in the target context.');
    }

    // 3) Evaluate action runner async IIFE in the extension session context
    if (verbose) console.error('Executing actions in extension context...');
    const expression = `
      (async () => {
        const tabId = ${values.tabId != null ? Number(values.tabId) : 'null'};
        const windowId = ${values.windowId != null ? Number(values.windowId) : 'null'};
        const urlContains = ${values.urlContains ? JSON.stringify(values.urlContains) : 'null'};
        const titleContains = ${values.titleContains ? JSON.stringify(values.titleContains) : 'null'};
        const actions = ${JSON.stringify(actions)};

        const tabs = await chrome.tabs.query({});
        let matched = tabs;
        if (tabId !== null) {
          matched = matched.filter(t => t.id === tabId);
        }
        if (windowId !== null) {
          matched = matched.filter(t => t.windowId === windowId);
        }
        if (urlContains) {
          const lowerUrl = urlContains.toLowerCase();
          matched = matched.filter(t => t.url && t.url.toLowerCase().includes(lowerUrl));
        }
        if (titleContains) {
          const lowerTitle = titleContains.toLowerCase();
          matched = matched.filter(t => t.title && t.title.toLowerCase().includes(lowerTitle));
        }

        if (matched.length === 0) {
          throw new Error("No matching tab found in Chrome.");
        }

        matched.sort((a, b) => {
          if (a.active && !b.active) return -1;
          if (!a.active && b.active) return 1;
          return 0;
        });

        const targetTabId = matched[0].id;

        // Ensure content script is injected
        try {
          await chrome.tabs.sendMessage(targetTabId, { type: 'PING' });
        } catch (e) {
          // Inject
          await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            files: ['content/content-script.js']
          });
          await chrome.scripting.insertCSS({
            target: { tabId: targetTabId },
            files: ['content/content.css']
          });
        }

        const res = await chrome.tabs.sendMessage(targetTabId, {
          type: 'RUN_ACTIONS',
          actions: actions,
          source: 'cdp_bridge'
        });
        return res;
      })()
    `;

    const evalRes = await browserClient.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);

    browserClient.close();

    if (evalRes.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails.exception?.description || 'JavaScript execution failed in options context.');
    }

    const value = evalRes.result?.value || {};
    if (values.json) {
      console.log(JSON.stringify(value, null, 2));
    } else {
      console.log('Execution completed successfully:', JSON.stringify(value, null, 2));
    }
  } catch (err) {
    if (values.json) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});
