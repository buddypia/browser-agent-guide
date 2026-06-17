# UI Quality Workflow

Browser Agent Guide is a static Chrome extension UI, so the first anti-slop gate should be lightweight,
repeatable, and close to the existing code. The adopted workflow is:

1. Keep implementation in the existing HTML, CSS, and JavaScript structure.
2. Use Playwright to load the real side panel and options pages in Chromium.
3. Mock only the Chrome extension APIs needed by those pages.
4. Run axe through `@axe-core/playwright` on the rendered UI.
5. Treat `npm run check` as the local quality gate before packaging.

## Why These Tools

- `axe-core`: Deque's accessibility testing engine for HTML-based UIs.
  Last-month npm downloads checked on 2026-06-12: 192,480,294.
  Source: https://www.npmjs.com/package/axe-core
- `@playwright/test`: Playwright's browser test runner for Chromium, Firefox, and WebKit.
  Last-month npm downloads checked on 2026-06-12: 158,464,929.
  Source: https://playwright.dev/docs/intro
- `@axe-core/playwright`: Deque's Playwright integration for axe-powered automated accessibility tests.
  Last-month npm downloads checked on 2026-06-12: 19,229,583.
  Source: https://github.com/dequelabs/axe-core-npm

`stylelint` was also reviewed because it has strong ecosystem adoption, but it is intentionally
not part of this first pass. The current UI risk is not CSS syntax drift; it is whether the
extension screens render, stay operable, and avoid accessibility regressions.

## Commands

```sh
npm run check:js
npm test
npm run test:ui
npm run check
```

## Anti-Slop Review Checklist

- The screen has one clear primary job.
- Empty, loading, error, and disabled states are represented or intentionally scoped out.
- Controls have accessible names, visible focus, and keyboard operation.
- Copy explains the user's next action with concrete nouns and verbs.
- Layout is verified at the side-panel width, not only a desktop browser width.
- Any generated UI change is backed by a repeatable test or screenshot.
