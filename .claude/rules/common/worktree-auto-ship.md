---
paths:
  - ".claude/scripts/create-pr/**"
  - ".worktrees/**"
  - ".claude/hooks/worktree-shipping-guard.mjs"
  - ".claude/hooks/pre-ship-review-guard.mjs"
  - ".claude/hooks/worktree-review-report-guard.mjs"
  - ".claude/scripts/lib/review-report.mjs"
  - ".claude/scripts/mark-worktree-reviewed.mjs"
---
# Worktree Auto-Ship Rules

## ID: R-CM-030
## Severity: major
## Enforced by: worktree-shipping-guard, pre-ship-review-guard, worktree-review-report-guard
## Boundary: perspective1-only (관점1 전용 — deployed-assets.json#rules.never_deploy. R-CM-028 배포 분리)

### Purpose

R-CM-008 Rule 4-6 의 worktree 시작 강제에 **종료 단계 자동화**를 추가. AI 가 worktree 안에서 시스템 코드 변경을 수행했다면 최종 응답 전 반드시 commit 을 남기도록 강제하고, commit 한 작업은 사용자에게 PR/merge 진행 여부를 먼저 확인한 뒤 명시 컨펌이 있을 때만 `/create-pr ship-worktree` 로 squash merge + cleanup 까지 종결하도록 유도하여 WIP 방치/PR 미생성/미머지 worktree 누적을 차단한다.

`/create-pr` 스킬은 PLAN.md 검증 → push → 멱등 PR → squash merge → cleanup 까지 이미 자동이므로, hook 의 역할은 "AI 가 작업 종료 신호 (Stop) 를 보낼 때 사용자에게 진행 여부를 묻고, yes/진행 컨펌 후에만 ship 호출하도록 유도" 하는 것이다.

본 룰의 핵심 흐름(commit 의무 + ship 자동화 + Pre-Ship Human Review Panel)은 **boundary-uniform** 이나, Pre-Ship Quality Gate 의 **simplification 단계 + verdict 단계** 는 **boundary-divergent** 로 전환되었다 (사용자 결정 2026-05-27 — Claude Code 빌트인 `/code-review` 통합). 본 PR 의 적용 영역은 brief2dev 자체로 한정. scaffold target 배포는 별도 PR.

### 사용자 결정 (2026-05-10)

| 항목 | 결정 |
|------|------|
| 트리거 | worktree 안 uncommitted 변경 또는 commit + PR 미머지 시 BLOCK |
| PLAN.md 미완료 | `ship-worktree` 가 자체 거부 (data loss 방지) |
| pending/실패 시 | 한 번 시도 후 다음 Stop 통과 (5분 마커). 사용자 재진입 시 멱등 재시도 |
| hotfix branch | 면제 (R-CM-008 escape hatch 정합) |

### 사용자 결정 (2026-05-14) — Worktree Commit Requirement

| 항목 | 결정 |
|------|------|
| Commit 의무 | 시스템 코드 변경을 worktree 에서 수행한 경우 최종 응답 전 반드시 해당 worktree 안에서 commit |
| 완료 판정 | uncommitted 변경이 남아 있으면 작업 완료로 간주하지 않음 |
| Hook 강제 | `worktree-shipping-guard` 가 Stop 시 uncommitted 변경을 BLOCK |
| 예외 | 사용자가 명시적으로 WIP 보존/커밋 금지를 요청한 경우. user abort/context limit 은 기존처럼 passthrough |
| Stage 원칙 | 본인이 만든 변경만 stage/commit. 사용자 또는 다른 세션의 unrelated 변경은 포함 금지 |

### 사용자 결정 (2026-05-13 + 2026-05-27 갱신) — Pre-Ship Quality Gate

| 항목 | 결정 |
|------|------|
| Quality Gate 위치 | Pre-Ship Human Review Panel **이전** (ship-worktree 의 사전 조건) |
| Claude Code 분기 (simplification + correctness) | `/code-review --fix` (1순위 — 단일 진입점). 2026-05-27 사용자 결정으로 `/simplify` 폐기 + `/code-review` 가 simplification + reuse/efficiency + correctness 통합 |
| Codex / Gemini CLI 분기 (simplification) | `codex:rescue` 또는 `gemini` 자체 cleanup — 양 환경 동일 |
| Verdict 단계 — 관점 1 (brief2dev 자체) | `code-reviewer` Agent type (별도 Agent 스레드 호출, 독립 스킬 자산 없음 — `subagent_type: "code-reviewer"`) 또는 `pre-quality-gate` 스킬 (`.claude/skills/pre-quality-gate/`, Makefile q.check 실행). final-review 가 pipeline-boundary-guard 로 scaffold-only 차단되므로 대체. Confidence-filtered findings + Go/No-Go 판정 |
| Verdict 단계 — 관점 2 (scaffold target) | `final-review` 스킬 — multi-perspective 6 역할 + Go/No-Go |
| No-Go 처리 | create-pr 차단. 수정 → verdict 재실행 → Go 달성 후만 다음 단계 |
| Trivial 면제 | 문서 신설/대수정 / 코드 로직 변경이 아닌 단순 파일 수정 (typo / config value / 1-line 추가 등) |
| 강제 메커니즘 | prompt-level (자기 규율 1차). hook 자동 검출 없음 — Pre-Ship Human Review Panel "Decisions & Trade-offs" 섹션에 quality gate 결과 명시 의무로 보조 검증 |
| R-CM-028 boundary | **boundary-divergent** (배포 분리) — simplification + verdict 양 단계 모두 양 관점에서 다름 (2026-05-27 사용자 결정으로 simplification 단계도 divergent 전환) |

### Rules

1. **Stop hook BLOCK 조건**: 다음 모두 만족 시 Stop 차단 + AI 에게 사용자 PR/merge 컨펌을 먼저 받도록 유도한다. 컨펌 전 `/create-pr ship-worktree` 실행 금지.
   - 활성 worktree (`.worktrees/<branch>/`) 에 uncommitted 변경 ≥ 1 또는 `origin/main..HEAD` 미머지 commit ≥ 1
   - 해당 branch 가 `hotfix/*` / `hotfix-*` 가 아님
   - **해당 worktree 가 본 Stop 세션 소유 (R-CM-036 세션 소유권 필터)** — 타 세션/orphan worktree 는 차단 대상에서 제외
   - 미머지 commit 만 있는 경우: 시도 마커 (`.tmp/worktree-shipping-attempted-<branch>`) 가 신선 (5분 이내) 하지 않음
   - `.tmp/create-pr-active` 가 신선 (30분 이내) 하지 않음 (= /create-pr 진행 중 아님)

1.1. **세션 소유권 필터 (R-CM-036 정합 — 사용자 결정 2026-06-11)**: `worktree-shipping-guard` 는 `git worktree list` 의 모든 worktree 가 아니라 **본 Stop 세션이 소유한 worktree 만** 차단 대상에 포함한다. 멀티세션(병렬 Claude Code / Codex / Antigravity) 환경에서 A 세션 Stop 이 B 세션 worktree 를 차단하던 cross-session 오차단을 근본 차단한다.
   - **소유권 판정 (R-CM-036 2-Layer, Stop stdin `session_id` + `cwd` 사용)**: Layer 1 — `cwd` 가 그 worktree 내부면 owned (Codex/Antigravity 는 worktree 로 cd). Layer 2 — `.session-owner` 사이드카 === 현재 `session_id` 면 owned (Claude Code 는 cwd=main 고정이라 사이드카가 유일 신호). 사이드카 owner 불일치 = `other` (타 세션), 둘 다 미확정 = `orphan`.
   - **owned 만 candidate 진입**: `other` / `orphan` worktree 는 미완료 작업이 있어도 차단하지 않고 `not_owned` 로 분리하여 **stderr 알림** (silent drop 차단 — 다른 세션 WIP 가시화). uncommitted 변경이 있어도 타 소유면 차단하지 않는다 (본 세션이 만든 변경이 아니므로).
   - **orphan 정책 (AI default)**: 사이드카 부재 (수동 `git worktree add` / 타 CLI / 표준 진입점 미경유) 는 소유 미확정으로 보아 차단하지 않는다. 표준 진입점 `make wt.new` 는 `worktree-owner-tracker` 가 항상 사이드카를 남기므로 단일 세션의 정상 worktree 는 owned 판정된다. orphan 을 차단하면 타 CLI worktree(항상 orphan)가 cross-session 오차단을 재발시키므로, R-CM-036 Layer 2 의 orphan→passthrough 선례와 정합한다.
   - **공식 문서 근거**: `session_id` / `cwd` 는 모든 hook 이벤트 (Stop 포함) 공통 stdin 필드 (`https://code.claude.com/docs/en/hooks`).
   - **Fail-open**: `session_id` 부재 등 소유 판정 불가 시 orphan 처리 (차단 안 함) — R-CM-006 Rule 2 정합.
   - **회귀**: `tests/unit/worktree-shipping-guard.test.mjs` 의 `classifyOwnership` + `evaluate — R-CM-036 세션 소유권 필터` describe.

2. **Uncommitted 변경 우선 처리**: uncommitted 변경이 있는 worktree 는 ship 대상이 아니라 commit-required 대상이다. Stop hook 은 시도 마커를 생성하지 않고 계속 BLOCK 한다. AI 는 `git status --short` 로 범위를 확인한 뒤 본인이 만든 변경만 stage/commit 한다.

3. **단일 알림 정책 (5분 마커)**: clean worktree 에 미머지 commit 만 있는 경우 hook 이 BLOCK 시 알림 마커를 즉시 생성. 마커 신선 동안 (5분) 같은 branch worktree 재차단 X. 사용자가 yes/진행 컨펌하면 `mark-pre-ship-confirmed` 후 ship 호출. 사용자가 멈춤/수정 필요를 선택하면 그 결정을 존중하고 자동 ship 하지 않는다.

4. **멱등 재시도**: 5분 후 마커 만료 시 다음 Stop 에서 재차단. 사용자가 진행 컨펌한 뒤 실행하는 `/create-pr ship-worktree` 는 멱등 (open PR 재사용 + title/body 업데이트).

5. **escape hatch (hotfix)**: `hotfix/*` / `hotfix-*` 브랜치는 면제.

6. **Fail-Open**: hook 에러 / git worktree list 실패 / 정책 데이터 부재 → passthrough (R-CM-006 Rule 2 정합).

7. **사용자 abort / context limit 존중**: `stop_hook_active=true` 또는 context limit stop 시 즉시 passthrough. 사용자 명시 중단 권한이 자동화보다 우선.

8. **Pre-Ship Quality Gate 의무 (substantial 변경)**: ship-worktree 호출은 Pre-Ship Quality Gate 통과를 사전 조건으로 한다. Substantial 변경 시 다음 순서를 ship 호출 직전에 실행한다.

   **환경 분기 (Code Simplification + Correctness)**

   | 환경 | 호출 도구 | 역할 |
   |------|----------|------|
   | **Claude Code** | `/code-review --fix` (1순위) | 변경 코드의 correctness bugs + reuse / simplification / efficiency cleanups 통합 검토 + 인라인 적용. 2026-05-27 사용자 결정으로 `/simplify` 폐기 + `simplifit` 스킬 deprecate → `/code-review` 단일 진입점 |
   | **Codex CLI** | `codex:rescue` 또는 codex 자체 review | 두 번째 LLM 시각으로 cross-review (simplification 차원, correctness 는 verdict 단계에 위임) |
   | **Gemini CLI** | `gemini` 스킬 cleanup | 두 번째 LLM 시각으로 cross-review (simplification 차원) |

   각 환경 분기 모두 다음 단계 (verdict) 로 합류. 각 환경에서 simplification 도구 1 개만 선택 실행 (cross-LLM 다중 호출 강제 X).

   **코드 변경 0 시 simplification 단계 SKIP**: 변경이 룰 텍스트 / 문서 / retrospective / 주석 전용이고 실행 코드 (`.mjs` / `.ts` 등 로직) diff 0 이면 simplification 단계는 검토 대상 부재로 SKIP 한다. **verdict 단계 (2.b) 는 유지** — code-reviewer agent 가 룰/문서 변경의 cross-ref·정합도를 판정. Rule 10 Trivial 면제 (≤ 2 파일 + ≤ 20 LOC) 와 독립 — substantial 분량이어도 코드 로직 diff 0 이면 simplification 만 SKIP, verdict 는 의무. Pre-Ship Human Review Panel "Decisions & Trade-offs" 에 `/code-review --fix SKIP (사유: 코드 로직 diff 0)` 명시 의무 (silent SKIP 차단).

   **환경 감지 fallback 정책**: AI 가 실행 컨텍스트를 명시적으로 알 수 없는 경우 (env var / runtime probe 부재) **Claude Code 분기를 default 로 적용** — brief2dev 기본 실행 환경. Codex/Gemini CLI 환경은 해당 CLI 가 명시적으로 호출 컨텍스트를 알리거나, 사용자가 직접 환경을 선언한 경우에만 적용.

   **Verdict 단계 (boundary-divergent — R-CM-028)**

   | 관점 | Verdict 호출 대상 | 자산 위치 + 비고 |
   |------|-------------|------|
   | **관점 1 (brief2dev 자체)** | `code-reviewer` Agent type (별도 Agent 스레드) 또는 `pre-quality-gate` 스킬 | `code-reviewer` 는 독립 스킬 파일 부재 — Claude Code 의 `Agent(subagent_type: "code-reviewer")` Agent type 으로 호출 (CRITICAL→LOW 심각도 + Confidence > 80% 필터링). `pre-quality-gate` 는 `.claude/skills/pre-quality-gate/` (Makefile q.check 기반 정량 검증). `final-review` 는 pipeline-boundary-guard 의 `DEVELOPMENT_SKILLS` 셋에 등재되어 brief2dev 리포에서 차단되므로 사용 불가. Go/No-Go 판정 결과를 사용자가 받는다 |
   | **관점 2 (scaffold target)** | `final-review` 스킬 | `.claude/skills/final-review/SKILL.md` (scaffold target 배포). 8-Axis review + multi-perspective 6 역할 + Go/No-Go. scaffold target 코드 변경 시 정상 호출 |

   **Verdict 단계 환경 분기 (CLI-agnostic — Claude Code / Codex / Gemini)**

   `code-reviewer` Agent type 과 `final-review` skill 은 **Claude Code 전용** 호출 메커니즘 (각각 `Agent(subagent_type:...)` 와 Claude Code Skill 시스템). 다른 CLI 환경에서는 호출 불가. 본 룰은 CLI agnostic 으로 동작해야 하므로 environment-별 verdict fallback 을 명시한다.

   | 환경 | 관점 1 verdict 1순위 | 관점 1 verdict fallback | 관점 2 verdict |
   |------|---------------------|----------------------|----------------|
   | **Claude Code** | `code-reviewer` Agent type | `pre-quality-gate` 스킬 | `final-review` 스킬 |
   | **Codex CLI** | `codex` 자체 review (예: `codex review --files <diff>`) | `pre-quality-gate` 스킬 (Makefile q.check) | `pre-quality-gate` (Makefile) — `final-review` Claude Code skill 호출 불가 |
   | **Gemini CLI** | `gemini` 자체 review skill | `pre-quality-gate` 스킬 (Makefile q.check) | `pre-quality-gate` (Makefile) — `final-review` Claude Code skill 호출 불가 |

   **CLI agnostic 핵심**: `pre-quality-gate` 의 정량 검증 (Makefile q.check / validate-rules / audit-rule-enforcement / vitest) 은 **Bash 명령** 이라 모든 CLI 환경에서 동일하게 호출 가능. environment-1순위 verdict (Agent type / codex review / gemini skill) 가 호출 불가능한 경우 `pre-quality-gate` 가 보편 fallback 이며, 사용자 명시 "환경 1순위 verdict SKIP" 컨펌 없이 silently 우회 금지.

   **환경 감지 정책**: AI 가 자기 실행 environment 를 명시적으로 알 수 없는 경우 (env var / runtime probe 부재) 다음 순서로 처리.
   1. 사용자가 prompt 에 environment 를 명시 (예: "Codex 에서 작업 중") → 명시값 사용
   2. simplification 단계의 environment 분기 (Rule 8 본문) 와 동일 environment 가정 — Claude Code default
   3. environment 1순위 verdict 호출 시 도구 부재로 실패 → `pre-quality-gate` fallback + Pre-Ship Human Review Panel "Decisions & Trade-offs" 에 fallback 사유 명시

   **CLI-specific 차단 금지**: 환경 1순위 verdict 도구 부재를 이유로 Quality Gate **전체** SKIP 는 금지. fallback 으로 `pre-quality-gate` 의무 — "Codex 에는 code-reviewer agent 없으니 quality gate 통째로 SKIP" 같은 우회 = R-CM-016 Rule 10 (User Sovereignty) 위반 + Rule 8 anti-pattern.

   **Claude Code 환경 빌트인 abnormal 응답 fallback (사용자 결정 2026-05-23 — P0 cluster 회고 + 2026-05-27 갱신)**: Claude Code 환경 simplification 단계의 `/code-review --fix` 빌트인이 abnormal 응답 (예: 빈 응답 / hook 응답 가로채기 / unexpected exit) 시 silently SKIP 금지. fallback 순서: (1) `pre-quality-gate` 스킬 Bash 명령 (Makefile q.check 기반 정량 검증) 호출 시도, (2) main session AI 자가 review 도 fallback 으로 인정 — 단 Pre-Ship Human Review Panel "Decisions & Trade-offs" 섹션에 빌트인 abnormal 응답 + fallback 사용 사유 명시 의무. silently 우회 시 R-CM-024 (Mechanism Truthfulness) 위반 audit 누적.

   **Workflow (Substantial 변경, 관점 1 brief2dev 자체)**:

   ```
   1. 코드/문서 개발 완료 (worktree 안 commit ≥ 1)
   2. Pre-Ship Quality Gate
      a. /code-review --fix (Claude Code, simplification + correctness 1순위)
         OR codex:rescue (Codex)
         OR gemini (Gemini CLI)
      b. code-reviewer agent (또는 pre-quality-gate) — Go/No-Go 판정
         (Codex/Gemini 환경은 correctness 차원이 simplification 단계에 통합되지 않으므로 verdict 단계가 1차 correctness 게이트)
   3. verdict 분기
      - No-Go → ship 차단. 지적사항 수정 → 2.b 재실행
      - Go    → 다음 단계 (Pre-Ship Human Review Panel)
   4. Pre-Ship Human Review Panel (7섹션) + 사용자 컨펌
   5. /create-pr ship-worktree
   ```

   **Workflow (관점 2 scaffold target)**: 위 2.b 를 `final-review` 로 대체. 나머지 동일.

9. **Quality Gate 의 No-Go 차단 효과**: verdict (final-review 또는 code-reviewer / pre-quality-gate) 가 No-Go 판정 시 다음 단계 (Pre-Ship Human Review Panel + ship-worktree) 진행 금지. 지적사항을 수정한 후 verdict 를 재실행하여 Go 달성한 시점에만 다음 단계로 진행한다.

   - No-Go 상태에서 ship 시도는 R-CM-016 Rule 10 (User Sovereignty) 위반 — 사용자의 quality gate 결정을 silently 우회.
   - Pre-Ship Human Review Panel "Decisions & Trade-offs" 섹션에 verdict 판정 결과 (Go / verdict source skill / Quality Score 또는 issue count) 명시 의무.

10. **Quality Gate Trivial 면제 기준** (Rule 8 의 적용 제외 조건): 다음 3 조건 모두 충족 시 Pre-Ship Quality Gate (`/code-review --fix` + verdict) 를 SKIP 한다.

   | 조건 | 기준 |
   |------|------|
   | 변경 파일 수 | ≤ 2 |
   | 변경 LOC | ≤ 20 (insertions + deletions) |
   | 변경 성격 | non-substantive — typo / version bump / config value / whitespace / 1-line config 추가 등. **신규 룰 / 신규 섹션 / 새 hook / 코드 로직 변경 / 새 함수 = 즉시 disqualified** |

   조건 1 개라도 위반 → substantial → Pre-Ship Quality Gate 의무.

   **수치 출처 (정직 명시)**: 위 임계값 (≤ 2 파일 / ≤ 20 LOC) 은 사용자 명시 결정 부재 — AI default. 운영 중 false-positive (의무 발동인데 실질 trivial) 또는 false-negative (의무 면제인데 실질 substantial) 패턴 누적 시 사용자 컨펌 후 조정. Panel trivial (≤ 3 / ≤ 50) 도 동일하게 AI default 이며 사용자 결정 2026-05-10 으로 확정.

   **Pre-Ship Human Review Panel trivial 기준 (변경 파일 ≤ 3 + LOC ≤ 50 + 코드 영향 0) 과의 관계**:
   - Quality Gate trivial 은 Panel trivial 보다 **엄격하다** — Panel trivial 통과해도 Quality Gate 의무인 경우 가능
   - 의심 시 substantial 이 default

11. **자기 규율 1차 (정직 명시)**: hook 자동 강제 없음 — AI 가 Quality Gate 단계를 silently 우회 가능. 강제 메커니즘은 다음 2 단계로 보조 검증:
    - **Pre-Ship Human Review Panel "Decisions & Trade-offs" 섹션 의무**: verdict 판정 결과 + Quality Gate 실행 여부 (또는 trivial SKIP 사유) 명시
    - **사용자 retroactive 발견**: panel 에 quality gate 결과 누락 또는 거짓 시 R-CM-024 audit 누적 + R-CM-016 Rule 10 위반 retrospective 트리거

    Hook 자동 검출 도입은 본 룰의 prompt-level 운영 안정화 (≥ 4 주 + 위반 패턴 식별) 이후 R-CM-021 retrospective 통해 결정.

    **자기 규율 패턴 cross-ref**: 본 룰의 "hook 자동 강제 없음 → AI 자기 규율 + retroactive 발견" 구조는 Pre-Ship Human Review Panel 하단 "한계 (정직 명시)" 섹션의 마커 우회 한계 인정 패턴과 동일 구조 — Quality Gate 차원과 마커 차원의 같은 자기 규율 모델.

### Pre-Ship Human Review Panel (7섹션 양식 — 사용자 결정 패널 의무)

Stop hook 이 BLOCK 한 후 AI 가 `/create-pr ship-worktree` 를 호출하기 **직전에**, 다음 7섹션 의사결정 브리프를 사용자에게 제공해야 한다. 사용자가 명시적으로 "진행" 컨펌하기 전에 ship 호출 금지. 단독 질문("ship으로 PR을 머지하겠습니까?")은 merge 의사결정에 필요한 맥락을 제공하지 않으므로 컨펌으로 인정하지 않는다.

| 섹션 | 내용 |
|------|------|
| **Summary** | 무엇을 왜 수정했는지 3-5줄. 사용자 요청/버그 증상/기존 갭/해결 방향을 연결한다 |
| **Evidence** | commit 수, quality gate verdict, 테스트/품질 게이트 실행 명령과 결과, 미실행 검증과 사유. diff stat 은 `git diff origin/main...HEAD --stat` (triple-dot, merge-base 기준) 으로만 측정 |
| **Changed Files** | 변경된 파일 표: path, NEW/EDIT/DELETE, 라인 수, 역할, 수정 이유. 파일별 역할이 불명확하면 merge 판단 보류 |
| **File Structure** | 수정된 파일의 디렉터리 트리와 책임 경계. 새 파일/이동 파일/삭제 파일은 왜 그 위치가 맞는지 명시 |
| **Impact** | 다음 세션부터 변경되는 동작, 영향받는 시스템 영역 (코드 / 룰 / 문서 / hook / 데이터 SSOT / CI / 사용자 workflow), 면제 조건 |
| **Decisions & Trade-offs** | 사용자 명시 결정, AI default, 대안과 선택 이유, 품질 판정. "트레이드오프 없음" 이면 왜 없는지 근거를 쓴다 |
| **Risks, Follow-up & Rollback** | 주의사항, 우려, 미해결 질문, 향후 제안 액션, deferred 항목 처리 (R-CM-033 followup-debt 필요 여부), 롤백 옵션 (일시 ECC_DISABLED_HOOKS / 영구 PR revert) |

**사용자 컨펌**: "진행" / "멈춤" / "수정 필요" 3지선다. Claude Code native 에서는 AskUserQuestion 을 사용하고, Codex/Gemini/`BRIEF2DEV_DECISION_MODE=file` 에서는 Decision Exchange 또는 일반 채팅에서 같은 선택지를 명시 확인한다. 영구 위임 의도 표현이 있어도 **메타 PR 또는 hard-to-reverse 변경 시** 패널 의무는 유지. 컨펌 후에만 ship 호출.

**Trivial 정량 기준** (7섹션 양식 간소화 허용 조건): 다음 3 조건 모두 충족 시에만 trivial.

| 조건 | 기준 |
|------|------|
| 변경 파일 수 | ≤ 3 |
| 변경 LOC | ≤ 50 (insertions + deletions) |
| 코드 영향 | 0 (문서/주석/whitespace 전용. hook/script/test 변경 시 즉시 trivial 부적격) |

조건 1+ 위반 시 풀 양식. 의심 시 풀 양식이 default.

### 자동 강제: pre-ship-review-guard (PreToolUse Bash)

`node .claude/scripts/create-pr/ops.mjs ship-(worktree|feature)` 패턴 검출. `.tmp/pre-ship-review-confirmed-<branch>` 마커 freshness (10분) 검사.

- 마커 부재/stale → `permissionDecision: "deny"` + 7섹션 Human Review Panel + 사용자 컨펌 + 마커 생성 절차 안내
- 마커 신선 → passthrough
- error → passthrough (R-CM-006 Rule 2 fail-open)

**마커 생성 책임 (AI)**: 7섹션 Human Review Panel 작성 → 사용자 컨펌 받은 직후, 표준 스크립트로 마커 생성 (raw `touch` 금지 — quality 라벨 누락 + 경로/safeBranch 정규화 오류 위험):

```bash
node .claude/scripts/mark-pre-ship-confirmed.mjs <branch> --quality <agent_go|self_review_pass|trivial_skip>
```

**스크립트 경로 SSOT**: `.claude/scripts/mark-pre-ship-confirmed.mjs` — `create-pr/` 하위가 아니다 (경로 추측 금지). 내부적으로 `.tmp/pre-ship-review-confirmed-<safeBranch>` 를 생성하므로 AI 가 직접 path/slash 치환을 하지 않는다.

10분 freshness window 안에 ship 호출. 만료 후 재호출 시 스크립트 재실행 (재컨펌).

**branch 키 규칙**: `--worktree <path>` 인자에서 branch 추출 (`inferBranchFromWorktreePath` 사용) → 슬래시 `__` 치환 → 마커 키 산출.
- 두 worktree path 컨벤션 모두 같은 branch 로 정규화된다:
  - `.worktrees/feature/foo` → branch `feature/foo` → 키 `feature__foo`
  - `.worktrees/feature__foo` (escape 변형) → branch `feature/foo` → 키 `feature__foo`
- escape reverse 는 KNOWN_BRANCH_PREFIXES (`feature`, `fix`, `hotfix`, `chore`, `refactor`, `docs`, `test`) 로 시작하는 segment 에만 적용. 그 외 (`.worktrees/random__name`) 는 fallback 으로 path-as-branch 처리.
- `ship-feature` 모드 (worktree 인자 부재) 는 `staged` 키.
- 회귀 차단: `tests/unit/pre-ship-review-guard.test.mjs` 의 `inferBranchFromWorktreePath` describe block.

**한계 (정직 명시)**: 본 hook(pre-ship-review-guard) 은 마커 *존재*만 검사 — AI 가 패널 없이 마커 생성 후 ship 호출 시 우회 가능. 단, **본문 출력 자체의 강제는 `worktree-review-report-guard` (Stop) 가 REVIEW.md 본문 검증으로 보강**한다 (아래 절). "패널 + 컨펌 → 마커 → ship" 인과 정직성의 *컨펌→마커* 구간은 여전히 AI 자기 규율이 1차이나, *본문 출력* 구간은 결정론적으로 강제된다. 우회 발생 시 사용자 retroactive 발견 + R-CM-024 audit 누적.

### 자동 강제: worktree-review-report-guard (Stop)

`pre-ship-review-guard` 가 닫지 못한 갭("패널 없이 마커 생성") 중 **본문 출력** 차원을 결정론적으로 닫는다. 본 세션이 소유한 worktree 에 commit 된 작업이 있는데 사람이 리뷰할 구조화 레포트(`REVIEW.md`)가 부재/미완성/stale 이면 Stop 을 BLOCK 한다.

- **검증 대상 artifact**: `<worktree>/.tmp/worktree-<safeBranch>/REVIEW.md` (위치 SSOT: `.claude/scripts/lib/review-report.mjs`). `.tmp/` 는 `.gitignore` 로 머지 누출이 봉쇄되며, REVIEW.md 작성은 worktree 의 tracked diff / uncommitted 상태에 영향을 주지 않아 `worktree-shipping-guard` 와 직교한다.
- **필수 9 섹션** (사용자 열거 항목 1:1 — bilingual 헤더 허용): Summary/概要(작업내용) · Why/なぜ · Changed Files/変更ファイル(어떤 작업) · How/作業方法(어떻게) · Impact/影響範囲 · Trade-offs/トレードオフ · Remaining Work/残作業 · File Structure/フォルダー構造 · Review Requests/レビュー依頼(확인 요청 항목). trivial 변경도 헤더는 유지 — 본문만 축약.
- **HEAD staleness**: REVIEW.md 본문의 `<!-- bag-review: head=<sha> -->` 앵커가 worktree 현재 HEAD 와 불일치하면 stale 로 보아 BLOCK (commit 후 미갱신 레포트 통과 차단).
- **engage 조건**: owned(R-CM-036) + uncommitted == 0 + unmerged ≥ 1 + REVIEW.md invalid. uncommitted > 0 이면 skip(먼저 commit — `worktree-shipping-guard` 담당). 타 세션/orphan 은 차단 안 함(stderr 알림).
- **강제 강도 (의도된 설계 — shipping-guard 와 다름)**: "한 번 시도 후 통과(5분 마커)" give-up 을 두지 않는다 — 사용자 "강제" 의도. REVIEW.md 가 완성되면 자연히 통과하며, deadlock backstop 은 Claude 의 8연속 block 상한 + fail-open. 긴급 비활성화는 `ECC_DISABLED_HOOKS=worktree-review-report-guard`.
- **헬퍼 CLI**: `node .claude/scripts/mark-worktree-reviewed.mjs <branch> [--scaffold]` — `--scaffold` 는 9 섹션 템플릿 생성, 인자 없으면 섹션 검증 + 현재 HEAD stamp 갱신.
- **멀티-CLI**: Claude Code(`.claude/settings.json#Stop`) + Codex(`.codex/hooks.json#Stop` + `codex/worktree-review-report-guard.mjs` 어댑터). 본문 결정 로직 1벌(`run`/`evaluate`) + 얇은 어댑터(MULTI-CLI.md 패턴).
- **검증(node:test, 의존 0)**: `.claude/scripts/lib/__tests__/review-report.test.mjs` (lib) + `worktree-review-report-guard.test.mjs` (판정 매트릭스). 실행: `node --test .claude/scripts/lib/__tests__/*.test.mjs`.
- **등록 정직 명시**: 본 transplant 에는 donor 의 `regen-hooks-settings.mjs` codegen 이 미설치 → `.claude/settings.json` 은 수동 SSOT 로 직접 등록. `hook-registry.mjs` 에도 entry 를 추가하나 효과는 `isHookEnabled` profile 활성화(+`ECC_DISABLED_HOOKS` 무력화 해제)뿐이다.

본 gate 는 `pre-ship-review-guard` 를 *대체하지 않고 보완*한다: pre-ship-review-guard 는 ship 호출 시점의 마커/quality-label, 본 gate 는 완료(Stop) 시점의 본문 출력 — 두 차원이 직교.

### `/create-pr` 스킬과의 역할 분담

| 단계 | 담당 |
|------|------|
| uncommitted 변경 검출 → BLOCK + commit 유도 메시지 | worktree-shipping-guard |
| commit + unmerged 검출 → BLOCK + ship 유도 메시지 | worktree-shipping-guard |
| commit 완료 → BLOCK + REVIEW.md(9섹션) 본문 출력 강제 | worktree-review-report-guard |
| **Pre-Ship Quality Gate (`/code-review --fix` → verdict)** | **AI (본 룰 Rules 7-10 prompt-level)** |
| 7섹션 Human Review Panel + 사용자 컨펌 + 마커 | AI (본 룰 prompt-level) + pre-ship-review-guard |
| PLAN.md 검증, push, 멱등 PR, squash merge, cleanup | `/create-pr ship-worktree` |
| graceful 실패 (pending / BLOCKED / BEHIND) | `/create-pr` v2 응답 계약 |

### Anti-Patterns

- 시도 마커 freshness 무시 → stop loop. CI pending 시 매 stop 재차단.
- uncommitted 변경을 남긴 채 최종 응답 → 작업 완료 거짓 보고. Stop hook 이 BLOCK 해야 한다.
- uncommitted 변경 강제 ship → 미완성 코드 머지 위험. 먼저 commit 이 필수.
- hotfix escape hatch 누락 → 긴급 수정 흐름 차단.
- 자동 PR 생성을 hook 이 직접 수행 (`gh pr create` 등 외부 명령) → hook spec 위반 + 비결정적 동작. hook 은 Claude 출력 차단/유도만 가능, ship 호출은 AI 책임.
- 컨펌 없이 ship 직행 / 마커 미리 생성 후 패널 생략 → R-CM-016 Rule 10 (User Sovereignty) 위반.
- Human Review Panel 중 "Decisions & Trade-offs" 또는 "Risks, Follow-up & Rollback" 누락 → 사람이 merge 판단 불가.
- 메타 PR 패널 생략 ("자동화 자체를 머지하는 PR 은 자동" 사고) → 자기 차단 회피.
- **substantial 변경에 `/code-review --fix` SKIP** → silently quality 누락. Rule 8 위반.
- **verdict No-Go 무시하고 ship 강행** → Rule 9 위반 + 사용자 신뢰 손상.
- **"이번 한 번만 trivial" 사고** → R-CM-010 합리화 표 정합. Rule 10 기준 미충족 시 substantial 처리.
- **Codex/Gemini CLI 환경에서 simplification 도구 부재라고 quality gate 전체 SKIP** → verdict 단독이라도 의무. Rule 8 환경 분기 위반.
- **환경 분기 라벨 거짓** (Claude Code 인데 "Codex 라 `/code-review --fix` SKIP" 등) → R-CM-016 Rule 10 (User Sovereignty) + R-CM-024 카테고리 라벨 거짓 위반.
- **Pre-Ship Human Review Panel "Decisions & Trade-offs" 에 quality gate 결과 누락 또는 거짓** → Rule 10 자기 규율 우회. 사용자 retroactive 발견 시 R-CM-024 audit 누적.
- **review-only subagent 가 commit/stage/push/branch create 자율 실행** (사용자 결정 2026-05-25) → R-CM-016 Rule 10 (User Sovereignty) 위반 + learnings `subagent-autonomous-commit-bypass` (conf=8, observed — code-reviewer subagent 가 review 도중 git commit 자율 실행, `subagent-autonomous-ship-bypass` 의 commit 차원 변종). 호출자 prompt 에 `**review only — commit/stage/push/branch create/PR create/merge/ship 호출 금지**` 명시 의무. `ship/merge/PR create 호출 금지` 만 명시 + commit 어휘 누락 = enumeration 빈틈 — 동일 subagent 가 commit 만 자율 실행하여 우회. autonomous commit 발견 시 R-CM-024 audit 누적 + 사용자 retroactive 보고.

### 핵심 cross-reference

- R-CM-008 (Git Workflow) — Rule 4-6 worktree 시작 강제에 종료 강제 추가
- R-CM-016 Rule 10 (User Sovereignty) — 메타 PR / hard-to-reverse 변경 시 패널 의무 정합 + Rule 9 No-Go silently 우회 차단
- R-CM-024 (Mechanism Truthfulness) — enforced_by 실재 hook 매핑 + Rule 10 거짓 보고 audit 누적
- R-CM-028 (Two-Perspective Boundary) — Pre-Ship Quality Gate 의 **simplification + verdict 양 단계 모두 boundary-divergent** (배포 분리: 관점 1 `/code-review --fix` + code-reviewer/pre-quality-gate, 관점 2 simplification 부재 + final-review). 2026-05-27 사용자 결정으로 simplification 단계도 divergent 전환 (Codex/Gemini 는 `codex:rescue`/`gemini`)
- R-CM-029 Rule 3-4 (Simplicity / Surgical) — Rule 8 simplification 단계가 자기 검증 질문 ("over-engineering 인가?") + orphan cleanup 정책의 실행 위치
- R-CM-031 Rule 6 (AskUserQuestion 카테고리 라벨) — Rule 8 환경 분기 결정은 Mechanical (AskUserQuestion 호출 금지 + 보고도 생략 가능). 환경 감지 자체의 fallback 정책은 Rule 8 본문에 명시
- 도구: `/code-review --fix` (Claude Code 빌트인 simplification + correctness 1순위) / `codex:rescue` / `gemini` (Codex/Gemini simplification) + `final-review` (관점 2 verdict) / `code-reviewer` agent · `pre-quality-gate` 스킬 (관점 1 verdict) — Rule 8 환경 분기 + verdict 분기의 호출 대상

> Sources: 사용자 결정 2026-05-10 (worktree-auto-ship 기본 메커니즘) + 사용자 결정 2026-05-13 (Pre-Ship Quality Gate `/goal` 지시 + pipeline-boundary-guard 충돌로 verdict 단계 boundary-divergent 설계 채택) + 사용자 결정 2026-05-14 (worktree commit requirement) + 사용자 결정 2026-05-27 (Claude Code 빌트인 `/simplify` 폐기 + `/code-review --fix` 가 simplification + correctness 통합 단일 진입점, `simplifit` 스킬 deprecate, simplification 단계도 boundary-divergent 전환). `/create-pr` 스킬 (`.claude/skills/create-pr/SKILL.md`) Mode B `ship-worktree`. 환경 분기 도구: `/code-review --fix` (Claude Code 빌트인), `codex:rescue` (codex agent), `gemini` (`.claude/skills/gemini/`). Verdict 스킬: `final-review` (`.claude/skills/final-review/SKILL.md`, 관점 2), `code-reviewer` agent + `pre-quality-gate` (`.claude/skills/pre-quality-gate/`, 관점 1). 외부 기준 웹 확인 2026-06-11: GitHub PR standardization/templates/code owners/protected branches (`https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/getting-started/managing-and-standardizing-pull-requests`), GitHub required reviews (`https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches`), Google code review 관점 (`https://google.github.io/eng-practices/review/`), GitLab description templates (`https://docs.gitlab.com/user/project/description_templates/`). 검증: `npx vitest run tests/unit/worktree-shipping-guard.test.mjs` + `node .claude/scripts/audit-rule-enforcement.mjs --json`.
