# Chrome Web Store Listing — Browser Agent Guide

> Last Updated: 2026-06-18

## Store Listing

**Extension Name**
Browser Agent Guide


**Short Description**
Guardrails for browser-operating AIs: a side-panel agent that drives any page through a closed, deterministic verb registry.


**Detailed Description**
Browser Agent Guide provides robust guardrails and helper affordances for browser-operating AI agents to ensure predictable and safe automation.

FEATURES
• Visual Annotations — Click to attach notes, indicators, and labels to page elements.
• Anchored Canvas Drawings — Circle, box, arrow, or sketch freehand directly on elements. Sketches auto-scroll and scale dynamically.
• Deterministic Anchor Multi-Signal — Elements are re-resolved using stable-ID paths, test IDs, and ARIA labels.
• Closed Verb Registry — Restricts the AI to safe, predefined actions (click, fill, scroll) to prevent destructive DOM behaviors.
• Side Panel UI — Interacts with the AI, tracks execution history, and manages saved page configurations inline.
• Dynamic Injection Auto-Save — Save custom CSS or JS scripts using Chrome's User Scripts API to re-apply on visit.
• Direct AI Integration — Connect directly to OpenAI, Anthropic, Gemini, or custom OpenAI-compatible endpoints with local API keys.

HOW TO USE
1. Click the Browser Agent Guide icon in the extensions toolbar to open the side panel chat.
2. Open the Options page (or click the Settings icon in the sidebar) to input your local API key and choose your model provider.
3. Click "Add context" or "Draw" to mark specific webpage regions or elements.
4. Paste the page context into an external AI or instruct the side panel chat using natural language (e.g., "Highlight the search box").
5. Monitor actions as the guide translates prompts into precise, registered verbs.

PRIVACY
Your privacy is our priority. Browser Agent Guide does not collect, store, or transmit your personal data or browsing history to any external server. All configuration details, API keys, prompt history, and local rules remain securely stored on your local device. Direct API requests are sent only to the AI provider endpoint you explicitly configure.

PERMISSIONS
• "Read and change all your data on all websites" — Needed to detect elements, draw annotation overlays, and run automation verbs.
• "Manage your downloads" — Needed to download page context, saved drawings, and history logs locally.
• "Modify data you copy and paste" — Needed to write descriptive page context vectors to the clipboard.
• "Store data on your local device" — Needed to persist API keys, preferences, and page memory rules.
• "Run scripts in the background" — Needed to run the extension service worker for message routing and API connections.
• "Control side panel layout" — Needed to display the main chat interface alongside the active tab.

SUPPORT
Found a bug? Have a suggestion? Visit our GitHub Issues page at:
https://github.com/buddypia/browser-agent-guide/issues

Version 0.1.0 — Initial release. Features interactive side panel chat, multi-signal anchoring, page-scoped drawing, and custom script auto-injection memory.


**Category**
Developer Tools


**Single Purpose**
Guides browser-operating AI agents through a safe, closed verb registry and stores element annotations.


**Primary Language**
English


## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes
• Screenshot 1: Overview of the side panel chat opened next to a target webpage, showcasing the "empty hint" state and the top action buttons.
• Screenshot 2: Demonstration of elements annotated with drawings (circle/arrow/pen) and comments, showing how sketches anchor to page elements.
• Screenshot 3: Settings page, illustrating the AI Connection configuration panel (OpenAI/Anthropic/Gemini) and the list of remembered page/domain rules.


## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Used to save user preferences, model selection, prompt history, and page memory rules locally on the device. |
| `sidePanel` | permissions | Used to display the primary user interface and AI chat guide alongside web content. |
| `scripting` | permissions | Used to inject the action executor and interactive canvas overlays into active web tabs. |
| `tabs` | permissions | Used to retrieve the URL and title of the active tab in order to query/apply matching rules. |
| `userScripts` | permissions | Used to dynamically execute custom user scripts saved for page-specific automation rules via Chrome's secure User Scripts API. |
| `offscreen` | permissions | Used to create a temporary offscreen canvas context to composite user drawings onto page screenshots without DOM access in the service worker. |
| `downloads` | permissions | Used to export and save page feedback packages and page metadata logs directly to the user's local Downloads folder. |
| `<all_urls>` | host_permissions | Used to detect interactive elements, show overlay instructions, and run safe automation verbs on any site the user navigates to. |


## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

*(Note: Data is transmitted directly to the user's chosen third-party AI provider API, but no data is collected or stored by the extension developer.)*

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes


## Privacy Policy

**Privacy Policy URL**
`https://github.com/buddypia/browser-agent-guide/blob/main/PRIVACY.md` *(Placeholder: Update with live hosted URL, such as raw link or GitHub Pages)*


## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free


## Developer Info

**Publisher Name**
buddypia

**Contact Email**
contact@buddypia.com *(Update as appropriate)*

**Support URL / Email**
https://github.com/buddypia/browser-agent-guide/issues

**Homepage URL**
https://github.com/buddypia/browser-agent-guide


## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-06-18 | Initial release package. Visual drawing annotations, multi-signal anchoring, closed verb registry, and script memory. | Draft |


## Review Notes

### Known Issues / Limitations
• `injectScript` requires the "Allow User Scripts" toggle to be enabled in `chrome://extensions` on newer versions of Chrome (Chrome 138+).
• The Extension requires a valid external API key to perform automated actions.
