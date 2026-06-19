---
title: Cross-CLI Hook 계약 매핑 (Claude Code ↔ Codex CLI)
purpose: 두 CLI 의 hook 계약 차이를 단일 표로 정규화 — 어댑터/codegen 이 흡수해야 할 4대 차이의 SSOT
updated_at: 2026-06-15T02:34:17Z
derived_from:
  - ./claude-code-hooks.md (Claude 공식 원문, https://code.claude.com/docs/en/hooks)
  - ./codex-cli-hooks.md (Codex 공식 원문, https://developers.openai.com/codex/hooks)
verification: 5-agent 워크플로 deep-digest + 적대적 검증 (28/30 확인, 2 정정 반영). 본 문서는 합성(요약) — 원문 검증이 필요하면 위 두 파일 직접 인용.
referenced_by: ./../SKILL.md
note: 이 문서는 "합성"이다. 원문 보존 SSOT 는 claude-code-hooks.md / codex-cli-hooks.md. spec 주장은 항상 원문으로 재확인.
---

# Cross-CLI Hook 계약 매핑

> **한 줄 요약**: 두 CLI 의 hook 은 **이벤트 9종에서 겹치고**, stdin/hooks.json 구조·exit-code 규약이 거의 같다. 차이는 **① 등록 파일 ② 경로 변수 ③ tool 이름 ④ 출력 방언 ⑤ 활성/신뢰 모델** 5개로 수렴한다. 결정 로직은 1벌(본체 hook), 이 5개 차이만 어댑터(`cli-adapter-utils.mjs`) + codegen 이 흡수한다.

## 0. 정직한 범위 (Parity = SUBSET)

- **겹치는 이벤트는 ~9종뿐**: SessionStart · PreToolUse · PermissionRequest · PostToolUse · UserPromptSubmit · SubagentStart · SubagentStop · Stop · PreCompact/PostCompact.
- Claude 의 나머지 **19+ 이벤트는 claude-only** (SessionEnd · PostToolBatch · FileChanged · ConfigChange · Setup · InstructionsLoaded · UserPromptExpansion · MessageDisplay · PostToolUseFailure · PermissionDenied · Notification · TaskCreated/TaskCompleted · TeammateIdle · StopFailure · CwdChanged · WorktreeCreate/Remove · Elicitation/ElicitationResult). → **Codex 어댑터 경로 없음.**
- 특히 **brief2dev 의 SessionEnd hook (pipeline-memory-extractor 등) 은 Codex 등가물이 없다** — 멀티-CLI 강제는 본질적으로 부분집합이다. 동등성을 날조하지 말 것 (UNVERIFIED).

## 1. 이벤트 parity (9 overlap)

| 중립 | Claude | Codex | 차단? | 핵심 차이 |
|------|--------|-------|:----:|----------|
| 세션 시작 | SessionStart | SessionStart | Claude ✗ / Codex 부분 | matcher=source(startup\|resume\|clear\|compact). **Claude SessionStart 는 차단 불가**(exit2=stderr만). Codex 는 `continue:false` 파싱. Claude 전용: model/session_title 입력 + initialUserMessage/watchPaths/reloadSkills 출력 + CLAUDE_ENV_FILE |
| 도구 전 | PreToolUse | PreToolUse | ✓ | 아래 §3 참조. **Codex permissionDecision 은 allow/deny 만** (ask/defer/legacy 는 hook FAILED). Codex 는 Bash/apply_patch/MCP 만 가로챔 |
| 권한 요청 | PermissionRequest | PermissionRequest | ✓ | **PreToolUse 와 출력 스키마가 다름** — `hookSpecificOutput.decision.behavior`(allow\|deny\|none) 중첩 구조. PreToolUse 의 `permissionDecision`(flat) 와 혼용 불가 |
| 도구 후 | PostToolUse | PostToolUse | 결과 무효화 | matcher=tool_name. `decision:block`+additionalContext. Codex 추가: 비0 Bash exit 에도 실행. Claude 추가: updatedToolOutput/duration_ms. `updatedMCPToolOutput` 은 Codex 미지원(FAILED) |
| 프롬프트 제출 | UserPromptSubmit | UserPromptSubmit | ✓ | **matcher 무시(양쪽)**. plain stdout=context. exit2/decision:block 차단. Claude 기본 timeout 30s |
| 서브에이전트 시작 | SubagentStart | SubagentStart | ✗ | matcher=agent_type, additionalContext 주입. 진짜 차단 불가 |
| 서브에이전트 종료 | SubagentStop | SubagentStop | ✓ | matcher=agent_type. **Codex 는 exit0 시 JSON 필수**(plaintext invalid) |
| 종료 | Stop | Stop | ✓ | **matcher 무시(양쪽)**. **Codex `decision:block` 은 단순 차단이 아니라 reason 텍스트로 새 continuation prompt 를 자동 생성**(의미 다름). Codex exit0 JSON 필수. Claude 8회 연속 block cap |
| 압축 | PreCompact / PostCompact | PreCompact / PostCompact | 부분 | matcher=trigger(manual\|auto). **PostCompact: Codex 차단 가능 / Claude 차단 불가**(역) |

## 2. tool 이름 매핑 (차이 ③)

| 중립 | Claude | Codex | 비고 |
|------|--------|-------|------|
| shell-exec | `Bash` | `Bash`(canonical) | brief2dev 관례로 `shell\|run_shell\|run_shell_command\|exec_command` 별칭 추가 (공식 미보증, UNVERIFIED). `unified_exec`·`WebSearch` 는 **미가로챔** |
| file-edit | `Edit` | `apply_patch` | Codex 는 단일 파일 tool. hook 입력의 tool_name 은 **항상 `apply_patch`** (어떤 별칭으로 매칭됐든) |
| file-write | `Write` | `apply_patch` | Edit/Write/MultiEdit 모두 apply_patch 로 collapse |
| file-multi | `MultiEdit` | `apply_patch` | 동상 |
| mcp | `mcp__<srv>__<tool>` | `mcp__<srv>__<tool>` | matcher `mcp__memory__.*` 에서 **`.*` 필수** (`mcp__memory` 단독은 매칭 0) |
| web-search | `WebSearch` | (미가로챔) | Codex PreToolUse/PostToolUse 가 WebSearch 에 발화 안 함 |
| web-fetch | `WebFetch` | (없음) | — |
| agent-spawn | `Agent` | (tool 아님) | Codex 는 SubagentStart/Stop 이벤트로 대응 (tool matcher 아님) |

> **함정**: Codex 가로채기는 불완전하다 — Bash/apply_patch/MCP 외 경로(unified_exec, WebSearch)는 hook 이 발화하지 않는다. **guardrail 이지 enforcement boundary 가 아니다.** Codex 는 차단된 Bash 를 다른 tool 경로로 우회할 수 있다.

## 3. 출력 방언 (차이 ④)

| 동작 | Claude | Codex | brief2dev 어댑터 계약 |
|------|--------|-------|----------------------|
| ALLOW (PreToolUse) | exit0 + `hookSpecificOutput.permissionDecision:'allow'` (+updatedInput) | 동일. **단 ask/defer 거부**(FAILED) | `buildCliEmission` 이 exit0+JSON |
| DENY (PreToolUse) | exit0 + `permissionDecision:'deny'`+reason. alt: `{decision:'block',reason}` / exit2+stderr | 동일 | **항상 exit0+stdout JSON** (아래 함정) |
| DENY (PermissionRequest) | exit0 + `hookSpecificOutput.decision.behavior:'deny'`(+message) | 동일. Codex 추가값 `behavior:'none'`(정상 승인 흐름) | 중첩 구조 — PreToolUse 와 다름 |
| ASK | `permissionDecision:'ask'` (인터랙티브) | **없음** (parsed→FAILED) | 자동화 컨텍스트 미사용 |
| 컨텍스트 주입(차단 X) | exit0 + `hookSpecificOutput.additionalContext` | 동일 | plain stdout=context 는 SessionStart/UserPromptSubmit/SubagentStart 한정 |
| STOP continue | `decision:'block'`+reason → 차단(8-cap) | `decision:'block'`+reason → **continuation prompt 자동 생성**(의미 다름). exit0 JSON 필수 | worktree-shipping-guard Codex 어댑터가 Stop block 시 reason 으로 재프롬프트됨 |
| FAIL-OPEN | 빈 출력/exit0-no-JSON = passthrough | 동일 | try/catch → `process.exit(0)` (R-CM-006 Rule 2) |

### ⚠ exit code 의미는 이벤트별로 다르다 (검증 정정 #2)

Claude exit2 는 **이벤트마다 의미가 다르다** (claude-code-hooks.md):
- **PreToolUse**: exit2 = 도구 차단
- **Stop**: exit2 = 종료 방지(턴 계속)
- **SessionStart/Setup**: exit2 = stderr 표시만(차단 안 됨)
- **WorktreeCreate**: 예외 — **any non-zero = fail**
- 그 외: exit1 = NON-blocking(진행됨!), exit2 = blocking. JSON 은 exit0 에서만 파싱.

### ⚠ Codex Stop wire-contract 지뢰 (brief2dev 고유)

`exit2 + stdout JSON + empty stderr` 조합은 Codex Stop 에서 런타임 오류(`did not write a continuation prompt to stderr`)를 낸다. → **어댑터는 block/deny 에 항상 exit0 + stdout JSON 만 사용**(`cli-adapter-utils.mjs#buildCliEmission` 에 코드로 강제 + 주석 명시).

## 4. 경로 변수 (차이 ②)

| Claude | Codex | Antigravity |
|--------|-------|-------------|
| `${CLAUDE_PROJECT_DIR}/X` | **내장 변수 없음** → `"$(git rev-parse --show-toplevel)/X"` | `~/.gemini/...` 절대 경로 (install-antigravity-hooks.mjs 가 resolve) |

> Codex 는 hook 을 **세션 cwd**(하위 디렉토리일 수 있음)로 실행 → repo-local 경로는 반드시 `$(git rev-parse --show-toplevel)` 사용. 상대 `.codex/hooks/...` 금지.

## 5. 활성 · 신뢰 모델 (차이 ⑤)

| 축 | Claude | Codex |
|----|--------|-------|
| 기본 활성 | on (disableAllHooks 로 off) | `[features] hooks=true` 기본 (deprecated alias `codex_hooks`) |
| **신뢰(trust)** | 없음 (`/hooks` 는 읽기 전용 브라우저) | **per-hook 해시 기반 review+trust** — 어댑터 .mjs 편집 시 해시 변경 → 재신뢰 필요(`/hooks` 또는 `--dangerously-bypass-hook-trust`). 새 어댑터는 신뢰 전까지 미실행 |
| 프로젝트 신뢰 | 없음 | project-local `.codex/` hook 은 `.codex/` 레이어 신뢰 시에만 로드 |
| handler type | command/http/mcp_tool/**prompt/agent** (이벤트별 부분집합) | **type:command 만** — prompt/agent/async:true 는 파싱 후 SKIP |
| 레이어 합성 | 설정 precedence(managed>local>project>plugin>user) | **additive-union** (상위가 하위를 대체 안 함) |
| dedup | command+args / URL 중복 제거 | **dedup 없음** — 매칭 hook 동시 실행 |
| 엔터프라이즈 lockdown | allowManagedHooksOnly | requirements.toml `allow_managed_hooks_only` + `[features].hooks` pin |

## 6. brief2dev 현재 상태 + 갭

| 자산 | 상태 |
|------|------|
| `cli-adapter-utils.mjs` (`runAdapter`/`normalizePayload`/`emit`/...) | ✅ 존재 — 어댑터 표준 진입점 |
| `.claude/hooks/codex/*.mjs` (어댑터 7) | ✅ 존재 (commit-guard/destructive-git-guard/worktree-* 등) |
| `.codex/hooks.json` | ✅ 존재하나 **수동 유지** |
| `MULTI-CLI.md` | ✅ 매핑 SSOT (본체↔codex↔antigravity) |
| **`regen-hooks-settings.mjs` 의 `.codex/hooks.json` codegen** | ❌ **부재 — Claude settings.json 만 생성. = 핵심 갭** (이 스킬의 scaffolder 가 보완) |
| 3-surface(Claude/Codex/Antigravity) parity 검증기 | ❌ 부재 |
| hook-registry entry 의 codex_adapter 메타 | ❌ 부재 (어댑터 매핑이 registry SSOT 밖) |

## 7. Top gotchas (체크리스트)

1. Codex Stop/SubagentStop 은 **exit0 + JSON 필수** (plaintext invalid). `exit2+JSON+empty-stderr` = 런타임 오류.
2. Codex Stop `decision:block` 은 **reason 으로 새 프롬프트 자동 생성** (단순 차단 아님).
3. Codex **parsed-but-unsupported** 필드(continue/stopReason/suppressOutput/ask/defer 등)는 hook 을 **FAILED 처리** → 어댑터는 Claude 전용 필드를 Codex 로 흘리지 말 것.
4. Codex **feature flag**(`[features] hooks=true`) + **per-hook trust** 없으면 가드가 조용히 미동작.
5. Codex **apply_patch alias** — tool_name 은 항상 `apply_patch`.
6. Codex **가로채기 불완전** — unified_exec/WebSearch 미발화 (우회 가능).
7. **경로 변수 비대칭** — Codex 에 `${CLAUDE_PROJECT_DIR}` 없음 → `$(git rev-parse --show-toplevel)`.
8. **parity = 부분집합** — 9 이벤트만 겹침. SessionEnd 등 claude-only 는 Codex 경로 없음.
9. **fail-open 의무** (R-CM-006 Rule 2) — 어댑터 에러는 무조건 exit0 passthrough.
