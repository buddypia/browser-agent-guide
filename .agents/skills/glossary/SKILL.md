---
name: glossary
description: Domain glossary procedure — read the relevant entries first, keep @term code regions in step, bump last_verified. Read before working on a glossary term or editing glossary/.
---

# Glossary (domain SSOT)

Entries live in `glossary/<ctx>/<id>.md`: `extension/` (`verb-registry`, `affordance`, `recipe`, `workflow-step`) and `daemon/` (`entry-store`, `page-feedback`). Schema: `glossary/_schema.md`; mechanism, same-day exception and runbook: `docs/glossary-mechanism.md`.

## Before a task
Read only the entries the task touches and restate `id` / definition / `code_refs` / `confidence`. Normalize any `deprecated_terms` to the canonical name in code, docs and replies.

## When you change load-bearing code
Load-bearing code sits in `// @term: <id>` … `// @endterm` regions. When you change one:
1. Reconcile the entry (definition, `code_refs`, invariants) with the new code.
2. Run `npm run glossary:touch <id>` to bump its `last_verified`.
3. `npm run glossary:staleness` (part of `npm run check` and CI) fails if a changed region's term was not bumped.

## Commands
```bash
npm run check:glossary      # schema / refs / freshness / @term: markers
npm run glossary:staleness  # changed @term: regions must bump the bound term's last_verified
npm run glossary:touch      # bump last_verified for an id
npm run glossary:trace      # generate glossary/TRACEABILITY.md (generated, never committed)
npm run test:glossary       # tests for the glossary tooling
```
