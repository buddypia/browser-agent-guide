# Contributing to Browser Agent Guide

Thank you for your interest in contributing to **Browser Agent Guide**!

This project is a Chrome Manifest V3 extension and companion local daemon that lets Large Language Models operate web pages through a **closed, deterministic verb registry** instead of free-form DOM access.

Please take a moment to review this guide before submitting issues or pull requests.

---

## Code of Conduct

This project is governed by the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## Repository Structure

The repository consists of two independent npm packages:

- **Root (`/`)** — The Chrome Manifest V3 side-panel extension. Vanilla JavaScript using ES modules with **no build step, no bundler, no linter**.
- **`daemon/`** — An independent Node.js ESM daemon (`bag-page-feedback-daemon`) bridging browser screenshot annotations to AI coding CLIs over Model Context Protocol (MCP) and WebSockets. Has its own `package.json` and dependencies.

---

## Prerequisites

- **Node.js**: `>= 20.0.0`
- **Playwright Chromium**: installed via `npx playwright install chromium`

---

## Setup & Installation

Clone the repository and install dependencies for both the extension and daemon:

```bash
# Clone the repository
git clone https://github.com/buddypia/browser-agent-guide.git
cd browser-agent-guide

# Install root dependencies (Playwright and testing tools)
npm install
npx playwright install chromium

# Install daemon dependencies (@modelcontextprotocol/sdk, ws, zod)
cd daemon && npm install && cd ..
```

---

## Quality Gates & Verification

We maintain strict quality gates with zero tolerance for broken invariants. Always run verification locally before submitting changes:

```bash
# Full test suite for the extension
npm run check

# Fast syntax and schema checks
npm run check:js         # node --check syntax over tracked source files
npm run check:markers    # @agent: marker lint
npm run check:glossary   # domain glossary validation

# Individual extension tests
npm test                 # anchor test via playwright-cli
npm run test:slug        # slug generation tests
npm run test:recipe      # recipe merge and deduplication tests
npm run test:prompt      # system prompt assembly tests
npm run test:workflow-lib # workflow evaluation tests
npm run test:eg2         # EmbeddingGemma 2 client tests
npm run test:ship        # auto-ship and cleanup tests
npm run test:pf          # annotation compositor tests
npm run test:ui          # Playwright side panel / options page UI specs

# Daemon tests
cd daemon && npm test    # runs all daemon node:test specs

# Run all gates (extension + daemon) in one command:
make q.check
```

To test the extension interactively in a headed browser:

```bash
npm run debug:playground
```

---

## Worktree Workflow

To ensure isolation and reproducible review, all development is performed in owned git worktrees:

```bash
# 1. Create a fresh worktree branched from origin/main
make wt.new BR=feature/<task-name>

# 2. Run commands inside the active worktree
make wt.run CMD="npm run check"

# 3. Clean up merged local branches
make clean.branches
```

Avoid committing directly on `main`.

---

## Architectural Invariants

Contributors must respect these core architectural rules:

1. **Closed Verb Registry**:
   - The LLM can only emit verbs that exist in `AI_VERBS` (`content/content-script.js`).
   - Free-form DOM evaluation or arbitrary code execution from the model is strictly prohibited.
   - To add a new action, define a single verb in `AI_VERBS`. It automatically flows into the system prompt and the Structured Outputs schema.

2. **Structured Outputs & `argsJson`**:
   - LLM responses use strict Structured Outputs schemas.
   - Verb arguments travel as a JSON string (`argsJson`), not a nested object, to satisfy strict schema constraints across providers.

3. **Canvas 2D Only in `compositor.js`**:
   - `lib/page-feedback/compositor.js` must remain strictly Canvas 2D.
   - Do NOT use SVG `foreignObject`, `createElementNS`, `new Image`, or tainted elements, as they taint the canvas and throw `SecurityError` on `convertToBlob()`.

4. **Bilingual UI Strings**:
   - Extension UI strings are bilingual by design (Japanese / English, e.g., `お描き/Draw`, `メモを残す/Add note`).
   - `README.md` is the authoritative English documentation; `README.ja/ko/zh.md` are translations.

5. **Security & Guardrails**:
   - API keys are stored strictly in `chrome.storage.local` (never `sync` and never committed).
   - High-risk verbs (`setStyle`, `removeElement`, `defineMarker`) are hidden from chat and rejected on the chat execution path.
   - Page text and attributes are treated as untrusted data to mitigate prompt injection.

---

## Pull Request Guidelines

1. Ensure your branch passes `npm run check` and `cd daemon && npm test`.
2. Fill out the [Pull Request Template](.github/pull_request_template.md) completely.
3. Keep pull requests focused on a single change or feature.
4. If modifying existing features or adding new verbs, include accompanying unit and/or UI specs.
