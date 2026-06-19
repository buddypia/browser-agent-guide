---
name: multi-cli-skills
description: |
  Agent Skills 를 어느 CLI(Claude Code / Codex / Gemini)에서도 같은 수준으로 동작하게 만드는 portability 스킬.
  Agent Skills 는 오픈 표준이라 SKILL.md 본문은 이미 portable — 이 스킬은 ① 발견 경로 wiring 확인
  ② 본문의 Claude 전용 가정 검출/수정(lint-skill-portability.mjs) ③ runtime 결합 정직 분류를 담당한다.
  공식 skills 문서 원문(references/)을 SSOT 로 항상 참조한다.

  "스킬 다중 CLI 지원", "skill portability", "Codex 에서 스킬 동작", "CLI-agnostic 스킬",
  "multi-cli-skills", "스킬 portability 검사" 등의 요청으로 트리거된다.
---

# Multi-CLI Skills (스킬 CLI-portability)

> **핵심 콘셉트**: Agent Skills 는 오픈 표준(Anthropic 2025-12 → Codex/Gemini/30+ 도구). **`SKILL.md` 본문은 이미 모든 CLI 에서 동일하게 동작**한다(훅과 정반대 — 어댑터 불요). "똑같은 수준"을 깨는 건 ① 발견 경로 ② 본문의 Claude 전용 *가정* ③ brief2dev 런타임 결합 3가지뿐.

---

## 항상 먼저 읽을 것 (references — SSOT)

spec 주장 전 공식 원문을 인용한다 (R-CM-029 Rule 6 — 기억/추측 금지).

| 파일 | 내용 | 원천 |
|------|------|------|
| `references/claude-code-skills.md` | Claude Code skills 공식 원문 | https://code.claude.com/docs/en/skills |
| `references/codex-cli-skills.md` | Codex CLI Agent Skills 공식 원문 | https://developers.openai.com/codex/skills |
| `references/cross-cli-skill-mapping.md` | CLI 계약 매핑(발견경로·표준/확장 필드·openai.yaml·Claude 전용 가정 대안) | 위 2개 + 오픈 표준 agentskills.io |
| `references/skills-portability-audit.md` | brief2dev 전체 스킬 전수 감사 분류 + remediation | 16-agent 워크플로 + 린터 |

---

## 언제 쓰나

- 새 스킬을 작성할 때 CLI-agnostic 한지 검사(`lint-skill-portability.mjs`).
- 기존 스킬의 Claude 전용 가정을 CLI-agnostic 대안으로 수정.
- Codex/Gemini 가 brief2dev 스킬을 발견하는지 확인.

## Not For / Boundaries

- **스킬 *생성* 자체**는 이 스킬이 아님 — 스킬 작성은 일반 SKILL.md 작성 + `.claude/skills/AGENTS.md` 규약. 이 스킬은 그 위에 **portability 검사/수정**만 얹는다.
- **훅 portability** 는 `multi-cli-hooks` (어댑터/codegen 영역). 스킬과 훅은 다른 메커니즘.
- **runtime-coupled 스킬의 완전 parity** 는 이 스킬 범위 밖 — brief2dev 런타임(hooks/Saga/gate) 포팅이 선행되어야 하며 그건 multi-cli-hooks + 런타임 레이어. 이 스킬은 본문 portability + 정직 분류까지.
- **scaffold 출력(`output/<slug>`) 대상 아님** — §boundary (R-CM-028 배포 분리, 관점 1 전용).
- **(핸드오프) 이 스킬 작업이 훅도 동반하면** (예: 스킬이 가드/주입 hook 을 생성·사용) → `multi-cli-hooks` 로 훅도 다중 CLI 저작한다. 위 boundary(훅 portability ≠ 스킬 portability)는 *도구 분리*이고, 본 핸드오프는 *작업이 걸칠 때*의 연결이다 — 모순 아님.

---

## 핵심 원리

### 1. 발견(discovery)은 이미 wiring 됨

공식 Codex 문서: Codex 는 `$REPO_ROOT/.agents/skills` 를 스캔하고 **symlink 를 추종**한다. brief2dev 엔 `.agents -> .claude` symlink 가 이미 존재 → `.agents/skills` = `.claude/skills`. **따라서 Codex 는 brief2dev 의 모든 스킬을 추가 작업 없이 자동 발견**한다. (Claude 는 `.claude/skills` 직접, Codex 는 `.agents` 경유, Gemini 는 `.gemini/skills` symlink 추가 시.)

→ 단일 소스 `.claude/skills/`, 발견은 symlink 가 해결. **새로 만들 wiring 없음.**

### 2. SKILL.md 본문은 오픈 표준 — 이미 portable

표준 필드(name/description/license/compatibility/metadata/allowed-tools)는 모든 CLI 공통. Claude 확장(context/model/disable-model-invocation)은 타 CLI 가 무시(깨지지 않음). 상세: `references/cross-cli-skill-mapping.md §2`.

### 3. parity 를 깨는 것 = 본문의 Claude 전용 가정 (이 스킬의 작업 대상)

| blocker | CLI-agnostic 대안 |
|---------|------------------|
| `AskUserQuestion` | 의도("사용자에 X 옵션 질문") + per-CLI (Claude: AskUserQuestion / Codex: Decision Exchange / `BRIEF2DEV_DECISION_MODE=file`) |
| `Agent(subagent_type)` / `Task` | 역할 문자열 + per-CLI 서브에이전트 매핑, 비-Claude 는 skip-and-record |
| `/code-review` `/create-pr` 등 빌트인을 *유일 경로* | 의도 + CLI 분기 (Codex `codex review` / `pre-quality-gate` Bash). R-CM-030 이 이미 CLI-agnostic verdict fallback |
| `WebFetch` | WebSearch/curl wrapper + fallback |

**NOT 문제 (portable)**: `.claude/scripts/X.mjs`(node 어디서나), `make q.X`, Bash, references 읽기.

### 4. runtime 결합은 정직 분류 (수정 아님)

`.brief2dev/` Saga · hooks · pipeline-boundary-guard · output-gate 의존 스킬은 Claude-Code 런타임에서만 강제. Codex 에서 본문은 따를 수 있으나 동일 *강제 수준* 불가 → "본문 portable + 런타임 parity 불가" 로 정직 표기. 완전 parity 는 hooks 포팅(multi-cli-hooks) 선행.

---

## Workflow

```
1. 스킬 portability 검사
   node .claude/skills/multi-cli-skills/scripts/lint-skill-portability.mjs --skill <name>
   (전수: --all --json)                                              → 분류: portable / fixable / runtime-coupled
2. fixable 이면 §3 대안 적용 (SKILL.md 본문 수정)                     → verify: 같은 스킬 재-lint → blocker 0
3. runtime-coupled 이면 SKILL.md 에 런타임 의존 명시 (수정 X, 정직 분류)
4. 신규 스킬은 작성 후 --strict 로 회귀 차단                          → verify: --strict exit 0
```

> **DETECT 먼저**: 스킬이 portable/fixable/runtime-coupled 중 무엇인지 린터로 확인 후 행동. 분류 근거는 `references/skills-portability-audit.md`.

---

## lint-skill-portability.mjs

SKILL.md 본문(frontmatter 제외)을 12 룰로 스캔 → 2-tier 분류.

```bash
node .claude/skills/multi-cli-skills/scripts/lint-skill-portability.mjs --all [--json] [--strict]
node .claude/skills/multi-cli-skills/scripts/lint-skill-portability.mjs --skill <name>
```

- **blocker**(Claude 전용 tool/빌트인 — fixable): AskUserQuestion / Task / Agent / WebFetch / builtin-slash.
- **runtime-signal**(brief2dev 런타임 결합): `.brief2dev/` 경로 / hooks / pipeline-gate / worktree / 거버넌스 정책.
- 분류: runtime-signal 1+ → runtime-coupled · blocker 1+ (runtime 0) → fixable · 둘 다 0 → portable.
- `--strict`: blocker 1+ 시 exit 1 (CI/pre-commit 회귀 차단).
- **한계 (정직)**: 보수적 surfacing 도구 — `.brief2dev`·`-guard`·`/create-pr` 언급만으로도 flag(검토 유도). 정확 경계는 per-skill 런타임 의존 검증 필요. portable 판정은 high-confidence, coupled 판정은 over-flag 가능.

---

## tool-specific 메타 (선택)

Codex UI/정책/MCP 의존은 스킬 폴더에 `agents/openai.yaml` 추가(타 CLI 무시). cross-CLI 영향 0. 상세: `references/cross-cli-skill-mapping.md §3`.

---

## boundary (R-CM-028) — 관점 1 전용, 배포 분리

본 스킬과 린터는 brief2dev 자체(관점 1) 전용 (boundary-divergent, 배포 분리). scaffold 출력에는 미배포 — `project-scaffolder/references/deployed-skills.json#excluded` 등록. 근거: brief2dev 개발자의 멀티-CLI 작업용 메타 도구. 생성 프로젝트는 자기 CLI 환경을 결정.

---

## 검증 (same-turn 의무 — R-CM-010)

```bash
node --check .claude/skills/multi-cli-skills/scripts/lint-skill-portability.mjs
node .claude/skills/multi-cli-skills/scripts/lint-skill-portability.mjs --all --json   # 전수 분류
# 수정한 스킬 재검사 → blocker 감소 확인 (Red-Green)
node .claude/skills/multi-cli-skills/scripts/lint-skill-portability.mjs --skill <fixed> --json
```

---

## 안티패턴

- 발견 wiring 을 새로 만들기 → 불요. `.agents -> .claude` symlink + Codex symlink 추종이 이미 해결.
- runtime-coupled 스킬을 "fix" 한다고 본문 억지 수정 → 런타임 결합은 본문 문제 아님. 정직 분류 + hooks 포팅(multi-cli-hooks)이 정답.
- Codex 에서 모든 스킬이 같은 수준이라 주장 → runtime-coupled 다수는 가드 부재로 강제 수준 다름. 동등성 날조 금지(UNVERIFIED).
- spec 을 기억으로 단언 → references/ 원문 인용 (R-CM-029 Rule 6).

---

## Pre-flight Checklist

| ID | 항목 | 필수 |
|----|------|------|
| PF-001 | 공식 문서 원문 references/ (claude-code-skills.md, codex-cli-skills.md) 존재 + spec 인용 | ✅ |
| PF-002 | 대상 SKILL.md 존재 확인 | ✅ |

## Post-flight Checklist

| ID | 항목 | 필수 |
|----|------|------|
| POF-001 | lint-skill-portability.mjs 구문 검사 (node --check) 통과 | ✅ |
| POF-002 | 수정 스킬 재-lint 시 blocker 감소(Red-Green) 확인 | ✅ |
| POF-003 | runtime-coupled 스킬은 본문 강제 수정 금지 — 정직 분류만 | — |

---

## Maintenance

- **Sources**:
  - Claude Code skills 공식: https://code.claude.com/docs/en/skills → `references/claude-code-skills.md`
  - Codex CLI Agent Skills 공식: https://developers.openai.com/codex/skills → `references/codex-cli-skills.md`
  - Agent Skills 오픈 표준: https://agentskills.io
  - brief2dev: `.agents -> .claude` symlink, `.claude/skills/AGENTS.md`, R-CM-028
- **Last updated**: 2026-06-15 (공식 문서 원문 fetch + 16-agent 전수 감사 + 결정론적 린터)
- **Known limits**:
  - 공식 문서 변경 시 references/ `updated_at` 확인 후 `.md` 재fetch.
  - 린터는 보수적 surfacing — coupled over-flag 가능. 정확 경계는 per-skill 검증.
  - runtime-coupled 스킬의 완전 CLI parity 는 hooks/런타임 포팅(multi-cli-hooks) 선행 필요 — 이 스킬 범위 밖.
  - 분류 수치는 측정법 따라 bracket(린터 감사 52/9/46 → 이 PR fixable remediation 후 61/0/47 vs LLM 68/21/18) — 린터가 재현 SSOT.
