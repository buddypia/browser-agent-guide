# 프로젝트 라이프사이클 전체 가이드

> 스크래치 개발부터 릴리스 운영까지 — AI 기반 템플릿 에코시스템의 완전한 맵

> ⚠️ **관점 안내 (R-CM-028 boundary, 2026-05-16 검증)**
>
> 본 문서의 6-Phase 라이프사이클 (Phase 0 초기화 → Phase 6 운영) 은 **관점 2 (생성된 scaffold 프로젝트)** 시각이다. brief2dev 자체 (관점 1) 는 별도의 8-stage 파이프라인 — `intake → market_research → mvp_scoping → platform_decision → stack_selection → infra_design → scaffolding → output_gate` — 로 동작한다 (SSOT: `.claude/pipelines/brief2dev.yaml`).
>
> 다음 항목은 SSOT 와 일치하지 않을 수 있으므로 SSOT 참조 우선:
> - 품질 게이트 / 훅 / CI/CD 섹션 — `Makefile` (q.critical / q.check / q.ci-mirror) + `.github/workflows/quality-gate.yml` + `.claude/settings.json`
> - 스킬·에이전트 카운트 — `.claude/skills/project-scaffolder/references/deployed-skills.json` + `.claude/agents/MANIFEST.json`
> - "템플릿 변수 치환 {{PROJECT_NAME}}" 워크플로 — scaffold 산출 컨벤션이며, brief2dev 자체는 worktree+stage handoff 흐름이다.

---

## 목차

1. [전체 개요](#1-전체-개요)
2. [Phase 0: 프로젝트 초기화](#2-phase-0-프로젝트-초기화)
3. [Phase 1: Discovery (무엇을 만들지 결정)](#3-phase-1-discovery무엇을-만들지-결정)
4. [Phase 2: Design (설계)](#4-phase-2-design설계)
5. [Phase 3: Develop (구현)](#5-phase-3-develop구현)
6. [Phase 4: Verify (검증)](#6-phase-4-verify검증)
7. [Phase 5: Release (릴리스)](#7-phase-5-release릴리스)
8. [Phase 6: Operate (운영)](#8-phase-6-operate운영)
9. [개발 파이프라인 상세](#9-개발-파이프라인-상세)
10. [품질 게이트 시스템](#10-품질-게이트-시스템)
11. [스킬 및 에이전트 체계](#11-스킬-및-에이전트-체계)
12. [훅 자동화 시스템](#12-훅-자동화-시스템)
13. [CI/CD 파이프라인](#13-cicd-파이프라인)
14. [SSOT (단일 진실 공급원) 맵](#14-ssot단일-진실-공급원-맵)
15. [부록: 명령어 레퍼런스](#15-부록-명령어-레퍼런스)

---

## 1. 전체 개요

### 라이프사이클 전체도

```
Phase 0        Phase 1          Phase 2          Phase 3         Phase 4        Phase 5       Phase 6
초기화    →    Discovery    →    Design     →    Develop    →    Verify    →    Release   →   Operate
                                                                                               ↓
템플릿         무엇을 만들지   어떻게 만들지   구현하기        검증하기       릴리스        운영 및 개선
셋업           결정하기        설계하기        테스트하기      품질 보증      배포              ↓
                                                                                          Phase 1로 돌아감
                                                                                         (지속적 개선 루프)
```

### 3가지 기반 원칙

| 원칙 | 설명 | 핵심 파일 |
|------|------|-------------|
| **Feature-First Architecture** | 기능 단위로 디렉토리를 분할하고, 관심사의 분리를 철저히 함 | `tsconfig.json`, ESLint rules |
| **Contract-First Development** | API 사양을 먼저 정의하고, 타입 안전한 클라이언트/목 자동 생성 | `src/shared/contracts/` |
| **Pipeline as Code** | 개발 플로우를 YAML로 정의하여 재현 가능하고 투명하게 | `.claude/pipelines/*.yaml` |

### 아키텍처 개관

```
routes/ ↔ features/ ↔ shared/
(UI)     (도메인)     (공통 유틸리티)
       ↓            ↓            ↓
      [상태 관리를 통한 반응형 결합]
            ↓
       [Contract Layer]
     Zod Schema + 타입 안전 API Client
            ↓
       [Infrastructure]
     AWS CDK / GCP Pulumi (듀얼 클라우드)
```

---

## 2. Phase 0: 프로젝트 초기화

### 2.1 템플릿에서 프로젝트 생성

```bash
# 1. 템플릿 클론
git clone <template-repo> my-project
cd my-project

# 2. 템플릿 변수 치환
#    {{PROJECT_NAME}} → 실제 프로젝트명
#    {{PLATFORM}}     → web / mobile / api
#    {{FRAMEWORK}}    → Next.js / React / Vue 등

# 3. 의존성 설치 (Node.js >= 22.0.0 필수)
npm install

# 4. 초기 검증
make q.check
```

### 2.2 초기 파일 구성

```
my-project/
├── CLAUDE.md                 # AI 운영 가이드라인 (SSOT)
├── AGENTS.md                 # → CLAUDE.md로 리다이렉트
├── Makefile                  # 품질 게이트 SSOT
├── package.json              # npm 스크립트 정의
├── tsconfig.json             # TypeScript 설정 (strict: true)
├── vitest.config.ts          # 테스트 설정 (v8 coverage)
├── eslint.config.mjs         # Lint + Security 규칙
├── .claude/
│   ├── settings.json         # AI 설정 + 훅 정의
│   ├── hooks/                # 자동화 훅 (18개)
│   ├── scripts/              # 유틸리티 스크립트
│   ├── skills/               # AI 스킬 (50+)
│   ├── pipelines/            # 파이프라인 정의 (3개)
│   ├── agents/               # 에이전트 정의
│   └── notepads/             # 세션 메모
├── src/
│   ├── config/env.ts         # 환경 변수 관리
│   ├── shared/               # 공통 모듈
│   │   ├── contracts/        # Contract-First 기반
│   │   ├── components/       # 공유 UI 컴포넌트
│   │   ├── hooks/            # 공유 커스텀 훅
│   │   ├── lib/              # 유틸리티 (logger, errors)
│   │   ├── types/            # 공통 타입 정의
│   │   └── constants/        # 상수 (messages.ts)
│   ├── features/             # 기능 모듈 (여기에 기능 추가)
│   └── routes/               # 라우팅
├── tests/                    # 테스트
├── docs/                     # 프로젝트 문서
│   ├── architecture/         # ADR, 인프라 계약
│   ├── development/          # 개발 가이드
│   ├── features/             # 기능 사양 (SPEC, BRIEF)
│   └── _templates/           # 문서 템플릿
├── infra/                    # 인프라 (AWS CDK / GCP Pulumi)
│   ├── aws/
│   ├── gcp/
│   ├── local/
│   └── shared/
└── .github/workflows/        # CI/CD (5 워크플로우)
```

### 2.3 환경 변수 설정

```bash
# .env.example을 복사하여 편집
cp .env.example .env.local

# 프로덕션용
cp .env.example .env.production
```

### 2.4 Git 초기화

```bash
git init
git checkout -b main
git add .
git commit -m "feat: initial project setup from template ecosystem"
```

---

## 3. Phase 1: Discovery (무엇을 만들지 결정)

### 3.1 의사 결정 플로우

```
"무엇을 만들어야 할까?"
       ↓
  ┌─────────────────────────────────────┐
  │  /decide (Tier 1 Orchestrator)      │
  │  → 페이즈 판정 + 프레임워크 선택    │
  └─────────────────────────────────────┘
       ↓
  ┌───────────┬────────────┬──────────────┐
  │ 경쟁 분석 │ 시장 조사  │ 사용자 조사  │
  └───────────┴────────────┴──────────────┘
       ↓
  ┌─────────────────────────────────────┐
  │  /prioritize (RICE 스코어링)        │
  │  → 우선순위 결정                    │
  └─────────────────────────────────────┘
```

### 3.2 사용하는 스킬

| 스킬 | 명령어 예시 | 출력 |
|--------|-----------|------|
| `decide` | "다음에 뭘 해야 할까?" | 페이즈 판정 + 추천 액션 |
| `competitive-tracker` | "경쟁사 비교해줘" | 6사 MECE 비교 매트릭스 |
| `market-intelligence-scanner` | "시장 트렌드 스캔" | 기능 후보 리스트 |
| `research-pilot` | "이 기능을 리서치해줘" | OST + Double Diamond 검증 결과 |
| `deep-research` | "딥 리서치" | OpenAI/Gemini 심층 분석 리포트 |
| `priority-analyzer` | "우선순위 분석" | RICE 스코어 포함 우선순위표 |
| `analyze-what-to-build` | "다음에 뭘 만들까?" | 통합 파이프라인 결과 |

### 3.3 Shape Up 파이프라인

```
Stage 1: signal-collector     → signal-digest.json (시그널 수집)
Stage 2: opportunity-mapper   → opportunities.json (JTBD + ODI 스코어)
Stage 3: betting-table        → betting-round.json (Appetite 판단)
Stage 4: 가설 검증            → 검증 결과
Stage 5: mvp-launcher         → MVP 스코프 + 메트릭스
Stage 6: 통합                 → 최종 판단
```

### 3.4 Phase 1의 산출물

- `docs/research/` — 리서치 리포트 묶음
- `docs/features/candidates/` — 기능 후보 리스트
- 우선순위가 부여된 백로그

---

## 4. Phase 2: Design (설계)

### 4.1 설계 플로우

```
요구사항 정의
   ↓
┌──────────────────────────────────────────────┐
│ feature-architect (Tier 2)                    │
│ → BRIEF.md + CONTEXT.json 생성               │
└──────────────────────────────────────────────┘
   ↓
┌──────────────────────────────────────────────┐
│ Discovery (Feature Characteristics에 따라)     │
│ domain-modeler (도메인 복잡도 높음)           │
│ + architecture-selector (아키텍처 변경 시)   │
│ + system-designer (C4 모델, 필요 시)         │
└──────────────────────────────────────────────┘
   ↓
┌──────────────────────────────────────────────┐
│ feature-spec-generator (Tier 2)               │
│ → SPEC-XXX.md + screens/*.md 생성            │
└──────────────────────────────────────────────┘
   ↓
┌──────────────────────────────────────────────┐
│ ui-approval-gate (사용자 승인 필수)           │
│ → SVG 와이어프레임 + Before/After 비교       │
└──────────────────────────────────────────────┘
   ↓
┌──────────────────────────────────────────────┐
│ Readiness Gate (자동 검증)                    │
│ → 스키마/계약/안전성 체크                    │
└──────────────────────────────────────────────┘
```

### 4.2 설계 깊이 (Feature Characteristics 기반)

AI가 Feature Characteristics를 분석하여 설계 깊이를 자동 결정합니다.

| 특성 | 설계 스킬 | 필요 산출물 |
|------|-----------|-----------|
| 기본 | architect → spec | BRIEF, CONTEXT, SPEC, screens |
| 도메인 복잡도 높음 | + domain-modeler | + DOMAIN-MODEL.md |
| 아키텍처 변경 필요 | + architecture-selector + system-designer | + ADR, C4 System Design |

### 4.3 주요 산출물

| 산출물 | 위치 | 설명 |
|--------|------|------|
| BRIEF.md | `docs/features/XXX/` | 비즈니스 목표, 사용자 스토리, 완료 조건 |
| CONTEXT.json | `docs/features/XXX/` | 기능 진행의 SSOT, 상태 관리 |
| SPEC-XXX.md | `docs/features/XXX/` | 기술 사양서 (FR 정의, API, 에러 핸들링) |
| screens/*.md | `docs/features/XXX/screens/` | 화면 사양 (Element ID, 레이아웃) |
| DOMAIN-MODEL.md | `docs/features/XXX/` | 도메인 모델 (M 이상) |
| ADR-*.md | `docs/architecture/adr/` | 아키텍처 결정 기록 (L 이상) |

### 4.4 문서 참조 우선순위

```
SPEC-XXX.md > screens/*.md > PRD-XXX.md
(기술 계약)    (UI 사양)      (비즈니스 목표)
```

---

## 5. Phase 3: Develop (구현)

### 5.1 개발 플로우 전체

```
┌──────────────────────────────────────────────┐
│ feature-pilot (Tier 1 통합 엔트리 포인트)     │
│ → 작업 타입 자동 판별                         │
└──────────────────────────────────────────────┘
         ↓                    ↓                  ↓
  ┌────────────┐    ┌────────────────┐   ┌─────────────┐
  │ NEW_FEATURE │    │ MODIFY_FEATURE │   │ BUG_FIX     │
  │ Pipeline    │    │ Pipeline       │   │ Pipeline    │
  └────────────┘    └────────────────┘   └─────────────┘
```

### 5.2 NEW_FEATURE 파이프라인 (스크래치 개발)

```yaml
# .claude/pipelines/new-feature.yaml

단일 파이프라인 (Feature Characteristics 기반 깊이 조절):
  architect → constraints_load → discovery → spec → ui_approval
  → readiness_gate → implement → wiring → status_sync
  → quality_gate → dod_verification
```

### 5.3 구현의 계층 순서 (TDD)

```
Batch 1: Data Layer (병렬 가능)
  ├── TypeScript Type + Zod Schema
  └── API Layer

Batch 2: Logic Layer
  └── Custom Hook

Batch 3: Presentation Layer
  └── Component

Batch 4: Test Layer
  ├── API Test
  ├── Hook Test
  └── Component Test
```

### 5.4 Feature-First 디렉토리 구조

새 기능 추가 시 아래 구조로 `src/features/` 하위에 생성:

```
src/features/[feature-name]/
├── components/       # 기능 전용 UI 컴포넌트
├── hooks/            # 기능 전용 커스텀 훅
├── api/              # API 호출/데이터 페치
├── types/            # 기능 전용 타입 정의
└── index.ts          # 배럴 파일 (공개 API)
```

### 5.5 의존 관계 규칙

```
허용:
  feature/ui → feature/hooks → feature/api
  feature → shared
  feature → feature (배럴 파일 index.ts를 통해서만)

금지:
  shared → feature            ← 역방향 의존
  feature 내부 직접 import    ← 배럴 파일 우회
  순환 의존 (A → B → A)      ← 순환 참조
```

### 5.6 Contract-First 워크플로우

```
1. SPEC 정의 → API 사양 기술 (JSON Schema)
       ↓
2. contract-codegen → Zod 스키마 + 타입 + API 클라이언트 + MSW 목 자동 생성
       ↓
3. contract-tester → 계약 테스트 자동 생성 및 실행
       ↓
4. 구현 → 생성된 타입/클라이언트를 사용하여 안전하게 구현
```

### 5.7 MODIFY_FEATURE 파이프라인

```yaml
단일 파이프라인 (Feature Characteristics 기반 깊이 조절):
  spec_update → impact_analysis → ui_approval → readiness_gate → implement
  → wiring → status_sync → quality_gate → dod_verification
```

특징: 수정된 FR만 구현 스코프로 하며, 기존 코드는 유지.

### 5.8 BUG_FIX 파이프라인

```yaml
analyze → root_cause → regression_test(Red) → fix(Green) → quality_gate → dod_verification
```

특징: TDD Red-Green 사이클, 최소 변경, 근본 원인 리포트 필수.

### 5.9 실행 모드

| 모드 | 명령어 | 용도 |
|--------|---------|------|
| **일반** | 그대로 지시 | 표준적인 개발 작업 |
| **자동 라우팅** | `@agent:quality-gate` 등 | Cron/CI 에서 스킬 직접 기동 |

### 5.10 모델 라우팅

```
Sonnet  → 탐색, 검색, 단순 수정 (파일 5개 이하)
Sonnet → 표준 구현, 문서 작성 (파일 6-20개)
Opus   → 아키텍처 설계, 보안 리뷰 (파일 20개 이상)

자동 폴백: 3회 연속 에러 → 상위 모델로 자동 승격
```

---

## 6. Phase 4: Verify (검증)

### 6.1 품질 게이트 체계

```
┌─────────────────────────────────────────────────────────────┐
│                    make q.check (통합 실행)                   │
├─────────────────────────────────────────────────────────────┤
│ Critical (실패 시 커밋/PR 불가)                               │
│  ├── q.format.check      Prettier 포맷                      │
│  ├── q.analyze            ESLint + Security 스캔             │
│  ├── q.typecheck          TypeScript 엄격 타입 체크          │
│  ├── q.ai-contracts       AI Contract JSON 검증              │
│  ├── q.check-architecture Feature-First 의존성 검증          │
│  ├── q.contract-test      계약 테스트                        │
│  ├── q.test               유닛/통합 테스트                   │
│  └── q.build              TypeScript 빌드                    │
├─────────────────────────────────────────────────────────────┤
│ Major (경고 표시, 진행 가능)                                  │
│  ├── q.test-exists        테스트 파일 존재 확인              │
│  ├── q.coverage           커버리지 임계값 검증 (40%)         │
│  ├── q.security-audit     npm audit (high 이상)              │
│  └── q.license-check      GPL/AGPL 감염성 라이선스 검출     │
├─────────────────────────────────────────────────────────────┤
│ Info (참고 정보만)                                            │
│  └── 의존 관계 리포트 등                                     │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 DoD (완료 조건) 검증

각 파이프라인의 최종 단계 `dod_verification`에서 자동 검증:

| ID | 검증 내용 | 검증 방법 |
|----|---------|---------|
| DoD-FT-01 | 전체 FR의 DoD 통과 | `progress.percentage == 100` |
| DoD-FT-02 | Critical 전부 통과 | `make q.check exit 0` |
| DoD-FT-03 | SPEC 준수 | AI가 SPEC vs 구현을 비교 |
| DoD-FT-04 | Feature-First 준수 | `make q.check-architecture exit 0` |
| DoD-FT-05 | 테스트 추가 | `make q.test-exists exit 0` |
| DoD-FT-06 | TypeScript strict 에러 없음 | `make q.build exit 0` |
| DoD-FT-07 | i18n 하드코딩 없음 | AI 스캔 |
| DoD-FT-08 | 한국어 JSDoc | AI 스캔 |
| DoD-FT-09 | UI Flow 정합성 | `make q.ui-flow exit 0` |
| DoD-FT-10 | CONTEXT.json Done | CONTEXT.json 확인 |

### 6.3 Evidence Freshness (검증 캐시)

```
lint          → 30분 유효 (src/**/* 변경 시 무효화)
test          → 30분 유효 (test/**/*, src/**/* 변경 시 무효화)
security-scan → 1시간 유효 (.env* 변경 시 무효화)
build         → 1시간 유효 (src/**/*, package.json 변경 시 무효화)
```

### 6.4 보안 검증

| 검증 | 도구 | 대상 |
|------|--------|------|
| 정적 분석 | eslint-plugin-security | eval, unsafe-regex, bidi 등 |
| 의존성 감사 | npm audit | high 이상의 취약점 |
| 시크릿 스캔 | TruffleHog (CI) | 코드 내 시크릿 |
| 의존성 리뷰 | GitHub Dependency Review (CI) | PR 시 신규 의존성 |
| 라이선스 검사 | npm license check | GPL/AGPL 감염성 라이선스 |

---

## 7. Phase 5: Release (릴리스)

### 7.1 브랜치 전략 (GitHub Flow)

```
main (프로덕션, 항상 배포 가능) ← squash merge PR ← feature/xxx (기능 브랜치)
                                                  ← fix/xxx (버그 수정 브랜치)
```

`develop` 브랜치는 사용하지 않는다 (R-CM-008).

### 7.2 릴리스 플로우

```
Step 1: 기능 브랜치에서 개발 완료
   git checkout -b feature/xxx main
   # ... 개발 ...
   git push -u origin feature/xxx

Step 2: main으로 PR 생성 / squash merge
   gh pr create --base main --head feature/xxx
   # Quality Gate CI 자동 실행 → Critical 전부 통과 필수
   # 코드 리뷰 → squash merge

Step 3: 자동 릴리스 (release.yml)
   # main push 트리거
   # 1. 품질 게이트 실행
   # 2. 시맨틱 버전 자동 산출
   #    - feat: → minor
   #    - fix: → patch
   #    - BREAKING CHANGE: → major
   # 3. Changelog 자동 생성
   # 4. GitHub Release 생성
```

### 7.3 커밋 메시지 규약

```
feat:      새 기능 추가
fix:       버그 수정
refactor:  리팩터링
test:      테스트 추가/수정
docs:      문서 변경
chore:     빌드/CI/설정 변경
```

### 7.4 PR의 자동 체크

PR 생성 시 아래가 자동 실행됩니다:

```
quality-gate.yml:
  ├── [Critical] Format → TypeCheck → AI Contracts → Lint+Security
  │                → Architecture → Contract Tests → Tests → Build
  ├── [Major]    Test Existence, Coverage, Security Audit
  ├── [Security] TruffleHog + Dependency Review
  └── [SPEC]     feature 라벨이 붙은 PR만 SPEC 검증
```

---

## 8. Phase 6: Operate (운영)

### 8.1 배포

```
┌─────────────────────────────────────────────┐
│ deploy.yml (수동 트리거)                     │
│                                              │
│ 입력:                                        │
│   environment: dev / staging / prod          │
│   provider: auto / aws / gcp                 │
│                                              │
│ 플로우:                                      │
│   1. Quality Gate 실행                       │
│   2. Contract Tests 실행                     │
│   3. Provider 자동 판별                      │
│      (infrastructure-contract.json에서)      │
│   4. AWS → CDK deploy / GCP → Pulumi up     │
│   5. Health Check 실행                       │
└─────────────────────────────────────────────┘
```

### 8.2 인프라 관리

```bash
# IaC 차분 확인
make infra.plan ENV=dev

# IaC 배포
make infra.deploy ENV=staging

# 인프라 계약 검증
make contract.validate

# 헬스 체크
make app.health
```

**infrastructure-contract.json**이 인프라 구성의 SSOT:

| 섹션 | 기본값 |
|-----------|-------------|
| Compute | Node.js LTS, 0.5 vCPU, 1GB RAM, 1-4 instances |
| Database | PostgreSQL 16, small, 7일 백업 |
| Storage | Object Storage (S3/GCS) |
| Monitoring | 구조화 로그 (30일 보존) |
| Networking | CDN 활성화, SSL 필수 |
| Cost | 월 $100 예산 |

### 8.3 듀얼 클라우드 대응

```
infra/
├── aws/       # AWS CDK (TypeScript)
│   ├── bin/   # CDK 애플리케이션
│   └── lib/   # CDK 스택
├── gcp/       # GCP Pulumi (TypeScript)
│   ├── stacks/
│   └── config/
├── local/     # 로컬 개발 (docker-compose)
└── shared/    # 공유 스크립트
    ├── deploy.sh
    ├── health-check.sh
    ├── rollback.sh
    └── env-loader.sh
```

### 8.4 롤백

```bash
# 애플리케이션 롤백
make app.rollback

# 인프라 롤백
make infra.destroy ENV=dev  # 확인 필요
```

### 8.5 지속적 개선 루프

```
운영 중 발견 사항 / 사용자 피드백 / 버그 리포트
       ↓
Phase 1 (Discovery)로 돌아감
  - competitive-tracker: 경쟁사 변화 추적
  - signal-collector: 사용자 시그널 수집
  - app-review-analyzer: 앱 리뷰 분석
       ↓
Phase 2-5 재실행
       ↓
릴리스 → 운영 지속
```

---

## 9. 개발 파이프라인 상세

### 9.1 파이프라인 정의 파일

| 파이프라인 | 파일 | 용도 |
|-------------|---------|------|
| NEW_FEATURE | `.claude/pipelines/new-feature.yaml` | 새 기능의 스크래치 개발 |
| MODIFY_FEATURE | `.claude/pipelines/modify-feature.yaml` | 기존 기능 수정 |
| BUG_FIX | `.claude/pipelines/bug-fix.yaml` | 버그 수정 |

### 9.2 글로벌 설정 (전 파이프라인 공통)

```yaml
evidence_caching: true                    # 검증 캐시 활성화
context_json_ssot: true                   # CONTEXT.json이 SSOT
model_fallback:
  enabled: true
  order: [sonnet, opus]            # 비용 최적화 순
  max_failures_before_escalation: 3       # 3회 실패 시 상위 모델로
```

### 9.3 실패 시 보상 액션

각 단계에 `compensation`이 정의되어 있어, 실패 시:

1. **리트라이**: 설정 횟수까지 동일 단계를 재실행
2. **자동 수정**: `make q.fix` 등의 자동 수정 시도
3. **롤백**: 산출물을 삭제하고 이전 단계로 복귀
4. **모델 에스컬레이션**: Sonnet → Sonnet → Opus

---

## 10. 품질 게이트 시스템

### 10.1 실행 방법

```bash
# 전체 품질 검사 (커밋 전 필수)
make q.check

# 자동 수정 후 재검사
make q.fix

# 개별 실행
make q.format.check       # Prettier
make q.analyze            # ESLint + Security
make q.typecheck          # TypeScript
make q.check-architecture # Feature-First 검증
make q.test               # 테스트
make q.build              # 빌드
make q.coverage           # 커버리지 (40%)
make q.contract-test      # 계약 테스트
make q.security-audit     # npm audit
make q.license-check      # 라이선스 검사
```

### 10.2 npm 스크립트

```bash
make q.typecheck          # tsc --noEmit
make q.lint               # ESLint
make q.lint --fix         # ESLint 자동 수정
make q.test               # Vitest
make q.test -- --unit         # 유닛 테스트만
make q.test -- --integration  # 통합 테스트만
make q.test -- --contract     # 계약 테스트
make q.test -- --coverage     # 커버리지 검증
make q.format             # Prettier 포맷
make q.check              # 전체 검증 일괄
```

### 10.3 커버리지 임계값

| 메트릭스 | 임계값 |
|-----------|------|
| Statements | 40% |
| Branches | 30% |
| Functions | 40% |
| Lines | 40% |

---

## 11. 스킬 및 에이전트 체계

### 11.1 3계층 스킬 등급제

```
Tier 1: Orchestrator (통합 제어)
  ├── feature-pilot        전체 개발 요청의 단일 엔트리 포인트
  ├── decide               의사 결정 프레임워크
  └── analyze-what-to-build 경쟁 분석 파이프라인

Tier 2: Pipeline (워크플로우)
  ├── feature-architect      BRIEF + CONTEXT 생성
  ├── feature-spec-generator SPEC + Screen 생성
  ├── feature-spec-updater   기존 SPEC 수정
  ├── feature-implementer    TDD 구현
  ├── feature-wiring         통합 검증
  ├── feature-status-sync    상태 동기화
  ├── domain-modeler         DDD Event Storming
  ├── architecture-selector  ATAM Lite 평가
  ├── system-designer        C4 모델 설계
  ├── spec-validator         SPEC 검증
  ├── contract-codegen       계약 코드 생성
  ├── contract-tester        계약 테스트
  ├── priority-analyzer      RICE 분석
  ├── deep-research          심층 리서치
  ├── research-pilot         Product Discovery
  ├── mvp-launcher           MVP 의사 결정
  ├── shape-up-pipeline      Signal-Driven Discovery
  └── ... (기타 다수)

Tier 3: Utility (단일 태스크)
  ├── feature-doctor       CONTEXT 복구
  ├── skill-health-check   거버넌스 감사
  ├── sync-project-md       CLAUDE.md 동기화
  ├── glossary-updater     용어집 갱신
  ├── deep-explain         심층 분석
  ├── final-review         최종 품질 리뷰
  ├── bug-fix              버그 수정 실행
  └── ... (기타 다수)
```

### 11.2 에이전트

| 에이전트 | 용도 |
|-------------|------|
| `Explore` | 코드베이스 탐색 |
| `Plan` | 구현 계획 설계 |
| `code-audit` | 코드 품질 통합 검사 |
| `todo-debt-tracker` | 기술 부채 추적 |
| `project-health-auditor` | 프로젝트 건전성 감사 |
| `diagram-generator` | 다이어그램 생성 |

---

## 12. 훅 자동화 시스템

### 12.1 라이프사이클 훅

```
[세션 시작]
  → session-start.mjs        Wisdom 로드, 상태 복원

[사용자 입력]
  → keyword-router.mjs       스킬 자동 기동 판정 + @agent 라우팅

[도구 실행 전] (Edit/Write 시)
  → feature-boundary-guard    기능 경계 검증
  → import-architecture-guard Feature-First 의존성 검증
  → adr-compliance-guard      ADR 준수 확인
  → design-guard              디자인 사양 준수
  → esp-consistency-guard     ESP 규칙 준수
  → docs-consistency-guard    문서 동기화

[도구 실행 후]
  → edit-error-recovery.mjs  에러 자동 복구 (Edit 시)
  → web-format.mjs           포맷 자동 적용 (Write/Edit 시)

[Bash 실행 시]
  → destructive-git-guard    위험한 git 명령어 방지
  → commit-guard             커밋 검증

[정지 시]
  → feature-drift-guard      드리프트 검출
  → feature-sync-checker     동기화 확인

[컴팩트화 전]
  → compact-context-preserver 컨텍스트 유지

[세션 종료]
  → session-end               클린업
```

### 12.2 권한 제어

```json
{
  "deny": ["Bash(sudo:*)", "Bash(git reset:*)", "Bash(git rebase:*)"]
}
```

---

## 13. CI/CD 파이프라인

### 13.1 워크플로우 목록

| 워크플로우 | 파일 | 트리거 | 목적 |
|-------------|---------|---------|------|
| Quality Gate | `quality-gate.yml` | PR (main), workflow_dispatch | 품질 검증 |
| Deploy | `deploy.yml` | 수동 (workflow_dispatch) | 배포 |
| Release | `release.yml` | Push (main), 수동 | 릴리스 |
| Infra | `infra.yml` | PR (infra/ 변경 시) | IaC 차분 확인 |
| Contract Impact | `contract-impact.yml` | PR (contracts/ 변경 시) | 계약 영향 분석 |

### 13.2 전형적인 CI 플로우

```
feature/xxx 브랜치 → main으로 PR (GitHub Flow)
  ↓
quality-gate.yml 자동 실행
  ├── [Critical] Format → TypeCheck → Contracts → Lint → Architecture → Tests → Build
  ├── [Major] Test Existence, Coverage, Security Audit
  ├── [Security] TruffleHog, Dependency Review
  └── [SPEC] SPEC Validation (feature 라벨 시)
  ↓
전체 체크 통과 → squash merge → main
  ↓
release.yml (main push) → 시맨틱 버전 관리 → GitHub Release
  ↓
deploy.yml (수동 workflow_dispatch) → dev → staging → prod
```

---

## 14. SSOT (단일 진실 공급원) 맵

| 영역 | SSOT | 위치 |
|------|------|------|
| **AI 가이드라인** | CLAUDE.md | 프로젝트 루트 |
| **품질 게이트** | Makefile | 프로젝트 루트 |
| **인프라 구성** | infrastructure-contract.json | `docs/architecture/` |
| **기능 진행** | CONTEXT.json | `docs/features/XXX/` |
| **기술 사양** | SPEC-XXX.md | `docs/features/XXX/` |
| **파이프라인 정의** | *.yaml | `.claude/pipelines/` |
| **스킬 정의** | SKILL.md + MANIFEST.json | `.claude/skills/*/` |
| **의존성** | package.json | 프로젝트 루트 |
| **TypeScript 설정** | tsconfig.json | 프로젝트 루트 |
| **아키텍처 결정** | CURRENT.md | `docs/architecture/adr/` |

---

## 15. 부록: 명령어 레퍼런스

### 일상 개발 명령어

```bash
# 품질 체크 (커밋 전 필수)
make q.check

# 자동 수정 + 재체크
make q.fix

# 테스트 실행
make q.test
make q.test -- --watch          # 워치 모드

# 포맷
make q.format

# 전체 검증 일괄
make q.check
```

### SPEC / 계약 관련

```bash
# SPEC 검증
make spec.validate SPEC=001
make spec.validate-all

# 계약 코드 생성
make contract.codegen

# 계약 테스트
make contract.test
make q.test -- --contract

# 계약 밸리데이션
make contract.validate
```

### 인프라 / 배포

```bash
# 로컬 개발
docker-compose -f infra/local/docker-compose.yml up

# IaC 조작
make infra.plan ENV=dev
make infra.deploy ENV=staging

# 앱 배포
make app.deploy
make app.health
make app.rollback
```

### Git / 릴리스

```bash
# 브랜치 생성 (main에서 분기)
git checkout -b feature/xxx main

# 커밋
git add <specific-files>
git commit -m "feat: 새 기능 설명"

# PR 생성 (main 타겟, squash merge)
gh pr create --base main --head feature/xxx
```

### AI 스킬 호출 (자연어)

```
"새 기능 추가해줘"          → feature-pilot (NEW_FEATURE)
"버그 수정해줘"             → feature-pilot (BUG_FIX)
"SPEC 수정해줘"             → feature-spec-updater
"다음에 뭘 만들까?"         → analyze-what-to-build
"경쟁사 비교해줘"           → competitive-tracker
"딥 리서치"                 → deep-research
"우선순위 분석"             → priority-analyzer
"도메인 모델 생성"          → domain-modeler
"아키텍처 선정"             → architecture-selector
"시스템 설계"               → system-designer
"CONTEXT 복구"              → feature-doctor
"스킬 헬스 체크"            → skill-health-check
@agent:quality-gate         → pre-quality-gate (Makefile q.check)
/deep-explain [대상]        → deep-explain (심층 분석)
```

---

## 퀵 스타트 플로우 (요약)

첫 기능 개발 시 최단 플로우:

```
1. git checkout -b feature/my-feature main

2. "새 기능 추가해줘: [기능 설명]"
   → feature-pilot이 자동 기동
   → 특성 분석 → 파이프라인 자동 선택

3. AI가 자동으로 아래를 실행:
   a. BRIEF.md + CONTEXT.json 생성
   b. SPEC + Screen 생성
   c. UI 승인 게이트 (사용자 확인)
   d. Readiness Gate
   e. TDD 구현 (Type → API → Hook → Component → Test)
   f. 품질 게이트 (make q.check)
   g. DoD 검증

4. git add <files> && git commit -m "feat: 새 기능"

5. gh pr create --base main --head feature/my-feature  (또는 /create-pr)

6. CI 품질 게이트 통과 → squash merge

7. release.yml 자동 실행 → GitHub Release → deploy.yml (수동)
```

---

> **최종 갱신**: 2026-03-11
> **대상**: {{PROJECT_NAME}} 템플릿 에코시스템 v1.0.0
