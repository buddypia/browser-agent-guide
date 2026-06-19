---
name: pre-ship-quality-advisor
description: |
  PR 생성 직전, 변경 size 에 따라 코드 품질 도구(`/code-review` / `code-standards-aligner` / `final-review`) 사용을 추천하는 advisor 스킬.
  강제 X — 권고만. /create-pr ship-worktree / ship-feature 호출 직전에 자동 또는 수동 발동.
  Claude Code 외 CLI (Gemini CLI, Codex 등) 에서는 포터블 동등 스킬 (`code-standards-aligner`) 호출을 안내한다.
  "PR 직전 점검", "ship 전 체크", "품질 advisor", "pre-ship review", "quality check" 등의 요청으로 트리거된다.
---

## `/pre-ship-quality-advisor` — Pre-Ship Quality Advisor

`/create-pr` 호출 직전, 현재 변경 size 를 측정하여 적절한 코드 품질 도구를 추천한다.

**핵심 원칙**: 강제 X. 권고만. 사용자 결정 존중 (R-CM-016 Rule 10 User Sovereignty 정합).

## Trigger

다음 시점에 발동한다:

- `/create-pr ship-worktree` / `ship-feature` 호출 직전
- 사용자가 "PR 직전 점검", "ship 전 체크", "품질 advisor" 등 자연어 요청
- worktree 안 commit 완료 후 사용자가 push/PR 의사를 표현한 시점

`worktree-shipping-guard` (R-CM-030, Stop hook) 가 BLOCK 한 직후, R-CM-030 Pre-Ship Human Review Panel 작성 **이전에** 본 advisor 를 1회 권고하는 것을 권장한다 (강제 X).

## Not For / Boundaries

| 상황 | 처리 |
|------|------|
| 도구 자동 실행 | ❌ — 본 advisor 는 권고만, 실제 실행은 사용자 또는 후속 스킬 |
| 코드 수정 | ❌ — Read-Only advisor. 실제 수정은 `/code-review --fix` (Claude Code) 또는 `code-standards-aligner` (포터블) 가 담당 |
| 게이트 강제 | ❌ — 사용자가 "스킵" 선택 시 즉시 통과 |
| 테스트 실행 | ❌ — `final-review` 또는 `pre-quality-gate` 가 담당 |
| 비-Claude-Code CLI 에서 자동 invoke | ❌ — 포터블 동등 스킬 (`code-standards-aligner`) 호출로 fallback |

## Decision Logic (Size-Based Hybrid)

변경 size 를 측정 후 아래 tier 별 권고를 출력한다. **Claude Code 권고** 는 Anthropic 환경 우선, **포터블 동등** 은 어떤 CLI 에서도 동작.

| Tier | 변경 size | Claude Code 권고 | 포터블 동등 (모든 CLI) | 권고 강도 |
|------|----------|-----------------|---------------------|----------|
| **T-S (Small)** | ≤ 3 파일 + ≤ 100 LOC | `/code-review --fix` | `code-standards-aligner` (자율 표준 정합) | Passive (출력만) |
| **T-M (Medium)** | 4-10 파일 또는 100-500 LOC | `/code-review --fix` → `final-review` | `code-standards-aligner` → `final-review` | Active (AskUserQuestion 컨펌) |
| **T-L (Large)** | > 10 파일 또는 > 500 LOC | `/code-review high --fix` → `final-review` | `code-standards-aligner` → `final-review` | Active (AskUserQuestion 컨펌) |
| **모든 Tier** | (공통) | `final-review` 가 PR 직전 GO/NO-GO 게이트 | (동일) | Passive 알림 |
| **Verdict 강화 (옵션)** | substantial 변경 | `/code-review high` (correctness bugs broader coverage, review-only) | (Claude Code 전용) | Passive 추가 권고 |

**Trivial 예외 (R-CM-030 정합)**: 다음 모두 충족 시 본 advisor 자체 SKIP 가능 — 변경 파일 ≤ 3 + LOC ≤ 50 + 코드 영향 0 (문서/주석/whitespace 전용). 의심 시 풀 advisor 가 default.

## Phase 1: Detect Change Size

```bash
# worktree 안 또는 staged 변경 size 측정
git diff --stat HEAD                  # uncommitted 변경
git diff --stat origin/main..HEAD     # 미머지 commit
```

추출 정보:
- `files_changed`: 변경 파일 수
- `loc_changed`: insertions + deletions 합산
- `code_only`: 실행 코드 변경 존재 여부 (hook/script/test/.mjs/.ts/.tsx/.py 등)

## Phase 2: Tool Recommendation

Tier 결정 후 다음 형식으로 권고 출력 (Claude Code 환경):

```
## Pre-Ship Quality Advisor

**변경 측정**: <files_changed> 파일, <loc_changed> LOC, code_only=<true|false>
**Tier**: <T-S | T-M | T-L>

### 권고 순서

1. **`/code-review --fix`** — Claude Code 빌트인 simplification + correctness 통합 (effort default medium).
   - T-L 은 `/code-review high --fix` (broader coverage).
   - 호출: `/code-review --fix` 또는 `/code-review high --fix`
2. **final-review** — Read-Only 게이트 + 테스트 실행 + GO/NO-GO JSON
   - 호출: `/final-review`
3. (옵션) **/code-review high** — 적용 없는 추가 correctness verdict (review-only)
   - 호출: `/code-review high` (substantial 변경 default), `/code-review medium` (빠른 회전), `--comment` 옵션으로 PR 인라인 코멘트 가능

### 다음 단계

→ 도구 실행 후 `/create-pr ship-worktree` 진행
→ 또는 권고 스킵 후 직행
```

**T-M / T-L 의 active 권고**: AskUserQuestion 으로 "advisor 실행 / 스킵 / 매뉴얼 체크리스트만 보기" 3지선다 제시.

## Phase 3: Portable Skill Routing (Non-Claude-Code CLIs)

Claude Code 외 CLI (Gemini CLI, Codex, OpenAI CLI 등) 환경에서는 본 advisor 가 Claude Code 빌트인 `/code-review` 를 호출할 수 없다. 대신 brief2dev 자체에 배포된 **포터블 동등 스킬** 을 호출한다.

| Claude Code 전용 도구 | 포터블 동등 스킬 (CLI 비의존) | 호출 방법 |
|---------------------|---------------------------|----------|
| `/code-review --fix` (simplification + correctness 통합, 2026-05-27 사용자 결정으로 `/simplify` 폐기 + `simplifit` deprecate 후 단일 진입점) | **`code-standards-aligner`** (자율 표준 정합 — simplification 차원 동등) | `/code-standards-aligner` 또는 `<CLI> "@.claude/skills/code-standards-aligner/SKILL.md 읽고 실행"` |
| `/code-review high` (correctness verdict, review-only) | (포터블 동등 부재 — 다른 CLI 의 자체 review 도구 또는 `pre-quality-gate` Makefile q.check 사용) | (Claude Code 전용) |
| `final-review` (이미 brief2dev 자체 스킬) | (동일 — `final-review`) | `/final-review` |

포터블 스킬은 markdown SKILL.md 형식이라 Gemini CLI / Codex / OpenAI CLI 등 어떤 CLI 환경에서도 같은 워크플로 적용 가능. 자세한 항목 카탈로그:
- `.claude/skills/code-standards-aligner/SKILL.md` (프로젝트 표준 정합 5 차원)
- `.claude/skills/final-review/SKILL.md` (8축 평가 + JSON GO/NO-GO 핸드오프)
- `.claude/skills/pre-quality-gate/SKILL.md` (Makefile q.check 정량 검증, CLI agnostic verdict fallback)

## CLI 환경 감지

```bash
# Claude Code 감지 (CLAUDECODE 환경변수)
[ -n "$CLAUDECODE" ] && echo "claude-code" || echo "other-cli"
```

| 환경 | 권고 형태 |
|------|----------|
| Claude Code | Phase 2 (Claude Code 빌트인 `/code-review --fix` 권고) — 포터블 스킬도 동일하게 동작 가능 |
| 기타 CLI (Gemini / Codex / OpenAI 등) | Phase 3 (포터블 스킬 호출 — `code-standards-aligner` / `final-review` / `pre-quality-gate`) |

## Pre-flight Checklist

| ID | 항목 | 필수 | 담당 |
|----|------|------|------|
| PF-001 | 변경 size 측정 (`git diff --stat`) | ✅ | advisor |
| PF-002 | code_only 판정 (실행 코드 변경 존재 여부) | ✅ | advisor |
| PF-003 | CLI 환경 감지 (CLAUDECODE 환경변수) | ✅ | advisor |
| PF-004 | Tier 결정 (T-S / T-M / T-L) | ✅ | advisor |

## Post-flight Checklist

| ID | 항목 | 필수 |
|----|------|------|
| POF-001 | 권고 출력 완료 (Tier + 도구 우선순위 + 호출 명령) | ✅ |
| POF-002 | T-M/T-L 의 경우 AskUserQuestion 컨펌 받음 | ✅ |
| POF-003 | 비-Claude-Code CLI 시 포터블 스킬 라우팅 안내 (`code-standards-aligner`) | ✅ |
| POF-004 | 사용자 결정 (실행/스킵) 명시 기록 | ✅ |

## Maintenance

- **Boundary (R-CM-028)**: boundary-uniform — 본 스킬은 관점 1 (brief2dev 자체 거버넌스/룰/스킬/hook 변경) + 관점 2 (scaffold 내부 feature/bug-fix) 양쪽에서 동일 의미로 사용. 분기 메커니즘 불필요. 양 관점 모두 "PR 직전 코드 품질 도구 사용 권고" 라는 동일 목적. 단, 권고 대상 도구는 R-CM-030 Rule 8 의 simplification 단계 boundary-divergent 전환에 따라 환경별로 다르다 (Claude Code = `/code-review --fix`, Codex/Gemini = `code-standards-aligner`/`codex:rescue`/`gemini`).
- **Sources**:
  - 사용자 결정: 2026-05-10 conversation (initial advisor design)
  - 사용자 결정: 2026-05-27 — Claude Code 빌트인 `/simplify` 완전 폐기 + `/code-review --fix` 가 simplification + correctness 통합 단일 진입점. `simplifit` 스킬 deprecate. simplification 1순위 도구 = `/code-review --fix` (Claude Code) / `code-standards-aligner` (포터블)
  - `final-review`: `.claude/skills/final-review/SKILL.md`
  - R-CM-018 (Skill Authoring Discipline), R-CM-019 (Doc Hygiene), R-CM-028 (Two-Perspective Boundary), R-CM-030 (Worktree Auto-Ship Pre-Ship Human Review Panel), R-CM-009 (Command Portability), R-CM-016 Rule 10 (User Sovereignty)
- **관련 도구**:
  - `/code-review [low|medium|high|max] [--fix|--comment]` — Claude Code 빌트인. simplification + reuse/efficiency + correctness 통합. `--fix` = 적용, `--comment` = PR 인라인 코멘트, default = review-only. Claude Code 전용
  - `code-standards-aligner` — brief2dev 포터블 스킬 (`/code-standards-aligner`). 프로젝트 표준 정합 자율 리팩터링. CLI 비의존
  - `final-review` — brief2dev 스킬 (`/final-review`). 8축 평가 + JSON GO/NO-GO 핸드오프
  - `pre-quality-gate` — brief2dev 스킬 (`/pre-quality-gate`, Makefile q.check 정량 검증). CLI agnostic verdict fallback
  - `/create-pr ship-worktree` — 본 advisor 의 후속 호출 대상
- **Last updated**: 2026-05-27
- **Known limits**:
  - `/code-review` 는 Claude Code 전용 — 기타 CLI 는 포터블 동등 스킬 (`code-standards-aligner`) + verdict fallback (`pre-quality-gate`) 호출
  - 본 advisor 자체는 도구 실행 X — 권고만. 실행 책임은 사용자/AI 후속 호출
  - Tier threshold (3 파일 / 100 LOC / 500 LOC) 는 휴리스틱. 도메인별 조정 가능
