---
paths:
  - ".claude/scripts/lib/worktree-path.mjs"
  - ".claude/hooks/worktree-*.mjs"
---

# Worktree Target-Context Resolution Rules

## ID: R-CM-037
## Severity: critical
## Enforced by: null (worktree-path.mjs SSOT 순수함수 lib + 본 룰 명문화 + worktree-path 회귀 테스트)
## Boundary: perspective1-only (관점1 전용 — deployed-assets.json#rules.never_deploy. R-CM-028 배포 분리)

### Purpose

path-분류 hook 의 worktree 판정을 단일 SSOT 순수함수로 통일해, 트리거 세션의 ENV/cwd/projectDir 과 **구조적으로 무관**하게 만든다 → 멀티세션·멀티worktree 동시 작업에서 cross-worktree 오판정·컨텍스트 오전달이 발생할 수 없다 (컨플릭 구조적 불가).

trip-jarvis 이식 (exporter R-CM-038 → 본 룰 R-CM-037).

### Source — 근본원인

"이 타깃 파일이 어느 worktree 소속인가" 를 hook 마다 세션축(projectDir/cwd)에서 제각각 재발명하면, 세션이 worktree 안에서 동작할 때 `relative()` 가 `.worktrees/` 접두를 잃어 자기 worktree 안 정상 편집을 자기 차단하거나, wt1 세션이 wt2 를 오판정한다. 세션축은 per-target 판정에 잘못된 축 — 올바른 축은 **편집/커밋 대상의 절대경로** 다.

### Rules

1. **SSOT 단일 출처**: worktree 소속 판정은 `.claude/scripts/lib/worktree-path.mjs` 의 `resolveWorktreeRoot(absPath)` / `isWorktreeAbsPath(absPath)` **만** 사용한다. 두 함수는 **순수함수** — 파일 읽기·git 호출·전역상태·세션 입력 0. 입력은 오직 **편집/커밋 대상의 절대경로**. 2-세그먼트(`<prefix>/<slug>`) 판정은 첫 세그먼트가 정확히 `KNOWN_BRANCH_PREFIXES`(`worktree-plan-path.mjs` SSOT) 일 때만 — 단일 세그먼트 worktree(`hotfix-foo`/`wt1`)의 하위 파일을 2-세그먼트로 오판해 자기 worktree 작업을 false-deny 하지 않는다 (DEBT-182).

2. **세션축 금지**: path-분류 hook 은 worktree 판정에 `resolveProjectDir` / `data.cwd` / `process.cwd()` / `CLAUDE_PROJECT_DIR` 를 **사용하지 않는다**. 세션축은 진단 메시지·로그 등 비-판정 용도로만 허용.

3. **적용 hook (이행 완료)**: `worktree-session-owner-guard` (R-CM-036) 가 `resolveWorktreeRoot` lib import (re-export 제거 — DEBT-183, 테스트는 `worktree-path.mjs` 직접 import). worktree cwd 판정과 target 판정 모두 동일 SSOT 경유.

4. **신규/수정 hook 의무**: 앞으로 worktree 소속을 판정하는 PreToolUse path 분류 hook 은 본 SSOT 를 import 한다. 자체 `relative(projectDir,...)`+`.worktrees/` 접두 / `cwd.includes('/.worktrees/')` 재발명 금지.

5. **hook 모듈 import 부작용 회피**: SSOT 는 hook 이 아닌 순수 lib 이므로 import 해도 standalone `readStdin()` 선소비 부작용 없음. hook 간 직접 import 는 여전히 금지.

6. **테스트 위치 비의존**: worktree 판정이 절대경로 기준이므로, 테스트 temp repo 는 반드시 `.worktrees/` **밖**(`os.tmpdir()`)에 둔다. in-repo temp 는 worktree 안 실행 시 경로에 `/.worktrees/` 섞여 전 대상 오판.

### 기존 룰과의 관계

| 본 룰 | 관련 룰 | 관계 |
|------|---------|------|
| R-CM-037 | R-CM-036 (Worktree Session Ownership) | 보완 — R-CM-036 의 worktree 판정을 본 SSOT 순수함수가 제공 |
| R-CM-037 | R-CM-006 (Hook Convention) | 정합 — 순수함수 SSOT, hook 은 fail-open 유지 |
| R-CM-037 | R-CM-034 (Worktree Workflow) | 정합 — `.worktrees/<branch>` 2-세그먼트 경로 규약 공유 |

### Anti-Patterns

- **세션축으로 타깃 worktree 판정**: `relative(resolveProjectDir(data), file)` 후 `.worktrees/` 접두 검사 = 근본원인. 재도입 금지.
- **SSOT 우회 자체 구현**: hook 안에서 `lastIndexOf('/.worktrees/')` / `includes('/.worktrees/')` 직접 작성 = 복제 = drift 씨앗. lib import 필수.
- **in-repo 테스트 temp**: `.claude/__tests__/.tmp-*` 사용 → worktree 안 실행에서 경로 오염. `os.tmpdir()` 필수.

### 검증 명령

```bash
# SSOT 순수함수 단위 (위치 무관·빠름)
npx vitest run tests/unit/worktree-path.test.mjs

# 세션축 미사용 확인 (판정부에 세션축 없어야)
grep -nE "resolveProjectDir|process\.cwd|CLAUDE_PROJECT_DIR" .claude/hooks/worktree-session-owner-guard.mjs

# SSOT 단일성 (lastIndexOf('/.worktrees/') 는 worktree-path.mjs 1건만)
grep -rn "lastIndexOf('/.worktrees/')" .claude/hooks .claude/scripts/lib
```

### Sources

- trip-jarvis 이식 (exporter `worktree-target-context.md` R-CM-038 → 본 룰 R-CM-037)
- 패턴 출처: file-anchored worktree 판정 순수함수 (세션축 배제, GitHub-Flow 2-세그먼트 인식)
- 관련 룰: R-CM-036, R-CM-006, R-CM-034
