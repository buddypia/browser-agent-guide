/**
 * hook-registry.mjs — Single SSOT Hook Registry (R-CM-006 Rule 4)
 *
 * 본 파일은 brief2dev 의 모든 Hook 정보의 **단일 진실 원천 (Single SSOT)** 이다.
 * - settings.json#hooks 는 이 registry 로부터 codegen 된다 (regen-hooks-settings.mjs)
 * - profile 멤버십은 entry 의 `profile` 필드에서 직접 derive
 * - hook-flags.mjs 의 PROFILE_MAP 은 이 registry 로부터 build
 *
 * settings.json 직접 편집 금지 — settings-codegen-guard hook 이 차단.
 * profile 변경 시 entry 의 `profile` 필드만 수정 후 `node .claude/scripts/regen-hooks-settings.mjs` 실행.
 *
 * 각 hook entry 필드:
 *   id                — hookId (safeHookMainWithProfile 의 인자)
 *   module            — `.mjs` 경로 (../scripts/ 또는 ./)
 *   priority          — 실행 순서 (낮을수록 먼저)
 *   profile           — 'minimal' | 'standard' | 'none' (프로파일 미적용; strict 티어 제거 2026-06-11 → 2-tier)
 *   profileChecked    — false 면 safeHookMain 사용 (profile 우회)
 *   orchestrated      — true 면 hook-orchestrator 경유 in-process 실행
 *   description       — AI 컨텍스트 인식용
 *   timeout           — settings.json command 타임아웃 (초)
 *   if                — Bash conditional matcher (예: 'Bash(git *)')
 *   statusMessage     — 사용자 표시 상태 메시지
 *   async             — true 면 비동기 실행
 *   commandArgs       — node module.mjs 의 추가 인자 (예: 'SessionStart')
 *   type              — 'command' (기본) 또는 'prompt'
 *   prompt            — type='prompt' 시 LLM 프롬프트 본문
 *   hookType          — PROMPT_AGENT_HOOKS 의 'prompt' | 'agent'
 *
 * @see .claude/rules/common/hooks.md (R-CM-006 Rule 4 — Single SSOT)
 * @see .claude/scripts/regen-hooks-settings.mjs (codegen)
 * @see .claude/hooks/settings-codegen-guard.mjs (직접 편집 차단)
 */

/** 유효한 hook 이벤트 타입 */
export const VALID_EVENT_TYPES = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionStart', 'SessionEnd',
  'PreCompact', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted', 'PermissionRequest', 'FileChanged', 'Notification', 'ConfigChange',
  'WorktreeCreate', 'WorktreeRemove',
]);

/** orchestrator dispatcher entries (settings.json 에서 1 matcher = 1 호출) */
export const ORCHESTRATOR_DISPATCHERS = [
  {
    "event": "Stop",
    "matcher": "",
    "timeout": 60
  },
  {
    "event": "PreToolUse",
    "matcher": "Edit|Write",
    "timeout": 15
  },
  {
    "event": "PostToolUse",
    "matcher": "Write|Edit",
    "timeout": 45
  }
];

/** prompt/agent type hooks (PROMPT_AGENT_HOOKS) */
export const PROMPT_AGENT_HOOKS = {
  // completion-evidence-guard 는 HOOK_REGISTRY.Stop 에 command-type (priority 58) 으로 실행된다.
  // 과거 PROMPT_AGENT_HOOKS.Stop 의 prompt-type entry 는 `prompt` 본문 필드가 없어 codegen
  // (regen-hooks-settings.mjs#appendPromptHooks `if (!ph.prompt) continue;`) 에서 settings.json 진입이
  // 영구 skip 되던 죽은 메타데이터였다 (#109 prompt→command 전환 잔재). flattenRegistry/getRegistryStats
  // 통계만 +1 오염시키고 실행 영향 0 → 삭제.
  "Stop": [],
  "PreToolUse": [],
  "TaskCompleted": [],
  // SubagentStop 은 prompt-type hook 을 등록하지 않는다 (codegen 가드가 강제 — regen-hooks-settings.mjs).
  // 근거: prompt-type SubagentStop 은 검증 지시문을 subagent context 에 주입하므로,
  //       subagent 가 그 지시에 응답({"decision":"allow"})하면서 실제 산출물
  //       (예: code-reviewer 의 리뷰 결과) 을 최종 결과로 덮어쓰는 구조적 오염을 일으킨다.
  //       의도였던 R-PL-002 Rule 7 stage closure 검증은 R-PL-002 Rule 7 prompt-level audit
  //       (stage skills) + handoff-consistency-guard (PostToolUse, handoff 구조 검증) 가
  //       각자의 home 에서 커버하므로, allow-biased 한 본 hook 은 중복 + 오염만 일으킨다.
  //       SubagentStop 검증이 필요하면 command-type hook 으로만 작성한다 (R-CM-006 Rule 1).
  "SubagentStop": []
};

/** Single SSOT — settings.json hooks 섹션은 이 registry 의 codegen */
export const HOOK_REGISTRY = {
  "PreToolUse": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "pre-tool-enforcer",
          "module": "../scripts/pre-tool-enforcer.mjs",
          "priority": 10,
          "profile": "minimal",
          "description": "파이프라인 컨텍스트 주입 + Skill 실행 전 검증",
          "orchestrated": false,
          "timeout": 5
        }
      ]
    },
    {
      "matcher": "Edit|Write",
      "hooks": [
        {
          "id": "settings-codegen-guard",
          "module": "./settings-codegen-guard.mjs",
          "priority": 6,
          "profile": "minimal",
          "description": "[R-CM-006 Rule 4] settings.json#hooks 직접 편집 차단 (Single SSOT)",
          "orchestrated": false,
          "timeout": 5
        },
        {
          "id": "phase-boundary-file-guard",
          "module": "./phase-boundary-file-guard.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "파이프라인 산출물 Write 시 requiredInputs 유효성 검증 (3-Layer L1)",
          "orchestrated": true
        },
        {
          "id": "secret-leak-guard",
          "module": "./secret-leak-guard.mjs",
          "priority": 5,
          "profile": "minimal",
          "description": "API 키/시크릿 하드코딩 감지 + DENY",
          "orchestrated": true
        },
        {
          "id": "worktree-policy-guard",
          "module": "./worktree-policy-guard.mjs",
          "priority": 8,
          "profile": "minimal",
          "description": "main 직접 작업 Tier 정책 강제 (Tier 1/2/3 + hotfix/* escape hatch). SSOT: .claude/config/worktree-policy.json",
          "orchestrated": true
        },
        {
          "id": "worktree-session-owner-guard",
          "module": "./worktree-session-owner-guard.mjs",
          "priority": 9,
          "profile": "standard",
          "description": "[R-CM-036] 멀티세션 cross-worktree 편집 차단 (Layer 1 cwd-confinement + Layer 2 session_id 사이드카). Edit|Write|MultiEdit 대상",
          "orchestrated": true
        },
        {
          "id": "coverage-threshold-guard",
          "module": "./coverage-threshold-guard.mjs",
          "priority": 40,
          "profile": "standard",
          "description": "커버리지 threshold 하향 방지 (Ratchet: up-only)",
          "orchestrated": true
        },
        {
          "id": "health-ratchet-guard",
          "module": "./health-ratchet-guard.mjs",
          "priority": 41,
          "profile": "standard",
          "description": "Code Health 7-축 baseline (data/registry/code-health-ratchet-baseline.json) 직접 수정 시 score 하향 감지 + warning (R-CM-016 Rule 10 정합)",
          "orchestrated": true
        }
      ]
    },
    {
      "matcher": "Bash",
      "hooks": [
        {
          "id": "agent-worktree-guard-pre-tool",
          "module": "./agent-worktree-guard.mjs",
          "priority": 4,
          "profile": "minimal",
          "description": "Agent Worktree Guard: raw git worktree add/remove, worktree rm -rf, git push --no-verify 차단",
          "orchestrated": false,
          "timeout": 5,
          "commandArgs": "pre-tool",
          "statusMessage": "Agent Worktree Guard: checking worktree command"
        },
        {
          "id": "merge-guard",
          "module": "../scripts/merge-guard.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "Git merge 충돌 방지",
          "orchestrated": false,
          "timeout": 30,
          "if": "Bash(git *)"
        },
        {
          "id": "destructive-git-guard",
          "module": "./destructive-git-guard.mjs",
          "priority": 5,
          "profile": "minimal",
          "description": "reset --hard, force push 등 파괴적 Git 명령 차단",
          "orchestrated": false,
          "timeout": 30,
          "if": "Bash(git *)"
        },
        {
          "id": "commit-guard",
          "module": "./commit-guard.mjs",
          "priority": 20,
          "profile": "standard",
          "description": "Conventional Commits 형식 + 변경 범위 검증",
          "orchestrated": false,
          "timeout": 30,
          "if": "Bash(git *)"
        },
        {
          "id": "worktree-session-owner-guard",
          "module": "./worktree-session-owner-guard.mjs",
          "priority": 25,
          "profile": "standard",
          "description": "[R-CM-036] 멀티세션 cross-worktree git commit 차단 (Layer 1 cwd-confinement). Bash git commit 대상",
          "orchestrated": false,
          "timeout": 5,
          "if": "Bash(git *)"
        },
        {
          "id": "dev-server-guard",
          "module": "./dev-server-guard.mjs",
          "priority": 30,
          "profile": "standard",
          "description": "dev server 실행 시 tmux 세션 사용 권장",
          "orchestrated": false,
          "timeout": 30
        },
        {
          "id": "git-push-warning",
          "module": "./git-push-warning.mjs",
          "priority": 35,
          "profile": "standard",
          "description": "[OSS] git push 전 변경 사항 리뷰 알림",
          "orchestrated": false,
          "timeout": 30,
          "if": "Bash(git push*)"
        },
        {
          "id": "guardrail-guard",
          "module": "./guardrail-guard.mjs",
          "priority": 40,
          "profile": "standard",
          "description": "Bash 도구 위험도 분류 + 파이프라인 중 high 도구 차단",
          "orchestrated": false,
          "timeout": 30,
          "statusMessage": "Guardrail: checking tool risk level"
        },
        {
          "id": "pre-ship-review-guard",
          "module": "./pre-ship-review-guard.mjs",
          "priority": 50,
          "profile": "minimal",
          "description": "(settings-only — generated during R-CM-006 single SSOT migration)",
          "orchestrated": false,
          "timeout": 30
        }
      ]
    },
    {
      "matcher": "Task",
      "hooks": [
        {
          "id": "model-routing-guard",
          "module": "./model-routing-guard.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "Task 실행 시 모델 적합성 검증 + 비용 최적화",
          "orchestrated": false,
          "timeout": 5
        },
        {
          "id": "agent-review-readiness-guard",
          "module": "./agent-review-readiness-guard.mjs",
          "priority": 20,
          "profile": "standard",
          "description": "review/code-simplifier agent 호출 시 uncommitted + zero commits 차단 (wrong-scope review 방지). 2026-05-27 사용자 결정으로 /simplify 폐기 + simplifit 스킬 deprecate 후 /code-review 단일 진입점",
          "orchestrated": false,
          "timeout": 5
        }
      ]
    },
    {
      "matcher": "Skill",
      "hooks": [
        {
          "id": "new-run-guard",
          "module": "./new-run-guard.mjs",
          "priority": 2,
          "profile": "standard",
          "description": "새 비즈니스 아이디어 시작 직전(business-analyzer 진입 시) boundary 자동 차단 (R-CM-014/028)",
          "orchestrated": false,
          "timeout": 5
        },
        {
          "id": "pipeline-boundary-guard",
          "module": "./pipeline-boundary-guard.mjs",
          "priority": 5,
          "profile": "minimal",
          "description": "brief2dev 리포에서 개발 스킬 실행 차단 + Saga State 주입",
          "orchestrated": false,
          "timeout": 5
        },
        {
          "id": "pipeline-context-awareness-guard",
          "module": "./pipeline-context-awareness-guard.mjs",
          "priority": 25,
          "profile": "standard",
          "description": "파이프라인 상태 인식 + AI 컨텍스트 안내 (SSOT: SKILL_TO_STAGE)",
          "orchestrated": false,
          "timeout": 5
        },
        {
          "id": "constraint-injector",
          "module": "./constraint-injector.mjs",
          "priority": 35,
          "profile": "standard",
          "description": "이전 스테이지 제약 조건 주입 (Rule 6-9)",
          "orchestrated": false,
          "timeout": 10,
          "statusMessage": "Constraint Injector: injecting previous stage constraints (Rule 6-9)"
        },
        {
          "id": "inbox-guard-skill",
          "module": "./inbox-guard.mjs",
          "priority": 3,
          "profile": "standard",
          "description": "Skill 실행 전 inbox 미처리 항목 감지",
          "orchestrated": false,
          "timeout": 5,
          "commandArgs": "PreToolUse"
        }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "Edit",
      "hooks": [
        {
          "id": "edit-error-recovery",
          "module": "./edit-error-recovery.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "Edit 실패 시 자동 복구 안내",
          "orchestrated": false,
          "timeout": 5
        }
      ]
    },
    {
      "matcher": "WebSearch",
      "hooks": [
        {
          "id": "websearch-evidence-extractor",
          "module": "./websearch-evidence-extractor.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "[R-CM-035] WebSearch 결과를 runs/{active}/research/web-search/ 에 markdown + meta JSON 영속화 (Observatory 의사결정 근거)",
          "orchestrated": false,
          "timeout": 5
        }
      ]
    },
    {
      "matcher": "Read",
      "hooks": [
        {
          "id": "wisdom-ref-tracker",
          "module": "./wisdom-ref-tracker.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "Wisdom 파일 참조 추적 (last_referenced 갱신 — session-extractor confidence scoring 입력)",
          "orchestrated": false,
          "timeout": 3
        },
        {
          "id": "prompt-injection-guard",
          "module": "./prompt-injection-guard.mjs",
          "priority": 20,
          "profile": "standard",
          "description": "[ECC] 읽은 파일 콘텐츠의 프롬프트 인젝션 패턴 탐지. standalone: settings.json 직접 호출",
          "orchestrated": false,
          "timeout": 5
        }
      ]
    },
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "id": "pipeline-change-tracker",
          "module": "./pipeline-change-tracker.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "파이프라인 산출물 변경 추적 + Schema 검증 + Saga 업데이트",
          "orchestrated": true
        },
        {
          "id": "esp-consistency-guard",
          "module": "./esp-consistency-guard.mjs",
          "priority": 30,
          "profile": "standard",
          "description": "ESP(Enforced Skill Pattern) 일관성 검증",
          "orchestrated": true
        },
        {
          "id": "handoff-consistency-guard",
          "module": "./handoff-consistency-guard.mjs",
          "priority": 40,
          "profile": "standard",
          "description": "Confidence Ratchet + Handoff 구조 검증",
          "orchestrated": true
        },
        {
          "id": "docs-consistency-guard",
          "module": "./docs-consistency-guard.mjs",
          "priority": 45,
          "profile": "standard",
          "description": "Input→Output Staleness 감지",
          "orchestrated": true,
          "async": true
        },
        {
          "id": "compact-warning",
          "module": "./compact-warning.mjs",
          "priority": 80,
          "profile": "standard",
          "description": "Saga State 인식 전략적 /compact 제안",
          "orchestrated": true,
          "async": true
        },
        {
          "id": "complexity-threshold-warning",
          "module": "./complexity-threshold-warning.mjs",
          "priority": 96,
          "profile": "standard",
          "description": "[Code Health Pipeline Step 2] cyclomatic complexity > 15 감지 (PostToolUse). 약한 알림 (R-CM-022 -warning). SSOT: code-health-axes.json#axes.cognitive-complexity. v1: ESLint fallback. v2: sonarjs/cognitive",
          "orchestrated": true
        },
        {
          "id": "skill-structure-check",
          "module": "./skill-structure-check.mjs",
          "priority": 90,
          "profile": "standard",
          "description": "[R-CM-018] SKILL.md 구조 유효성 검증",
          "orchestrated": true,
          "timeout": 5,
          "statusMessage": "R-CM-018: validating SKILL.md structure"
        },
        {
          "id": "scaffold-artifact-schema-warning",
          "module": "./scaffold-artifact-schema-warning.mjs",
          "priority": 92,
          "profile": "standard",
          "description": "scaffold 산출물(project-brief/config) schema drift 알림",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "P13: scaffold artifact schema check"
        },
        {
          "id": "scaffold-validation-warning",
          "module": "./scaffold-validation-warning.mjs",
          "priority": 93,
          "profile": "standard",
          "description": "output scaffold validation report staleness 알림",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "P20: scaffold validation staleness check"
        },
        {
          "id": "quality-stamp-cleanup",
          "module": "./quality-stamp-cleanup.mjs",
          "priority": 50,
          "profile": "standard",
          "description": "(settings-only — generated during R-CM-006 single SSOT migration)",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "Quality Gate: cleaning stamp on file change"
        }
      ]
    },
    {
      "matcher": "Bash",
      "hooks": [
        {
          "id": "agent-worktree-guard-post-tool",
          "module": "./agent-worktree-guard.mjs",
          "priority": 45,
          "profile": "minimal",
          "description": "Agent Worktree Guard: git commit/push/gh pr create 후 ledger/checklist 완료 상태 갱신",
          "orchestrated": false,
          "timeout": 5,
          "commandArgs": "post-tool",
          "statusMessage": "Agent Worktree Guard: updating worktree ledger"
        },
        {
          "id": "worktree-owner-tracker",
          "module": "./worktree-owner-tracker.mjs",
          "priority": 90,
          "profile": "standard",
          "description": "[R-CM-036] worktree 생성 성공 시 세션 소유권 사이드카(.session-owner) 기록 (safeHookMain — profile 무관, 절대 BLOCK 안 함)",
          "orchestrated": false,
          "timeout": 5,
          "profileChecked": false
        },
        {
          "id": "bash-file-integrity-guard",
          "module": "./bash-file-integrity-guard.mjs",
          "priority": 70,
          "profile": "standard",
          "description": "sed -i / awk -i inplace 이후 0바이트 파일 손상 감지",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "Bash File Integrity: detecting 0-byte corruption from sed -i / awk -i inplace (R-CM-019)"
        },
        {
          "id": "governance-capture",
          "module": "./governance-capture.mjs",
          "priority": 80,
          "profile": "minimal",
          "description": "검증 명령 실행 증거를 governance event로 캡처",
          "orchestrated": false,
          "timeout": 3,
          "statusMessage": "P15: capturing verification command for R-CM-010 evidence"
        },
        {
          "id": "quality-stamp-cleanup",
          "module": "./quality-stamp-cleanup.mjs",
          "priority": 50,
          "profile": "standard",
          "description": "(settings-only — generated during R-CM-006 single SSOT migration)",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "Quality Gate: cleaning stamp on bash execution"
        }
      ]
    }
  ],
  "PostToolUseFailure": [
    {
      "matcher": "mcp__*",
      "hooks": [
        {
          "id": "mcp-failure-tracker",
          "module": "./mcp-failure-tracker.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "MCP 도구 실패 시 명시적 실패 정보로 건강 상태 갱신. standalone: settings.json 직접 호출",
          "orchestrated": false,
          "timeout": 5
        }
      ]
    }
  ],
  "Stop": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "quality-gate-stop-guard",
          "module": "./quality-gate-stop-guard.mjs",
          "priority": 5,
          "profile": "standard",
          "description": "품질 게이트 (make q.check) 통과 강제",
          "orchestrated": true
        },
        {
          "id": "stop-handler",
          "module": "../scripts/stop-handler.mjs",
          "priority": 10,
          "profile": "none",
          "description": "ECC instincts 추출 (파이프라인 스테이지 학습)",
          "orchestrated": true,
          "profileChecked": false
        },
        {
          "id": "analyze-guard",
          "module": "../scripts/analyze-guard.mjs",
          "priority": 20,
          "profile": "none",
          "description": "분석 결과 요약 + 컨텍스트 주입",
          "orchestrated": true,
          "profileChecked": false
        },
        {
          "id": "pipeline-drift-guard",
          "module": "./pipeline-drift-guard.mjs",
          "priority": 30,
          "profile": "standard",
          "description": "Drift + 구조 + 콘텐츠 + 스키마 정합성 + Saga 일관성 검증 (L3)",
          "orchestrated": true
        },
        {
          "id": "worktree-shipping-guard",
          "module": "./worktree-shipping-guard.mjs",
          "priority": 35,
          "profile": "standard",
          "description": "[R-CM-030] worktree commit + unmerged 시 /create-pr ship-worktree 자동 유도 (5min 시도 마커)",
          "orchestrated": true
        },
        {
          "id": "worktree-review-report-guard",
          "module": "./worktree-review-report-guard.mjs",
          "priority": 37,
          "profile": "standard",
          "description": "[R-CM-030] worktree commit 완료 시 사람-리뷰 REVIEW.md(9섹션) 출력 강제 (마커-only 우회 갭 폐쇄)",
          "orchestrated": false,
          "timeout": 10
        },
        {
          "id": "security-scan-guard",
          "module": "./security-scan-guard.mjs",
          "priority": 40,
          "profile": "standard",
          "description": "보안 취약점 스캔",
          "orchestrated": true
        },
        {
          "id": "ecosystem-health-guard",
          "module": "./ecosystem-health-guard.mjs",
          "priority": 50,
          "profile": "standard",
          "description": ".claude/ 에코시스템 내부 일관성 검증",
          "orchestrated": true
        },
        {
          "id": "inbox-guard-stop",
          "module": "./inbox-guard.mjs",
          "priority": 5,
          "profile": "standard",
          "description": "Stop 시 inbox 미처리 항목 감지",
          "orchestrated": false,
          "timeout": 5,
          "commandArgs": "Stop"
        },
        {
          "id": "agent-worktree-guard-stop",
          "module": "./agent-worktree-guard.mjs",
          "priority": 34,
          "profile": "minimal",
          "description": "Agent Worktree Guard: 모든 ledger worktree 완료 시 PR 확인 문구로 continuation",
          "orchestrated": false,
          "timeout": 10,
          "commandArgs": "stop",
          "statusMessage": "Agent Worktree Guard: auditing worktree completion"
        },
        {
          "id": "completion-evidence-guard",
          "module": "./completion-evidence-guard.mjs",
          "priority": 58,
          "profile": "standard",
          "description": "[R-CM-010] 검증 증거 없이 완료 주장 차단 (command type)",
          "orchestrated": false,
          "timeout": 10,
          "statusMessage": "R-CM-010: verifying code changes have test/lint evidence"
        },
        {
          "id": "docs-index-guard",
          "module": "./docs-index-guard.mjs",
          "priority": 55,
          "profile": "standard",
          "description": "docs/ 변경 시 docs/index.md 자동 인덱스(AUTO 마커) stale 차단 + 갱신 유도 (main + 소유 worktree)",
          "orchestrated": false,
          "timeout": 15,
          "statusMessage": "docs-index-guard: checking docs/index.md AUTO section freshness"
        }
      ]
    }
  ],
  "SessionStart": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "trunk-start-warning",
          "module": "./trunk-start-warning.mjs",
          "priority": 5,
          "profile": "minimal",
          "description": "main 브랜치에서 AI 세션 진입 시 worktree 안내를 컨텍스트로 주입 (R-CM-006 Rule 1 정합 — SessionStart 는 차단 불가)",
          "orchestrated": false,
          "timeout": 10
        },
        {
          "id": "agent-worktree-guard-session-start",
          "module": "./agent-worktree-guard.mjs",
          "priority": 6,
          "profile": "minimal",
          "description": "Agent Worktree Guard: session ledger 상태를 context 로 주입",
          "orchestrated": false,
          "timeout": 10,
          "commandArgs": "session-start",
          "statusMessage": "Agent Worktree Guard: loading ledger"
        },
        {
          "id": "session-start",
          "module": "../scripts/session-start.mjs",
          "priority": 10,
          "profile": "none",
          "description": "이전 세션 컨텍스트 로드 + 파이프라인 상태 감지",
          "orchestrated": false,
          "profileChecked": false,
          "timeout": 10
        },
        {
          "id": "pipeline-memory-injector",
          "module": "./pipeline-memory-injector.mjs",
          "priority": 30,
          "profile": "standard",
          "description": "세션 시작 시 파이프라인 메모리 주입",
          "orchestrated": false,
          "timeout": 10,
          "statusMessage": "Pipeline Memory: injecting session context"
        },
        {
          "id": "inbox-guard",
          "module": "./inbox-guard.mjs",
          "priority": 35,
          "profile": "standard",
          "description": "inbox 미처리 항목 감지 + 알림",
          "orchestrated": false,
          "timeout": 5,
          "commandArgs": "SessionStart"
        },
        {
          "id": "session-integrity-check",
          "module": "./session-integrity-check.mjs",
          "priority": 40,
          "profile": "standard",
          "description": "에코시스템 교차 파일 일관성 검증",
          "orchestrated": false,
          "timeout": 10,
          "statusMessage": "Ecosystem Integrity: validating cross-file consistency"
        },
        {
          "id": "worktree-system-symlink-guard",
          "module": "./worktree-system-symlink-guard.mjs",
          "priority": 42,
          "profile": "minimal",
          "description": "[R-CM-030] worktree 의 .brief2dev/system/ 이 main worktree symlink 인지 검출. 자동 생성 X (Consequential). fail-open.",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "R-CM-030: checking system_persistent worktree symlink"
        },
        {
          "id": "learnings-injector",
          "module": "./learnings-injector.mjs",
          "priority": 45,
          "profile": "standard",
          "description": "[R-CM-020] 세션 시작 시 이전 learnings를 컨텍스트로 주입",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "Learnings: injecting past session learnings (gstack Round 11)"
        },
        {
          "id": "compact-context-preserver",
          "module": "./compact-context-preserver.mjs",
          "priority": 50,
          "profile": "standard",
          "description": "compact 직후 첫 세션 시작 시 핵심 컨텍스트 재주입 (source===\"compact\" 한정)",
          "orchestrated": false,
          "timeout": 15,
          "statusMessage": "Compact Context: re-injecting preserved context after compaction"
        }
      ]
    }
  ],
  "WorktreeCreate": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "agent-worktree-guard-worktree-create",
          "module": "./agent-worktree-guard.mjs",
          "priority": 10,
          "profile": "minimal",
          "description": "Agent Worktree Guard: Claude Code --worktree 생성 경로를 ledger wrapper 로 수렴",
          "orchestrated": false,
          "profileChecked": false,
          "timeout": 30,
          "commandArgs": "worktree-create"
        }
      ]
    }
  ],
  "WorktreeRemove": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "agent-worktree-guard-worktree-remove",
          "module": "./agent-worktree-guard.mjs",
          "priority": 10,
          "profile": "minimal",
          "description": "Agent Worktree Guard: Claude Code worktree removal 을 owner marker 검증 cleanup 으로 수렴",
          "orchestrated": false,
          "profileChecked": false,
          "timeout": 30,
          "commandArgs": "worktree-remove"
        }
      ]
    }
  ],
  "SessionEnd": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "session-end",
          "module": "../scripts/session-end.mjs",
          "priority": 30,
          "profile": "none",
          "description": "세션 정리",
          "orchestrated": false,
          "profileChecked": false,
          "timeout": 5
        },
        {
          "id": "session-extractor",
          "module": "./session-extractor.mjs",
          "priority": 50,
          "profile": "standard",
          "description": "세션 패턴 분석 + wisdom confidence 업데이트 + instinct 승격",
          "orchestrated": false,
          "async": true,
          "timeout": 15
        },
        {
          "id": "pipeline-memory-extractor",
          "module": "./pipeline-memory-extractor.mjs",
          "priority": 60,
          "profile": "standard",
          "description": "세션 종료 시 파이프라인 팩트 추출",
          "orchestrated": false,
          "timeout": 10,
          "statusMessage": "Pipeline Memory: extracting session facts"
        },
        {
          "id": "transcript-extractor",
          "module": "./transcript-extractor.mjs",
          "priority": 70,
          "profile": "standard",
          "description": "Claude Code transcript_path jsonl 을 active run 의 transcript/ 로 복사 (Observatory 채팅 뷰 입력)",
          "orchestrated": false,
          "async": true,
          "timeout": 5
        }
      ]
    }
  ],
  "UserPromptSubmit": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "keyword-router",
          "module": "./keyword-router.mjs",
          "priority": 10,
          "profile": "none",
          "description": "키워드 라우팅 (context 전환 + @agent + NFR/패턴 RAG)",
          "orchestrated": false,
          "profileChecked": false,
          "timeout": 10
        },
        {
          "id": "task-context-injector",
          "module": "./task-context-injector.mjs",
          "priority": 20,
          "profile": "standard",
          "description": "작업성 prompt에 최신 태스크/SSOT/검증 계약을 주입하여 AI context drift를 줄임",
          "orchestrated": false,
          "timeout": 5
        }
      ]
    }
  ],
  "SubagentStart": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "subagent-limit-guard",
          "module": "./subagent-limit-guard.mjs",
          "priority": 10,
          "profile": "standard",
          "description": "동시 서브에이전트 수 제한 (MAX=5)",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "Subagent Limit: tracking concurrency"
        }
      ]
    }
  ],
  "SubagentStop": [
    {
      "matcher": "*",
      "hooks": [
        {
          "id": "subagent-cleanup",
          "module": "./subagent-cleanup.mjs",
          "priority": 5,
          "profile": "standard",
          "description": "서브에이전트 종료 시 활성 목록에서 제거",
          "orchestrated": false,
          "timeout": 5,
          "statusMessage": "Subagent Cleanup: removing from active agents"
        },
        {
          "id": "stop-handler",
          "module": "../scripts/stop-handler.mjs",
          "priority": 10,
          "profile": "none",
          "description": "ECC instincts 추출 (서브에이전트 종료)",
          "orchestrated": false,
          "profileChecked": false,
          "timeout": 15
        }
      ]
    }
  ]
};

// ═══════════════════════════════════════════════════════════════
// Helpers (registry-derived)
// ═══════════════════════════════════════════════════════════════

export function matchesTool(matcher, toolName) {
  if (matcher === '*' || matcher === '') return true;
  return matcher.split('|').some((m) => m.trim() === toolName);
}

export function getHooksForEvent(event, toolName) {
  const groups = HOOK_REGISTRY[event] || [];
  const matched = [];
  for (const g of groups) {
    if (matchesTool(g.matcher, toolName)) matched.push(...g.hooks);
  }
  return matched.sort((a, b) => (a.priority || 50) - (b.priority || 50));
}

/** 모든 entry 의 평탄화 목록 (id 중복 제거 X — inbox-guard 같은 다중 등록 보존) */
export function flattenRegistry() {
  const out = [];
  for (const [event, groups] of Object.entries(HOOK_REGISTRY)) {
    for (const g of groups) {
      for (const h of g.hooks) out.push({ event, matcher: g.matcher, ...h });
    }
  }
  for (const [event, list] of Object.entries(PROMPT_AGENT_HOOKS)) {
    for (const h of list) out.push({ event, matcher: '', ...h });
  }
  return out;
}

export function getRegistryStats() {
  const flat = flattenRegistry();
  return {
    total: flat.length,
    byProfile: {
      minimal: flat.filter((h) => h.profile === 'minimal').length,
      standard: flat.filter((h) => h.profile === 'standard').length,
      none: flat.filter((h) => h.profile === 'none' || h.profileChecked === false).length,
    },
    orchestrated: flat.filter((h) => h.orchestrated).length,
    standalone: flat.filter((h) => h.orchestrated === false).length,
  };
}
