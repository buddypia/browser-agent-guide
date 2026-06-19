---
name: feature-pilot
description: |
  대상 프로젝트의 AI 주도 기능 개발을 통합하는 오케스트레이터.
  모든 개발 요청의 단일 진입점으로서, 작업 유형을 자동 판별하고 적절한 하위 스킬을 조율한다.
  Readiness Gate 기능이 내장되어 있어, Go/No-Go 검증을 직접 실행한다.

  "새 기능 추가", "버그 수정", "기능 수정", "개발 요청", "구현해줘" 등의 요청으로 트리거된다.
calls:
  - feature-architect
  - feature-spec-generator
  - feature-spec-updater
  - ui-approval-gate
  - feature-implementer
  - engineering-plan-writer
  - feature-wiring
  - feature-status-sync
  - bug-fix
  - pre-quality-gate
  - priority-analyzer
  - research-pilot
  - discover
  - infra-selector
  - architecture-selector
  - domain-modeler
  - system-designer
  - contract-codegen
  - contract-tester
  - prioritize
  - design-pilot
  - final-review
  - market-intelligence-scanner
  - research-gap-analyzer
  - story-decomposer
  - verification-loop
  - de-sloppify
---

# Feature Pilot

`feature-pilot`은 개발 요청의 단일 진입점이다. 활성 문서는 AI가 작업 유형, worktree, CONTEXT, 하위 스킬, 검증 전이를 헷갈리지 않게 하는 실행 계약만 담고, 긴 파이프라인 예시와 세부 절차는 `references/feature-pilot-protocol-details.md`에서 필요할 때만 읽는다.

## Core Contract

- **Single Entry Point**: 사용자가 스킬을 고르게 하지 않는다. 요청을 분류하고 적절한 파이프라인을 직접 조율한다.
- **No Direct Bypass**: SPEC 생성/수정, 버그 수정, UI 승인, wiring, 상태 동기화는 담당 하위 스킬을 우회하지 않는다.
- **CONTEXT First**: 신규 기능은 `feature-architect`가 `CONTEXT.json`을 만든 뒤 `feature-spec-generator`로 넘어간다.
- **Readiness Gate Built-in**: NEW_FEATURE/MODIFY_FEATURE는 UI 승인 후 내장 Readiness Gate에서 Go/No-Go를 판정한다.
- **Worktree Required**: 코드 변경은 `.worktrees/<branch>`에서 수행하고, worktree 루트에 `PLAN.md`를 둔다.
- **Evidence-Based Completion**: 완료 보고 전 테스트/품질 검증, 하위 스킬 Post-flight, `CONTEXT.json` cleanup 상태를 확인한다.

## Path Contract

파일 작업 전 `project-config.json`을 읽어 경로를 해결한다. 없으면 기본값을 사용한다.

| Placeholder | Resolution Source | Default |
| --- | --- | --- |
| `{FEATURES_DIR}` | `project-config.paths.features` | `src/features` |
| `{SHARED_DIR}` | `project-config.paths.shared` | `src/shared` |
| `{TESTS_DIR}` | `project-config.paths.tests_unit` | `tests/unit` |
| `{DOCS_DIR}` | `project-config.paths.docs_features` | `docs/features` |
| `{COMPONENT_EXT}` | `project-config.conventions.component_extension` | `.tsx` |
| `{FEATURE_LAYERS}` | `project-config.conventions.feature_structure` | `["types","api","hooks","components"]` |

해결된 경로를 하위 스킬에 전달한다. 리터럴 `src/features/`, `src/shared/`에 고정한 설계는 금지한다.

## Target Scope Contract

`feature-pilot`은 먼저 **무엇을 개발할지**를 고정해야 한다. 특히 brief2dev 본체 안에서 실행할 때 `output/<slug>`는 scaffold 결과물이며, 사용자가 명시하지 않는 한 feature-pilot 산출물 대상이 아니다.

- 기본 대상: 현재 brief2dev 리포지토리의 개발 작업.
- 제외 대상: `output/<slug>` 하위 생성 프로젝트. `output/<slug>/project-config.json` 존재만으로 target을 전환하지 않는다.
- 예외: 사용자가 `output/<slug>`, "생성된 프로젝트", "scaffold 결과물"을 명시하거나 현재 작업 디렉토리가 해당 생성 프로젝트 내부일 때만 output target을 허용한다.
- 사용자가 "output 불필요" 또는 "산출물에 output 제외"라고 말하면, PF-009는 brief2dev 본체 target으로 고정하고 output 쓰기를 중단한다.

## Pre-flight Checklist

스킬 시작 전 아래 체크리스트를 출력하고, 각 항목을 `---`에서 통과/실패 상태로 갱신한다.

```markdown
## Pre-flight Checklist (feature-pilot)

|   ID   | 항목                                        | 상태 |
| :----: | ------------------------------------------- | :--: |
| PF-000 | Path Resolution 완료 (project-config.json 읽기) | ---  |
| PF-001 | 작업 유형 판별 완료                         | ---  |
| PF-002 | CONTEXT.json 접근 가능 또는 신규 생성 가능  | ---  |
| PF-003 | CLAUDE.md 규칙 확인                         | ---  |
| PF-004 | Feature Characteristics 판정 완료           | ---  |
| PF-005 | Evidence 캐시 확인                          | ---  |
| PF-006 | 하위 스킬 ESP 호환성 확인                   | ---  |
| PF-007 | 작업 ID 확정                                | ---  |
| PF-008 | worktree 생성 및 PLAN.md 초기화             | ---  |
| PF-009 | Target Scope 확정 (brief2dev 본체 vs output/<slug>) | ---  |
| PF-010 | Domain Placement 판정 완료 (domain-map.json + index.md 조회) | ---  |

**작업 유형**: [NEW_FEATURE | MODIFY_FEATURE | BUG_FIX | DOCS_ONLY]
**Risk Level**: [high | medium | low]
**파이프라인**: [해당 파이프라인 목록]
```

하나라도 실패하면 실행을 중단하고 사유와 다음 조치를 보고한다.

## Work Type Routing

| Type | 판단 기준 | 필수 흐름 |
| --- | --- | --- |
| NEW_FEATURE | Domain Placement Verdict가 NEW_IN_EXISTING_DOMAIN 또는 NEW_DOMAIN | `research-pilot` 조건부 -> `feature-architect` -> `feature-spec-generator` -> `ui-approval-gate` -> Readiness Gate -> worktree/PLAN -> 구현 -> `feature-wiring` -> QA -> `feature-status-sync` |
| MODIFY_FEATURE | 기존 SPEC 있음 또는 Verdict가 EXTEND_EXISTING | `feature-spec-updater` -> `ui-approval-gate` -> Readiness Gate -> 구현 -> `feature-wiring` 조건부 -> `feature-status-sync` -> QA |
| BUG_FIX | 버그, 오류, 동작 안 함 | `bug-fix` -> 회귀 테스트 확인 -> QA |
| DOCS_ONLY | 문서만, SPEC만, 구현 제외 | 지정된 문서/스펙 스킬만 실행하고 구현 단계로 넘어가지 않음 |

NEW vs MODIFY 판별 전 `{DOCS_DIR}/domain-map.json` + `{DOCS_DIR}/index.md` 조회는 의무다 (PF-010, 상세: `references/feature-pilot-protocol-details.md` Phase 0). Verdict가 DUPLICATE면 중단하고 기존 기능을 보고하며, 후보가 애매하면 임의 선택 대신 사용자에게 확인한다. 작업 유형이 불명확하면 사용자에게 최소 질문으로 확인한다. 보안/결제/PII는 즉시 `AwaitingUser`로 전이하고 사용자 확인을 받는다.

## Model Routing

| Work | Model |
| --- | --- |
| 작업 유형 분류 | Sonnet |
| 컨텍스트 수집 | Sonnet |
| Readiness Gate | Sonnet |
| 구현 조율 | Sonnet |
| 아키텍처 결정 | Opus |

하위 스킬이 ESP v2.0+이면 해당 스킬의 Pre/Post-flight를 확인한다. 폴백 체인은 Sonnet -> Opus다.

## Evidence Caching

| Evidence | TTL | Invalidation |
| --- | --- | --- |
| `project-config.json#commands.lint` | 30분 | source 변경 |
| `project-config.json#commands.test` | 30분 | source/test 변경 |
| Readiness Gate | 60분 | SPEC/screens 변경 |
| Security Scan | 60분 | `.env*` 변경 |

캐시가 유효하면 재실행을 생략할 수 있지만, 무효화 조건이나 `--force`가 있으면 강제 재실행한다.

## Execution Flow

1. **Classify**: 요청, 기능 ID, 기존 문서 존재 여부로 작업 유형을 확정한다.
   - 먼저 PF-009로 target scope를 확정한다. brief2dev 본체 작업에서 `output/<slug>`는 사용자가 명시하지 않는 한 산출물 대상이 아니다.
   - PF-010: 기능 인벤토리(domain-map.json + index.md)를 조회하고 Domain Placement Verdict를 출력한 후에만 NEW/MODIFY를 확정한다.
2. **Plan**: 파이프라인 표를 제시하고 단계 상태를 계속 갱신한다.
3. **Prepare Context**: 신규 기능은 `feature-architect`가 `CONTEXT.json`을 생성한다. 손상/불일치 시 `feature-doctor`를 고려한다.
4. **Produce Or Update SPEC**: 신규는 `feature-spec-generator`, 수정은 `feature-spec-updater`를 사용한다.
5. **UI Approval**: UI 변경은 `ui-approval-gate` 승인 없이는 Readiness Gate로 가지 않는다.
6. **Readiness Gate**: `references/readiness-gate-protocol.md` 기준으로 Go/No-Go를 판정한다. No-Go면 SPEC 단계로 되돌린다.
7. **Worktree Handoff**: GitHub Flow 브랜치와 `.worktrees/<branch>/PLAN.md`를 만들고, `CONTEXT.json execution.worktree`에 `branch`, `worktree_path`, `plan_path`, `status`, `last_updated`, `handoff`를 기록한다.
8. **Implement And Clean**: `feature-implementer`, 필요 시 `engineering-plan-writer`/SDD, 구현 후 `de-sloppify`를 사용한다.
9. **Wire And Verify**: `feature-wiring`, `pre-quality-gate`, 필요 시 `final-review`/`verification-loop`를 실행한다.
10. **Sync And Cleanup**: `feature-status-sync` 후 worktree PLAN과 `CONTEXT.json` cleanup 상태를 정리한다.

### Step 3.6: Git worktree 준비 - 필수

코드 변경 전에는 반드시 GitHub Flow 브랜치와 `.worktrees/<branch>` worktree를 준비한다. worktree 루트에는 `PLAN.md`를 만들고, 기능 `CONTEXT.json`의 `execution.worktree`에는 `branch`, `worktree_path`, `plan_path`, `status`, `last_updated`, `handoff`를 기록한다. 이 단계가 끝나기 전에는 구현 파일을 수정하지 않는다.

## Built-in Readiness Gate

핵심 질문은 "AI가 이 문서만 보고 추가 질문 없이 안전하게 구현할 수 있는가?"다. NEW_FEATURE/MODIFY_FEATURE에서 SPEC 생성/수정과 UI 승인 후 실행한다.

상세 5-Phase 검증, 출력 형식, 판정 기준은 `references/readiness-gate-protocol.md`를 읽는다.

## Auto-Stop

| 조건 | 조치 |
| --- | --- |
| 작업 유형 불명확 | 최소 질문으로 확인 |
| `CONTEXT.json` 손상/불일치 | `feature-doctor` 또는 중단 보고 |
| Readiness Gate No-Go | SPEC 생성/수정 단계로 복귀 |
| UI 승인 거부 | `Blocked` 또는 `AwaitingUser`로 전이 |
| 하위 스킬 실패 | 실패 원인, 재시도 여부, 수동 개입 필요성을 보고 |
| 보안/결제/PII | 즉시 정지, 사용자 확인 필수 |
| 동일 에러 3회 또는 QA 반복 한도 | 중단 후 handoff 기록 |

## Post-flight Checklist

완료 전 아래 체크리스트를 출력하고, 각 항목을 갱신한다.

```markdown
## Post-flight Checklist (feature-pilot)

|   ID    | 항목                                                | 상태 |
| :-----: | --------------------------------------------------- | :--: |
| POF-001 | 파이프라인 완료 또는 명시적 중단                    | ---  |
| POF-002 | CONTEXT.json 최종 상태 갱신                         | ---  |
| POF-003 | QA 검증 통과 (pre-quality-gate)                     | ---  |
| POF-004 | 하위 스킬 Post-flight 모두 완료                     | ---  |
| POF-005 | Evidence 캐시 완료                                  | ---  |
| POF-006 | DoD 검증 완료 (completion_contract verdict = passed) | ---  |
| POF-007 | worktree PLAN.md 및 CONTEXT.json cleanup 완료        | ---  |

**최종 상태**: [Done | Blocked | AwaitingUser | Failed]
```

## References

| Reference | Use When |
| --- | --- |
| `references/feature-pilot-protocol-details.md` | 이전 전체 프로토콜, 긴 파이프라인 예시, 사용자 인터랙션, 상세 DO/DON'T가 필요할 때 |
| `references/context-management-protocol.md` | `CONTEXT.json` 상태 머신, 라이프사이클, DoD 검증이 필요할 때 |
| `references/readiness-gate-protocol.md` | 내장 Readiness Gate의 5-Phase 검증 상세가 필요할 때 |
| `references/efficiency-skills-protocol.md` | pre-quality-gate 운영 상세가 필요할 때 |
| `references/autonomy-control-rules.md` | 7문 상한, 자율성 레벨, 자동 정지 조건이 필요할 때 |

## Not For / Boundaries

- 프로젝트 초기 scaffold: `project-scaffolder`
- 비즈니스/시장 분석: `business-analyzer`, `market-researcher`
- Discovery 단독 실행: `discover`, `research-pilot`
- GTM/가격 전략: `gtm-pilot`, `pricing-strategist`
- 전체 brief2dev 파이프라인 실행: `brief2dev-orchestrator`

## Maintenance

- Sources: CLAUDE.md, project-config.json, R-CM-018
- Last updated: 2026-06-11
- Active budget target: 260 lines 이하
