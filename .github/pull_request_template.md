## Description

<!-- Provide a brief explanation of what this pull request does and the motivation behind it. -->

## Type of Change

- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] ♻️ Architecture / Refactoring (no functional changes)
- [ ] 📝 Documentation / OSS hygiene
- [ ] 🔧 Tooling / Dependencies / CI

## Scope

- [ ] Chrome Extension (repo root)
- [ ] Local Daemon (`daemon/`)
- [ ] Documentation / Workflows

## Invariant & Quality Checklist

<!-- Please check the items that apply to this PR. -->

- [ ] **Tests pass**: Ran `npm run check` at repository root.
- [ ] **Daemon tests pass**: Ran `npm test` in `daemon/` (if `daemon/` code was modified).
- [ ] **Closed verb registry preserved**: No arbitrary DOM injection/execution outside `AI_VERBS` in `content/content-script.js`.
- [ ] **Structured Outputs schema**: Action arguments travel as `argsJson` JSON string, not a loose nested object.
- [ ] **Canvas 2D only**: No SVG `foreignObject`, `createElementNS`, or tainted canvas usage in `compositor.js`.
- [ ] **Bilingual UI strings**: Any user-visible UI copy is bilingual (JP/EN, e.g. `お描き/Draw`).
- [ ] **Determinism & Safety**: Deterministic affordance IDs, high-risk verbs rejected on chat path.
- [ ] **No Secrets**: No API keys, tokens, or credential leaks.
