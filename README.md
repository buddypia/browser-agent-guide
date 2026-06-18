# Browser Agent Guide 🧭

> Guardrails and a guide that keep browser-operating AIs on track.

**English** · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md)

---

**Browser Agent Guide** is a Chrome (Manifest V3) extension that lets **non-engineers** add notes, markers,
cue-buttons, and **drawings (circle/box/arrow/freehand around an element)** to any web page **just by
clicking** — so a browser-operating AI (this extension's chat, or an external AI chat UI) understands the
page context and behaves deterministically.

Annotations are **persisted per page (origin + path)** and **restored on every visit** (reproducibility),
and each target element is re-resolved through a **robust multi-signal anchor** (stable-ID path,
`data-testid`, `name`, `aria-label`, text match) so the *same element is found every time*
(determinism). A **Copy context** button exports a deterministic page description to paste into an
external AI chat.

You can also instruct the AI directly from the side-panel chat — but only through a **closed,
deterministic verb registry** (`clickAffordance`, `fillAffordance`, `markElement`, `addNote`, …).
Combined with **stable element IDs** and **Structured Outputs**, *the same prompt produces the same
actions*.

## Why guardrails?

| Goal | How Browser Agent Guide delivers it |
| --- | --- |
| AI integration + Structured Outputs | The service worker calls the AI with a strict JSON Schema (`reply` + `actions`) |
| Store the API key | `chrome.storage.local` only, set from the options page |
| Remember pages as needed | Rules are added automatically after saved annotations or chat-driven page changes; injection memory can target the current URL, current domain, or all sites, and rules can still be edited manually |
| Add cues from the sidebar | The AI can use safe verb-registry actions; explicit HTML / CSS / JS injections can be saved as re-apply recipes |
| Deterministic, consistent operation | AI can only use registered verbs; elements get stable `aiId`s; recipes re-apply every load |

The AI never improvises raw DOM calls. It chooses from the **verb registry**, so behaviour stays
predictable: *same instruction → same verb → same result*.
Page text and HTML attributes are treated as untrusted data. High-risk DOM mutation verbs such as
`setStyle`, `removeElement`, and `defineMarker` are hidden from chat AI and rejected from chat /
auto-recipe execution paths. `injectHtml`, `injectCss`, and `injectScript` are available only for
explicit user-requested page additions and are saved as re-apply recipes when they succeed.
`injectScript` runs through Chrome's User Scripts API, so it does not rely on page inline-script CSP.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on
3. **Load unpacked** → select this folder
4. Click the toolbar icon to open the side panel

> Requires Chrome 135+ (Side Panel API + User Scripts API).
> On Chrome 138+, enable **Allow User Scripts** in the extension details page before using `injectScript`.

## Setup

1. Right-click the icon → **Options** (or the **設定 / Settings** button in the side panel)
2. **① AI connection** — choose a provider (OpenAI / Anthropic / Gemini / custom OpenAI-compatible), paste the
   API key and model, then save
   - OpenAI-compatible: uses `response_format: json_schema` with `strict: true`
   - Anthropic: forces structured output via `tool_choice`
   - Gemini: uses `generationConfig.responseMimeType: "application/json"` with `responseJsonSchema`
3. Choose **② AI injection auto-save** to decide whether injected HTML / CSS / JS should be saved for
   the current URL, current domain, or all sites
4. Save an annotation or ask the chat to change the page; Browser Agent Guide automatically remembers that scope
5. Optionally edit **③ remembered URLs / activation rules** and **④ memory rules** for verbs that
   re-apply on every page load

## Usage

Open any page and type natural-language instructions into the side-panel chat:

- "Find the login button and highlight it"
- "Plant a *Summarize* button bottom-right; its purpose is to ask the AI to summarize this page"
- "Type *Chrome extension* into the search box and submit"
- "Inject a fixed notice on this page and keep showing it next time"
- "Inject CSS for this domain so headings are easier to scan"

The AI returns a structured `reply` (explanation) plus `actions` (verbs), which run in order. Each
verb's result is shown inline in the chat. When a saved annotation or chat-driven page change succeeds,
the selected URL / domain / all-sites scope and any durable re-apply rules are remembered automatically.
Saved visual changes such as `outlineElement` re-apply after page refresh. To revert them, delete the
matching remembered URL or memory rule in Settings, then refresh the page.

Toolbar: **＋補足を付ける/Add context** (save notes, markers, or cue buttons) ·
**お描き/Draw** (circle/box/arrow/freehand a target and attach a comment) ·
**文脈をコピー/Copy context** · **手がかり/Affordances** (list interactive elements) ·
**履歴/History** (reuse sent prompts, also via ↑/↓ at the textarea edge) · **設定/Settings**.

### Drawing (circle/box/arrow/freehand around an element)

Press **🖍 お描き/Draw** to enter drawing mode and sketch on the page (◯circle / ▭box / ↗arrow / ✎pen +
color), then **Done** to attach a comment and an AI-facing purpose. Each drawing is **anchored to the
element it encircles**; coordinates are stored as **fractions of the element's box**, so the sketch
follows the element and is **restored at the same place on revisit, scroll, and reflow**. The AI receives
a plain-language description (e.g. *"circled in red. comment: …"*), so "look here / fix this circled part"
instructions land precisely. Saved drawings (kind: **お描き**) are editable/removable from the
"このページの補足" list.

## Verb registry (excerpt)

Implemented in `content/content-script.js` as `AI_VERBS`. Every function name is a verb.

| Verb | Purpose |
| --- | --- |
| `annotatePage` / `listAffordances` | Assign stable IDs / list interactive elements |
| `clickAffordance` / `clickElement` | Click |
| `fillAffordance` / `fillInput` / `selectOption` | Fill / select |
| `submitForm` / `focusElement` / `scrollToElement` | Submit / focus / scroll |
| `highlightElement` / `outlineElement` | Temporary highlight / persistent outline |
| `injectHtml` / `injectCss` / `injectScript` | Inject explicit HTML / CSS / JS and re-apply it on revisit |
| `injectButton` / `injectPanel` | Plant cue buttons and sanitized panels |
| `waitForElement` | Wait for an element |
| `navigateTo` / `goBack` / `notify` | Navigate / toast |
| `readText` / `extractData` / `readSignals` | Read / extract / read user signals |
| `startAnnotating` / `startDrawing` | Start the click-to-annotate / draw (circle/box/arrow/pen) mode |

### Affordances & human-AI cooperation

`annotatePage` assigns **deterministic `aiId`s** in document order (`button#1`, `input-text#2`, …).
The AI references those IDs via `clickAffordance({aiId})`, so there's no drift from guessed selectors.

Buttons planted with `injectButton` carry a neutral DOM attribute such as `data-bag-intent` and, when clicked, record a **signal**
readable via `readSignals`. This closes the loop: *a human clicks a planted button → the AI reads the
intent and continues the task.*

For elements an author wants the AI to target **reliably across reflows**, the repo also defines the **`@agent:` marker convention** — a stable anchor `data-agent-id="@agent:<path>"` found with `rg -n 'data-agent-id="@agent:'`. See [docs/agent-markers.md](docs/agent-markers.md). (Dynamically-injected UI is out of scope — it already has `data-bag-id` + signals.) The `/bag-workflow` skill uses these markers, and `npm run check:markers` lints them.

## Architecture

```
sidepanel (chat UI)
   │  CHAT {text, history, tabId}
   ▼
background (service worker)
   │  ① COLLECT_CONTEXT → content (collect verb catalog + affordances)
   │  ② callAI (Structured Outputs → reply + actions)
   │  ③ RUN_ACTIONS → content (run verbs in order)
   ▼
content-script (in the page / verb registry + executor)
```

- `lib/ai-client.js` — provider-agnostic Structured Outputs call
- `lib/prompt.js` — system prompt carrying the verb catalog + affordances
- `lib/site-matcher.js` — URL / domain / regex matching
- `lib/storage.js` — settings persistence

## Security / privacy

- The API key is stored only in `chrome.storage.local` and sent only to the AI API you choose.
- Prompt history and page-scoped chat history are also stored in `chrome.storage.local`.
- Destructive/irreversible actions (submit, purchase, delete) are stated in `reply` before running.
- The verb registry is a closed set, so the AI cannot perform unexpected DOM operations.

## Extending

Add a verb by appending one `{ description, args, run }` entry to `AI_VERBS` in
`content/content-script.js`. Its `description` and `args` automatically flow into the system prompt and
the Structured Outputs schema (the `verb` enum).

## Tech

Vanilla JavaScript, no build step. Manifest V3, Side Panel API, `chrome.scripting`, `chrome.storage`.

## Quality gate

Run `npm run check` before packaging. It runs JavaScript syntax checks, the deterministic anchor
test, and Playwright + axe UI checks for the side panel and options page.

The adopted anti-slop workflow is documented in [docs/ui-quality-workflow.md](docs/ui-quality-workflow.md).

## License

[MIT](LICENSE)
