# Security Policy

## Supported Versions

We provide security updates for the following versions of **Browser Agent Guide**:

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |
| >=0.1.0 | :white_check_mark: |

We recommend always running the latest version from `main` or the latest published release.

---

## Reporting a Vulnerability

The Browser Agent Guide team takes the security of our users and their data seriously. If you discover a security vulnerability, please follow responsible disclosure practices:

1. **Do NOT open a public GitHub issue** to report a security vulnerability.
2. Submit a report through **[GitHub Private Vulnerability Reporting](https://github.com/buddypia/browser-agent-guide/security/advisories/new)**. This enables maintainers and reporters to collaborate on a patch in private before public disclosure.

### What to Include in Your Report

To help us triage and resolve the issue quickly, please include:
- A clear description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal Proof of Concept (PoC).
- The affected component (Extension background worker, content script, side panel, or daemon).
- Software versions (Chrome version, OS, Node.js version).

### What to Expect

- **Acknowledgment**: We aim to acknowledge vulnerability reports as promptly as possible.
- **Assessment & Triage**: We will keep you informed of our progress as we investigate and develop a fix.
- **Credit**: Upon public release of the fix, we will gladly credit you in our release notes and security advisory (unless you prefer to remain anonymous).

---

## Security Architecture & Design Principles

Browser Agent Guide is designed with defense-in-depth principles:

1. **Closed Verb Registry**: The LLM operates web pages strictly through a finite, deterministic set of actions (`AI_VERBS`). It cannot execute arbitrary JavaScript or manipulate unrestricted DOM nodes.
2. **Local Credential Storage**: AI provider API keys are stored exclusively in `chrome.storage.local`. They are never stored in synced storage, never exposed to web pages, and sent only to the configured AI API endpoint.
3. **Untrusted Input Sanitation**: Web page DOM text, attributes, and user input are treated as untrusted data to guard against indirect prompt injection.
4. **Daemon Local Boundaries & Authentication**: The background daemon binds by default to loopback (`127.0.0.1`). Authentication is enforced on the WebSocket push route (`/ws`) and image retrieval routes (`/shot/:id.png`, `/raw/:id.png`) using high-entropy bearer tokens and constant-time token comparison (`tokenEquals`). The `/mcp` route is unauthenticated by design to avoid leaking the write-capable bearer token in MCP responses, relying on the loopback network boundary. Users should never expose the daemon port to untrusted external interfaces.
