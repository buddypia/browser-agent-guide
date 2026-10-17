#!/usr/bin/env node
/**
 * antigravity/agy-bridge.mjs — Antigravity(agy) 훅 입출력 ↔ Claude 훅 규약 번역기
 *
 * 사용 (`.agents/hooks.json` 등록 형식): node agy-bridge.mjs <Event> <command> [args...]
 *
 * agy 계약(agy 바이너리 내장 "Lifecycle Hooks" 문서 + 2026-10-17 실측)은 입출력 모두 Claude 규약과 다르다:
 *   입력  camelCase — toolCall.{name, args.CommandLine, args.Cwd} · conversationId · workspacePaths · executionNum
 *   출력  protojson — 모르는 키가 하나라도 섞이면 결과 전체를 버린다 (`failed to unmarshal result … via protojson`)
 *         PreToolUse {allow_tool:false, deny_reason} · Stop {decision:"continue", reason}
 *         SessionStart {injectSteps:[{systemMessage:{systemMessage}}]} · PostToolUse {}
 * 가드(guard.py · worktree-shipping-guard)는 Claude 규약만 말하므로 번역은 여기 한 곳에서 한다 — 가드마다 agy 분기를
 * 두면 하나만 빠져도 그 가드가 agy 에서 조용히 꺼진다.
 *
 * 차단 신호는 Claude 의 두 형태를 다 받는다: exit 2 + stderr / stdout JSON 의 deny·block.
 * 할 말이 없으면 **아무것도 출력하지 않는다** — agy 는 같은 이벤트의 훅 결과를 합칠 때 첫 결과의 사유만 남기고
 * `{}` 도 결과로 센다. 앞 훅이 `{}` 를 내면 뒤 훅의 차단 사유가 빈칸이 된다 (빈 출력은 건너뛴다).
 * 어떤 실패도 exit 0 + 무출력 — 가드 자체의 오류로 agy 를 멈추지 않는다 (fail-open).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** agy 입력 → Claude 훅 stdin. */
function toClaudeInput(event, data) {
  const call = data.toolCall || {};
  const args = call.args || {};
  const input = {
    hook_event_name: event,
    session_id: data.conversationId,
    transcript_path: data.transcriptPath,
    cwd: args.Cwd || data.workspacePaths?.[0],
  };
  if (call.name) {
    input.tool_name = call.name;
    input.tool_input = typeof args.CommandLine === 'string' ? { ...args, command: args.CommandLine } : args;
  }
  if (event === 'PostToolUse') {
    // agy 는 실패만 error 문자열("exit status 3")로 알린다 — 가드는 exit_code 를 본다
    const exitCode = data.error ? Number(/exit status (\d+)/.exec(data.error)?.[1] ?? 1) : 0;
    input.tool_response = { output: data.result, error: data.error, exit_code: exitCode };
  }
  if (event === 'Stop') {
    // executionNum 은 0 부터 센다 — 1 이상이면 이미 한 번 continue 로 되돌아온 Stop (Claude 의 stop_hook_active)
    input.stop_hook_active = Number(data.executionNum ?? 0) > 0;
    input.last_assistant_message = data.finalModelOutput;
  }
  return input;
}

/** Claude 훅 결과(exit · stdout · stderr) → agy 출력. */
function toAgyOutput(event, { status, stdout = '', stderr = '' }) {
  const text = (stdout || '').trim();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // 평문 stdout — SessionStart 에서는 컨텍스트다
  }
  const specific = json?.hookSpecificOutput || {};
  const blocked = status === 2 || specific.permissionDecision === 'deny' || json?.decision === 'block';
  const reason = specific.permissionDecisionReason || json?.reason || (stderr || '').trim() || undefined;

  if (event === 'PreToolUse') {
    // 문서의 {decision:"deny", reason} 은 막기는 하지만 사유가 에이전트에게 가지 않는다 (실측). 사유가 전달되는 형태는 이것뿐이다.
    if (blocked) return { allow_tool: false, deny_reason: reason };
    if (specific.permissionDecision === 'ask') return { decision: 'ask', reason };
    return {};
  }
  if (event === 'Stop') return blocked ? { decision: 'continue', reason } : {};
  if (event === 'SessionStart') {
    const context = json ? specific.additionalContext : text;
    return context ? { injectSteps: [{ systemMessage: { systemMessage: context } }] } : {};
  }
  return {}; // PostToolUse — agy 는 빈 객체만 받는다 (권고를 실을 필드가 없다)
}

function main() {
  const [event, command, ...args] = process.argv.slice(2);
  let output = {};
  try {
    const data = readStdinJson();
    // Claude Code 는 사용자 중단에 Stop 을 돌리지 않는다 — agy 는 돌리므로 여기서 같은 동작으로 맞춘다
    if (event === 'Stop' && data.terminationReason === 'USER_CANCELED') return;
    const input = toClaudeInput(event, data);
    const result = spawnSync(command, args, {
      input: JSON.stringify(input),
      encoding: 'utf8',
      cwd: input.cwd && existsSync(input.cwd) ? input.cwd : undefined,
    });
    output = toAgyOutput(event, result);
  } catch {
    output = {};
  }
  if (Object.keys(output).length > 0) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main();
