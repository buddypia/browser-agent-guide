# Multi-CLI Hook Adapters

이 문서는 `.claude/hooks/codex/*.mjs` 와 `.claude/hooks/antigravity/*.mjs` 에 배치된 어댑터 hook 의 거버넌스 위치를 명시한다.

## 정체

| 위치 | 등록 SSOT | audit 대상 |
|---|---|---|
| `.claude/hooks/*.mjs` (single-level) | `.claude/scripts/lib/hook-registry.mjs` + `.claude/settings.json` | I2/C4 (R-CM-024) |
| `.claude/hooks/codex/*.mjs` | `.codex/hooks.json#hooks` (tracked — 클론 즉시 존재. 머신-로컬 env 는 `.codex/config.toml` untracked 가 별도 담당) | **자동 제외** — audit 의 `listInDir(dir, '.mjs')` 가 single-level 만 스캔하므로 서브디렉토리는 처음부터 검사 대상 아님 |
| `.claude/hooks/antigravity/*.mjs` | `~/.gemini/antigravity-cli/settings.json` (사용자 home global, `install-antigravity-hooks.mjs` 가 작성) | **자동 제외** — 위와 동일 |

## 매핑

| 본체 hook | Codex 어댑터 | Antigravity 어댑터 | 사유 |
|---|---|---|---|
| `commit-guard.mjs` | `codex/commit-guard.mjs` | `antigravity/commit-guard.mjs` | main 직접 commit / amend / branch create 차단 (R-CM-008 Rule 6) |
| `destructive-git-guard.mjs` | `codex/destructive-git-guard.mjs` | `antigravity/destructive-git-guard.mjs` | reset --hard / push --force / rebase 등 파괴적 명령 차단 (R-CM-008 Rule 5) |
| `worktree-policy-guard.mjs` | `codex/worktree-policy-guard.mjs` | `antigravity/worktree-policy-guard.mjs` | main 직접 Edit/Write 차단 (R-CM-008 Rule 6, tier 기반) |
| `worktree-session-owner-guard.mjs` | `codex/worktree-session-owner-guard.mjs` | `antigravity/worktree-session-owner-guard.mjs` | 멀티세션 cross-worktree 편집/commit 차단 (R-CM-036, 2-Layer cwd-confinement + session_id) |
| `worktree-owner-tracker.mjs` | `codex/worktree-owner-tracker.mjs` | (없음 — UNVERIFIED) | worktree 생성 시 세션 소유권 사이드카(.session-owner) 기록 (R-CM-036 Layer 2). Codex `session_id` 공식 지원. Antigravity 는 Gemini AfterTool session_id 미검증으로 보류 |
| `worktree-shipping-guard.mjs` | `codex/worktree-shipping-guard.mjs` | `antigravity/worktree-shipping-guard.mjs` | 미커밋 / 미머지 worktree 시 Stop/SessionEnd BLOCK (R-CM-030) |
| `worktree-review-report-guard.mjs` | `codex/worktree-review-report-guard.mjs` | (없음 — 미배포) | worktree commit 완료 시 사람-리뷰 REVIEW.md(9섹션) 출력 강제 (R-CM-030, 마커-only 우회 갭 폐쇄) |
| `agent-worktree-guard.mjs` | `codex/agent-worktree-guard.mjs` | (없음 — UNVERIFIED) | Agent Worktree Guard ledger/checklist/owner-marker enforcement. Codex project hooks use the same Python CLI through this adapter |
| `trunk-start-warning.mjs` | `codex/trunk-session-warn.mjs` | `antigravity/trunk-session-warn.mjs` | main 진입 시 worktree 안내 컨텍스트 주입 |

## Codex 등록 (`.codex/hooks.json`) — 이벤트 매핑

등록 파일은 `.codex/hooks.json` (tracked). Codex hook spec (https://developers.openai.com/codex/hooks) 의 PascalCase 이벤트 키를 사용한다.

| Codex 이벤트 | matcher | 어댑터 |
|---|---|---|
| `PreToolUse` | `^(apply_patch\|Edit\|Write\|MultiEdit)$` | `worktree-policy-guard` |
| `PreToolUse` | `^(apply_patch\|Edit\|Write\|MultiEdit\|Bash\|shell\|run_shell\|run_shell_command\|exec_command)$` | `worktree-session-owner-guard` |
| `PreToolUse` | `^(Bash\|shell\|run_shell\|run_shell_command\|exec_command)$` | `agent-worktree-guard`, `commit-guard`, `destructive-git-guard` |
| `PostToolUse` | `^(Bash\|shell\|run_shell\|run_shell_command\|exec_command)$` | `agent-worktree-guard`, `worktree-owner-tracker` |
| `Stop` | (전체) | `agent-worktree-guard`, `worktree-shipping-guard`, `worktree-review-report-guard` |
| `SessionStart` | `startup\|resume` | `trunk-session-warn`, `agent-worktree-guard` |

머신-로컬 env (`GIT_WORK_TREE`/`GIT_DIR`) 는 `.codex/config.toml` (untracked, `worktree-init.mjs` 주입) 가 담당 — 등록 파일과 분리하여 worktree 마다 발생하던 추적 충돌을 차단 (PR #639 + 본 PR).

## 어댑터 구조 (회귀 0 보장)

각 어댑터는 본체 hook 의 export 된 `run(data)` 함수를 import 한 후 `runAdapter()` 헬퍼 1 줄로 위임한다. 본체 hook 본문은 변경되지 않으며 (LOC diff 0), 가드 도메인 로직은 본체에 단일 SSOT 로 유지된다.

```js
import { run as runCommitGuard } from '../commit-guard.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';
runAdapter(runCommitGuard, { cli: 'codex' });
```

stdin schema 변환 + CLI 별 event 이름 매핑 (Antigravity 의 BeforeTool (Gemini CLI hook spec 호환)/SessionEnd) + 응답 형식 emit 은 `.claude/scripts/lib/cli-adapter-utils.mjs` 가 담당한다.

응답 emit 계약: Codex hook spec 기준 block/deny 는 `exit 0 + stdout JSON` 을 기본으로 사용한다. `exit 2 + stderr reason` 방식과 혼합하면 Stop hook 이 `code 2 but did not write a continuation prompt to stderr` 오류를 내므로 금지한다.

## R-CM-024 / R-CM-006 audit 와의 관계

- `audit-rule-enforcement.mjs` 의 `listInDir(.claude/hooks, '.mjs')` 는 **single-level 스캔** 이므로 `codex/` 와 `antigravity/` 서브디렉토리의 `.mjs` 는 hook 자산 collection 에 포함되지 않는다. 따라서 I2 (not_registered) / C4 (unregistered_in_profile) 위반이 발생하지 않는다.
- `ecosystem-health-guard.mjs` 의 E1 검사도 single-level 가정이므로 동일하게 자동 제외.
- 만약 향후 audit 스크립트가 recursive scan 으로 변경되면 본 어댑터들의 등록 SSOT (`.codex/hooks.json` / `~/.gemini/antigravity-cli/settings.json`) 도 검사에 포함되도록 audit 측 분기 추가가 필요하다.

## worktree-owner-tracker — Codex 어댑터 지원 (Antigravity 만 한계, R-CM-036)

`worktree-owner-tracker.mjs` (PostToolUse Bash, 세션 소유권 사이드카 기록) 는 본체 `run(data)` export + `runAdapter` 패턴으로 **Claude Code + Codex 양쪽에서 사이드카를 기록**한다.

- **Codex**: `codex/worktree-owner-tracker.mjs` 어댑터가 `.codex/hooks.json#hooks.PostToolUse` 에 등록된다. `session_id` 는 Codex PostToolUse payload 의 공통 필드 ("Current Codex session id" — 공식 문서 https://developers.openai.com/codex/hooks) 이므로 Codex 세션도 owner 사이드카를 남겨 **Layer 2 (session_id 사이드카) 가 Codex 에서도 동작**한다.
- **Antigravity**: 어댑터 **부재** (UNVERIFIED) — Gemini AfterTool payload 의 `session_id` 존재를 미검증하여 추정 도입을 회피 (R-CM-029 Rule 6 Source-Driven). Antigravity 세션 worktree 는 `.session-owner` 부재 → Layer 2 미동작이나, `antigravity/worktree-session-owner-guard` 의 Layer 1 (cwd-confinement) 이 session_id 무관 결정론으로 보호하므로 cross-worktree 침범은 차단된다. Gemini AfterTool `session_id` 공식 확인 후 어댑터 추가는 후속 PR.

`tool_response` (PostToolUse exit_code 게이트) 는 `cli-adapter-utils.mjs#normalizePayload` 가 정규화 payload 에 전달한다 (PreToolUse 어댑터는 undefined — 무해).

## R-CM-028 boundary

본 어댑터들은 **관점 1 (brief2dev 자체) 전용**. scaffold target (`output/<slug>`) 에는 배포되지 않는다. scaffold 내부 프로젝트가 Codex/Antigravity 와 통합되려면 별도 PR 의 boundary 분기 검토 필요.

## R-CM-022 hook-naming 면제

`antigravity/trunk-session-warn.mjs` 와 `codex/trunk-session-warn.mjs` 는 `-warn` suffix 를 사용한다 (R-CM-022 의 카논 suffix 는 `-warning`). R-CM-022 의 적용 범위는 `.claude/hooks/*.mjs` single-level 이므로 서브디렉토리의 어댑터는 검사 대상이 아니다. `-warn` 명을 채택한 이유는 exporter README 와 외부 CLI 통합 가이드의 표준 명명 (`trunk-session-warn`) 을 따르기 위함이다.
