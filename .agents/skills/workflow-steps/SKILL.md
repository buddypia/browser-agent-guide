---
name: workflow-steps
description: Invariants for recorded workflows and the System One judge (AI only suggests; judge approval never releases the irreversible gate). Read before changing workflow, judge or runStep code.
---

# Recorded workflows & the System One judge

Glossary `workflow-step` (`glossary/extension/workflow-step.md`) is the spec — read it first.

## Workflow steps

Recorded workflows are structured, deterministic steps (`lib/workflow.js` `pickCandidate`, content `runStep`, SW `driveWorkflow`; E2E `test/workflow-e2e.spec.mjs`, `test/workflow-judge.spec.mjs`). AI is only a fallback that returns one key from the candidate enum, and its pick stays a `suggestion` until the human adopts it. With `settings.judge.provider:'jev'`, `'clef'` or `'eg2'`, candidate choice and optional post-step visual verification (`check.type:'visual'`) go to System One (TypeSafe Jev, Cloudflare Clef or local EmbeddingGemma 2) with confidence gating.

Invariants:
1. Judge approval (`judgeApprovedStepId`) **never** releases the irreversible-click gate (`approvedStepId`).
2. An approval authorizes only the candidate the human was shown (`heldLabel` → `approvedLabel` → content `expectText`), never a re-asked AI pick.
3. Neither typed step values nor live field values go to the judge/LLM chooser. For `check.type:'visual'`, `PREPARE_VISUAL_CHECK` masks live `input`/`textarea`/`contenteditable` text before `captureVisibleTab`, and refuses to shoot when the target tab is not active.
4. A judge error or malformed answer fails the step — never read it as "no match".
5. Every stop that is a failure (`failed`/`mismatch`) writes `run.failure` `{stepId, n, stage, text, detail}` through `driveWorkflow`'s `stop` — `text` for people, `detail` the raw trace (content responses, AI engine/candidates/verdict) without typed values. The side panel renders it from storage; chat notices alone vanish on reload.

## Judge client

`lib/judge-client.js` — builds the closed `choice` request (candidate keys + `none`; asks "same target as recorded?", which separates relabeled-same from different far better than "matches intent?") or ranks candidates via `eg2` cosine similarity, parses probabilities/scores into a closed set, and enforces https-only base URL (http only for loopback). Each judge is one entry in `JUDGE_PROVIDERS` (`ready` / `choose` / `visual`); `judgeChain` orders `provider` then the optional `fallback`, and the fallback is asked only when the primary cannot answer (error or malformed answer) — a low-confidence or `none` answer is final. Jev and Clef share the request/answer contract; Clef goes to a Worker proxy (`clefEndpoint`) or Workers AI REST (`clefAccountId` must be 32 hex — it lands in the URL path). Images differ: Jev takes `assets` `{type:'image', format:'png'|'jpg', data_base64}` (no `data:` prefix) plus the `TypeSafe-Danger-Zone-Images: true` header and rejects sides outside 280–1568 px, so the SW shrinks visual-check shots in offscreen (`FIT_IMAGE`) to `JUDGE_IMAGE_MAX_EDGE`; Clef takes data URLs in `images`. `askJudge` retries only Jev 429/529 (twice, honoring a `retry-after` up to 4 s); any other error goes straight to the fallback. Jev 1.13 is weak at numbers (its docs say keep arithmetic in code): live, a `choice.by:'ai'` condition like 「一番安い」 came back as a low-confidence `none`, i.e. a hold, in Japanese and English alike, while same-item/none/ambiguous picks were ≥0.97 in both languages. Check contract changes against the published specs: Jev https://docs.typesafe.ai/api/system-one and /images, Clef https://developers.cloudflare.com/workers-ai/models/clef/ (`schema-input.json` / `schema-output.json`). Unit-tested by `test/judge-client.test.mjs` (no network); opt-in live checks in `scripts/live/` (`scripts/live/README.md`).

## Workflow MCP tools

`list_workflows`/`run_workflow`/`get_workflow_run`/`stop_workflow` (`daemon/src/server.js`, over WS `workflow` `{op}`). There is deliberately no approve tool — confirm steps and judge holds wait for a person in the side panel. `run` always opens the start page in a new tab and refuses — before opening anything — while a run is active/held, while recording, when the side panel has unsaved working steps, or when vars are missing. Status returns only progress, the held step, the failed step number + closed `stage` and the last event's phase, never typed values or step texts.
