#!/usr/bin/env node

/**
 * hook-orchestrator.mjs — 중앙 Hook 실행기
 *
 * OSS(everything-claude-code)의 run-with-flags.js 패턴을
 * brief2dev의 ESM + 3-Layer Guard 아키텍처에 네이티브 이식.
 *
 * 핵심 최적화:
 *   기존: Edit 1회 → 18개 Node 프로세스 spawn (0.9~3.6초 오버헤드)
 *   개선: Edit 1회 → matcher별 1개 프로세스 (in-process dynamic import)
 *   성능 개선: ~85% 오버헤드 감소
 *
 * 사용법 (settings.json에서):
 *   node "${CLAUDE_PROJECT_DIR}/.claude/scripts/hook-orchestrator.mjs" PreToolUse "Edit|Write"
 *   node "${CLAUDE_PROJECT_DIR}/.claude/scripts/hook-orchestrator.mjs" PostToolUse "Write|Edit"
 *   node "${CLAUDE_PROJECT_DIR}/.claude/scripts/hook-orchestrator.mjs" PreToolUse Bash
 *
 * 동작:
 *   1. stdin에서 hook input JSON 읽기 (1회만)
 *   2. hook-registry.mjs에서 event+matcher에 해당하는 hook 목록 조회
 *   3. 각 hook의 프로파일 체크 (hook-flags.mjs)
 *   4. orchestrated=true인 hook은 dynamic import → run(data) 호출 (in-process)
 *   5. orchestrated=false인 hook은 건너뜀 (settings.json에서 직접 실행)
 *   6. 결과 집계 (event 시맨틱에 따라)
 *
 * 집계 규칙:
 *   PreToolUse:  DENY가 하나라도 있으면 DENY (첫 번째 우선)
 *   PostToolUse: CONTEXT 모두 병합 (줄바꿈 구분)
 *   Stop:        BLOCK이 하나라도 있으면 BLOCK (첫 번째 우선)
 *
 * 안전 장치:
 *   - 개별 hook 오류 시 해당 hook만 건너뜀 (나머지 계속 실행)
 *   - 전체 orchestrator 오류 시 passthrough ({}) 출력
 *   - __HOOK_ORCHESTRATOR__ 전역 플래그로 hook의 standalone 모드 비활성화
 *
 * @see .claude/hooks/hook-registry.mjs
 * @see .claude/scripts/lib/hook-flags.mjs
 */

import { pathToFileURL } from 'url';
import { join, resolve } from 'path';
import { isHookEnabled } from './lib/hook-flags.mjs';
import { recordFiringIfDenyBlock } from './lib/governance-writer.mjs';

// ═══════════════════════════════════════════════════════════════
// 전역 플래그: hook 모듈의 standalone 모드를 비활성화
// ═══════════════════════════════════════════════════════════════
globalThis.__HOOK_ORCHESTRATOR__ = true;

const MAX_STDIN = 2 * 1024 * 1024; // 2MB

// ═══════════════════════════════════════════════════════════════
// stdin 읽기 (1회만)
// ═══════════════════════════════════════════════════════════════

async function readStdinOnce() {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize <= MAX_STDIN) {
      chunks.push(chunk);
    }
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
// 결과 집계
// ═══════════════════════════════════════════════════════════════

/**
 * PreToolUse 결과 집계.
 * DENY가 하나라도 있으면 DENY. 경고는 첫 번째 것만.
 */
function aggregatePreToolUse(results) {
  for (const r of results) {
    const decision = r?.hookSpecificOutput?.permissionDecision;
    if (decision === 'deny') return r;
  }

  // allowWithWarning 수집
  for (const r of results) {
    const decision = r?.hookSpecificOutput?.permissionDecision;
    if (decision === 'allow' && r?.hookSpecificOutput?.permissionDecisionReason) {
      return r;
    }
  }

  // allowWithUpdatedInput (마지막 것이 우선)
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]?.hookSpecificOutput?.updatedInput) {
      return results[i];
    }
  }

  return {};
}

/**
 * PostToolUse 결과 집계.
 * BLOCK이 있으면 BLOCK. CONTEXT는 모두 병합.
 * Claude Code 공식 스펙: hookSpecificOutput 사용 시 hookEventName 필수.
 */
function aggregatePostToolUse(results, event = 'PostToolUse') {
  // BLOCK 체크
  for (const r of results) {
    if (r?.decision === 'block') return r;
  }

  // CONTEXT 병합
  const contexts = results
    .map(r => r?.hookSpecificOutput?.additionalContext)
    .filter(Boolean);

  if (contexts.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: contexts.join('\n\n'),
      },
    };
  }

  return {};
}

/**
 * Stop 결과 집계.
 * BLOCK이 있으면 모든 block을 병합 (사용자가 턴마다 나눠보지 않고 전체 현황을 한 번에 파악).
 *
 * 이전 동작 (첫 번째 block만): 여러 L3 hook이 각자 발화하면 사용자는 턴마다 하나씩
 * 해결해야 했고 결정권이 파편화됨. 근본 대처로 모든 block을 병합하여 단일 리포트로 출력.
 */
function aggregateStop(results) {
  const blocks = results.filter(r => r?.decision === 'block');
  if (blocks.length === 0) return {};
  if (blocks.length === 1) return blocks[0];

  const combined = blocks
    .map((r, i) => `───── Block ${i + 1}/${blocks.length} ─────\n${r.reason || '(no reason)'}`)
    .join('\n\n');

  return {
    decision: 'block',
    reason: `[STOP HOOK AGGREGATE — ${blocks.length}개 block 동시 발생]\n\n` +
            `${combined}\n\n` +
            `위 ${blocks.length}개 문제를 모두 확인하고 해결한 후 세션을 종료하세요.`,
  };
}

/**
 * 이벤트 타입에 맞는 집계 함수 반환.
 */
function getAggregator(event) {
  switch (event) {
    case 'PreToolUse': return aggregatePreToolUse;
    case 'PostToolUse': return aggregatePostToolUse;
    case 'Stop':
    case 'SubagentStop': return aggregateStop;
    default: return aggregatePostToolUse; // context merge default
  }
}

// ═══════════════════════════════════════════════════════════════
// 메인 실행
// ═══════════════════════════════════════════════════════════════

async function main() {
  const [,, event, matcher] = process.argv;

  if (!event) {
    console.log('{}');
    process.exit(0);
  }

  const data = await readStdinOnce();

  // Hook Registry 로드
  let getHooksForEvent;
  try {
    const registryPath = join(
      process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      '.claude', 'scripts', 'lib', 'hook-registry.mjs'
    );
    const registry = await import(pathToFileURL(registryPath).href);
    getHooksForEvent = registry.getHooksForEvent;
  } catch (err) {
    // Registry 로드 실패 시 passthrough
    console.log('{}');
    process.exit(0);
  }

  // 실제 tool_name 결정 (stdin에서 또는 matcher에서)
  const toolName = data.tool_name || matcher || '*';

  // 매칭되는 hook 조회
  const hooks = getHooksForEvent(event, toolName)
    .filter(h => h.orchestrated); // orchestrated=true만 실행

  if (hooks.length === 0) {
    console.log('{}');
    process.exit(0);
  }

  const results = [];
  const aggregator = getAggregator(event);

  // ECC Native Transplant: sync/async 분류 실행
  // async: true인 hook은 병렬 실행하여 UX 개선 (PostToolUse L2 전용)
  const syncHooks = hooks.filter(h => !h.async);
  const asyncHooks = hooks.filter(h => h.async);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  /** hook 모듈 경로 해결 */
  function resolveHookPath(hook) {
    return hook.module.startsWith('../scripts/')
      ? join(projectDir, '.claude', 'scripts', hook.module.replace('../scripts/', ''))
      : resolve(projectDir, '.claude', 'hooks', hook.module);
  }

  /** 단일 hook 실행 */
  async function executeHook(hook) {
    const hookModulePath = resolveHookPath(hook);
    const hookModule = await import(pathToFileURL(hookModulePath).href);
    if (typeof hookModule.run !== 'function') return null;
    const result = await hookModule.run(data);
    // 발동 기록 (fail-safe): deny/block 결과를 governance-events.jsonl 에 append.
    // sync/async 양 경로 공통 진입점이므로 모든 orchestrated hook 발동을 단일 chokepoint 로 측정.
    recordFiringIfDenyBlock(hook.id, result, event);
    return result;
  }

  // ── Sync hooks: 순차 실행 (기존 동작 유지) ──
  for (const hook of syncHooks) {
    if (hook.profileChecked !== false && !isHookEnabled(hook.id)) continue;

    try {
      const result = await executeHook(hook);
      if (result && typeof result === 'object') {
        results.push(result);

        // PreToolUse DENY 시 즉시 중단 (이후 hook 불필요)
        if (event === 'PreToolUse' &&
            result?.hookSpecificOutput?.permissionDecision === 'deny') {
          break;
        }

        // Stop BLOCK 시 즉시 중단
        if ((event === 'Stop' || event === 'SubagentStop') &&
            result?.decision === 'block') {
          break;
        }
      }
    } catch (err) {
      // 개별 hook 오류 → 건너뜀 (다른 hook은 계속 실행)
    }
  }

  // ── Async hooks: 병렬 실행 (PostToolUse에서만 유효, 에러 격리) ──
  if (asyncHooks.length > 0) {
    const ASYNC_TIMEOUT_MS = 10_000; // 10초

    // 프로파일 필터: sync 경로(line 240)의 `profileChecked !== false && !isHookEnabled → skip`
    // 과 동치 — 진행 조건은 `profileChecked === false || isHookEnabled`. 이전의 이중 filter
    // (`!== false || enabled` AND `=== false || enabled`) 는 두 조건 교집합이 모든 경우 enabled 를
    // 요구해, profileChecked:false async hook 까지 프로파일 체크를 받는 버그였다 (단일 필터로 정정).
    const asyncPromises = asyncHooks
      .filter(h => h.profileChecked === false || isHookEnabled(h.id))
      .map(async (hook) => {
        // 실효 timeout: 이전 AbortController 는 signal 이 executeHook 에 전달되지 않아 abort() 가
        // 무효했다. Promise.race 로 교체해 timeout 시 결과를 버려(null) orchestrator 가 멈추지 않게 한다
        // (in-process hook 자체는 협조적 중단 불가이나, 결과 집계에서 제외되어 stdout blocking 회피).
        let timer;
        try {
          return await Promise.race([
            executeHook(hook),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), ASYNC_TIMEOUT_MS); }),
          ]);
        } catch {
          return null; // 개별 async hook 에러 → passthrough
        } finally {
          clearTimeout(timer);
        }
      });

    const settled = await Promise.allSettled(asyncPromises);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value && typeof s.value === 'object') {
        results.push(s.value);
      }
    }
  }

  // 결과 집계 + 출력 (event를 aggregator에 전달하여 hookEventName 보장)
  const aggregated = results.length > 0 ? aggregator(results, event) : {};
  console.log(JSON.stringify(aggregated));
}

main().catch(() => {
  // 전체 오류 시 안전하게 passthrough
  try { console.log('{}'); } catch { /* stdout 파이프 파손 시 무시 */ }
});
