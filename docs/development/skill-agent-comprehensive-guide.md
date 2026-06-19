# 스킬·에이전트 종합 가이드

> ⚠️ **카탈로그 경계 주의 — 본문 표는 대표 예시, 정확한 수·목록은 SSOT 직접 참조**
>
> 스킬·에이전트의 **개수·전체 목록**은 아래 SSOT 가 권위 원천이다. 본문 표는 대표 예시이며 카운트를 하드코딩하지 않는다 (drift 방지 — AGENTS.md 설계원칙 #13):
> - 스킬: `.claude/skills/project-scaffolder/references/deployed-skills.json`
> - 에이전트: `.claude/agents/MANIFEST.json` (`.claude/agents/` 디렉토리)
> - 모델: 자동 폴백/승격 없음 (`brief2dev.yaml#global.model_fallback.enabled: false`). 모델 라우팅 SSOT: [model-routing.md](./model-routing.md).
> - 자동 라우팅: `.claude/hooks/keyword-router.mjs` (MANIFEST `magic_keywords` 아님).
> - 개발 스킬(`feature-pilot`/`bug-fix`/`feature-*`)은 brief2dev 리포에서 `pipeline-boundary-guard` 차단 (관점 1). 본문은 관점 2(생성된 프로젝트) 기준.

> **목적**: {{PROJECT_NAME}} 프로젝트의 AI 주도 개발을 지원하는 "스킬"과 "에이전트"의 전체상을 이해하고, 적절히 활용하기 위한 포괄적 문서.
>
> **대상 독자**: 개발자, 프로젝트 오너, AI 어시스턴트 이용자
>
> **최종 업데이트**: 2026-02-10

---

## 목차

1. [개요 — 스킬과 에이전트란](#1-개요--스킬과-에이전트란)
2. [왜 필요한가](#2-왜-필요한가)
3. [3계층 아키텍처](#3-3계층-아키텍처)
4. [메인 파이프라인](#4-메인-파이프라인)
   - 4.1 [새 기능 개발 (NEW_FEATURE)](#41-새-기능-개발-new_feature)
   - 4.2 [기능 수정 (MODIFY_FEATURE)](#42-기능-수정-modify_feature)
   - 4.3 [버그 수정 (BUG_FIX)](#43-버그-수정-bug_fix)
   - 4.4 [리서치·분석 (RESEARCH)](#44-리서치분석-research)
   - 4.5 [후보 변환 (CONVERT_CANDIDATE)](#45-후보-변환-convert_candidate)
5. [작업 유형 자동 판별](#5-작업-유형-자동-판별)
6. [스킬 목록과 상세](#6-스킬-목록과-상세)
   - 6.1 [Layer 1: 오케스트레이터](#61-layer-1-오케스트레이터)
   - 6.2 [Layer 2: 파이프라인](#62-layer-2-파이프라인)
   - 6.3 [Layer 3: 유틸리티](#63-layer-3-유틸리티)
7. [에이전트 목록과 상세](#7-에이전트-목록과-상세)
8. [실행 모드](#8-실행-모드)
9. [품질 보증 메커니즘](#9-품질-보증-메커니즘)
10. [유스케이스 모음](#10-유스케이스-모음)
11. [거버넌스와 라이프사이클](#11-거버넌스와-라이프사이클)

---

## 1. 개요 — 스킬과 에이전트란

{{PROJECT_NAME}} 프로젝트에서는 AI 주도 개발을 실현하기 위해 **스킬**과 **에이전트**라는 두 가지 메커니즘을 사용합니다.

### 스킬 (Skills)

**스킬이란, 특정 워크플로우나 절차를 정의한 재사용 가능한 명령 집합**입니다.

- `.claude/skills/` 디렉토리에 `SKILL.md`로 정의
- `/스킬명`으로 직접 호출하거나 키워드로 자동 실행
- 파이프라인(복수 스킬의 연쇄)을 구성할 수 있음
- 총 개수·전체 목록은 `deployed-skills.json` (SSOT) 참조 — 카운트 하드코딩 안 함 (drift 방지)

### 에이전트 (Agents)

**에이전트란, 특정 전문 영역에 특화된 AI 워커**입니다.

- `.claude/agents/` 디렉토리에 정의
- `Task` 툴로 실행하며, 병렬 작업 가능
- 파일 소유권(읽기 전용/편집 가능)이 엄격하게 분리
- 총 개수·전체 목록은 `.claude/agents/MANIFEST.json` (SSOT) 참조

### 양자의 차이

| 항목             | 스킬                         | 에이전트       |
| ---------------- | ---------------------------- | -------------- |
| **성질**         | 워크플로우 정의              | 전문 워커      |
| **실행 방법**    | `/스킬명` 또는 키워드        | `Task` 툴      |
| **병렬 실행**    | 단독                         | 팀 병렬 가능   |
| **파일 권한**    | 제한 없음                    | 소유권 분리    |
| **주요 용도**    | 절차 자동화                  | 전문 작업 위임 |

---

## 2. 왜 필요한가

### 해결하는 과제

| 과제                           | 스킬/에이전트에 의한 해결                                              |
| ------------------------------ | ---------------------------------------------------------------------- |
| **개발 프로세스의 개인 의존**  | 파이프라인으로 절차를 표준화하여, 누가 실행해도 동일한 품질            |
| **사양과 구현의 괴리**         | Readiness Gate로 사양의 완전성을 검증한 후 구현 시작                   |
| **품질의 일관성**              | pre-quality-gate (make q.check)로 자동 품질 체크                       |
| **컨텍스트 전환 비용**         | feature-pilot이 작업 유형을 자동 판별하여 최적 파이프라인으로 라우팅   |
| **보안 누락**                  | pre-quality-gate (q.secrets / q.deps-audit)로 시크릿·의존성 보안 검사  |
| **문서-코드 불일치**           | feature-status-sync로 항상 문서와 코드를 동기화                        |

### 비용 최적화

모델 라우팅에 의해 작업의 복잡도에 따른 최적 모델 선택:

| 모델       | 용도                             | 상대 비용 |
| ---------- | -------------------------------- | :-------: |
| **Sonnet** | 탐색·검색·단순 체크              |    1x     |
| **Sonnet** | 표준 구현·문서 작성              |    3x     |
| **Opus**   | 아키텍처 설계·보안               |   10x     |

이를 통해 **토큰 비용 30-50% 절감** 실현.

---

## 3. 3계층 아키텍처

![3계층 아키텍처](diagrams/01-tier-architecture.svg)

스킬은 **3개의 계층 (Layer)**으로 분류됩니다. 전체 스킬 목록·수는 `deployed-skills.json` (SSOT) 를 참조하며, 아래는 대표 예시다.

### Layer 1: 오케스트레이터

**역할**: 사용자 요청의 단일 진입점. 하위 스킬을 자동으로 조정·실행한다.

| 스킬            | 설명                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| `feature-pilot` | **전체 개발 요청의 통합 진입점**. 작업 유형을 자동 판별하여 최적 파이프라인을 실행 |
| `decide`        | 라이프사이클 페이즈를 판정하여 다음 액션을 결정                                    |
| `discover`      | 통합 리서치 — "만들기 전에 알아야 할 것"을 체계적으로 해결                         |

### Layer 2: 파이프라인

**역할**: 특정 워크플로우를 실행. 복수 스텝으로 구성.

주요 스킬: `feature-architect`, `feature-spec-generator`, `feature-implementer`, `feature-wiring`, `bug-fix`, `priority-analyzer` 등.

### Layer 3: 유틸리티

**역할**: 단일 태스크를 실행. 독립적이며 직접 호출 가능.

주요 스킬: `create-pr`, `deploy`, `contract-codegen`, `sync-project-md` 등.

---

## 4. 메인 파이프라인

### 4.1 새 기능 개발 (NEW_FEATURE)

**가장 중요한 파이프라인**. 7단계로 설계부터 구현, 연동, 동기화까지 일관되게 실행.

![새 기능 개발 파이프라인](diagrams/02-new-feature-pipeline.svg)

#### 단계 상세

| Step | 스킬                     | 입력                     | 출력                    | 설명                           |
| :--: | ------------------------ | ------------------------ | ----------------------- | ------------------------------ |
|  1   | `feature-architect`      | 사용자 스토리 + Why      | CONTEXT.json            | 비즈니스 컨텍스트를 구조화     |
|  2   | `feature-spec-generator` | CONTEXT.json             | SPEC.md + screens/*.md  | 구현 가능한 기술 사양서 생성   |
|  3   | `ui-approval-gate`       | SPEC + screens           | wireframe.md            | 와이어프레임으로 UI 승인        |
|  4   | Readiness Gate (내장)    | 전체 문서                | Go/No-Go 판정           | 4페이즈 검증                   |
|  5   | `feature-implementer`    | SPEC.md                  | 코드 + 테스트           | TDD 방식으로 구현              |
|  6   | `feature-wiring`         | 구현 코드                | 연동된 앱               | 데이터+내비게이션 연결         |
|  7   | `feature-status-sync`    | Feature ID               | 업데이트된 문서         | CONTEXT.json + index.md 동기화 |

**핵심 원칙**:

1. `feature-architect`가 CONTEXT.json 생성의 **유일한 책임자**
2. Readiness Gate는 별도 스킬 호출 불필요 (**내장**)
3. `feature-wiring`은 **원자적** (전체 성공 or 전체 롤백)

---

### 4.2 기능 수정 (MODIFY_FEATURE)

기존 기능 변경 시 사용. SPEC 업데이트부터 시작한다는 점이 NEW_FEATURE와 다름.

```
spec-updater → ui-gate(변경 시) → Readiness Gate → implementer → wiring → status-sync
```

| Step | 스킬                   | 설명                                 |
| :--: | ---------------------- | ------------------------------------ |
|  1   | `feature-spec-updater` | 기존 SPEC을 로드하여 변경 차분 생성  |
|  2   | `ui-approval-gate`     | UI 변경이 있는 경우에만 실행         |
|  3   | Readiness Gate         | 수정된 SPEC을 검증                   |
|  4   | `feature-implementer`  | 변경된 FR만 구현                     |
|  5   | `feature-wiring`       | 새로운 Hooks/화면 추가 시에만        |
|  6   | `feature-status-sync`  | 상태를 동기화                        |

**주의**: 기존 SPEC이 있는 경우는 `feature-spec-generator`가 아닌 **`feature-spec-updater`**를 사용.

---

### 4.3 버그 수정 (BUG_FIX)

경량 파이프라인 (5단계). 근본 원인 특정을 최우선시.

```
재현·분석 → 근본 원인 특정 → 수정 구현 → 회귀 테스트 → status-sync
```

|  Phase  | 내용                                    | 원칙                     |
| :-----: | --------------------------------------- | ------------------------ |
| 1. 분석 | 증상 정리, 관련 코드 탐색, 로그 분석   | 증상만 보고 수정하지 않음 |
| 2. 원인 | 가설 수립, 코드 추적, 원인 검증        | 근본 원인을 반드시 특정   |
| 3. 수정 | 회귀 테스트 작성(Red) → 코드 수정(Green) | 테스트 없는 수정 금지    |
| 4. 검증 | 전체 테스트 통과 + analyze 통과        | 품질 게이트 필수         |
| 5. 동기화 | CONTEXT.json 상태 업데이트            | 문서 반영                |

**직접 호출** (`/bug-fix "증상"`)도 가능. 긴급 핫픽스 시 유효.

---

### 4.4 리서치·분석 (RESEARCH)

읽기 전용 파이프라인. 코드를 변경하지 않고 정보를 수집·분석한다.

| 스킬                          | 용도                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `research-gap-analyzer`       | 기존 리서치의 부족을 특정하고 Deep Research로 자동 보완 |
| `deep-research`               | OpenAI / Google Gemini의 Deep Research API로 심층 조사 |
| `competitive-tracker`         | 경쟁사 6개와 MECE 비교 분석                            |
| `market-intelligence-scanner` | 시장 트렌드 스캔으로 미정의 기능 후보 발견             |
| `priority-analyzer`           | RICE 모델로 기능의 우선순위 계산                       |
| `oss-analyzer`                | OSS의 설계 결정을 PDR 프레임워크로 분석                |

---

### 4.5 후보 변환 (CONVERT_CANDIDATE)

시장 분석에서 발견된 기능 후보를 공식 기능으로 변환하는 파이프라인.

```
후보 승인 → architect(--candidate) → spec-gen → ui-gate → Gate → impl → wiring → sync
```

`market-intelligence-scanner`가 생성한 후보(`scan-status.json`)에서 ICE 스코어 순으로 후보를 선택하여 일괄 또는 개별로 변환 가능.

---

## 5. 작업 유형 자동 판별

![작업 유형 라우팅](diagrams/03-work-type-routing.svg)

`feature-pilot`은 사용자의 자연어 요청에서 **키워드 + 컨텍스트**를 분석하여 최적 파이프라인을 자동 선택합니다.

### 키워드 매핑

| 키워드                              | → 작업 유형       |
| ----------------------------------- | ----------------- |
| "새 기능", "추가해", "만들어"       | NEW_FEATURE       |
| "수정", "변경", "개선"              | MODIFY_FEATURE    |
| "버그", "에러", "작동 안 함"        | BUG_FIX           |
| "조사", "리서치", "분석"            | RESEARCH          |
| "후보 승인", "convert"              | CONVERT_CANDIDATE |
| "SPEC만", "문서만"                  | DOCS_ONLY         |

### 추가 컨텍스트 판정

키워드만으로 판정할 수 없는 경우, 다음을 자동 확인:

1. **기존 SPEC 유무** — 있으면 MODIFY, 없으면 NEW
2. **에러 메시지 유무** — 있으면 BUG_FIX
3. **후보 ID 언급** — 있으면 CONVERT_CANDIDATE

### 동점 시 우선순위

```
BUG_FIX > REVERT > CONVERT > MODIFY > NEW_FEATURE
```

(버그 수정이 최우선)

---

## 6. 스킬 목록과 상세

> 전체 스킬 목록·수는 `deployed-skills.json` (SSOT)를 참조 — 아래는 대표 항목이다.

### 6.1 Layer 1: 오케스트레이터

#### feature-pilot (v9.0)

| 항목               | 내용                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **역할**           | 전체 개발 요청의 단일 진입점                                                                                                 |
| **트리거**         | "새 기능", "버그", "수정", "구현해" 등                                                                                       |
| **호출하는 스킬**  | architect, spec-gen, spec-updater, ui-gate, implementer, wiring, bug-fix, status-sync, priority-analyzer, pre-quality-gate  |
| **특징**           | 작업 유형 자동 판별, Readiness Gate 내장, 7문 상한 규칙, Feature Characteristics 기반 자율성 제어                             |
| **ESP**            | v2.0 적용 완료                                                                                                               |

#### decide

| 항목               | 내용                                                          |
| ------------------ | ------------------------------------------------------------- |
| **역할**           | 프로덕트 라이프사이클 페이즈를 판정하여 다음 액션을 결정      |
| **트리거**         | "뭘 해야 해", "다음 판단은", "의사결정"                       |
| **특징**           | 페이즈별 의사결정 프레임워크 실행 + Signal-Driven Discovery   |
| **출력**           | 현재 페이즈 판정 + 권장 액션                                  |

#### discover

| 항목               | 내용                                                                |
| ------------------ | ------------------------------------------------------------------- |
| **역할**           | 통합 리서치 — "만들기 전에 알아야 할 것"을 체계적으로 해결          |
| **트리거**         | "통합 리서치", "리서치 갭 점검"                                     |
| **특징**           | 3-Tier Evidence 모델 적용 — 모든 리서치 산출물에 근거 등급 부여     |
| **출력**           | 근거 등급이 부여된 리서치 산출물                                    |

---

### 6.2 Layer 2: 파이프라인

| 스킬                       | 역할                              | 입력                     | 출력                          |
| -------------------------- | --------------------------------- | ------------------------ | ----------------------------- |
| **feature-architect**      | CONTEXT.json 생성 (유일한 책임자) | 사용자 스토리 + Why      | CONTEXT.json                  |
| **feature-spec-generator** | SPEC.md + Screen 문서 생성        | CONTEXT.json             | SPEC.md, screens/*.md         |
| **feature-spec-updater**   | 기존 SPEC 수정                    | 기존 SPEC + 변경 요청    | 수정 SPEC + diff              |
| **ui-approval-gate**       | UI 와이어프레임 승인              | SPEC + screens           | wireframe.md + 승인 판정      |
| **feature-implementer**    | TDD 방식 코드 구현                | SPEC.md                  | 프로덕션 + 테스트 코드        |
| **feature-wiring**         | 데이터 + 내비게이션 통합 연동     | 구현 코드                | 연동된 앱 (원자적)            |
| **feature-status-sync**    | CONTEXT.json ↔ index.md 동기화    | Feature ID               | 업데이트된 문서               |
| **bug-fix**                | 버그 분석 + TDD 수정              | 버그 증상                | 수정 코드 + 회귀 테스트       |
| **priority-analyzer**      | RICE 모델로 우선도 계산           | CONTEXT.json             | priority 섹션 업데이트        |
| **pre-quality-gate**       | 품질 검증 게이트                  | 없음                     | analyze + test 결과           |

---

### 6.3 Layer 3: 유틸리티

| 스킬                               | 역할                                | 트리거 예시                |
| ---------------------------------- | ----------------------------------- | -------------------------- |
| **create-pr**                      | Worktree 격리 GitHub Flow PR 생성   | "PR 만들어", "ship"        |
| **deploy**                         | Multi-Cloud 애플리케이션 배포       | "배포", "deploy"           |
| **contract-codegen**               | 계약 기반 코드 생성                 | "계약 코드 생성"           |
| **contract-tester**                | 계약 테스트 실행                    | "계약 테스트"              |
| **spec-validator**                 | SPEC의 JSON Schema 검증             | "SPEC 검증"                |
| **feature-doctor**                 | CONTEXT.json 불일치 자동 복구       | "context 망가졌어"         |
| **deep-explain**                   | 대상에 대한 구조화된 심층 분석      | "deep-explain", "설명해"   |
| **manual-generator**               | Diataxis 기반 매뉴얼 생성·갱신      | "매뉴얼 생성"              |
| **ai-model-advisor**               | AI 모델 선택 자문                   | "어떤 모델 쓸까"           |
| **glossary-updater**               | 용어집 자동 업데이트                | "용어집 업데이트"          |
| **sync-project-md**                | CLAUDE.md 자동 업데이트             | "CLAUDE.md 업데이트"       |
| **skill-health-check** (ESP)       | 스킬 거버넌스 자동 감사             | "헬스 체크"                |
| **app-review-analyzer**            | 앱 스토어 리뷰 분석                 | "리뷰 분석"                |

---

## 7. 에이전트 목록과 상세

![에이전트 목록](diagrams/04-agents-overview.svg)

> 전체 에이전트는 `.claude/agents/`를 참조 — 아래는 대표 항목이다.

### 빌드·수정 에이전트

| 에이전트                  | 담당 영역                                       |
| ------------------------- | ----------------------------------------------- |
| **build-error-resolver**  | 빌드 에러 진단 및 해결                          |
| **rust-build-resolver**   | Rust 빌드 에러 해결                             |
| **refactor-cleaner**      | 리팩터링 후 잔재 정리                           |
| **test-writer**           | Unit Test / Helper / Fixture 작성 (RED phase)  |
| **tdd-guide**             | TDD 사이클 가이드                              |
| **e2e-runner**            | E2E 테스트 실행                                |

### 품질·리뷰 에이전트

| 에이전트                  | 담당 영역                                       |
| ------------------------- | ----------------------------------------------- |
| **code-audit**            | 안정성 + 보안 + 성능의 통합 품질 검사          |
| **code-reviewer**         | 코드 스타일·베스트 프랙티스 리뷰               |
| **security-reviewer**     | 보안 취약점 리뷰                               |
| **database-reviewer**     | 데이터베이스 스키마·쿼리 리뷰                  |
| **design-reviewer-live**  | UI/디자인 라이브 리뷰                          |

### 언어별 리뷰어

| 에이전트                                                                                                            | 담당 영역             |
| ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **cpp-reviewer**, **go-reviewer**, **java-reviewer**, **kotlin-reviewer**, **python-reviewer**, **rust-reviewer**, **typescript-reviewer**, **flutter-reviewer** | 언어·프레임워크별 코드 리뷰 |

### 문서·감사 에이전트

| 에이전트                       | 담당 영역                            |
| ------------------------------ | ------------------------------------ |
| **doc-updater**                | 코드 변경과 문서의 정합성 갱신       |
| **docs-gap-filler**            | 누락 문서의 자동 생성·보완           |
| **diagram-generator**          | 기술 다이어그램 생성                 |
| **todo-debt-tracker**          | TODO/FIXME/HACK 추적 및 우선도 분류  |
| **project-health-auditor**     | 프로젝트 전체의 건전성 감사          |
| **pipeline-harness-auditor**   | 파이프라인 하니스 감사               |
| **pipeline-self-audit**        | 파이프라인 자기 감사                 |

---

## 8. 실행 자동화

> 실행 모드(web-qa / turbo / persistent)는 제거되었습니다. 자동화는 `@agent:` 커맨드(Cron/CI)와 훅 시스템으로 수행합니다 — 상세는 [agent-commands.md](../../agent-commands.md). 품질 검사는 `pre-quality-gate`(`make q.check`)를 단일 패스로 실행하며, 자동 반복 루프는 없습니다.

---

## 9. 품질 보증 메커니즘

### Readiness Gate (4페이즈 검증)

구현 시작 전에 SPEC의 완전성을 검증하는 **내장 게이트**.

| Phase | 검증 내용                              | 실패 시           |
| :---: | -------------------------------------- | ----------------- |
|   0   | JSON 문법, 필수 필드, 스키마           | 즉시 No-Go        |
|   1   | 상위 계약 (who/trigger/value)          | No-Go → SPEC 수정 |
|   2   | 코어5 (API/모델/상태/네비/에러)        | No-Go → SPEC 수정 |
|   3   | 구현 안전성 (BLOCKING 0 / TODO 0)      | Conditional Go    |

### Enforced Skill Pattern (ESP v2.0)

중요 스킬에 적용되는 **강제 프로토콜**.

```
✈️ Pre-flight Checklist → 스킬 실행 → 🛬 Post-flight Checklist
```

| 요소          | 설명                                 | 위반 시            |
| ------------- | ------------------------------------ | ------------------ |
| Pre-flight    | 실행 전 체크리스트 출력              | CRITICAL: 즉시 중단 |
| Model Routing | Task 호출 시 model 파라미터 필수     | HIGH: 재실행       |
| Post-flight   | 완료 전 검증 실행                    | HIGH: 검증 실행    |

**적용 스킬**: `feature-pilot`, `pre-quality-gate`, `skill-health-check`

### Evidence Freshness (검증 캐시)

| 검증 유형     | 유효 시간 | 무효화 조건           |
| ------------- | :-------: | --------------------- |
| lint/analyze  |  30분     | `src/**/*` 변경 시    |
| test          |  30분     | `test/**/*` 변경 시   |
| secrets/deps (q.secrets/q.deps-audit) |  1시간    | `infra/**` 변경 시    |
| build         |  1시간    | `package.json` 변경 시 |

---

## 10. 유스케이스 모음

### 유스케이스 1: 새 기능을 처음부터 개발

**시나리오**: "사용자가 저장한 항목을 관리할 수 있는 대시보드 기능이 필요"

```
사용자: "대시보드 기능 만들어"

→ feature-pilot이 NEW_FEATURE로 판정
  → Step 1: feature-architect → CONTEXT.json 생성
  → Step 2: feature-spec-generator → SPEC.md + 화면 정의
  → Step 3: ui-approval-gate → 와이어프레임으로 확인
  → Step 4: Readiness Gate → Go 판정
  → Step 5: feature-implementer → TDD로 코드 구현
  → Step 6: feature-wiring → 앱에 통합
  → Step 7: feature-status-sync → 문서 업데이트

→ 완료 ✅
```

### 유스케이스 2: 기존 기능의 버그 수정

**시나리오**: "설정 화면에서 알림이 발송되지 않음"

```
사용자: "설정 화면에서 알림이 발송되지 않는 버그 수정해"

→ feature-pilot이 BUG_FIX로 판정
  → /bug-fix "설정 화면 알림 발송 안 됨"
    → Phase 1: 코드 탐색으로 알림 관련 파일 특정
    → Phase 2: 근본 원인: async/await의 타이밍 문제
    → Phase 3: 회귀 테스트 작성 → 코드 수정
    → Phase 4: 전체 테스트 통과 확인

→ 완료 ✅
```

### 유스케이스 3: 경쟁사 분석에서 기능 후보 생성

**시나리오**: "경쟁 앱과 비교하여 부족한 기능을 찾고 싶다"

```
사용자: "경쟁사와 비교하여 갭을 분석해"

→ /competitive-tracker로 포트폴리오 비교
  → 경쟁사 6개 × MECE 프레임워크
  → 갭 리포트 생성

→ /market-intelligence-scanner로 스캔
  → 후보 기능 목록 생성 (ICE 스코어 포함)

→ 사용자: "ICE 7.0 이상의 후보 전부 승인해"
  → feature-pilot이 CONVERT_CANDIDATE로 처리
  → 각 후보를 공식 기능으로 변환
```

### 유스케이스 4: 품질을 철저하게 검사

**시나리오**: "릴리스 전에 전체 품질을 확인하고 싶다"

```
사용자: "품질 검사 돌려"

→ /pre-quality-gate 실행 (make q.check 단일 패스)
  → 빌드 → analyze → 테스트
  → q.secrets: 시크릿 누출 없음 ✓
  → q.deps-audit: 의존성 보안 검사 ✓
  → 전체 통과 ✅
```

---

## 11. 거버넌스와 라이프사이클

### 스킬의 라이프사이클

```
Draft → Active → Stable → Deprecated → Archived
  ↓        ↓                    ↑
Rejected  Maintenance ─────────┘
```

| 상태        | 설명              | 표시             |
| ----------- | ----------------- | ---------------- |
| Draft       | 개발 중           | `🚧 DRAFT`       |
| Active      | 정상 운용 중      | (표시 없음)      |
| Stable      | 6개월+ 수정 없음  | `✅ STABLE`      |
| Maintenance | 문제 있어 수정 중 | `🔧 MAINTENANCE` |
| Deprecated  | 대안 있어 비권장  | `⚠️ DEPRECATED`  |
| Archived    | 삭제됨            | 폴더 삭제        |

### MANIFEST.json

Layer 1-2의 핵심 스킬은 `MANIFEST.json`으로 메타데이터를 관리:

```json
{
  "schema_version": 2,
  "skill_id": "feature-pilot",
  "tier": 1,
  "skill_version": "9.0.0",
  "public_api": {
    "invokable": true,
    "trigger_keywords": ["새 기능", "버그", "수정"]
  },
  "calls": ["feature-architect", "feature-spec-generator", ...],
  "called_by": []
}
```

### 정기 감사

| 빈도   | 내용                                                         |
| ------ | ------------------------------------------------------------ |
| 월간   | MANIFEST 스키마 검증, 의존 관계 정합성 확인                  |
| 분기   | 스킬 인벤토리 업데이트, 미사용 스킬 특정, 메트릭스 리뷰      |

---

## 참고 링크

| 문서                   | 위치                                          |
| ---------------------- | --------------------------------------------- |
| 스킬 거버넌스          | `.claude/skills/GOVERNANCE.md`                |
| 스킬 디렉토리          | `.claude/skills/README.md`                    |
| feature-pilot 상세     | `.claude/skills/feature-pilot/docs/README.md` |
| ESP 규칙               | `docs/development/esp-rules.md`               |
| 스킬 자동 라우팅       | `docs/development/skill-auto-routing.md`      |
| 모델 라우팅            | `docs/development/model-routing.md`           |

---

> **이 문서는 {{PROJECT_NAME}} 프로젝트의 AI 주도 개발 에코시스템의 포괄적 레퍼런스입니다. 새로운 스킬이나 에이전트가 추가된 경우에는 이 문서도 업데이트해 주세요.**
