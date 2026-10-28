# Apply the local ai-harness collection

## Contract

- Objective: read the user-supplied local `ai-harness` collection one folder at a time, analyze each against this project and apply as much relevant guidance as possible before proceeding to the next folder. Preserve the complete three-folder scope.
- Deliverable: repository changes applying the collection's relevant guidance, with a per-folder mapping of adopted, existing and deliberately omitted mechanisms, and real validation evidence.
- Order: `0xwhrrari_post` → `hanakoxbt_article` → `kyr0stack_video` (lexical order; one folder's read, analysis, application and validation before reading the next).
- Constraints: existing security boundaries, bilingual product UI, owned worktree, 8,000-character AGENTS budget; no speculative platform or duplicate approval gates.
- Acceptance: all three folders' supplied text and images inspected; each substantive recommendation mapped to implementation or an explicit reason; affected checks pass; reviewable changes and a receipt remain available.
- Worktree: `.worktrees/feature/apply-ai-harness`; branch: `feature/apply-ai-harness`; rollback baseline: `a68e17cc9fec2f1770ec348362e7ce1ee3550a6f`.

## 1. 0xwhrrari_post

Read `post.md`, `image_text.md` and all four JPGs. The embedded vendor demo has a preview only; the linked `video/` and `summary.md` do not exist in the supplied folder. The article's complete seven-job framework and image text are available locally. Treat its vendor claims as source claims, not verified current product documentation.

| Recommendation | Application / existing evidence |
|---|---|
| Contract with goal, inputs, constraints, done criteria | Added `task-continuity` skill and this actual contract. |
| Small map with on-demand knowledge | Existing `AGENTS.md` → subsystem skills; `scripts/check-harness.mjs` enforces size, discoverability and live commands. Added only one trigger. |
| Tools with predictable contracts, isolated execution | Existing closed verb enum and `argsJson` in `lib/ai-client.js`, `content/content-script.js`; worktree guard isolates coding. No new arbitrary browser tools. |
| Durable decisions, artifacts, failures and handoffs | Added tracked work record procedure; this record exercises it. Existing shared verification cache in `scripts/agent-scratchpad.mjs` stays a cache, not a task history. |
| Sensors before autonomy | Existing `check:fast`, CI `fast`/`daemon`/`e2e`, testing skill and UI evidence procedure. Actual checks are recorded below. |
| Policy outside the model | Existing allow-lists, judge approval boundaries and deterministic auto-ship protected-path/size/CI gates; retain them. |
| Trace and local recovery | Existing `runStep` response/AI failure detail and three-repair bound in `background/service-worker.js`, two-attempt AI calls in `lib/ai-client.js`; added checkpoint/recovery instructions for coding tasks. |
| Encode important rules in checks | Existing sync-pair, harness and hook-reference checks; do not duplicate these as prose gates. |
| Bounded loops and escalation | Product retry bounds above; continuity skill requires a changed hypothesis after two repairs without new evidence. User budgets take precedence. |
| Failure upgrades the harness | Existing experience library; new adaptation entry records evidence with pending verdicts. |
| Separate brain, hands and history | Existing service-worker LLM / deterministic content-script execution / stored workflow results; coding uses git, external tests and retained work records. No new vendor dependency. |
| Change receipt, rollback and proportional complexity | Receipt procedure in skill and this document; git baseline above. CI/review stay independent. Cost and token usage are unavailable rather than fabricated. |

Decision: use a short on-demand procedure and real tracked record. Do not add a new task database, agent orchestrator, append-only audit service or self-attested approval gate: this task shows continuity needs, not evidence that the existing tools need replacing. See `2026-10-14-remove-self-attested-ship-gates.md` for the earlier failure of report gates.

Verification (2026-10-28, working diff on baseline a68e17c): `npm run check:harness` passed (5,832/8,000 characters, 10 skills); `quick_validate.py .agents/skills/task-continuity` passed; skill links created for Claude/Codex. The ledger check caught an omitted historical open-row citation; it passed after inspecting and citing that entry. Unit 1 read/analysis/application/validation finished before opening unit 2.

## 2. hanakoxbt_article

Read both Markdown files and all six images. The supplied article describes a vendor-specific trading desk; it is used here as a methodology source, not current financial or product advice. No live vendor claims, model names, returns or subscription terms are adopted as facts.

| Recommendation | Application / reason |
|---|---|
| Real data and compute instead of confident model claims | Testing skill now requires source/revision/coverage and emitted results; separates static, mocked and live evidence. Existing node/browser/CI runners do the computation. |
| Scout checks coverage before tests | Added coverage/freshness/gap check before an improvement experiment. |
| Sweep nearby parameters; keep failed cells | Added bounded matrix examples specific to this repo and complete result reporting. Avoid mandatory exhaustive grids for ordinary fixes. |
| Held-out evaluation; prevent leakage | Added reserved fixtures/sites for prompt/selector/heuristic tuning, and event-order preservation for time-dependent inputs. |
| Skeptic separate from author | Existing `scripts/auto-ship.mjs` read-only independent reviewer and CI; testing skill explicitly distinguishes the builder's analysis from acceptance. No fixed five-agent team: `2026-10-25-fold-harness-reflector-into-skill.md` found repeated author-context delegation costly. |
| Librarian reuses evidence | Existing experience INDEX and harness-rules read-first procedure; testing/continuity skills now also consult rejected hypotheses. |
| Ledger remembers rejected ideas and next reason to retry | Reuse existing harness library verdicts and task record; continuity skill retains counterexamples and retry reasons. No duplicate `research.md`. |
| Fixed verdict contract; no selective reporting | Reuse helped/hurt/no observed effect/confounded/pending; explicitly distinguish functional gains, cost trade-offs and insufficient evidence. Trading verdict names do not fit this product. |
| Paper before runner; research cannot release real effects | Added fixture/dry-run before live-effects guidance while retaining workflow human release and ship-flow approval. |
| Single MCP connection, tools scoped by role | Existing daemon MCP and deterministic browser tool surface; do not add QuantGPT, Alpaca, subscriptions, trading models, finance datasets or keys to a browser extension. Those are the example domain, not reusable harness requirements. |

Verification (2026-10-28, working diff): `harness:index`, `check:harness` and both changed skills' `quick_validate.py` passed. Unit 2 read/analysis/application/validation finished before opening unit 3. No product code or financial execution was changed.

## 3. kyr0stack_video

Read the full 32:30 transcript, all 544 English subtitle cues and the 32 Japanese chapter cues. The supplied folder contains no video or slide images; audiovisual inspection is unavailable. The subtitles corroborate the transcript's versioning, permission, concurrency and batch-review sections; timestamped claims below refer to this supplied talk, not current vendor API documentation.

| Recommendation | Application / existing evidence |
|---|---|
| Small root context, progressive skills | Existing AGENTS budget and skill map; added short continuity trigger and shortened harness-rules discovery description. |
| Searchable Markdown filesystem memory | Existing `docs/harness/INDEX.md`, entries and retros; new tracked task record. Skills now specify focused `rg` retrieval and revalidation. |
| Autonomous in-band memory | Agent updates its own task record at boundaries without a new approval gate; shared rules use normal review. |
| Versioning, author, source, rollback (08:50) | Git histories and source-linked library rows already provide versions; new review procedure requires source/revision, provenance and rollback. |
| Hash concurrency protection | Owned worktrees, contextual patches and git merge cover tracked memory. Added stale-draft re-read/digest guidance and explicit warning that check-then-write is not atomic CAS. Existing shared scratchpad's read/modify/write can lose cache entries despite atomic rename; it is disposable cache, never authoritative task state. No unsupported transactional guarantee is claimed. |
| Hierarchical permissions and injection defense (12:10) | Existing guards control shared promotion; task-local observations stay local until reviewed. Added source/audience boundary, untrusted-memory handling and no private-transcript copying. Existing user authorization governs actual edits. |
| Portable memory across products | Canonical `.agents/skills/`, setup-skills symlinks, `CLAUDE.md` import and Markdown/git, without a new API dependency. |
| In-band resource/visibility limits (15:32) | Compact checkpoints for current task; separate on-demand batch review for cross-session patterns. |
| Dreaming process with recurrence evidence (18:27–24:18) | Added harness-rules review workflow over authorized library/retro/task evidence, actual tool metadata, denominators, counterexamples, stale rows, proposals and rejection reasons. Existing independent ship review/CI promotes changes. |
| Permission-aligned transcript selection (Q&A) | Review corpus explicitly constrained to authorized sources and target audience; no automatic global transcript harvesting. |
| Start simple; no database reinvention (25:43, Q&A) | Reuses git/library, no scheduled agent fleet, cloud memory service or speculative transactional store. Missing evidence and performance gains remain unknown. |

Verification (2026-10-28, working diff): all three changed skills passed `quick_validate.py`; `check:harness` passed at 5,846/8,000 AGENTS characters and 10 skills; `npm run test:harness` passed 33/33 tests with no skips (1.34 s). `BAG_DISABLE_SCRATCHPAD=1 npm run check:fast` passed: harness and glossary checks executed freshly, 17 unrelated checks were diff-skipped (not 19 fresh executions). `git diff --check` passed. No new runtime code, dependencies, hooks or tests were added. Browser/daemon behavior is unchanged; their full suites are left to the normal ship CI. Documentation checks cannot establish a future reliability or cost improvement, so new experience verdicts stay pending.

All supplied substantive text files and ten images across the three folders have now been inspected in order; absent linked files and audiovisual limits are recorded above. Finder `.DS_Store` files are metadata, not source material.

## Receipt / next action

All three units' read/analysis/application/local validation are finished. Changed artifacts: AGENTS trigger, new task-continuity skill, testing and harness-rules skill updates, experience entry/INDEX and this source-to-change record. Self-review checked source coverage, all skill triggers/commands, retry semantics, stale/concurrent memory, permissions, privacy, proportional cost and compatibility with existing ship gates. It found no remaining blocker; independent review/CI remain part of shipping. Runtime UI, API, storage and dependencies are unchanged.

Initial implementation: 7808217; PR #165. The independent review requested changes for weak repository-specific evidence, a mandatory tracked-record convention and raw local/user details. Revisions make record storage optional, specify retention, summarize the request without machine paths, and connect experiment/memory procedures to actual repository incidents. Human review remains required by ship-flow after `NEEDS_HUMAN`; no merge approval is inferred from the implementation request. PR daemon/E2E jobs are path-skipped for this documentation change; fast CI executes the node gate. Rollback baseline is a68e17c (above). Model costs and token counts are unavailable; future cross-session effectiveness is unmeasured.

### Repository evidence reviewed after independent feedback

Read three retros as an on-demand memory review, without private transcripts or a fleet prevalence claim:

- `retro-2026-07-19-guard-root-resolves-to-linked-worktree.md`: a previous “verified” claim came from inspecting a dispatcher rather than the implementation, and the unregistered-worktree path was untested. This motivates coverage/implementation checks and a boundary matrix in the testing skill. Its code defect was already fixed; no new runtime fix is claimed here.
- `retro-2026-06-30-worktree-base-remote-divergence-recurrence.md`: an existing advisory failed again in a later session. This supports checking prior outcomes and counterexamples instead of treating retained instructions as validated improvements.
- `retro-2026-06-20-orphaned-ship-gate.md`: removing an entrypoint left a retained guard inert. This supports revalidating stored commands and tool metadata against current implementation during a memory review; the existing hook-reference validator remains the mechanical prevention.

These are three incident records, not an unbiased sample of all sessions. Session-level denominators and cost benefits are unavailable. Rejected alternative: create a separate memory database or restore report gates. Existing git/library/checks address those needs; the new guidance connects their evidence to the supplied methods. This retained document is the requested source-to-change deliverable, not an archive of private session logs.
