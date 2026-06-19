---
name: create-pr
description: "Worktree 격리 GitHub Flow (8 명령, v2 응답 계약). Mode A (staged 격리 → Feature PR → main 동기화) + Mode B (PLAN.md 기반 worktree 배포). unstaged/untracked는 stash 백업으로 100% 보전."
argument-hint: "[추가 지시사항 (선택)]"
---

## `/create-pr` — Worktree 격리 GitHub Flow

AI가 병렬로 변경한 결과를 Feature PR → main 동기화까지 자동 수행. 두 가지 모드 지원, 질문 없이 자동 진행.

> **권고 (강제 X)**: 본 스킬 호출 직전, 변경 size 에 따라 `/pre-ship-quality-advisor` 실행을 권장한다. `/code-review --fix` (Claude Code, simplification + correctness 1순위) / `code-standards-aligner` (포터블 fallback) / final-review (모든 PR) / `/code-review high` (substantial 변경의 review-only correctness verdict 옵션) 도구 우선순위와 매뉴얼 체크리스트를 제안. 다른 CLI (Gemini CLI, Codex 등) 환경에서도 매뉴얼 체크리스트로 fallback 동작.

### 핵심 불변식 + 금지 사항

**불변식**: unstaged/untracked는 실행 전후로 정확히 동일하다.
- Mode A Phase 1: worktree 격리 → 원본 HEAD 불변
- Mode A Phase 2: `git stash push --include-untracked` → main ff-only merge → `git stash pop`. pop 충돌 시 stash 자동 유지(reflog 영구 보존).

**Worktree Commit Requirement**: Mode B `ship-worktree` 는 dirty worktree 를 배포하지 않는다.
- PR 생성/머지 전에 `git status --porcelain --untracked-files=all` 이 clean 이어야 한다.
- uncommitted tracked/untracked 변경이 있으면 `code: "commit_required"` 로 실패한다.
- AI 는 본인이 만든 파일만 stage/commit 한 뒤 `ship-worktree` 를 다시 실행한다.
- 사용자가 명시적으로 WIP 보존/커밋 금지를 요청한 경우에는 `ship-worktree` 대신 작업 상태를 보고하고 중단한다.

**금지**: 원본 working tree 수정 · `git reset --hard` · `git checkout .` · `git restore .` · `git clean -f` · `git stash clear` (R-CM-008 Rule 7 — clear 만 차단, 그 외 stash 허용) · `--force` push · main 삭제 · 충돌 자동 해결

### v2 응답 계약 (모든 명령 공통)

```jsonc
{
  "ok": true | false,
  "mode": "staged" | "worktree" | null,    // AI 분기 지표
  "command": "init" | "verify-plan" ...,
  "sync_status"?: "synced" | "fetch_failed" | "stash_failed" | "ff_failed" | "synced_with_stash_conflict",
  "active_stash"?: "create-pr-sync-backup-..." | null,
  "changed_files"?: ["a.md", "b/c.mjs"],   // ship-feature/ship-worktree 머지 성공 시
  "changed_files_tree"?: "└── ...",         // 사람용 markdown box-drawing 트리
  "warnings"?: ["..."],
  "error"?: "...",     // ok:false 시
  "hint"?: "..."       // ok:false 시 회복 안내
}
```

**fail-loud 의미론** (R-CM-010 정합): `finalize`/`cleanup-worktree`의 fetch/stash/ff 실패는 `ok:false` + `sync_status`. silent warning 아님.

**Post-merge 트리 보고 의무 (`changed_files_tree`)**: `ship-feature` / `ship-worktree` 가 `merged: true` 응답 시 `changed_files` (path 배열) + `changed_files_tree` (markdown box-drawing 트리) 두 필드를 포함한다. AI 는 머지 보고 직후 `changed_files_tree` 필드 값을 **사용자에게 그대로 출력**하여 어떤 파일이 머지됐는지 인지 가능하게 한다. gh 호출 실패 시 `changed_files: []` + `changed_files_tree: "(no files)"` (silent fail-open — 핵심 머지 결과 영향 없음).

### ops.mjs 사용

```
node .claude/scripts/create-pr/ops.mjs <command> [--key value ...]
```

설정: `.claude/skills/create-pr/config.json` — `github_account`, `base_branch`(기본 `main`), `enforce_ssh_remote`(기본 false). ops.mjs가 `gh auth token -u`로 `GH_TOKEN` 자동 주입.

| 명령 | Mode | 인자 | 역할 |
|---|---|---|---|
| `init` | staged | — | base 확인 + 동시 실행 보호(30min mtime) + CI Mirror Gate(60min stamp) + staged 추출 + 기밀 차단 + gh auth |
| `isolate` | staged | `--branch <b>` | worktree + feature 브랜치 생성 + staged `apply --index` |
| `commit` | staged | `--message <m> [--files <f1,f2>]` | worktree 내 커밋 |
| `ship-feature` | staged | `--title <t> [--body <b>] [--no-merge]` | push → 멱등 PR → squash merge → remote branch 삭제 |
| `finalize` | staged | — | worktree 제거 + stash-based 원본 동기화 (fail-loud) |
| `verify-plan` | worktree | `--worktree <p> [--force]` | PLAN.md 미완료 체크박스 검증 (코드블록/HTML주석 strip, 취소 마커 인식) |
| `ship-worktree` | worktree | `--worktree <p> --title <t> [--body <b>] [--force-plan] [--no-merge] [--no-cleanup]` | PLAN.md 검증 + committed/clean worktree 검증 + push + 멱등 PR + auto full cleanup (기본값 — `cleanup-worktree` 위임: worktree·branch 제거 + auto-checkpoint stash drop + CONTEXT.json 정리 + main 동기화) |
| `cleanup-worktree` | worktree | `--worktree <p>` | worktree 제거 + branch 삭제 + auto-checkpoint stash drop + CONTEXT.json 정리 + main 동기화 (fail-loud). `--no-cleanup` 으로 ship 한 경우 별도 호출 |

### AI 실행 시퀀스 — Mode A (Staged 격리)

각 응답이 `ok: false`면 즉시 중단 + 오류 보고 + `finalize` 호출.

```bash
OPS="node .claude/scripts/create-pr/ops.mjs"

$OPS init                                             # Step 1
$OPS isolate --branch "$BRANCH"                       # Step 2 (AI가 BRANCH 결정)
$OPS commit --message "$MSG"                          # Step 3 (필요 시 --files로 여러 번)
$OPS ship-feature --title "$FT" --body "$FB"          # Step 4 (CI 완료까지 최대 5분 대기)
$OPS finalize                                         # Step 5
# → finalize의 active_stash가 null이 아니면 수동 복구 안내
# → finalize의 sync_status !== 'synced' 이면 추가 조치 필요
```

### AI 실행 시퀀스 — Mode B (Worktree, feature-pilot 연동)

`.worktrees/<branch>` 에서 작업한 기능을 PR로 내고 정리할 때 사용. PLAN.md 체크박스 검증 후 진행.

> **PLAN.md 취소 항목 처리**: 빈 체크박스(`- [ ]`)에 `(취소됨)` / `(dropped)` / `~~취소선~~` 마커가 있으면 무시하고 통과. 코드 블록(```` ``` ````)과 HTML 주석(`<!-- -->`) 안의 체크리스트는 자동 strip되어 false positive 방지. `--force` / `--force-plan` 으로 강제 우회 가능.

```bash
OPS="node .claude/scripts/create-pr/ops.mjs"
WT_PATH=".worktrees/feature/add-login"

# 1. PLAN.md 검증 (선택, ship-worktree 내부에서도 자동 검증)
$OPS verify-plan --worktree "$WT_PATH"

# 2. 품질 검사 및 커밋 (필수: ship-worktree는 uncommitted 변경 있으면 commit_required 에러)
# cd $WT_PATH && $QUALITY_GATE_CMD && git add . && git commit -m "..." && cd -
#   ($QUALITY_GATE_CMD = project-config.json#commands.quality_gate, null이면 스킵 — R-CM-009 Rule 3)

# 3. Push 및 PR 생성 (squash merge, 기존 PR 있으면 멱등 재사용)
# 옵션: --force-plan (PLAN 미완료 우회), --no-merge (PR만 생성), --no-cleanup (자동 full cleanup opt-out)
# 기본값: 머지 성공 시 cleanup-worktree 에 위임하여 worktree·branch 제거 +
#         auto-checkpoint stash drop + CONTEXT.json 정리 + main 동기화까지 일괄 수행
$OPS ship-worktree --worktree "$WT_PATH" --title "$FT" --body "$FB"

# 4. (--no-cleanup 으로 ship 한 경우에만 별도 호출) Worktree·branch·stash 정리 + CONTEXT.json + main 동기화
$OPS cleanup-worktree --worktree "$WT_PATH"
```

AI 판단 영역: BRANCH(Conventional Commits, 30자 이내), 커밋 메시지, PR 제목/본문, PLAN.md 취소 항목 명시 판단.

## 훅 연동 (commit-guard / destructive-git-guard)

`init` / `isolate` / `commit` 이 갱신하는 `.tmp/create-pr-active` 플래그 (mtime 기준 30분 freshness — ship-feature 5min polling + finalize 1min 커버)로 두 훅이 자동 완화:
- **commit-guard**: `/create-pr` 외 직접 `git commit` / 브랜치 생성 차단 → 플래그 freshness 시 통과
- **destructive-git-guard**: `git merge --ff-only` 및 `git worktree remove` 만 추가 허용 (그 외 파괴 명령은 플래그 무관 차단)
- `finalize` / `cleanup-worktree` 종료 시 플래그 자동 제거

**동시 실행 보호**: `init` 호출 시 30초 이내 active flag 가 있으면 거부. 이전 세션이 완료되지 않은 상태에서 새 세션 진입을 차단해 데이터 손실 방지.

## Branch Completion Options

worktree 작업이 끝났지만 PR, 보관, 폐기 중 어떤 종료 경로를 선택할지 정해야 할 때는 `references/superpowers-branch-completion-options.md`를 참조한다. 이 reference는 Superpowers의 branch finishing UX를 brief2dev Mode B와 destructive guard 정책에 맞춰 재작성한 것이다.

## Not For / Boundaries

| 상황 | 처리 |
|---|---|
| feature 브랜치에서 `init` 실행 | 에러 (main만 허용) |
| 로컬 main이 origin/main보다 **앞섬** | 에러 (자동 push는 의도치 않은 commit 전파 위험으로 비활성) |
| 로컬 main이 origin/main보다 **뒤쳐짐** | 경고, finalize가 ff-merge로 동기화 |
| `gh` CLI 미인증 | 에러 |
| `git fetch` 실패 (오프라인) | 경고, 플로우 진행 |
| ship-worktree 시 PLAN.md 미완료 | 에러 (`--force-plan` 또는 취소 마커로 우회) |
| ship-worktree 시 worktree 에 uncommitted 변경 | 에러 (`code: "commit_required"`; 먼저 본인 변경만 commit) |
| PR 재생성 | 멱등 (open PR 재사용 + title/body 업데이트) |
| BLOCKED/BEHIND mergeStateStatus | `pending: true` 반환 (graceful — 에러 아님) |
| 다른 create-pr 세션 진행 중 | `init` 거부 (30분 mtime 체크 — ship-feature 5min polling + finalize 1min 안전) |

**다루지 않는 범위**: 품질 게이트(CI 담당, brief2dev는 `init`이 q.ci-mirror 자동 실행) · hotfix · rebase 플로우(squash 고정) · 충돌 자동 해결 · multi-repo·서브모듈 · 다중 버전 릴리즈(GitHub Flow 단일 브랜치) · 원본 unstaged/untracked의 worktree 이주

## Pre-flight Checklist

| ID | 항목 | 필수 | 담당 |
|----|------|------|------|
| PF-001 | init: main 최신성 + staged 존재 + 기밀 파일 차단 + gh auth + 동시 실행 보호 (30min flag mtime) | ✅ | ops.mjs |
| PF-002 | init: CI Mirror Gate (make q.ci-mirror, 60min stamp freshness) | ✅ | ops.mjs |
| PF-003 | ship-worktree: PLAN.md 검증 + committed/clean worktree 검사 (`commit_required`) | ✅ | ops.mjs |

## Post-flight Checklist

| ID | 항목 | 필수 |
|----|------|------|
| POF-001 | ship-feature 완료 (`merged === true` 또는 `pending === true` graceful) | ✅ |
| POF-002 | finalize 완료 (`sync_status === 'synced'` 또는 의도된 fail-loud 응답) | ✅ |
| POF-003 | cleanup-worktree 완료 시 active_stash === null 또는 stash conflict hint 표시 | ✅ |

## Maintenance

- **Boundary (R-CM-028)**: boundary-uniform — 본 스킬은 관점 1 (brief2dev 자체 거버넌스/룰/스킬/hook 변경) + 관점 2 (scaffold 내부 feature/bug-fix) 양쪽에서 동일 의미로 사용. main + worktree-aware 분기는 코드 레벨 (commit-guard / destructive-git-guard) 에서 자동 처리되며, 두 관점 모두 같은 흐름 (init/isolate/commit/ship/finalize) 을 따름. 분기 메커니즘 불필요.
- **Sources**: R-CM-008 (git-workflow), R-CM-010 (verification-before-completion, fail-loud 의미론), R-CM-028 (two-perspective-boundary), `git-worktree(1)`, `git-stash(1)`, GitHub REST `PUT /repos/{owner}/{repo}/pulls/{n}/merge`
- **관련 스크립트**: `.claude/scripts/create-pr/ops.mjs` — 8명령 통합 실행 엔진
- **관련 훅**: `.claude/hooks/commit-guard.mjs`, `.claude/hooks/destructive-git-guard.mjs`
- **테스트**: `tests/unit/create-pr-ops.test.mjs` (verify-plan + 응답 계약), `tests/unit/create-pr-spec.test.mjs` (PLAN.md 파서 + parseArgs + finalize 상태 머신 + scope-aware gate + 동시 실행 보호 등 fragile 영역 격리 검증)
- **Known limits**: `git merge --ff-only`는 실행 중 remote 변경 시 실패 (`sync_status: ff_failed`) · stash pop 충돌 시 reflog 영구 보존 (수동 복구) · BLOCKED/BEHIND mergeStateStatus 시 `pending` 반환 — AI 가 CI 통과 후 재시도 또는 수동 머지 · multi-commit은 `commit --files` 수동 분할 · `--key=value` 형식 미지원 (모든 명령 `--key value` 형식 사용)
- **Last updated**: 2026-05-14 (v2 통합 — 8 명령, mode 필드, fail-loud finalize, 코드블록/HTML주석 strip, 동시 실행 보호, requireArg 타입 강제, 멱등 PR 생성. v2.1 갱신: 동시 실행 보호 30s→30min, BLOCKED branch warning(string)→warnings(array) 통일. v2.2 갱신: Mode B `ship-worktree` 에 Worktree Commit Requirement/`commit_required` 응답 계약 명시)
