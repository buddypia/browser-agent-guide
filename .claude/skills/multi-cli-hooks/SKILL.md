---
name: multi-cli-hooks
description: |
  Claude Code 본체 hook 을 Codex CLI(및 Antigravity/Gemini)로 확장하는 다중 CLI hook 작성 스킬.
  결정 로직 1벌(본체 hook 의 run()) + 얇은 어댑터(cli-adapter-utils.runAdapter) + 등록 codegen 으로
  "한 번 작성, 여러 CLI 강제"를 달성한다. 공식 hooks 문서 원문(references/)을 SSOT 로 항상 참조한다.

  "다중 CLI hook", "Codex hook 만들어줘", "본체 hook 을 Codex 로", "codex 어댑터 생성",
  "multi-cli-hooks", "hook 다중 CLI 지원" 등의 요청으로 트리거된다.
---

# Multi-CLI Hooks (다중 CLI hook 작성)

> **핵심 콘셉트**: hook 의 **결정 로직은 본체 1벌**(`.claude/hooks/<name>.mjs` 의 `export run()`), CLI 차이는 **얇은 어댑터**가 흡수. Claude·Codex hook 계약은 ~90% 동일하고 차이는 5개뿐 — 그 5개만 어댑터 + codegen 이 처리한다.

---

## 항상 먼저 읽을 것 (references — SSOT)

이 스킬은 **공식 문서 원문**을 SSOT 로 참조한다. spec 주장 전 반드시 해당 파일을 인용한다 (R-CM-029 Rule 6 DETECT→FETCH→IMPLEMENT→CITE — 기억/추측 금지).

| 파일 | 내용 | 원천 |
|------|------|------|
| `references/claude-code-hooks.md` | Claude Code Hooks 공식 원문 (전체 이벤트·입출력·핸들러) | https://code.claude.com/docs/en/hooks |
| `references/codex-cli-hooks.md` | Codex CLI Hooks 공식 원문 (이벤트·config·trust·schema) | https://developers.openai.com/codex/hooks |
| `references/cross-cli-hook-mapping.md` | 두 계약의 차이를 정규화한 매핑표(합성) — 5대 차이 + gotchas | 위 두 문서에서 파생 + 적대적 검증 |

> Antigravity/Gemini 계약은 `https://geminicli.com/docs/hooks/` 인용. 본 스킬은 Claude+Codex 가 1차 대상이며 Antigravity 는 기존 어댑터 재사용 수준으로만 다룬다.

---

## 언제 쓰나

- 이미 있는(또는 새로 만든) Claude 본체 hook 을 **Codex CLI 에서도 동작**시키고 싶을 때.
- 새 가드/주입 hook 을 처음부터 **다중 CLI 전제**로 설계할 때.
- `.codex/hooks.json` 이 본체 hook 과 동기화됐는지 점검·보정할 때.

## Not For / Boundaries

- **Claude 단독 hook 생성**은 이 스킬이 아니라 `hook-creator` 스킬 + R-CM-006 절차(hook-registry → regen-hooks-settings → audit)가 담당. 이 스킬은 그 위에 **Codex 어댑터 + `.codex/hooks.json` 등록**만 얹는다.
- **Stage output / 파이프라인 산출물 생성**과 무관 — 개발 인프라 메타 도구.
- **scaffold 출력(`output/<slug>`) 대상 아님** — §boundary 참조 (R-CM-028 배포 분리, 관점 1 brief2dev 자체 전용).
- 9개 겹치는 이벤트 밖(예: SessionEnd, PostToolBatch)은 **Codex 등가물이 없다** — 멀티-CLI 강제는 부분집합. 동등성 날조 금지.
- **(핸드오프) 이 hook 작업이 스킬도 동반하면** (예: hook 과 짝이 되는 스킬을 함께 저작·포팅) → `multi-cli-skills` 로 스킬 portability 도 처리한다. 훅·스킬은 별개 메커니즘이지만 한 작업이 둘을 걸칠 수 있다.

---

## 핵심 원리

```
                 결정 로직 (SSOT, 1벌)
        .claude/hooks/<name>.mjs  →  export run(data)
                 │                         │
   (Claude 네이티브)                  (어댑터 위임)
   settings.json#hooks         .claude/hooks/codex/<name>.mjs
        │                       └─ runAdapter(run, {cli:'codex'})
   node <name>.mjs                       │
                              .codex/hooks.json#hooks.<Event>
```

- **본체 hook** = 순수 결정 함수. Claude stdin 형식 `{tool_name, tool_input, cwd, ...}` 가정. CLI 무지.
- **어댑터** = 17줄. `cli-adapter-utils.mjs#runAdapter` 가 stdin 정규화 → `run()` → CLI 출력 방언 변환. **도메인 로직 0.**
- **차이 5개만 흡수** (cross-cli-hook-mapping.md §2~5): ① 등록 파일 ② 경로 변수 ③ tool 이름 ④ 출력 방언 ⑤ 활성/신뢰.

### 재사용 (재구현 금지)

`cli-adapter-utils.mjs` 의 export 를 그대로 쓴다 (schema/IO 재구현 금지):

- `runAdapter(runFn, {cli, eventName})` — 어댑터 표준 진입점 (이것만 호출)
- `normalizePayload(data, cli)` — Codex/Antigravity stdin → Claude 형식
- `mapAntigravityToolName` / `buildCliEmission` / `emit` / `augmentAntigravityDenyReason`

---

## Workflow

### A. 기존 본체 hook 을 Codex 로 확장 (가장 흔한 경우)

```
1. 본체 hook 확인 → .claude/hooks/<name>.mjs 에 export run(data) 존재  → verify: grep "export.*function run"
2. scaffolder 실행 (dry-run 먼저)
   node .claude/skills/multi-cli-hooks/scripts/scaffold-multi-cli-hook.mjs \
     --name <name> --event <Event> --tools <bash|write|edit> --dry-run
3. 검토 후 실제 적용 (--dry-run 제거)                                   → 산출: codex 어댑터 + .codex/hooks.json 패치
4. 같은 턴에 검증 (§검증)                                              → verify: echo stdin | node 어댑터
5. MULTI-CLI.md 매핑표에 본체↔codex 행 추가                            → verify: grep <name> .claude/hooks/MULTI-CLI.md
```

### B. 새 hook 을 처음부터 다중 CLI 로

```
1. 본체 작성: templates/body-hook.template.mjs 복사 → .claude/hooks/<name>.mjs
   (명명 R-CM-022 canonical suffix: -guard/-check/-injector/-warning ...)
2. Claude 등록 (R-CM-006): hook-registry.mjs entry 추가 → node regen-hooks-settings.mjs → node audit-rule-enforcement.mjs
3. 위 A.2~5 (Codex 어댑터 + 등록 + 검증 + MULTI-CLI.md)
```

> **DETECT 먼저**: 어떤 이벤트/매처가 맞는지 불확실하면 `references/cross-cli-hook-mapping.md §1` (이벤트 parity) + `§2` (tool 이름)로 확인. 이벤트가 claude-only(SessionEnd 등)면 Codex 어댑터를 만들지 말 것.

---

## scaffolder 사용법

`scripts/scaffold-multi-cli-hook.mjs` — 기존 본체 hook → Codex 어댑터 생성 + `.codex/hooks.json` 패치(idempotent, atomic). **`regen-hooks-settings.mjs` 가 안 채우는 `.codex/hooks.json` codegen 갭을 보완**한다.

```bash
node .claude/skills/multi-cli-hooks/scripts/scaffold-multi-cli-hook.mjs \
  --name commit-guard --event PreToolUse --tools bash --dry-run
```

| 옵션 | 의미 |
|------|------|
| `--name <hook>` | 본체 hook 이름 (`.claude/hooks/<name>.mjs` 존재해야 함) |
| `--event <Event>` | Codex 이벤트 (PreToolUse/PostToolUse/Stop/SessionStart/...) |
| `--tools <csv>` | 중립 tool 토큰 (`bash,write,edit,multiedit,read`) → Codex matcher 자동 확장 |
| `--matcher <re>` | 자동 계산 override (직접 정규식) |
| `--dry-run` | 쓰지 않고 계획 + 어댑터 미리보기 |
| `--json` | 기계 판독 출력 |
| `--force` | 이미 등록돼 있어도 재작성 |

- tool→matcher 확장은 `cross-cli-hook-mapping.md §2` 의 SSOT 표를 따른다 (bash→`Bash|shell|...`, write/edit→`apply_patch`).
- 이미 같은 command 가 등록돼 있으면 **SKIP**(idempotent). 본체 hook 부재 시 **에러**(fail-soft).

---

## 어댑터 계약 (반드시 지킬 것)

`references/cross-cli-hook-mapping.md §3~5` + `cli-adapter-utils.mjs` 주석이 SSOT. 핵심:

1. **exit0 + stdout JSON 으로만 block/deny** (`buildCliEmission` 강제). `exit2 + JSON + empty-stderr` 는 Codex Stop 에서 `did not write a continuation prompt to stderr` 런타임 오류 → **금지**.
2. **Fail-open** (R-CM-006 Rule 2): 어댑터/본체 에러 → `process.exit(0)` passthrough. silent BLOCK 금지.
3. **Claude 전용 필드를 Codex 로 흘리지 말 것**: ask/defer/continue/stopReason/suppressOutput/updatedMCPToolOutput 은 Codex 에서 hook 을 **FAILED 처리**한다.
4. **PermissionRequest ≠ PreToolUse**: 출력 스키마가 다르다 — `decision.behavior`(중첩) vs `permissionDecision`(flat). 혼용 금지.
5. **경로**: 어댑터 등록 command 는 `node "$(git rev-parse --show-toplevel)/.claude/hooks/codex/<name>.mjs"`. **`${CLAUDE_PROJECT_DIR}` 는 Codex 에 없다.**
6. **tool_name=apply_patch**: Codex 파일 편집은 어떤 별칭으로 매칭됐든 입력 tool_name 이 항상 `apply_patch`.
7. **어댑터 위치는 서브디렉토리** `.claude/hooks/codex/` — top-level `.claude/hooks/*.mjs` 에 두면 ecosystem-health-guard **E1 CRITICAL(죽은 hook) Stop BLOCK**. 서브디렉토리는 single-level scan 으로 자동 면제.

---

## Codex 활성화 (배포 시점 함정)

어댑터를 만들어도 Codex 가 안 막으면 다음을 확인 (`references/codex-cli-hooks.md`):

- `[features] hooks = true` (config.toml 기본값이나 admin 이 requirements.toml 로 off 가능)
- **per-hook trust**: 비-managed command hook 은 해시 기반 review+trust 필요. **어댑터 .mjs 를 편집하면 해시가 바뀌어 재신뢰 필요** (`/hooks` 또는 `--dangerously-bypass-hook-trust`).
- project-local `.codex/` 는 레이어 신뢰 시에만 로드.
- 머신-로컬 env(GIT_WORK_TREE 등)는 `.codex/config.toml`(untracked)가 담당 — `.codex/hooks.json`(tracked)과 분리.

---

## boundary (R-CM-028) — 관점 1 전용, 배포 분리

본 스킬과 생성 어댑터는 **관점 1(brief2dev 자체) 전용**이다 (boundary-divergent, 배포 분리):

- scaffold 출력(`output/<slug>`)에는 codex/antigravity 어댑터를 **배포하지 않는다** — 생성 프로젝트는 사용자가 자기 CLI 환경을 결정.
- `project-scaffolder/references/deployed-skills.json#excluded` 에 사유와 함께 등록 (validate-deployed-skills drift 방지).
- 근거: 멀티-CLI 어댑터는 brief2dev 개발자의 로컬 Claude+Codex 병렬 작업 가드용. 생성 프로젝트의 단일-프로젝트 lifecycle 과 의미가 다름.

---

## 검증 (same-turn 의무 — R-CM-010)

생성 직후 같은 턴에 실행하고 결과를 보고한다 (Generation-Verification Loop):

```bash
# 1. 구문
node --check .claude/hooks/codex/<name>.mjs

# 2. 어댑터 happy/deny/error-safety (stdin 주입)
echo '{"tool_name":"shell","tool_input":{"command":"echo ok"}}' | node .claude/hooks/codex/<name>.mjs
echo '{}' | node .claude/hooks/codex/<name>.mjs        # error-safety → exit0 passthrough

# 3. 어댑터 lib 회귀
npx vitest run tests/unit/cli-adapter-utils.test.mjs

# 4. 등록 정합 (.codex/hooks.json 유효 JSON + command 경로 실재)
node -e "JSON.parse(require('fs').readFileSync('.codex/hooks.json','utf8'))"
```

Pre-Commit Edge Case Check 5축(empty/null · whitespace/CRLF · 의도 주석 · adversarial mutation · cross-ref)을 어댑터/스크립트 변경에 적용 (R-CM-010 Rule 7.3).

---

## 안티패턴

- 어댑터에 도메인 로직 인라인 → 본체 SSOT 분기. `runAdapter` 위임만.
- `exit2 + JSON` 혼합 → Codex Stop 런타임 오류. exit0 + stdout JSON.
- 어댑터를 top-level `.claude/hooks/` 에 배치 → E1 CRITICAL Stop BLOCK. `codex/` 서브디렉토리 필수.
- `${CLAUDE_PROJECT_DIR}` 를 Codex command 에 사용 → 변수 부재로 경로 실패.
- claude-only 이벤트(SessionEnd 등)에 Codex 어댑터 날조 → 동등성 거짓.
- spec 을 기억으로 단언 → references/ 원문 인용 의무 (R-CM-029 Rule 6).
- `.codex/hooks.json` 수동 편집 후 본체와 drift 방치 → scaffolder 로 재생성.

---

## Pre-flight Checklist

| ID | 항목 | 필수 |
|----|------|------|
| PF-001 | 본체 hook (`.claude/hooks/<name>.mjs`, export run) 존재 | ✅ |
| PF-002 | 공식 문서 원문 references/ (claude-code-hooks.md, codex-cli-hooks.md) 존재 + spec 인용 | ✅ |

## Post-flight Checklist

| ID | 항목 | 필수 |
|----|------|------|
| POF-001 | 생성 어댑터 구문 검사 (node --check) 통과 | ✅ |
| POF-002 | 어댑터 happy/error-safety stdin 주입 검증 (exit0 passthrough) | ✅ |
| POF-003 | `.codex/hooks.json` 유효 JSON + command 경로 실재 | ✅ |
| POF-004 | MULTI-CLI.md 매핑표에 본체↔codex 행 동기화 | — |

---

## Maintenance

- **Sources**:
  - Claude Code Hooks 공식: https://code.claude.com/docs/en/hooks → 원문 `references/claude-code-hooks.md`
  - Codex CLI Hooks 공식: https://developers.openai.com/codex/hooks → 원문 `references/codex-cli-hooks.md`
  - Antigravity/Gemini Hooks: https://geminicli.com/docs/hooks/
  - brief2dev: `cli-adapter-utils.mjs`, `.claude/hooks/MULTI-CLI.md`, R-CM-006/R-CM-022/R-CM-028/R-CM-036
- **Last updated**: 2026-06-15 (공식 문서 원문 fetch + 5-agent 적대적 검증 매핑)
- **Known limits**:
  - 공식 문서는 변한다 — references/ 의 `updated_at` frontmatter 확인 후 stale 시 `.md` 재fetch (`curl -sL <url>.md`).
  - Codex tool 별칭(shell/run_shell/...)은 brief2dev 관례(UNVERIFIED) — 공식 canonical 은 Bash/apply_patch/MCP.
  - parity 는 9 이벤트 부분집합 — claude-only 이벤트는 Codex 강제 불가.
  - scaffolder 는 Codex 어댑터+`.codex/hooks.json` 만 자동화. Claude 본체+hook-registry 등록은 hook-creator/R-CM-006 절차.
  - 3-surface(Claude/Codex/Antigravity) parity 자동 검증기는 아직 부재 — 수동 점검.
