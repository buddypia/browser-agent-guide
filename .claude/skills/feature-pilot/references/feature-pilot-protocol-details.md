---
name: feature-pilot
description: |
  대상 프로젝트의 AI 주도 기능 개발을 통합하는 오케스트레이터.
  모든 개발 요청의 단일 진입점으로서, 작업 유형을 자동 판별하고 적절한 하위 스킬을 조율한다.
  **Readiness Gate 기능이 내장되어 있어, Go/No-Go 검증을 직접 실행한다.**

  "새 기능 추가", "버그 수정", "기능 수정", "개발 요청", "구현해줘" 등의 요청으로 트리거된다.

  <example>
  user: "사용자 대시보드에 통계 위젯을 추가하는 기능이 필요해"
  assistant: "feature-pilot을 사용하여 작업 유형을 판별하고 파이프라인을 시작합니다"
  </example>

  <example>
  user: "프로필 설정 화면에서 저장 버튼이 동작하지 않는 버그를 수정해줘"
  assistant: "feature-pilot을 사용하여 버그 수정 워크플로우를 시작합니다"
  </example>
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

# Feature Pilot (AI 주도 기능 개발 오케스트레이터)

> **핵심 컨셉**: "단일 진입점, 자동 조율, 내장 검증" (One Entry, Auto Orchestration, Built-in Validation)

AI 주도 개발 환경에서 모든 개발 요청을 접수하고, 적절한 워크플로우를 자동 조율하는 통합 오케스트레이터.

---

## EXECUTION PROTOCOL (MANDATORY) - v9.0

> **CRITICAL**: 이 섹션은 **건너뛸 수 없습니다**.
> feature-pilot 실행 시 아래 프로토콜을 **반드시** 준수해야 합니다.
> 위반 시 **즉시 중단**하고, 처음부터 재개해야 합니다.

### PATH CONTRACT (MANDATORY)

> **BINDING**: 이 스킬은 동적 경로 플레이스홀더를 사용합니다.
> AI는 파일 작업 전 반드시 `project-config.json`에서 경로를 해결해야 합니다.
> 리터럴 경로 사용은 **프로토콜 위반**입니다.

| Placeholder | Resolution Source | Default |
|-------------|-------------------|---------|
| `{FEATURES_DIR}` | project-config.paths.features | `src/features` |
| `{SHARED_DIR}` | project-config.paths.shared | `src/shared` |
| `{TESTS_DIR}` | project-config.paths.tests_unit | `tests/unit` |
| `{DOCS_DIR}` | project-config.paths.docs_features | `docs/features` |
| `{COMPONENT_EXT}` | project-config.conventions.component_extension | `.tsx` |
| `{FEATURE_LAYERS}` | project-config.conventions.feature_structure | `["types","api","hooks","components"]` |

**Resolution**: `Read project-config.json → 플레이스홀더 해결 → 해결된 값 사용`
**Fallback**: project-config.json 없으면 Default 컬럼 사용

**FORBIDDEN**: 생성 코드, 명령어, 파일 경로에 리터럴 `src/features/`, `src/shared/` 사용 금지.

**Step 0: 경로 해결 (Path Resolution)**

```
1. Read project-config.json (프로젝트 루트에 존재)
2. 해결된 경로 변수:
   - FEATURES_DIR = project_config.paths.features     (기본값: "src/features")
   - SHARED_DIR   = project_config.paths.shared        (기본값: "src/shared")
   - TESTS_DIR    = project_config.paths.tests_unit    (기본값: "tests/unit")
   - DOCS_DIR     = project_config.paths.docs_features (기본값: "docs/features")
   - COMPONENT_EXT = project_config.conventions.component_extension (기본값: ".tsx")
   - FEATURE_LAYERS = project_config.conventions.feature_structure   (기본값: ["types","api","hooks","components"])
3. project-config.json이 없으면 기본값 사용 (하위 호환성 보장)
4. 해결된 경로를 하위 스킬 호출 시 컨텍스트로 전달
```

**사용 예시**:
```
# project-config.json이 Next.js 프로젝트인 경우
FEATURES_DIR = "src/features"  →  Glob {FEATURES_DIR}/<feature>/components/

# project-config.json이 Flutter 프로젝트인 경우
FEATURES_DIR = "lib/features"  →  Glob {FEATURES_DIR}/<feature>/views/

# project-config.json이 없는 경우 (레거시 호환)
FEATURES_DIR = "src/features"  →  기존 동작과 동일
```

### Pre-flight Checklist (스킬 시작 전 필수 출력)

> **CHECKLIST UPDATE RULE (MANDATORY)**:
> 각 체크 항목 확인 완료 시, 체크리스트 전체를 재출력하고 해당 항목의 상태를 갱신할 것.
> `---` → `✅` (통과) 또는 `❌` (실패). 전체 항목 확인까지 매번 최신 상태를 반영.
> **미갱신인 채 다음 단계로 진행 = Violation Protocol 위반 (severity: HIGH)**

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

**작업 유형**: [NEW_FEATURE | MODIFY_FEATURE | BUG_FIX | DOCS_ONLY]
**Risk Level**: [high | medium | low]
**파이프라인**: [해당 파이프라인 목록]

---

→ 각 항목 확인 후 본 테이블을 재출력 (상태열을 ✅/❌로 갱신)
→ 전체 항목 ✅: 실행 진행 / 하나라도 ❌: 즉시 중단 + 사유 보고
```

### Model Routing Policy (필수 준수)

| 작업                          | 모델 | 비용 |
| ----------------------------- | :----: | :----: |
| 작업 유형 분류                | Sonnet  |   $    |
| 컨텍스트 수집                 | Sonnet  |   $    |
| Readiness Gate 검증           | Sonnet |   $$   |
| 구현 (feature-implementer)    | Sonnet |   $$   |
| 아키텍처 결정                 |  Opus  |  $$$   |

**하위 스킬 ESP 계승 규칙**:

- ESP v2.0+ 스킬 호출 시 → 해당 스킬의 Pre/Post-flight 출력 확인 필수
- ESP 미적용 스킬 호출 시 → feature-pilot이 대행 검증
- **폴백 체인**: Sonnet → Sonnet → Opus (실패 시 자동 승격)

### Evidence Caching Policy

| 검증 유형      | 유효 시간 | 무효화 조건                                     |
| -------------- | :------: | ----------------------------------------------- |
| make q.lint    |   30분   | `{SOURCE_ROOT}/**/*.{LANG_EXT}` 변경            |
| make q.test    |   30분   | `{TESTS_DIR}/**/*.{LANG_EXT}`, `{SOURCE_ROOT}/**/*.{LANG_EXT}` 변경 |
| Readiness Gate |   60분   | SPEC-_.md, screens/_.md 변경                    |
| Security Scan  |   60분   | `.env*` 변경                                    |

**캐시 활용**:

- 유효 시간 내 동일 검증 → 재실행 생략, 캐시 결과 사용
- 무효화 조건 충족 → 강제 재실행
- `--force` 플래그 → 캐시 무시, 강제 재실행

### Post-flight Checklist (스킬 종료 전 필수 출력)

> **CHECKLIST UPDATE RULE (MANDATORY)**:
> 각 체크 항목 확인 완료 시, 체크리스트 전체를 재출력하고 해당 항목의 상태를 갱신할 것.
> `---` → `✅` (통과) 또는 `❌` (실패). 전체 항목 확인까지 매번 최신 상태를 반영.
> **미갱신인 채 다음 단계로 진행 = Violation Protocol 위반 (severity: HIGH)**

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
**Evidence 캐시**:

- npm_lint: [CACHED until HH:MM | NOT_CACHED]
- npm_test: [CACHED until HH:MM | NOT_CACHED]
- readiness_gate: [CACHED until HH:MM | NOT_CACHED]

---

→ 각 항목 확인 후 본 테이블을 재출력 (상태열을 ✅/❌로 갱신)
→ 전체 항목 ✅: 완료 보고 / 하나라도 ❌: 수정 후 재검증
```

### Violation Protocol

| 위반 유형                                        |  심각도  | 처리                                         |
| ------------------------------------------------ | :------: | -------------------------------------------- |
| Pre-flight 미출력                                | CRITICAL | 즉시 중단, 처음부터 재개                     |
| Post-flight 미검증                               |   HIGH   | 완료 보고 전에 검증 실행                     |
| Model 파라미터 누락 (Task 호출)                  |   HIGH   | 해당 Task 재호출                             |
| 하위 스킬 ESP 위반                               |   HIGH   | 해당 스킬 재실행                             |
| 검증 없이 완료 주장                              | CRITICAL | 즉시 중단, 검증 실행                         |
| Evidence 캐시 무시 (불필요한 재실행)             |   LOW    | 경고 후 속행                                 |
| 체크리스트 상태 미갱신 (---/[ ]/⬜ 인 채 진행)   |   HIGH   | 즉시 체크리스트 재출력, 상태 갱신 후 진행    |

---

## 핵심 원칙

1. **Single Entry Point**: 사용자는 어떤 스킬을 사용하는지 알 필요가 없다
2. **Auto Classification**: 요청을 분석하여 작업 유형을 자동 판별
3. **Pipeline Orchestration**: 적절한 하위 스킬을 순차/병렬 호출
4. **Built-in Validation**: Readiness Gate가 내장되어 있어 별도 스킬 호출 불필요
5. **Context Continuity**: 전체 파이프라인에서 컨텍스트 유지
6. **Context Preservation via CONTEXT.json**: 통합 컨텍스트 파일을 통한 상태 추적으로 컨텍스트 손실 방지

---

## 작업 유형 (Work Types)

| 유형               | 트리거 신호                    | 파이프라인                                                                                |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------- |
| **NEW_FEATURE**    | "새 기능", "추가", SPEC 미존재 | architect → spec → ui-approval → **gate** → impl → wiring → qa → status-sync → quality-gate |
| **MODIFY_FEATURE** | "수정", "변경", 기존 SPEC 있음 | spec-update → ui-approval → **gate** → impl → wiring → status-sync → quality-gate           |
| **BUG_FIX**        | "버그", "에러", "수정"         | analyze → impl → test                                                                       |
| **DOCS_ONLY**      | "문서만", "SPEC만"             | 해당 스킬만 호출                                                                            |

---

## CONTEXT.json 관리 프로토콜 (Context Preservation)

> 상세: `references/context-management-protocol.md` 참조

---

## 효율성/품질 스킬

> 상세: `references/efficiency-skills-protocol.md` 참조

---

## 프로토콜 (Protocol)

### Phase 0: 요청 접수와 분류 (Request Classification)

1. **요청 분석**:
   - 키워드 추출 (새 기능, 수정, 버그, 리서치 등)
   - 기능 ID 언급 여부 확인
   - 구체적인 파일/화면 언급 여부 확인

2. **기능 인벤토리 조회 (의무 — 기능 ID 언급 여부와 무관)**:

   ```bash
   # 도메인 경계 SSOT + 기능 인벤토리 (없으면 ls docs/features/ + index.md 폴백)
   cat {DOCS_DIR}/domain-map.json 2>/dev/null
   cat {DOCS_DIR}/index.md 2>/dev/null
   # 기능 ID가 언급된 경우 해당 문서 존재 확인
   ls {DOCS_DIR}/<mentioned-id>/ 2>/dev/null
   ```

   > 인벤토리를 읽지 않고 NEW_FEATURE로 직행하는 것 = 프로토콜 위반. 사용자가 ID를 언급하지 않은 자연어 요청이 바로 중복 기능 폴더가 생기는 경로다.

2.5. **Domain Placement 판정 (BUG_FIX/DOCS_ONLY 외 의무)**:

   요구사항을 domain-map.json의 `domains[].keywords`/`responsibility` 및 `features[].title`과 비교하여 4-way 판정을 표 형식으로 출력한다:

   | Verdict | 의미 | 라우팅 |
   | --- | --- | --- |
   | `DUPLICATE` | 동일 기능 존재 | 중단 + 기존 기능 ID 보고 |
   | `EXTEND_EXISTING` | 기존 기능 범위 확장 | MODIFY_FEATURE (해당 기능 ID 대상) |
   | `NEW_IN_EXISTING_DOMAIN` | 기존 도메인 내 신규 기능 | NEW_FEATURE (domain id 전달) |
   | `NEW_DOMAIN` | 신규 도메인 | NEW_FEATURE (신규 도메인 정의 필요 명시) |

   출력 양식: `Verdict / 귀속 domain id / 비교한 기존 기능 ID (없으면 "없음") / 근거 1-2문장`.
   **애매한 경우** (후보 기능 2개 이상 또는 확신 부족): 후보 기능 ID + 각 후보의 책무 1줄을 제시하고 사용자에게 확인한다 (`AwaitingUser`). 임의로 NEW_FEATURE를 선택하지 않는다.
   판정 결과(verdict + domain id)는 feature-architect에 전달한다 (architect가 Step 1.5에서 재확인).

3. **작업 유형 판별**:
   ```
   IF 버그/에러/동작 안 함 언급 → BUG_FIX
   ELSE IF Verdict == DUPLICATE → 중단 + 기존 기능 보고
   ELSE IF Verdict == EXTEND_EXISTING → MODIFY_FEATURE
   ELSE IF SPEC 없음 AND 새 기능 요청 → NEW_FEATURE
   ELSE IF SPEC 있음 AND 변경 요청 → MODIFY_FEATURE
   ELSE → 사용자에게 명확화 질문
   ```

### Phase 1: 계획 제시 (Plan Presentation)

판별된 작업 유형에 따라 실행 계획을 제시:

> **PIPELINE PROGRESS UPDATE RULE (MANDATORY)**:
> 각 스텝 완료 시, 본 테이블을 재출력하고 상태열을 `✅`/`❌`/`⏭️`로 갱신할 것.
> `---`인 채 다음 스텝으로 진행 = Violation Protocol 위반 (severity: HIGH)

```markdown
## 작업 분류 완료

**요청**: [사용자 요청 요약]
**작업 유형**: NEW_FEATURE
**관련 기능**: 없음 (신규)

### 실행 계획

| Step | 상태 | 스킬/액션                 | 설명                                                    |
| :--: | :--: | ------------------------- | ------------------------------------------------------- |
|  0   | ---  | `/research-pilot`         | Product Discovery (조건부: 리서치/타당성 키워드 시)     |
|  1   | ---  | `/feature-architect`      | CONTEXT.json 생성                                       |
|  2   | ---  | `/feature-spec-generator` | SPEC.md + Screen 생성                                   |
|  3   | ---  | **Readiness Gate**        | Go/No-Go 검증 (내장)                                    |
|  4   | ---  | 구현 진행                 | SPEC 기준                                               |
|  5   | ---  | 테스트 + 품질 검증        | lint + test + architecture check                        |

→ 각 스텝 완료 시 본 테이블을 재출력하고 상태열을 ✅/❌/⏭️로 갱신
→ 전체 스텝 ✅/⏭️: 완료 / 하나라도 ❌: 중단 + 사유 보고

진행할까요?
```

### Phase 2: 파이프라인 실행 (Pipeline Execution)

각 작업 유형별 파이프라인:

#### NEW_FEATURE 파이프라인

**중요**: 새 기능은 반드시 **architect (CONTEXT 생성)** → SPEC → Gate → 구현 순서를 따릅니다.
**Option B 원칙**: feature-architect가 CONTEXT.json을 생성해야만 feature-spec-generator가 실행 가능합니다.

```
Phase -1: research-pilot (조건부 실행)
        +------------------------------------+
        | 조건: 아래 중 하나에 해당하는 경우    |
        |  - 사용자가 "리서치", "타당성",      |
        |    "조사", "제로 베이스"라고 언급     |
        |  - 사용자가 /research-pilot 명시 호출 |
        |  - 외부 API/AI/ML 연동 발견 시 실행 제안 |
        |                                    |
        | Skill 도구 사용:                     |
        | - skill: "research-pilot"          |
        | - args: "<기능 설명>"              |
        |                                    |
        | BUILD 결정 시:                      |
        |   → RESEARCH.md 생성               |
        |   → CONTEXT.json research 준비     |
        |   → Phase 0.5로 진행               |
        |                                    |
        | SKIP/DEFER 결정 시:                 |
        |   → RESEARCH.md 기록 후 파이프라인 종료|
        |                                    |
        | 캐시: 기존 RESEARCH.md 30일 이내     |
        |   → 재실행 생략, 캐시 사용           |
        +------------------------------------+
        v BUILD → Phase 0.5 / SKIP/DEFER → 종료

Phase 0.5: 병렬 컨텍스트 수집
        +------------------------------------+
        | 작업 목록 생성 → 의존성 분석 → 배치 구성|
        |                                    |
        | 병렬 실행 (단일 응답으로 여러 Task):   |
        | - Task 1: 기존 패턴 검색 [Sonnet]    |
        | - Task 2: 관련 API 확인 [Sonnet]    |
        | - Task 3: 테스트 패턴 조사 [Sonnet]   |
        | - Task 4: 재사용 후보 탐색 [Sonnet]   |
        |                                    |
        | 예상 시간 단축: 60-70%               |
        +------------------------------------+
        v 컨텍스트 수집 완료 (병렬 결과 병합)

Step 1: Skill 도구로 feature-architect 호출 - 필수 게이트
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "feature-architect"       |
        | - args: (없음) -- 항상 Standard 모드  |
        |                                    |
        | CONTEXT.json 생성의 유일한 책임자    |
        | 이 단계는 스킵 불가                  |
        +------------------------------------+
        v CONTEXT.json 생성 (필수)

Step 2: Skill 도구로 feature-spec-generator 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "feature-spec-generator"  |
        | - args: "<기능ID>"                 |
        |                                    |
        | 전제 조건: CONTEXT.json 필수         |
        | (Step 1에서 architect가 생성)       |
        +------------------------------------+
        v SPEC.md, screens/*.md 생성

Step 2.5: Skill 도구로 ui-approval-gate 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "ui-approval-gate"        |
        | - args: "<기능ID>"                 |
        |                                    |
        | 사용자 승인 필수 게이트               |
        | 와이어프레임 생성 + 리뷰 + 승인       |
        | 승인 없이는 다음 단계로 진행 불가      |
        +------------------------------------+
        v 승인 → Step 3 / 거부 → Blocked

Step 3: [내장] Readiness Gate Protocol 실행
        +------------------------------------+
        | 별도 스킬 호출 없이 직접 검증         |
        | - Phase 1: 상류 계약 검증            |
        | - Phase 2: 기술 계약 검증            |
        | - Phase 3: 구현 안전성 검증          |
        | → 아래 "Readiness Gate Protocol" 참조 |
        +------------------------------------+
        v Go → Step 3.5 / No-Go → Step 2로 복귀

Step 3.5: [조건부] Engineering Plan 생성 (SDD 모드 준비)
        +------------------------------------+
        | 조건: SPEC의 독립 태스크가 3개 이상   |
        |                                    |
        | Skill 도구 사용:                     |
        | - skill: "engineering-plan-writer" |
        | - args: "<기능ID>"                 |
        |                                    |
        | 산출물: PLAN.md (bite-sized tasks)   |
        | → feature-implementer가 SDD 모드    |
        |   (per-task subagent + 2-stage      |
        |    review) 자동 활성화              |
        |                                    |
        | 태스크 3개 미만:                     |
        | → PLAN.md 스킵, 인라인 TDD 모드      |
        +------------------------------------+
        v PLAN.md 생성 → Step 4 (SDD) / 스킵 → Step 4 (인라인)

Step 3.6: Git worktree 준비 - 필수
        +------------------------------------+
        | GitHub Flow 브랜치명 확정           |
        | worktree 경로: .worktrees/<branch>  |
        |                                    |
        | 필수 산출물:                         |
        | - .worktrees/<branch>/PLAN.md       |
        | - CONTEXT.json execution.worktree   |
        |                                    |
        | execution.worktree 필수 필드:        |
        | branch, worktree_path, plan_path,    |
        | status, last_updated, handoff        |
        +------------------------------------+
        v worktree 준비 완료 → Step 4

Step 4: 구현 시작 (Sequential 또는 SDD Mode)
        +------------------------------------+
        | 배치 병렬 구현                       |
        | → 배치 1: Type+Zod+API (병렬)       |
        | → 배치 2: Custom Hook (순차)         |
        | → 배치 3: Component (순차)           |
        | → 배치 4: Test (순차)                |
        +------------------------------------+
        v SPEC의 FR 순서대로 코드 작성 + 테스트

Step 4.5: Skill 도구로 de-sloppify 호출 - CODE CLEANUP
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "de-sloppify"             |
        |                                    |
        | 구현 후 자동 클린업:                  |
        | - console.log/debug 제거            |
        | - 미사용 import 정리                 |
        | - .only/.skip 제거                  |
        | - 매직 넘버 상수화 제안              |
        | - any 타입 → 구체 타입 제안           |
        +------------------------------------+
        v 코드 정리 완료

Step 4.6: Skill 도구로 feature-wiring 호출 - INTEGRATED
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "feature-wiring"          |
        | - args: "<기능ID>"                 |
        |                                    |
        | 데이터소스 연동 + 내비게이션 연결      |
        | 구현 완료 후 반드시 실행              |
        +------------------------------------+
        v 통합 연동 완료

Step 4.6: Skill 도구로 pre-quality-gate 호출 (QA 사이클)
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "pre-quality-gate"        |
        |                                    |
        | lint → test → 아키텍처 검사           |
        | 모든 검증 통과까지 최대 5회 반복       |
        | 동일 에러 3회 → 정지                 |
        | 통과 후 Step 5로 진행                |
        +------------------------------------+
        v QA 사이클 통과

Step 5: Skill 도구로 feature-status-sync 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "feature-status-sync"     |
        | - args: "<기능ID>" (생략 가능)       |
        +------------------------------------+
        v index.md 상태 동기화

Step 6: Skill 도구로 priority-analyzer 호출 (선택적)
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "priority-analyzer"       |
        | - args: "<기능ID> --apply"         |
        |                                    |
        | 선택적 실행 조건:                     |
        | - progress 변화 >= 10%              |
        | - 또는 priority.last_updated 14일+  |
        +------------------------------------+
        v 우선순위 재계산 (CONTEXT.json 갱신)

Step 7: Skill 도구로 pre-quality-gate 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "pre-quality-gate"        |
        +------------------------------------+
        v 최종 품질 검증
```

#### MODIFY_FEATURE 파이프라인

**중요**: 기존 SPEC이 있는 경우, 반드시 feature-spec-updater를 먼저 실행해야 합니다. SPEC 수정 없이 구현을 시작해서는 안 됩니다.

```
Step 1: Skill 도구로 feature-spec-updater 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "feature-spec-updater"    |
        | - args: "<기능ID>"                 |
        +------------------------------------+
        v 기존 SPEC 로드, 변경 범위 분석, diff 출력

Step 2: feature-spec-updater 결과 확인
        - SPEC 변경사항 리뷰
        - 변경 이력 추가 확인
        - 연쇄 영향 문서 확인
        v

Step 2.5: Skill 도구로 ui-approval-gate 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "ui-approval-gate"        |
        | - args: "<기능ID>"                 |
        |                                    |
        | 변경된 UI의 사용자 승인 필수          |
        | 와이어프레임 갱신 + 리뷰              |
        +------------------------------------+
        v 승인 → Step 3 / 거부 → Blocked

Step 3: [내장] Readiness Gate Protocol 실행
        +------------------------------------+
        | 별도 스킬 호출 없이 직접 검증         |
        | → 아래 "Readiness Gate Protocol" 참조 |
        +------------------------------------+
        v Go → Step 4 / No-Go → Step 2.5로 복귀

Step 4: 구현 + 테스트 (SPEC의 수정된 FR 기준)
        v

Step 4.5: Skill 도구로 feature-wiring 호출 (필요 시) - INTEGRATED
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "feature-wiring"          |
        | - args: "<기능ID>"                 |
        |                                    |
        | 실행 조건:                           |
        | - 신규 Hook/화면 추가 시             |
        | - 데이터/엔트리포인트 변경 시         |
        +------------------------------------+
        v 통합 연동

Step 5: Skill 도구로 feature-status-sync 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "feature-status-sync"     |
        | - args: "<기능ID>"                 |
        +------------------------------------+
        v index.md 상태 동기화

Step 6: Skill 도구로 priority-analyzer 호출 (선택적)
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "priority-analyzer"       |
        | - args: "<기능ID> --apply"         |
        |                                    |
        | 선택적 실행 조건:                     |
        | - progress 변화 >= 10%              |
        | - 또는 priority.last_updated 14일+  |
        +------------------------------------+
        v 우선순위 재계산

Step 7: Skill 도구로 pre-quality-gate 호출 (선택)
        v 품질 검증
```

#### BUG_FIX 파이프라인

**중요**: 버그 수정도 체계적인 프로세스를 따릅니다. 증상만 보고 수정하는 것이 아니라, 근본 원인을 찾아 해결합니다.

```
Step 1: Skill 도구로 bug-fix 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "bug-fix"                 |
        | - args: "<버그 증상 설명>"           |
        +------------------------------------+
        v Phase 1: 버그 분석 (증상 정리, 관련 코드 탐색)
        v Phase 2: 근본 원인 분석 (가설 수립, 검증)
        v Phase 3: 수정 구현 (회귀 테스트 → 코드 수정)
        v Phase 4: 검증 완료 (전체 테스트, lint)

Step 2: 수정 완료 확인
        - 회귀 테스트 추가 확인
        - 전체 테스트 통과 확인
        - make q.lint 통과 확인
        v

Step 3: (선택) Skill 도구로 pre-quality-gate 호출
        +------------------------------------+
        | Skill 도구 사용:                     |
        | - skill: "pre-quality-gate"        |
        +------------------------------------+
        v 최종 품질 검증 (커밋 전)
```

### Phase 3: 진행 상황 추적 (Progress Tracking)

각 단계 완료 시 상태 갱신:

```markdown
## 진행 상황

**작업**: 001-data-processing (NEW_FEATURE)

| 단계           |   상태   | 산출물                    |
| -------------- | :------: | ------------------------- |
| CONTEXT 생성   |   Done   | `CONTEXT.json`            |
| SPEC 생성      |   Done   | `SPEC-001.md`, `screens/` |
| Readiness Gate |   Done   | Go 판정                   |
| 구현           |   Done   | FR-00101~00105 완료       |
| 상태 동기화    | Progress | index.md 갱신 중          |
| 품질 검증      | Pending  | -                         |

### 현재 작업

feature-status-sync: index.md 상태 동기화 중...
```

---

## Readiness Gate Protocol (내장)

> **핵심 질문**: "AI가 이 문서만 보고, 추가 질문 없이 안전하게 구현할 수 있는가?"

### 개요

별도의 `Readiness Gate` 스킬을 feature-pilot에 **통합**하였다.

| 통합 사유                          | 효과                           |
| ---------------------------------- | ------------------------------ |
| Skill 도구 호출 오버헤드 제거      | 파이프라인 효율성 향상         |
| 컨텍스트 전환 없음                 | 정보 손실 방지                 |
| 스킬 수 감소                       | 소규모 개발 환경에서 인지 부하 경감 |
| 단일 스킬로 완결                   | 관리의 단순화                   |

### 실행 시점

- **NEW_FEATURE**: Step 3 (SPEC 생성 후)
- **MODIFY_FEATURE**: Step 3 (SPEC 수정 후)

> 5-Phase 검증 구조, 출력 형식, 판정 기준 상세: `references/readiness-gate-protocol.md` 참조

---

## 하위 스킬 호출 규칙

> **Option B 원칙**: feature-architect는 **필수 게이트**이다. spec-generator는 CONTEXT.json 없이는 실행할 수 없다.

| 스킬                   | 호출 조건                         | Skill 도구 args                              | 역할                                       |  필수  |
| ------------------------ | --------------------------------- | ---------------------------------------------- | ------------------------------------------ | :----: |
| `research-pilot`         | **NEW_FEATURE Phase -1** (조건부) | `"<기능 설명>"` 또는 `"--tier <S\|M\|L\|XL>"` | **Product Discovery**                      | 조건부 |
| `feature-architect`      | NEW_FEATURE Step 1                | `(없음)` 또는 `"--quick"`                     | **CONTEXT.json 생성 (유일한 책임자)**      |  필수  |
| `feature-spec-generator` | NEW_FEATURE Step 2                | `"<기능ID>"`                                  | CONTEXT 기준 SPEC 생성                     |  필수  |
| `feature-spec-updater`   | **MODIFY_FEATURE Step 1**         | `"<기능ID>"`                                  | **기존 SPEC 수정**                         |  필수  |
| `ui-approval-gate`       | **Step 2.5 (SPEC 생성/수정 후)**  | `"<기능ID>"`                                  | **UI 와이어프레임 생성 + 사용자 승인**     |  필수  |
| `bug-fix`                | **BUG_FIX Step 1**                | `"<버그 증상>"`                               | **버그 분석 및 수정**                      |  필수  |
| `feature-wiring`         | **구현 완료 후 Step 4.5**         | `"<기능ID>"`                                  | **데이터 연동 + 내비게이션 연결**          |  필수  |
| `feature-status-sync`    | **wiring 완료 후**                | `"<기능ID>"` (생략 가능)                       | **index.md 상태 동기화**                   |  필수  |
| `feature-doctor`         | **CONTEXT.json 불일치/손상 시**   | (없음)                                         | **상태 진단 + 자동 복구**                  |  임의  |
| `priority-analyzer`      | **상태 동기화 후** (선택적)       | `"<기능ID> --apply"`                           | **우선순위 재계산**                        |  임의  |
| `pre-quality-gate`       | priority 갱신 후                  | (없음)                                         | 최종 품질 검증                             |  임의  |
| `story-decomposer`      | **SPEC 완료 후** (선택적)         | `"<기능명>"` 또는 `"--format job"`             | **SPEC → User/Job Story 분해 + INVEST 검증** |  임의  |

**architect 모드**: 항상 Standard (전체 컨텍스트 수집, 최대 7건 질문)

> **참고**: Readiness Gate는 **내장**되어 있으므로, 별도 스킬 호출 없이 직접 실행합니다.

---

## 사용자 인터랙션 패턴

### 최소 입력 (추천)

```
사용자: "데이터 처리 기능을 추가해줘"
```

→ feature-pilot이 모든 것을 자동 조율

### 상세 입력

```
사용자: "001-data-processing의 분석 로직을 다른 AI 서비스로 변경해줘"
```

→ MODIFY_FEATURE로 판별, 해당 SPEC 로드 후 진행

### 중간 개입

```
사용자: "SPEC까지만 만들고, 구현은 나중에"
```

→ DOCS_ONLY로 전환, gate까지 실행

---

## 예외 처리

| 상황                            | 처리                                              |
| ------------------------------- | ------------------------------------------------- |
| **작업 유형 불명확**            | 사용자에게 선택지 제시                            |
| **하위 스킬 실패**              | 에러 내용 표시 후 리트라이 또는 수동 개입 요청    |
| **CONTEXT.json 불일치/손상**    | `feature-doctor` 실행 후 리트라이                 |
| **Readiness Gate No-Go (신규)** | 수정 안내 후 feature-spec-generator 재호출        |
| **Readiness Gate No-Go (수정)** | 수정 안내 후 feature-spec-updater 재호출          |
| **사용자 중단 요청**            | 현재 진행 상황 저장 후 중단                       |
| **7문 상한 도달**               | `AwaitingUser` 전이, 미답변 항목은 추천안 자동 선택 |
| **고위험 작업 감지 (보안/결제/PII)** | 즉시 정지, `AwaitingUser` 전이, 사용자 확인 필수  |

---

## 자율성 제어 규칙 (Autonomy Control Rules)

> 상세: `references/autonomy-control-rules.md` 참조

---

## AI 행동 지침

### DO (해야 할 것)

- 요청을 받으면 먼저 작업 유형을 분류
- **Skill 도구를 사용하여 하위 스킬을 호출** (feature-architect, feature-spec-generator, bug-fix 등)
- **SPEC 생성/수정 후 반드시 `ui-approval-gate`를 호출** (와이어프레임 생성 + 사용자 승인 필수)
- **Readiness Gate는 UI 승인 후 직접 실행** (별도 스킬 호출 없음)
- 각 단계의 결과를 명확히 보고
- 진행 상황을 지속적으로 갱신
- 하위 스킬의 출력을 요약하여 전달
- 예상되는 다음 단계를 안내
- **구현 완료 후 `feature-wiring`을 호출** (데이터소스 연동 + 내비게이션 연결 필수)
- **wiring 완료 후 `pre-quality-gate`를 호출** (QA 사이클 통과 필수)
- **QA 통과 후 `feature-status-sync`를 호출** (index.md 상태 동기화 필수)
- **BUG_FIX 시 반드시 `bug-fix` 스킬을 호출** (체계적 버그 분석 및 수정)
- **progress 변화 >= 10% 또는 priority 14일+ 경과 시 `priority-analyzer`를 호출** (우선순위 최신화)
- **컨텍스트 수집 시 병렬 Task 호출을 활용** (병렬 읽기로 효율성 향상)

### DON'T (해서는 안 되는 것)

- 사용자에게 어떤 스킬을 사용해야 하는지 질문
- 작업 유형 판별 없이 직접 구현 시작
- **하위 스킬 호출 없이 직접 작업 실행** (예: SPEC 수정 시 feature-spec-updater 없이 직접 수정, 버그 수정 시 bug-fix 없이 직접 수정)
- **UI 승인 없이 Readiness Gate로 진행** (ui-approval-gate 스킵 금지)
- Readiness Gate 검증 없이 구현 진행 (NEW_FEATURE/MODIFY_FEATURE)
- 중간 단계 스킵
- **wiring 스킬 없이 feature-status-sync 진행** (빈 데이터/고아 페이지 문제 발생)
- **상태 동기화 (feature-status-sync) 없이 품질 검증 (pre-quality-gate) 진행**
- **버그 수정 시 회귀 테스트 없이 수정 완료** (bug-fix 스킬이 강제)
- **NEW_FEATURE에서 feature-architect 스킵** (Option B 원칙 - CONTEXT.json 생성은 architect만 가능)
- **CONTEXT.json 없이 feature-spec-generator를 직접 호출** (필수 전제 조건 위반)

---

## 사용 예시

```bash
# 자연어로 요청 (추천)
"사용자가 제출한 데이터를 처리하여 구조화된 결과를 생성하는 기능이 필요해"

# 구체적인 수정 요청
"001-data-processing에서 데이터 처리 후 결과 텍스트의 품질을 개선해줘"

# 버그 수정 요청
"비교 표시 화면에서 서식이 동작하지 않는 문제를 수정해줘"

# 리서치 요청
"경쟁 서비스의 데이터 처리 기능을 분석해줘"
```

---

## Not For / Boundaries

- **프로젝트 초기 설정/scaffold**: project-scaffolder가 담당
- **비즈니스 분석/시장 조사**: business-analyzer, market-researcher가 담당
- **Discovery/리서치**: discover, research-pilot이 담당 (feature-pilot은 개발 실행 전용)
- **GTM/가격 전략**: gtm-pilot, pricing-strategist가 담당
- **brief2dev 파이프라인 실행**: brief2dev-orchestrator가 담당 (feature-pilot은 생성된 프로젝트 내 개발 오케스트레이션)

---

## 참조 문서

### 분리된 상세 참조

- [CONTEXT.json 관리 프로토콜](references/context-management-protocol.md) - 상태 머신, 라이프사이클, DoD 검증
- [효율성/품질 스킬 프로토콜](references/efficiency-skills-protocol.md) - pre-quality-gate
- [Readiness Gate 프로토콜](references/readiness-gate-protocol.md) - 5-Phase 검증 구조, 출력 형식, 판정 기준
- [자율성 제어 규칙](references/autonomy-control-rules.md) - 7문 상한, 자동 정지 조건, 자율성 레벨

### 핵심 파이프라인 스킬

- [Readiness Gate 상세 체크리스트](references/readiness-checklist.md)
- [feature-architect 스킬](../feature-architect/SKILL.md)
- [feature-spec-generator 스킬](../feature-spec-generator/SKILL.md) - 신규 SPEC 생성
- [feature-spec-updater 스킬](../feature-spec-updater/SKILL.md) - 기존 SPEC 수정
- [ui-approval-gate 스킬](../ui-approval-gate/SKILL.md) - UI 와이어프레임 승인 게이트
- [bug-fix 스킬](../bug-fix/SKILL.md) - 버그 분석 및 수정
- [feature-wiring 스킬](../feature-wiring/SKILL.md) - 데이터 연동 + 내비게이션 연결
- [feature-status-sync 스킬](../feature-status-sync/SKILL.md) - index.md 상태 동기화

### 효율성/품질 스킬

- [pre-quality-gate 스킬](../pre-quality-gate/SKILL.md) - lint/test/아키텍처 QA 사이클

---

## Maintenance

- **Sources**: CLAUDE.md (feature-pilot 파이프라인 정의), project-config.json (동적 경로 해결)
- **Last updated**: 2026-03-26
- **Known limits**: Readiness Gate의 validate_spec.py는 Markdown SPEC 전용. JSON/YAML SPEC은 미지원
