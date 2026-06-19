---
paths:
  - ".worktrees/**"
  - ".claude/hooks/worktree-*.mjs"
  - ".claude/scripts/lib/worktree-*.mjs"
---

# Worktree Session Ownership Rules

## ID: R-CM-036
## Severity: major
## Enforced by: worktree-owner-tracker, worktree-session-owner-guard
## Boundary: perspective1-only (관점1 전용 — deployed-assets.json#rules.never_deploy. R-CM-028 배포 분리)

### Purpose

ad-hoc 멀티세션(Claude Code / Codex / Antigravity 병렬)에서 "각 세션이 자기가 cd 한 worktree 의 파일만 편집·커밋" 을 구조적으로 보장한다. **2-Layer 방어**: Layer 1 (cwd-confinement, 결정론적·orphan-proof) + Layer 2 (session_id 사이드카, 같은 path 내 다른 세션 보강).

trip-jarvis 이식 (exporter R-CM-037 → 본 룰 R-CM-036). 멀티세션 cross-worktree 컨텍스트 오전달 차단이 핵심.

### Source — 동기 사고

한 세션이 Stop 차단을 받고 무관 세션의 worktree 에 commit 하여 컨텍스트가 오염된 사고. session_id 단독 모델은 사이드카 부재 worktree (과거 생성분·수동 `git worktree add`·tracker 미발동) 에서 orphan 구멍이 생긴다 → Layer 1 (cwd-confinement) 결정론으로 구조적 폐쇄.

### Rules

1. **기록 (`worktree-owner-tracker`, PostToolUse Bash)**: `make wt.new` / `worktree-new.mjs` / `git worktree add` 명령 성공 직후, hook stdin 의 `session_id` 를 `.tmp/worktree-<safeBranch>/.session-owner` 에 1줄 기록한다. 경로 SSOT: `worktree-plan-path.mjs#worktreeOwnerPath`. session_id 는 hook stdin JSON 으로만 전달되므로(공식 문서) PostToolUse hook 만이 기록 가능. tracker 는 어떤 경우도 도구 호출 BLOCK 금지 (`safeHookMain`).

2. **판정 (`worktree-session-owner-guard`, PreToolUse Edit|Write|MultiEdit|Bash) — 2-Layer**:

   **Layer 1 — cross-worktree confinement (cwd 가 *다른 worktree* 일 때만 deny)**:
   대상 worktree(`targetWt`)가 현재 `cwd` 의 worktree(`cwdWt`)와 다르고 **`cwdWt`가 null이 아닐 때만(=cwd 가 다른 worktree) deny**. brief2dev Claude Code 의 Edit/Bash cwd 는 항상 main(PROJECT_DIR) 고정 (learnings `bash-cwd-reset-worktree`) — 단일 세션이 main cwd 에서 자기 worktree 를 편집하는 것이 *정상* 워크플로이므로 `cwdWt`=null(main) 은 deny 하지 않고 Layer 2 로 위임한다. cwd 가 다른 worktree 인 경우만 cross-worktree 침범으로 차단 (멀티-cd 세션, 예: Codex 가 worktree 로 cd).

   **Layer 2 — session_id 사이드카 (brief2dev cwd=main 멀티세션 cross-worktree 핵심 방어)**:
   worktree 의 `.session-owner` 가 존재 + 현재 `session_id` 불일치 → deny. brief2dev 멀티 Claude Code 세션은 둘 다 cwd=main 이라 Layer 1 을 통과하므로, session_id 사이드카가 cross-worktree 의 진짜 방어선이다. 사이드카 부재(orphan) → passthrough (단일 세션 정상 + `worktree-owner-tracker` 가 사이드카 보장).

   worktree 소속 판정은 R-CM-037 (`worktree-path.mjs#resolveWorktreeRoot`) SSOT 순수함수만 사용 — 세션축 무관.

3. **carve-out (전부 fail-open passthrough — 오차단 0 우선)**:
   - tool 이 Edit|Write|MultiEdit|Bash 아님 → passthrough
   - 대상이 `.worktrees/` 하위 아님 (main repo 파일) → passthrough (worktree-policy-guard 영역)
   - `.tmp/create-pr-active` 존재 → passthrough (ship 흐름 carve-out)
   - Bash 가 `git commit` 아님 / `--dry-run` → passthrough
   - Layer 1 통과(cwd=main 또는 cwd===targetWt) + Layer 2 사이드카 부재 → passthrough
   - hook 에러 / git 실패 → passthrough (R-CM-006 Rule 2)

3-A. **`/r` resume / handoff 인계 carve-out**:
   handoff 인프라(R-CM-034 Rule 4)는 "다른 세션이 worktree 정보를 읽고 이어서 작업" 을 명시 — cross-session 인계가 *정상* 워크플로다. Layer 2 사이드카는 *적대적* cross-session 을 방어하지만 의도된 인계와 충돌할 수 있다.
   - 사용자가 `/r <topic>` / handoff resume 을 명시 호출 시: AI 가 handoff 의 worktree 경로 검출 → 그 worktree 의 `.session-owner` 사이드카 **삭제** 허용 (orphan 처리 → Layer 2 fail-open 통과). Layer 1 은 그대로 (사용자가 cd 후 자기 worktree 안에서 작업).
   - **AI 자체 판단 사이드카 삭제 금지** — `/r` chat 호출 또는 명시 위임 없이 임의 삭제 = R-CM-008 + AI 권한 경계 위반.

4. **enforcement 범위**: Edit·Write·MultiEdit(수정) + Bash `git commit`(커밋). 동기 사고가 commit 벡터였으므로 commit 포함.

5. **escape hatch**: `.tmp/create-pr-active` (ship 흐름) 외 별도 우회 없음. 긴급 시 사용자 chat prompt 명시 지시로만.

6. **잔여 마찰 (의도된 동작)**: Layer 1 은 "다른 worktree 에 cd 한 채 이 worktree 파일 편집/커밋" 을 deny — false-block 이 아니라 cross-worktree 격리의 **의도된 강제**. brief2dev 단일 세션(cwd=main)은 정상 통과하며, 멀티 Claude Code 세션의 cross-worktree 는 Layer 2(session_id 사이드카)가 차단한다.

### 멀티-CLI 소유권 기록 (Claude Code + Codex 지원, Antigravity Layer 1 한정)

`worktree-owner-tracker` 는 본체 `run(data)` export + CLI 어댑터 패턴 (MULTI-CLI.md) 으로 사이드카를 기록한다.

- **Claude Code**: `worktree-owner-tracker.mjs` (PostToolUse Bash) 가 `session_id` 를 `.session-owner` 에 기록.
- **Codex**: `codex/worktree-owner-tracker.mjs` (PostToolUse, `.codex/hooks.json` 등록) 가 Codex `session_id` 를 기록한다. `session_id` 는 Codex PostToolUse payload 의 공통 필드 ("Current Codex session id" — 공식 문서 https://developers.openai.com/codex/hooks, 2026-06-13 WebFetch 확인: 모든 hook 공통 필드로 PreToolUse/PostToolUse 포함). 따라서 Codex 세션이 표준 진입점 (`make wt.new`) 으로 만든 worktree 도 `.session-owner` 가 남아 **Layer 2 (session_id 사이드카) 가 Codex 에서도 동작**한다 (cwd=main 인 멀티 Codex/Claude 세션 cross-worktree 방어).
- **Antigravity**: owner-tracker 어댑터 **부재** — Gemini AfterTool payload 의 `session_id` 존재를 본 PR 에서 미검증하여 추정 도입을 회피 (R-CM-029 Rule 6 Source-Driven, UNVERIFIED). Antigravity 세션 worktree 는 `.session-owner` 부재 → Layer 2 미동작이나, Antigravity 는 worktree 로 `cd` 하여 작업하므로 (cwd=worktree) `antigravity/worktree-session-owner-guard` 의 **Layer 1 (cross-worktree confinement) 이 session_id 무관 결정론으로 보호** → cross-worktree 침범은 차단된다.

어댑터 매핑 SSOT: `.claude/hooks/MULTI-CLI.md`.

### 기존 룰과의 관계

| 본 룰 | 관련 룰 | 관계 |
|------|---------|------|
| R-CM-036 | R-CM-037 (Worktree Target-Context) | 의존 — worktree 소속 판정에 R-CM-037 `resolveWorktreeRoot` SSOT 순수함수 사용 |
| R-CM-036 | R-CM-030 (Worktree Auto-Ship) | 정합 + consumer — ship carve-out(`create-pr-active`)으로 ship 흐름 비간섭 + `worktree-shipping-guard` 가 소유권 사이드카를 읽어 본 세션 소유 worktree 만 Stop 차단 (R-CM-030 Rule 1.1, 사용자 결정 2026-06-11) |
| R-CM-036 | R-CM-006 (Hook Convention) | 정합 — `-guard`/`-tracker` suffix, fail-open passthrough |
| R-CM-036 | R-CM-008 (Git Workflow) | 정합 — commit enforcement 는 worktree branch commit 허용 위에 "타 세션 worktree commit 만" 차단 |
| R-CM-036 | R-CM-034 (Worktree Workflow) Rule 5 | 직교 — R-CM-034 per-worktree isolation 은 state 격리(cwd 축, 의도된 설계), 본 룰은 edit/commit 소유권. 다른 관심사 |
| R-CM-036 | R-CM-016 Rule 10 (User Sovereignty) | 정합 — 사용자 chat prompt 명시 우회 우선 |

### Anti-Patterns

- **Layer 1·2 순서 역전**: Layer 1(cross-worktree cwd 판정) 을 Layer 2(session_id) 보다 먼저 평가한다 — cwd 가 *다른 worktree* 인 침범은 사이드카 유무와 무관하게 차단돼야 하므로. (orphan + cwd=main → passthrough 는 Rule 2 Layer 2 의 *의도된* 동작 — false-deny 회피. 순서 자체는 cwd=다른worktree 의 사이드카-무관 차단을 위해 Layer 1 우선.)
- **create-pr-active carve-out 누락**: ship 흐름 worktree 경로 deny → `/create-pr ship-worktree` 전면 차단.
- **tracker 가 BLOCK**: PostToolUse tracker 는 기록 실패해도 silent — 도구 호출 차단 금지.
- **Stop hook 으로 commit 재구현**: 제거된 worktree-stop-commit 패턴(Stop 시 모든 worktree 를 검사하여 *대신 commit*) 재발 금지. 본 룰의 edit/commit 소유권 강제는 PreToolUse 대상-특정 guard (`worktree-session-owner-guard`, 다른 vector) 가 담당한다.
  - **단, `worktree-shipping-guard` (R-CM-030 Stop hook) 의 소유권 *필터* 는 허용 (사용자 결정 2026-06-11)**: 이 Stop hook 은 worktree 에 *대신 commit* 하지 않고, 본 세션 소유(`classifyOwnership` === 'owned') worktree 만 ship 차단 대상에 포함하도록 사이드카를 *읽기 전용 소비* 한다. cross-session 오차단을 막는 정당한 consumer 이며, 금지된 "Stop 시 자율 commit" 패턴과 무관하다. 소유권 SSOT(`worktreeOwnerPath` + 사이드카)를 PreToolUse guard 와 공유한다.
- **세션축으로 타깃 worktree 판정**: `relative(projectDir, file)` 후 `.worktrees/` 접두 검사 = cross-worktree 오판정. R-CM-037 SSOT import 필수.

### 검증 명령

```bash
# 회귀 (결정 매트릭스)
npx vitest run tests/unit/worktree-session-owner-guard.test.mjs

# 구문
node -c .claude/hooks/worktree-owner-tracker.mjs
node -c .claude/hooks/worktree-session-owner-guard.mjs

# 등록 정합 (settings.json == registry codegen)
node .claude/scripts/regen-hooks-settings.mjs --check
grep -c "worktree-owner-tracker\|worktree-session-owner-guard" .claude/settings.json
```

### Sources

- trip-jarvis 이식 (exporter `worktree-session-ownership.md` R-CM-037 → 본 룰 R-CM-036). 멀티세션 worktree 소유권 2-Layer 방어
- 동기 사고: 한 세션이 무관 worktree 에 commit (컨텍스트 오염)
- 공식 문서: hook stdin `session_id` (PreToolUse/PostToolUse 공통), env var 부재
- 관련 룰: R-CM-037, R-CM-030, R-CM-006, R-CM-008, R-CM-034, R-CM-016 Rule 10
