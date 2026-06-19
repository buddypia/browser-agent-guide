# Git Workflow Rules

## ID: R-CM-008
## Severity: critical
## Enforced by: commit-guard, destructive-git-guard

### Rules

1. **커밋 메시지**: Conventional Commits 형식 (feat:, fix:, refactor:, docs:, test:, chore:)
2. **커밋 단위**: 논리적으로 독립된 변경 단위. 하나의 커밋에 여러 기능 혼합 금지
3. **Force Push 금지**: main/master 브랜치에 force push 절대 금지 (destructive-git-guard)
4. **브랜치 전략**: feature/ → main (GitHub Flow). Feature PR은 squash merge로 main에 직접 통합. develop 브랜치 없음. 근거: Git Flow 원작자 Vincent Driessen 2020 note — continuous delivery 팀은 GitHub Flow 권장.
5. **파괴적 Git 명령 차단**: reset --hard, checkout ., clean -f, stash clear, push --force, rebase 등 destructive-git-guard가 차단. (사용자 결정 2026-06-06 — `git branch -D` 는 차단 목록에서 제거: 미머지 branch 강제 삭제 허용. remote main 삭제는 git-push-redirect 가 별도 차단.)
   - **`git restore` blast-radius scoped (사용자 결정 2026-06-16)**: stash drop(단일) 허용 / clear(전체) 차단 선례와 동형으로, `git restore <명시적 단일·소수 파일>` 은 허용하고 `git restore .` / glob / 디렉토리(`src/`) / magic pathspec(`:/`) / `..` traversal(`foo/..`) / command substitution(`$(...)`) / brace·변수 확장(`{.,x}`, `$X`) / pathspec 부재 같은 광역 blast radius 만 차단한다. regex 가 아닌 tokenizer 기반 `classifyRestore()` 로 판정하여 `git -C <path> restore .` 같은 global option 우회를 닫는다. `--staged` 는 working tree 미접촉이라 항상 허용. (codex/antigravity 어댑터는 본체 `run` 위임으로 자동 상속.)
     - **R-CM-028 boundary (배포 분리)**: 본 완화는 관점 1(brief2dev 자체, 단일 사용자 로컬) 의 `.claude/hooks/destructive-git-guard.mjs` 에만 적용된다. 관점 2(scaffold target / 생성 프로젝트) 의 `templates/hooks/destructive-git-guard.mjs` 는 독립·보수 baseline(다양·프로덕션 환경 안전망)으로 유지하며, 프로젝트 소유자가 필요 시 직접 완화한다. 두 hook 은 이미 독립적으로 진화한 별도 파일이다.
6. **AI commit 정책 (worktree-aware)**: AI 의 git commit 은 다음 정책으로 commit-guard가 자동 강제한다.
   - **main 직접 commit 차단**: 멀티 터미널 동시 작업 시 코드 경합 회피. worktree 브랜치 안에서는 commit 허용. **AI 호출 시 `git -C <worktree-path>` 명시 권장** — chained `cd .worktrees/<br> && git commit` 은 hook 평가 시점 cwd 가 main 으로 인식되어 차단되는 함정 회피 (P0 cluster PR 3 사례, 사용자 결정 2026-05-23 — learnings `git-bash-needs-explicit-git-C`).
   - **`git commit --amend` 항상 차단**: 멀티 터미널에서 push 충돌 + history rewrite 위험. 메시지 수정은 `reset --soft HEAD~1 + 새 commit` 또는 새 commit 으로 정정.
   - **브랜치 생성 차단**: `git checkout -b`, `git switch -c`, `git branch <name>` 차단. 대신 **표준 진입점** `make wt.new BR=feature/<task>` (또는 `node .claude/scripts/worktree-new.mjs --branch feature/<task>`) 사용 — fetch + ff main + add origin/main 기준으로 stale base 함정 차단. CLI agnostic (Claude/Codex/Gemini 공통).
   - **`/create-pr` 진행 중 예외**: `.tmp/create-pr-active` 파일 존재 시 commit + branch create 허용 (단 amend 는 항상 차단). `/create-pr` 사용 시 feature 브랜치 + commit + PR + squash merge 자동 처리.
   - **`git commit --dry-run` 허용**: 검증용이므로 실제 commit 아님.
7. **stash 안전 정책 (사용자 결정 2026-05-18 — clear-only 완화)**: AI 의 `git stash clear` 만 차단된다. 모든 stash entry 를 일괄 삭제하며 reflog 없이 복구 불가능하기 때문이다. `git stash push` / `git stash save` / 인수 없는 `git stash` / `git stash drop` / `apply` / `pop` / `list` / `show` / `branch` 는 모두 허용한다. 이전의 push/save/no-arg 차단 (멀티 터미널 untracked 손실 우려) 은 사용자 판단으로 stash 활용성을 우선하여 해제됨. drop (단일 entry) 은 허용하되 clear (전체 일괄) 만 차단하여 실수 시 피해 범위를 제한한다.
8. **.gitignore 필수**: .env, node_modules, .DS_Store, 빌드 산출물 등 추적 제외
9. **Multi-worktree superset 감지 (사용자 결정 2026-05-14)**: AI 가 동시에 복수의 worktree 를 `.worktrees/` 에 생성해서 진행하는 환경에서, 한 세션이 다른 세션의 commit 을 superset 으로 squash merge 하면 후자의 worktree 가 의미를 잃고 silently 흡수된다. 본 룰은 `ops.mjs#shipWorktree` 의 fetch 직후 (merge 전) `detectExternalSupersetRisk()` 를 실행하여 다음을 감지한다.
   - 본 worktree 의 변경 파일 set (`git diff origin/main..HEAD --name-only`)
   - origin/main 의 최근 24h commit 들이 건드린 파일 set (단일 `git log origin/main --since=24h.ago --name-only --format="%H %s"` 호출, blank-line block separator 로 commit 별 파일 list 파싱 — N+1 child process spawn 회피)
   - 두 set 의 intersection 1+ 시 ship-worktree response 의 `warnings[]` 배열에 superset 위험 항목 추가
   - **차단 X (Reversible default)**: 사용자가 의도적 fix 또는 merge conflict resolution 진행 가능. AI 가 warnings 인지 후 사용자에게 명시적 reconcile 안내해야 한다 (R-CM-016 Rule 10 User Sovereignty 정합).
   - **fail-open**: git 명령 실패 시 silent skip (R-CM-006 Rule 2 정합).
   - **회귀 차단**: `tests/unit/create-pr-superset-detection.test.mjs` 가 detection function 의 stub gitFn 으로 file overlap / no-overlap / 24h window edge / 빈 input edge 검증.
