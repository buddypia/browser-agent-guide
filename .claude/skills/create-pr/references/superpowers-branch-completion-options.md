# Superpowers Branch Completion Options

> Source: `oss/superpowers/skills/finishing-a-development-branch/SKILL.md`
> Adaptation: brief2dev `create-pr` Mode B에 맞춰 종료 선택 원칙만 흡수. 원본 skill의 local merge/discard 절차는 직접 배포하지 않는다.

## Core Principle

개발 branch 완료는 "작업 끝"이 아니라 통합 의사결정이다. 검증 결과를 먼저 확인하고, 그 다음 사용자가 선택할 수 있는 종료 경로를 명확히 제시한다.

## Completion Options

| Option | brief2dev action | Worktree handling | Safety rule |
|--------|------------------|-------------------|-------------|
| PR 생성 | `create-pr ship-worktree` | 자동 정리(기본값), `--no-cleanup`으로 보존 선택 | uncommitted changes가 있으면 중단 |
| 로컬 병합 | `create-pr` 자동화 밖의 고위험 작업 | 병합 후 별도 cleanup 필요 | main sync와 q.check 재검증 전 완료 주장 금지 |
| 보관 | 아무 자동 정리도 하지 않음 | worktree 유지 | `PLAN.md`에 paused/next action 명시 |
| 폐기 | destructive 작업 | worktree/branch 삭제 | 사용자의 typed confirmation 필요 |

## Before Presenting Options

1. 현재 branch와 worktree path를 확인한다.
2. `PLAN.md`에 미완료 체크박스가 있는지 확인한다.
3. 변경이 커밋됐는지 확인한다.
4. 최신 verification evidence를 확인한다.
5. base branch가 `main`인지, 또는 다른 base가 필요한지 명시한다.

## Recommended Prompt Shape

brief2dev에서는 원본의 4옵션을 그대로 쓰기보다 현재 자동화와 맞는 선택지만 노출한다.

```text
현재 worktree는 검증된 상태입니다. 다음 중 선택할 수 있습니다.

1. PR 생성: create-pr Mode B로 push + PR 생성
2. 보관: worktree와 branch를 그대로 유지하고 PLAN.md handoff만 남김
3. 폐기: typed confirmation 후 worktree/branch 삭제

로컬 main 병합이 필요하면 별도 요청으로 처리합니다.
```

## Do Not

- 테스트나 `PLAN.md` 확인 없이 완료 옵션을 제시하지 않는다.
- PR 생성 후 자동 cleanup을 기본값으로 삼지 않는다.
- discard를 암묵적으로 실행하지 않는다.
- `git reset --hard`, `git clean`, `git checkout --`로 정리하지 않는다.

## Mapping To Existing Automation

| Superpowers 원본 | brief2dev 매핑 |
|------------------|----------------|
| verify tests | `make q.check`, `npm run validate`, 또는 작업별 proving command |
| push and create PR | `node .claude/scripts/create-pr/ops.mjs ship-worktree ...` |
| keep branch as-is | worktree 보존 + `PLAN.md` handoff |
| discard | 사용자 typed confirmation 후 destructive guard 규칙 안에서 처리 |
