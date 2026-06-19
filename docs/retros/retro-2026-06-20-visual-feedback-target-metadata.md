# Retro 2026-06-20 — Visual feedback target metadata drift

## Trigger
user-explicit recurrence prevention request after an Amazon visual-feedback workflow required image interpretation because the context metadata did not identify the annotated product.

## Facts
- A visual-feedback capture for `amazon.co.jp` contained two drawing items with `intent="このアイテムをカートに入れる"`.
- The capture item metadata had empty `anchorLabel`, `href`, and `dataAsin`; only positional selectors such as `ol > li:nth-of-type(...) > ...` remained.
- Replaying those selectors against the live Amazon page resolved to different homepage modules because the page is dynamic.
- The workflow recovered by interpreting the annotated image, finding the live carousel section, and matching product links/ASINs manually.

## 5 Whys -> Root Cause
1. Why did target identification require image interpretation? -> The lightweight context lacked stable product/link identity.
2. Why did the lightweight context lack stable identity? -> Capture serialized the resolved drawing target itself and did not snapshot nearby link, item container, or section signals.
3. Why was the target itself insufficient? -> Drawings often land on a visual child node while durable identity lives on an ancestor, sibling, or nearby link.
4. Why did selector replay become unsafe? -> Dynamic commerce pages reorder modules and repeated card structures make nth-of-type selectors page-state dependent.
5. Why was this uncaught? -> The test suite covered direct `data-asin` rehydration but not "image child only, stable identity nearby" capture metadata.

**Root cause(s) (the class-blocking point(s)):**
occurrence: visual-feedback capture did not persist a ranked nearby target snapshot; detection: no regression test exercised child-only drawing targets whose stable identity is nearby rather than on the target node.

## Class
visual-feedback-target-metadata
recurrence_of: none
recurring class; blast radius: extension capture metadata and daemon MCP context; reversibility: reversible page operation until checkout, but externally visible web actions can be selected from this metadata.

## Decision
- Tier: ① metadata schema enrichment + ③ regression gates.
- **Why this tier:** The invalid lightweight context is prevented by making nearby target identity representable in `annotation.json` (`targetCandidates` plus top-level `href`/`dataAsin` fallbacks). A Playwright regression then detects drift in the capture pipeline, and daemon tests detect context-output loss.
- Rejected tiers + reason (the inner loop's REVISE reasons: violated C# + redirection): ② hook is not appropriate because no tool-call predicate can decide arbitrary page target quality without false blocks; ⑤ advisory rule is weaker than encoding the metadata at capture time; ⑥ record-only is underpowered because this is a recurring class for dynamic card UIs.
- (tier ② only) hook failure mode: N/A.

## Cure (existing instances)
- [x] Capture pipeline now emits ranked nearby target candidates for drawing annotations.
- [x] Daemon context text and structured content now preserve and display those candidates.

## Prevent (prevention mechanism)
- `content/content-script.js` builds `targetCandidates` from the target, nearest link, stable ancestor, item container, and section heading.
- `background/service-worker.js` serializes `targetCandidates` and surfaces `href`/`dataAsin` in memo output.
- `daemon/src/inbox.js` returns `targetCandidates` through context-first MCP output.
- negative test: `npx playwright test -c playwright.config.mjs test/ai-memo.spec.mjs -g "近傍の商品リンク候補"` ->
  `1 passed (843ms)`
- positive test (blocking gates only): N/A.

## Verify cmd
```bash
npm run check
cd daemon && npm test
```

## Next
none
