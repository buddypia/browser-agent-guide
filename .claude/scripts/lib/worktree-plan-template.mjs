/**
 * worktree-plan-template.mjs — `worktree-init.mjs` 가 첫 실행 시 작성하는
 * PLAN.md 의 표준 템플릿 helper.
 *
 * 목적 (R-CM-030 worktree 흐름 + 직전 회고 항목 #1 #5 #6 근본 해결):
 *   - PLAN.md 위치를 `worktree-plan-path.mjs#resolveWorktreePlanPath` SSOT 에
 *     맞춰 자동 생성 → AI 가 매 worktree 마다 mkdir + Write 로 위치 헷갈리는 패턴 차단.
 *   - verify 섹션을 "AI 자동" / "사용자 수동" 두 카테고리로 분리 → AI 가 작성 시점에
 *     사용자 의존 verify 와 자동 verify 를 의식적으로 구분하게 강제.
 *   - 멱등 — 기존 PLAN.md 가 있으면 보존 (사용자 작성 중인 PLAN 덮어쓰기 금지).
 *
 * 본 모듈은 pure helper 라 단위 테스트 가능.
 * 회귀: tests/unit/worktree-plan-template.test.mjs.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  resolveWorktreePlanPath,
  inferBranchFromWorktreePath,
} from './worktree-plan-path.mjs';

/**
 * PLAN.md 표준 템플릿 본문을 산출. Pure — fs 미접근.
 *
 * @param {string} branch — `feature/cmux-surface-select` 같은 branch 명.
 * @param {{ createdAt?: string }} [options]
 * @returns {string}
 */
export function renderPlanTemplate(branch, options = {}) {
  const branchName = branch || '<branch>';
  const createdAt = options.createdAt || new Date().toISOString().slice(0, 10);
  return `# PLAN — ${branchName}

## Goal
(작성 필요 — 한 문장으로 이 worktree 에서 달성할 목표)

## Why
(작성 필요 — 왜 지금 이 변경이 필요한가? 기존 갭/문제)

## Scope (Surgical — R-CM-029 Rule 4)
(작성 필요 — 변경 대상 파일/모듈 목록)

## Out of scope
(작성 필요 — 의도적으로 건드리지 않는 영역)

## Verify

### AI 자동 (이번 턴 안에 실행)
- [ ] (작성 필요 — \`npm test\` / \`npx vitest run <paths>\` 같은 명령)
- [ ] (작성 필요 — lint / audit / smoke 등 자동 검증)

### 사용자 수동
- [ ] (해당 없으면 항목 자체 삭제 또는 (dropped) 마커. UI 변경이라면 "브라우저에서 X 확인" 같은 사용자 결정 의존 검증)

## Status
- ${createdAt}: worktree 생성 + PLAN 초안.

## Outstanding
- 없음 (시작 시점)

## Decisions
- (작성 필요 — AI default / 사용자 명시 결정 구분)
`;
}

/**
 * worktree 안에 PLAN.md 가 없으면 표준 템플릿으로 생성. 있으면 보존.
 *
 * **`options.branch` override 주의** — branch 를 명시 override 하면 PLAN.md 가
 * `resolveWorktreePlanPath(worktreePath, options.branch)` 위치에 생성된다.
 * 이 path 는 `inferBranchFromWorktreePath(worktreePath)` 로 얻는 default path 와
 * **다를 수 있다** (worktree 물리 디렉토리명과 branch override 명이 다를 때).
 * 결과적으로 같은 worktree 안에 `.tmp/worktree-<inferred>/PLAN.md` 와
 * `.tmp/worktree-<override>/PLAN.md` 두 파일이 공존할 수 있다.
 * 호출자가 의도적으로 branch alias 를 쓰는 경우만 override 를 권장한다.
 *
 * @param {string} worktreePath — worktree 절대 경로.
 * @param {{ branch?: string, createdAt?: string }} [options]
 * @returns {{ created: boolean, path: string }}
 */
export function ensureWorktreePlan(worktreePath, options = {}) {
  const branch = options.branch || inferBranchFromWorktreePath(worktreePath);
  const planPath = resolveWorktreePlanPath(worktreePath, branch);
  if (existsSync(planPath)) {
    return { created: false, path: planPath };
  }
  const planDir = dirname(planPath);
  mkdirSync(planDir, { recursive: true });
  const body = renderPlanTemplate(branch, { createdAt: options.createdAt });
  writeFileSync(planPath, body, 'utf-8');
  return { created: true, path: planPath };
}
