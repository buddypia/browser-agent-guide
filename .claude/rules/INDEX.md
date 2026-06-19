# Rule Registry (always-on 인지 보존 인덱스)

> 이 파일은 frontmatter 없는 always-on 파일이다. 목적: rule 전문을 매 세션 주입하지 않고도 **"어떤 rule이 존재하며 언제 전문이 로드되는지"** 를 AI가 항상 알게 한다 (Claude Code large-codebase best-practice: lean root + progressive disclosure).
>
> 로딩 메커니즘: rule `.md` 파일에 `paths:` frontmatter가 있으면 **conditional** (해당 경로 편집 시 전문 로드), 없으면 **always** (매 세션 전문). 검증 계약은 `.claude/rules/MANIFEST.json` + `validate-rules.mjs` (VR6/VR7).

## Always-on (전문 매 세션 — 진짜 broadly-applicable)

| Rule | File | 사유 |
|---|---|---|
| R-CM-008 | common/git-workflow.md | 거의 모든 세션 git 사용 + 소형(28L). 전환 ROI 음수 |
| R-CM-010 | common/verification-before-completion.md | 모든 완료 주장에 보편 적용 (CRITICAL). conditional化 시 거버넌스 구멍 |
| R-PL-003 | pipeline/scaffold-completeness.md | scaffold 산출 경로 트리거 (기존 conditional 유지) |
| (generated) | rules/generated/INDEX.md | rules-as-code predicate 인덱스 (auto-gen, always-on) |

## Conditional (해당 경로 편집 시 전문 로드 — trigger 요약)

| Rule | File | Trigger (전문 로드 조건) |
|---|---|---|
| R-CM-016 | common/anti-sycophancy.md | business-analyzer/market-researcher/mvp-scoper 스킬 + 파이프라인 run (분석 단계 전용 — 룰 자체 Rule 3 선언) |
| R-CM-017 | common/gstack-native-patterns.md | SKILL.md / `.claude/scripts/*.mjs` 작업 (프로세스 패턴) |
| R-CM-028 | common/two-perspective-boundary.md | rule/hook/SKILL 신규·수정 (boundary 분기 자문). always-on 트리거는 CLAUDE.md "새 기능 추가 전 자문" 5번이 보존 |
| R-CM-029 | common/karpathy-coding-discipline.md | 코드 파일 / scripts / hooks 편집 (코드 작성 직전 규율) |
| R-CM-030 | common/worktree-auto-ship.md | create-pr / `.worktrees` / shipping·pre-ship guard (ship 시점). Stop BLOCK은 worktree-shipping-guard가 항상 강제 |
| R-CM-031 | common/autonomous-default-policy.md | brief2dev-orchestrator / business-analyzer / 파이프라인 run (결정 흐름) |
| R-CM-032 | common/archive-reuse-discipline.md | archive-and-reset / archive-similarity / archive-index (archive 재사용) |
| R-CM-033 | common/followup-debt-tracking.md | create-pr / followup-debt-tracker (PR 후속 부채) |
| R-CM-034 | common/worktree-workflow.md | `.worktrees/**` / worktree scripts·hooks / create-pr / Makefile (worktree 운영 가이드) |
| R-PL-001 | pipeline/stage-output-quality.md | `.brief2dev/runs/**` / stage-output schema (파이프라인 스테이지 산출) |
| R-PL-002 | pipeline/handoff-protocol.md | `.brief2dev/runs/**` (스테이지 핸드오프) |
| R-CM-001..027 등 | common/*.md (frontmatter 보유) | 각 파일 frontmatter `paths:` + MANIFEST `paths_patterns` 참조 |

> 언어별 룰(typescript/dart/rust)은 MANIFEST `categories.<lang>` 의 `paths_patterns`(확장자)로 conditional.
> 전체 룰 본문·강제는 해당 파일 + `.claude/rules/MANIFEST.json` 참조. 본 INDEX는 always-on 인지 보존용 — 변경 효력은 룰 파일에 있다.
