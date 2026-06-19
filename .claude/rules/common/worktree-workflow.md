---
paths:
  - ".worktrees/**"
  - ".claude/scripts/worktree-*.mjs"
  - ".claude/scripts/lib/worktree-*.mjs"
  - ".claude/hooks/worktree-*.mjs"
  - ".claude/scripts/create-pr/**"
  - ".claude/config/worktree-policy.json"
  - ".claude/scripts/lib/layout-resolver.mjs"
  - "Makefile"
  - "CLAUDE.md"
---

# Worktree Workflow Rules

## ID: R-CM-034
## Severity: major
## Enforced by: worktree-policy-guard, worktree-shipping-guard, worktree-init.mjs (시작 강제 R-CM-008 Rule 6, 종료 강제 R-CM-030)
## Boundary: perspective1-only (관점1 전용 — deployed-assets.json#rules.never_deploy. R-CM-028 배포 분리)

### Purpose

`.worktrees/<branch>` 격리 워크플로우의 운영 가이드를 정의한다. 시작 강제 (R-CM-008 Rule 6 commit-guard) 와 종료 강제 (R-CM-030 worktree-shipping-guard) 의 중간 단계 — worktree 생성 방식, PLAN.md 추적, system_persistent SSOT 공유, per-worktree 격리, shipping 경로 — 의 보편 운영 패턴을 단일 SSOT 로 통합한다. 본 룰 자체는 prompt-level 으로 동작하며, 실제 강제는 cross-ref hook 들이 담당.

### Rules

1. **Tier 분류 기반 작업 위치**: 코드 변경은 기본적으로 `.worktrees/<branch>` 에서 수행하고, 브랜치명은 GitHub Flow (`feature/*`, `fix/*`) 를 따른다. main 직접 수정은 `.claude/config/worktree-policy.json` 의 Tier 1 패턴과 `hotfix/*` escape hatch 만 허용한다.
   - **Tier 3 default (worktree 의무)**: **git-tracked 모든 자산** — `.claude/skills/`, `.claude/scripts/` (hook 포함), `data/registry/`, `data/personas/`, `data/process-contracts/`, `data/schemas/`, `.claude/config/`, `.claude/wisdom/`, `.brief2dev/governance/`, `.github/`, `docs/`, `tests/` 등 (2026-06-04: data/registry·personas·process-contracts·governance·wisdom·config·.github 를 Tier 1→3 이동 — split-brain 회피)
   - **Tier 1 (main 직접 작성 허용)**: **git-ignored 런타임 산출물 한정** (2026-06-04 재정의 — split-brain 회피). brief2dev-orchestrator 가 AI Write tool 로 생성하는 run-scoped 산출물 (`.brief2dev/runs/**`) + scaffold 결과물 (`output/**`) + 시스템 영속 상태 (`.brief2dev/system/**`, `.brief2dev/session-history/**`) + `.tmp/**` + `.claude/settings.json` (codegen 특수). 8 stage 실행 시 worktree 없이 진행 가능. **git-tracked 자산은 Tier 3** — main 직접 수정 변경이 worktree PR 과 따로 머지되는 split-brain 회피 (commit-guard 가 main commit 차단 → ship 시 main uncommitted 는 stash 보존만 됨). Tier 1 패턴/카테고리 SSOT 는 `.claude/config/worktree-policy.json#tier_classification_guide`
   - **escape hatch**: `hotfix/*` / `hotfix-*` 브랜치

2. **PLAN.md 추적 위치 (.tmp/ 하위)**: 각 worktree 는 `.tmp/worktree-<safeBranch>/PLAN.md` 로 목표/상태/검증/미해결 이슈를 추적한다.
   - **worktree 루트가 아닌 `.tmp/` 하위** — `.gitignore` 의 `.tmp/` 패턴으로 머지 누출 차단
   - 경로 SSOT: `.claude/scripts/lib/worktree-plan-path.mjs`
   - `worktree-new.mjs` 가 PLAN.md 초안을 자동 생성 (Goal / Why / Scope / Out of scope / Verify / Status / Outstanding / Decisions 섹션)
   - **R-CM-028 boundary**: brief2dev 자체는 `PLAN.md`/`handoff` 중심, scaffold 내부는 `feature-pilot` 이 `CONTEXT.json#execution.worktree` (`branch`, `worktree_path`, `plan_path`, `status`, `handoff`) 와 `PLAN.md` 를 함께 관리하고 완료 시 cleanup/정리한다. 두 관점에 같은 추적 메커니즘을 강제하지 않는다

3. **표준 진입점 (atomic 4 steps)**: worktree 생성은 표준 진입점 `make wt.new BR=feature/<task>` (또는 `node .claude/scripts/worktree-new.mjs --branch feature/<task>`) 로만 수행한다. CLI agnostic — Claude Code / Codex / Gemini CLI 모두 동일 명령 사용.

   `worktree-new.mjs` 가 atomic 하게 수행하는 단계:
   1. `git fetch origin <base>` (실패 시 fail-loud)
   2. main worktree + base branch 인 경우 `git merge --ff-only origin/<base>` 시도 (non-FF divergent 시 STOP — silent rebase 회피)
   3. `git worktree add .worktrees/<branch> -b <branch> origin/<base>` (멱등 — 같은 path+branch 재실행 시 SKIP)
   4. `worktree-init.mjs` chain (`.brief2dev/system` symlink + `PLAN.md` 자동 생성)

   raw `git worktree add` 직접 호출은 stale local main 위에서 분기하므로 사용하지 않는다 — ship 시점 rebase 부담 / R-CM-008 Rule 9 superset 위험.

4. **system_persistent SSOT 공유**: `.brief2dev/system/` 은 모든 worktree 가 공유하는 system_persistent SSOT (pipeline-memory / archive-index / learnings / registry — cross-aidea 누적 학습).
   - 접근은 `layout-resolver.mjs#resolveSystemPersistentRoot()` 를 거친다
   - worktree 에서는 `.brief2dev/system -> <main>/.brief2dev/system` symlink 로 직접 접근도 같은 위치를 보게 한다
   - 우선순위: `BRIEF2DEV_SYSTEM_ROOT` → `B2D_TEST_SANDBOX + CLAUDE_PROJECT_DIR` → git common-dir 부모 → `PROJECT_DIR`

5. **Per-worktree isolation (사용자 결정 2026-05-14)**: active-run state 는 worktree 마다 격리된다.
   - `.brief2dev/run/active.json` — `worktree_local` lifecycle, untracked (R-CM-026 `run` 카테고리)
   - 다른 worktree (Claude Code, Codex 등 multi-session) 가 brief2dev-orchestrator 를 동시 실행해도 active-run / runs / output 충돌 없음
   - `.brief2dev/runs/<run_id>/` 와 `output/<slug>/` 는 PROJECT_DIR 기준 자동 worktree-local
   - `.brief2dev/archives/<slug>/` 는 `ARCHIVES_ROOT` 가 system_persistent root 기준이라 worktree → main 자동 누적
   - **1 session = 1 idea, 다른 idea 는 다른 worktree**

6. **Commit 의무 (사용자 결정 2026-05-14)**: worktree 안에서 시스템 코드 변경을 수행했다면 최종 응답 전 반드시 해당 worktree 안에서 commit 을 남긴다.
   - 커밋하지 않는 예외는 사용자가 명시적으로 WIP 보존/커밋 금지를 요청한 경우뿐이다
   - `worktree-shipping-guard` 가 uncommitted worktree 변경을 Stop 시점에 BLOCK (R-CM-030)
   - 본인이 만든 변경만 stage/commit. 사용자 또는 다른 세션의 unrelated 변경은 포함 금지

7. **Shipping 경로 (단일 진입점)**: worktree commit 이후 shipping 은 반드시 `/create-pr ship-worktree` 또는 `node .claude/scripts/create-pr/ops.mjs ship-worktree --worktree <path>` 로만 수행한다.
   - `git merge --ff-only feature/*|fix/*|chore/*|...` 처럼 worktree branch 를 main 에 직접 fast-forward merge 하는 것은 금지 (`destructive-git-guard` 가 차단)
   - 예외 1: create-pr 플로우의 신선한 `.tmp/create-pr-active` 범위 안에서 실행되는 안전 명령
   - 예외 2: `worktree-new.mjs` 의 `git merge --ff-only origin/<base>` freshness sync
   - 호출 직전에는 Pre-Ship Human Review Panel 7섹션(Summary/Evidence/Changed Files/File Structure/Impact/Decisions & Trade-offs/Risks, Follow-up & Rollback) 과 사용자 컨펌이 필수 (R-CM-030)

8. **Fail-Open 정책**: `worktree-policy-guard` 는 main Edit/Write 를 검사하고, hook error/policy 부재/비-main branch 는 fail-open 한다 (R-CM-006 Rule 2 정합).

9. **PR Cluster Operation — context 관리 (사용자 결정 2026-05-23 — P0 cluster 회고)**: 2개 이상 PR 을 atomic 연속 진행하는 cluster 작업 시, 각 PR 머지 직후 + 다음 PR worktree 생성 직전에 사용자에게 `/compact` 호출 권고를 명시 제시한다.
   - **사유**: cluster N 진행 중 N worktree 의 system-reminder 룰 inject 이 누적되어 context window 가 빠르게 차감 (P0 3 PR cluster 의 본 세션 사례 — 8252+ 편집 도달, "/compact 고려" 자동 경고 트리거).
   - **compact 영향 범위**: transient context (PR description / verify output / Pre-Ship Human Review Panel / PLAN.md 본문) 만 압축. 룰 / SSOT path / 사용자 결정 / learnings.jsonl entry 는 SessionStart hook 으로 자동 보존 — 손실 없음.
   - **권고 시점**: 머지 직후 (cleanup 완료 시) AI 가 "다음 PR (N+1) 진행 전 `/compact` 권고 — 누적 context ~X% 회수 가능" 명시 안내.
   - **사용자 결정 우선**: 사용자가 거부하면 compact 없이 진행. AI 자동 호출 금지 (R-CM-016 Rule 10 User Sovereignty).
   - **적용 트리거**: cluster size ≥ 2 PR (단일 PR 작업은 적용 제외).

10. **Bash cwd reset 인지 (사용자 결정 2026-05-24)**: worktree 작업 중 Bash 호출은 매번 PROJECT_DIR(main) 으로 cwd reset 된다. learnings inject (top-k SessionStart) 만으로는 mid-session 위반 방지 부족 — 본 세션 2회 반복 위반 사례 (prettier --check + audit-brief2dev-layout 가 main path 의 동일 파일 검사 → worktree 의 LOW 1 정정 미검증). 다음 패턴 적용:
    - **git 명령**: `git -C <worktree-path>` 명시 (commit-guard hook 평가 시점 cwd=main 인식 차단 회피 — learnings `git-bash-needs-explicit-git-C` conf=10)
    - **검증 명령 (prettier/vitest/audit/lint)**: worktree absolute path 명시 (`prettier --check /abs/path/.worktrees/<branch>/...`) 또는 `cd <worktree-path> && <cmd>` chain. 단 chain 도 hook 평가 시점 cwd=main 위험 (learnings `bash-cwd-reset-worktree` conf=10) — absolute path 명시가 더 안전
    - **mid-session 자가 점검 의무**: 검증 명령 PASS 직후 output 의 file path 명시적 확인 (worktree 경로 prefix 포함 여부) — silently main path 검사한 PASS 는 *false PASS* 로 round-trip 발생 (본 세션 사례)
    - **회피 시점**: worktree commit 작성 전 검증 단계에서 의무 — round-trip 비용 (재검증 + 마커 재생성 + 다음 ship 차단) 회피

### 기존 룰과의 관계

| 이 룰 | 관련 룰 | 관계 |
|------|--------|------|
| R-CM-034 | R-CM-008 (Git Workflow) Rule 4-6 | 보완 — R-CM-008 은 commit/branch 정책, 본 룰은 worktree 운영 가이드 |
| R-CM-034 | R-CM-030 (Worktree Auto-Ship) | 보완 — R-CM-030 은 종료 단계 (shipping + Pre-Ship Quality Gate), 본 룰은 중간 운영 (생성/추적/공유/격리) |
| R-CM-034 | R-CM-026 (Layout SSOT) | 강제 — `worktree_local` / `system_persistent` lifecycle 카테고리 적용 (active-run / archives) |
| R-CM-034 | R-CM-028 (Two-Perspective Boundary) | boundary-divergent — 관점 1 (brief2dev 자체) 은 PLAN.md/handoff 중심, 관점 2 (scaffold) 는 CONTEXT.json#execution.worktree 중심 |

### R-CM-028 boundary 분류

**boundary-divergent (코드 분기)**:
- 관점 1 (brief2dev 자체): `worktree-init.mjs` / `worktree-policy-guard` / `worktree-shipping-guard` 적용. PLAN.md `.tmp/` 하위 추적
- 관점 2 (scaffold target): `feature-pilot` 이 `CONTEXT.json#execution.worktree` 로 별도 lifecycle 관리. brief2dev 자체 hook 들은 scaffold 영역에 미배포

### Anti-Patterns

- **raw `git worktree add` 호출**: stale local main 위에서 분기. ship 시점 rebase 부담 / R-CM-008 Rule 9 superset 위험. 표준 진입점 사용
- **PLAN.md 를 worktree 루트에 작성**: `.gitignore` 의 `.tmp/` 패턴으로 차단되지 않아 머지 누출 위험. `.tmp/worktree-<safeBranch>/PLAN.md` 위치 의무
- **다른 worktree 의 변경을 같이 commit**: per-worktree isolation 위반. 본인이 만든 변경만 stage
- **worktree branch 직접 main FF merge**: `/create-pr ship-worktree` 우회. `destructive-git-guard` 가 차단

### Sources

- 사용자 결정 2026-05-14 (per-worktree isolation + commit 의무)
- R-CM-008 Rule 6 (worktree-aware AI commit 정책)
- R-CM-030 (Worktree Auto-Ship + Pre-Ship Quality Gate)
- 이전 SSOT 위치: `CLAUDE.md#Worktree 작업 규칙` (본 PR 에서 분리)
- Rule 10: learnings `git-bash-needs-explicit-git-C` (conf=10) + `bash-cwd-reset-worktree` (conf=10), 사용자 결정 2026-05-24 (본 세션 2회 위반 사례 surface)
