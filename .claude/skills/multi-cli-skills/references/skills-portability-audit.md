---
title: brief2dev 전체 스킬 CLI-portability 전수 감사
purpose: 어느 CLI(Claude/Codex)에서도 "똑같은 수준"으로 나오는가를 스킬별로 분류 + remediation
updated_at: 2026-06-15T05:01:34Z
method: 16-agent 워크플로(LLM 분류 + 적대적 검증) + lint-skill-portability.mjs(결정론적 재현)
referenced_by: ./../SKILL.md
note: 분류는 bracket(범위)으로 본다 — LLM 은 portable 과대평가 경향, 린터는 runtime-coupled 과대평가(보수적). 정확한 경계는 per-skill 런타임 의존 검증 필요. 권위 있는 재현 수단은 린터(node lint-skill-portability.mjs --all --json).
---

# brief2dev 전체 스킬 CLI-portability 전수 감사

> **결론**: Discovery 는 이미 해결됨(`.agents -> .claude` + Codex symlink 추종). SKILL.md 는 오픈 표준이라 본문 portable. 따라서 "똑같은 수준"의 변수는 **본문의 Claude 전용 가정**(fixable)과 **brief2dev 런타임 결합**(runtime-coupled)뿐. 다수 스킬이 파이프라인/거버넌스 런타임에 결합되어, 진짜 CLI-무관 parity 는 지식/워크플로 스킬에서 현실적이다.

## 1. 분류 결과 (두 측정의 bracket)

> **Remediation 완료 (이 PR)**: 순수 fixable 9 개 전원을 CLI-agnostic 본문으로 전환 → **fixable 0** (린터 재측정으로 검증, 9 개 portable 로 이동). 적용 컨벤션: AskUserQuestion → `사용자 결정 요청(Decision Request)` + per-CLI 위임(`multi-cli-skills` §6), builtin-slash → CLI 분기(Claude `code-review` / Codex `codex review` / 공통 `pre-quality-gate`), `/create-pr`·`/deep-research` → 슬래시 제거(포터블 스킬명 참조), model 라우팅 → capability-tier + Claude 한정 qualifier.

| 분류 | 린터 (감사 시점) | 린터 (이 PR 후) | LLM 워크플로 (감사 시점) | 의미 |
|------|:---:|:---:|:---:|------|
| **portable** | 52 | **61** | 68 | blocker·런타임 결합 0 → 어느 CLI 에서도 같은 결과 (이미 달성) |
| **fixable** | 9 | **0** | 21 | Claude 전용 가정 있으나 런타임 무관 → CLI-agnostic 대안으로 수정 가능 (이 PR 에서 전원 remediated) |
| **runtime-coupled** | 46 | 47 | 18 | brief2dev 런타임(hooks/Saga/gate) 결합 → 런타임 포팅 필요 (multi-cli-hooks 영역) |
| **(total)** | 107 | 108 | 107 | — |

> runtime-coupled 46→47 및 total 107→108 은 감사 이후 머지된 신규 스킬(multi-cli-skills 등) 반영 — 이 PR 의 fixable remediation 과 무관(이 PR 은 스킬 추가/삭제 없음).

**측정 차이 해석 (정직)**:
- **적대적 검증 verdict**: LLM 분류 정확도 ~58% — *portable 과대평가*(agent-reach/feature-architect/discover 등 파이프라인 결합을 portable 로 오분류). multi-cli-hooks 는 역으로 portable 승격.
- **린터는 보수적**: 본문에 `.brief2dev/`·`-guard`·`/create-pr` 언급만 있어도 runtime/blocker 로 flag(surfacing 목적) → runtime-coupled 과대평가.
- **진실은 둘 사이**: (감사 시점) portable ~52-68, fixable ~9-21, runtime-coupled ~18-46. **방향은 일치** — 큰 덩어리가 런타임 결합, 의미있는 덩어리가 portable, 소수가 순수 fixable. (이 PR remediation 후 린터: portable 61 / fixable 0 / runtime-coupled 47.)

> 권위 있는 재현: `node .claude/skills/multi-cli-skills/scripts/lint-skill-portability.mjs --all --json` (결정론적, CI 연동 가능).

## 2. blocker 빈도 (결정론적)

| blocker | 횟수 | CLI-agnostic 대안 (cross-cli-skill-mapping.md §6) |
|---------|:---:|------|
| builtin-slash (`/code-review` `/create-pr` `/deep-research` 등) | 48 | 의도 기술 + CLI 분기 (Codex: `codex review` / `pre-quality-gate` Bash). R-CM-030 이 이미 CLI-agnostic verdict fallback 정의 |
| AskUserQuestion | 35 | 의도("사용자에 X 옵션 질문") + per-CLI (Claude: AskUserQuestion / Codex: Decision Exchange / `BRIEF2DEV_DECISION_MODE=file`) |
| WebFetch | 5 | WebSearch/curl wrapper + 비-Claude fallback |
| Task tool (model 라우팅) | 2 | LLMInvoke 추상화 + skip-and-record graceful degrade |
| Agent(subagent_type) | 1 | 역할 문자열 + per-CLI 서브에이전트, 비-Claude fallback |

> 다수의 builtin-slash/AskUserQuestion 은 brief2dev 파이프라인 스킬에 위치하며, 그 사용은 **파이프라인 의도적**이다(런타임 결합과 동반). 순수 fixable(런타임 무관)은 아래 9개.

> **Remediation 후 (이 PR)**: 순수 fixable 9 의 blocker 제거 완료. 린터 재측정 잔여 blocker 84 — 전원 runtime-coupled 스킬 내(builtin-slash 45 / AskUserQuestion 29 / WebFetch 7 / Agent 2 / Task 1). 위 표는 **감사 시점** 빈도이며, 차이(예: WebFetch 5→7)는 감사 이후 신규 스킬 반영. 잔여 blocker 는 파이프라인 런타임 결합과 동반이라 §5(런타임 포팅) 영역.

## 3. 순수 fixable (감사 시점 9 → 이 PR 에서 전원 remediated → portable)

> ✅ 아래 9 개는 이 PR 에서 본문을 CLI-agnostic 으로 전환 완료 — 린터 재측정 시 전원 `portable`. 아래 표는 적용된 수정 내역(record).

| 스킬 | blocker | 적용한 수정 |
|------|---------|----------|
| code-standards-aligner | builtin-slash ×3 | `/code-review` 의도 기술 + CLI 분기 |
| complexity-auditor | builtin-slash | 동상 |
| final-review | builtin-slash | 동상 |
| domain-modeler | task-tool | LLMInvoke 추상화 |
| infra-designer | AskUserQuestion | per-CLI decision 추상화 |
| mvp-launcher | AskUserQuestion ×3 | 동상 |
| oss-transplanter | AskUserQuestion | 동상 (+ worktree 추상화) |
| platform-selector | AskUserQuestion | 동상 |
| system-designer | AskUserQuestion ×2 | per-CLI STOP gate 추상화 |

## 4. portable (이미 달성 — 감사 52 → 이 PR 후 61)

린터 0-blocker·0-runtime 스킬. 어느 CLI 에서도 같은 결과. 대표: app-review-analyzer, architecture-selector, color-palette, deep-explain, deep-research, design-pilot, draw-io, engineering-plan-writer, gtm-pilot/strategist, interview-toolkit, manual-generator, oss-analyzer, pre-mortem-analyzer, pricing-strategist, story-decomposer, systematic-debugging, technical-svg-diagrams, writing-skills 등 (전체: `--all --json`).

## 5. runtime-coupled (감사 46 → 현재 47 — 정직한 한계)

brief2dev 런타임(`.brief2dev/` Saga, hooks, pipeline-boundary-guard, output-gate, archive-index 등) 결합. SKILL.md 본문 지시는 Codex 에서 따를 수 있으나 **가드/게이트가 작동하지 않아 동일 강제 수준 불가**. 대표: brief2dev-orchestrator, archive-and-reset, feature-pilot, create-pr, project-scaffolder, output-gate, market-researcher, mvp-scoper, stack-selector, sdlc-governance, memory-curator, code-health-pilot 등. **완전 parity 는 런타임(hooks) 포팅 = multi-cli-hooks 영역.**

## 6. Remediation 전략

1. **portable (감사 52 → 이 PR 후 61)**: 조치 없음 — 이미 CLI-무관. 린터가 회귀 감시.
2. **fixable (9 → 0, 이 PR 완료)**: cross-cli-skill-mapping.md §6 의 CLI-agnostic 대안을 9 개 전원에 적용 완료 — 린터 재측정 portable. 린터 `--strict` 로 신규 blocker 회귀 차단.
3. **runtime-coupled (감사 46 → 현재 47)**: "수정" 아닌 **정직 분류**. 본문은 portable 유지하되, 런타임 의존을 명시. 완전 parity 는 hooks 포팅(multi-cli-hooks) 선행 필요.
4. **durability (machine guard)**: `lint-skill-portability.mjs` 가 모든 신규/수정 SKILL.md 의 Claude 전용 가정을 검출. pre-commit/CI 연동 시 회귀 원천 차단(docs-only 가이드가 아닌 코드 가드 — 본 태스크 durability rule 충족).

## 7. 핵심 정직성

- "어느 CLI 든 똑같은 수준"은 **discovery + 표준 + portable 본문**까지는 달성되나, **런타임 강제(가드/게이트/Saga)** 차원에서는 brief2dev 가 Claude-Code 중심이라 runtime-coupled 스킬(다수)은 hooks 포팅 없이는 동일 강제 불가. 이를 숨기지 않는다(UNVERIFIED 날조 금지).
- 분류 수치는 측정 방법에 따라 bracket — 린터(결정론·보수)가 SSOT 재현 수단.
