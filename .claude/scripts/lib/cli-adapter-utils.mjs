/**
 * cli-adapter-utils.mjs — Multi-CLI Hook Adapter Utilities
 *
 * Codex CLI 와 Antigravity CLI (agy — Gemini CLI hook spec 호환) 의 stdin JSON
 * payload 를 본체 hook (Claude Code 형식 `{ tool_name, tool_input, cwd }`) 으로
 * 정규화한다.
 *
 * 본체 hook 의 `run(data)` 함수는 Claude stdin 형식을 가정하므로, 어댑터는
 * stdin schema 변환 + 본체 run() 호출 + CLI 별 응답 형식 변환만 담당한다.
 *
 * 본 lib 는 가드 도메인 로직을 포함하지 않는다 (schema/IO 만). 가드 결정은
 * 본체 hook (`.claude/hooks/<name>.mjs`) 의 export 된 순수 함수가 SSOT.
 *
 * Antigravity hook spec 출처: Antigravity CLI 는 Gemini CLI 의 plugin/hook 시스템을
 * 호환 사용한다 (`agy plugin import gemini` 마이그레이션 — 출처:
 * https://antigravitylab.net/en/articles/antigravity/antigravity-cli-agy-setup-and-slash-commands-getting-started).
 * BeforeTool / AfterTool / SessionStart / SessionEnd 등 이벤트 + matcher 정규식 +
 * stdin/stdout schema 모두 Gemini CLI 와 동일 (출처: https://geminicli.com/docs/hooks/).
 *
 * Boundary: 관점 1 (brief2dev 자체) 전용 — R-CM-028.
 */

const STDIN_DEADLINE_MS = 1500;

/**
 * stdin 에서 JSON 읽기. 타임아웃 또는 parse 실패 시 빈 객체 반환 (fail-open).
 *
 * @returns {Promise<object>}
 */
export async function readStdinJson() {
  return new Promise((resolve) => {
    let buf = '';
    let timer = setTimeout(() => resolve({}), STDIN_DEADLINE_MS);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf || '{}'));
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

/**
 * Antigravity (Gemini-compatible) BeforeTool 도구명을 Claude 형식으로 매핑.
 * 출처: Gemini CLI 공식 hooks reference (https://geminicli.com/docs/hooks/reference/)
 * — Antigravity CLI 가 그대로 호환 사용한다.
 *   write_file / replace → Write / Edit
 *   run_shell / shell    → Bash
 * 알 수 없는 이름은 그대로 통과 (어차피 본체 hook 의 tool name 분기에서 패스스루).
 */
export function mapAntigravityToolName(name) {
  if (!name) return 'Bash';
  if (name === 'run_shell' || name === 'shell' || name === 'run_shell_command') return 'Bash';
  if (name === 'write_file') return 'Write';
  if (name === 'replace') return 'Edit';
  if (name === 'multi_replace') return 'MultiEdit';
  return name;
}

/**
 * Backwards-compat alias. 신규 코드는 mapAntigravityToolName 사용 권장.
 * (Antigravity rename PR — feature/antigravity-rename-p0-fix)
 */
export const mapGeminiToolName = mapAntigravityToolName;

/**
 * Claude 호환 payload 형식 (`tool_name` 키 보유) 이면 그대로 picking.
 * 부재 시 null 반환 — 호출자가 alternate schema 처리.
 */
function pickClaudeShape(data) {
  if (!data?.tool_name) return null;
  return {
    tool_name: data.tool_name,
    tool_input: data.tool_input || {},
    cwd: data.cwd || process.cwd(),
    session_id: data.session_id,
    stop_hook_active: data.stop_hook_active,
    hook_event_name: data.hook_event_name,
    // PostToolUse 어댑터(worktree-owner-tracker)가 exit_code 게이트에 사용. PreToolUse 는 undefined.
    tool_response: data.tool_response,
  };
}

/**
 * Codex / Gemini 의 `tool.name` 또는 alternate `tool_name` 에서 tool name 추출.
 */
function extractToolName(data) {
  return data?.tool?.name || data?.tool_name || '';
}

/**
 * 각 CLI 의 stdin payload 를 Claude Code 형식으로 정규화.
 *
 * Schema (cross-checked 공식 문서):
 *   - Claude Code:   { tool_name, tool_input: { command, file_path, ... }, cwd, session_id, ... }
 *   - Codex CLI:     동일 schema (flat) + turn_id / permission_mode 확장
 *                    (https://developers.openai.com/codex/hooks)
 *   - Antigravity:   Gemini CLI hook 호환 — { tool: { name: 'run_shell'|'write_file'|..., input: {...} },
 *                    session_id, transcript_path, cwd, hook_event_name }
 *                    (https://geminicli.com/docs/hooks/reference/)
 *
 * Codex 의 `tool.name` (nested) fallback 은 schema drift 안전망 — 현재 사양상 dead path 이나
 * future-proof 로 유지.
 *
 * @param {object} data - raw stdin JSON
 * @param {'claude'|'codex'|'antigravity'} cli
 * @returns {object} Claude Code 형식의 정규화된 payload
 */
export function normalizePayload(data, cli) {
  if (!data || typeof data !== 'object') return { tool_name: '', tool_input: {} };

  const claudeShape = pickClaudeShape(data);
  if (claudeShape) return claudeShape;

  const toolName = extractToolName(data);
  const normalizedName = cli === 'antigravity' ? mapAntigravityToolName(toolName) : toolName;
  const toolInput = data.tool?.input || data.input || {};

  return {
    tool_name: normalizedName,
    tool_input: toolInput,
    cwd: data.cwd || data.session?.cwd || process.cwd(),
    session_id: data.session_id || data.session?.id,
    stop_hook_active: data.stop_hook_active,
    hook_event_name: data.hook_event_name,
    tool_response: data.tool_response,
  };
}

/**
 * Antigravity (Gemini-compatible) hook 의 deny 응답에 top-level `reason` 필드를
 * 추가한다. Gemini CLI hooks reference 의 BeforeTool deny 응답 형식 — `{ reason: ... }`
 * top-level (사양: https://geminicli.com/docs/hooks/reference/) — 을 따른다. Claude 의
 * `hookSpecificOutput.permissionDecisionReason` 만 emit 하면 Antigravity 가 deny 사유를
 * agent 에게 전달하지 않을 가능성. 양쪽 키 모두 emit 하여 spec drift 안전망.
 *
 * @param {object} result
 * @returns {object} reason 보강된 result (원본 그대로 유지 + top-level reason 추가)
 */
export function augmentAntigravityDenyReason(result) {
  if (result?.hookSpecificOutput?.permissionDecision !== 'deny') return result;
  if (result.reason) return result; // 이미 명시된 경우 보존
  const detailReason = result.hookSpecificOutput.permissionDecisionReason;
  if (!detailReason) return result;
  return { ...result, reason: detailReason };
}

/**
 * 본체 hook 의 결과 (Claude 형식 JSON) 를 CLI 별 wire 출력으로 변환한다.
 *
 * Codex hook spec 은 block/deny 에 대해 두 가지 방식을 허용한다:
 *   1. exit 0 + stdout JSON (권장 — 모든 이벤트에서 구조화 응답 유지)
 *   2. exit 2 + stderr reason (legacy/plain-text fallback)
 *
 * 둘을 섞은 `exit 2 + stdout JSON + empty stderr` 는 Stop hook 에서
 * "did not write a continuation prompt to stderr" 런타임 오류를 만든다.
 * 따라서 adapter 는 항상 exit 0 + stdout JSON 을 사용한다.
 *
 * @param {object} result - 본체 hook 의 반환값 (HookOutput.deny/passthrough/block/context)
 * @param {{ cli: 'codex'|'antigravity', eventName?: string }} opts
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export function buildCliEmission(result, opts = {}) {
  if (!result || Object.keys(result).length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  let out = result;

  // Codex / Antigravity 의 hookEventName 라벨이 다른 경우 어댑터에서 라벨 재라이팅.
  if (opts.eventName && result.hookSpecificOutput) {
    out = {
      ...result,
      hookSpecificOutput: {
        ...result.hookSpecificOutput,
        hookEventName: opts.eventName,
      },
    };
  }

  out = opts.cli === 'antigravity' ? augmentAntigravityDenyReason(out) : out;

  return {
    stdout: JSON.stringify(out) + '\n',
    stderr: '',
    exitCode: 0,
  };
}

/**
 * 본체 hook 의 결과 (Claude 형식 JSON) 를 CLI 별로 emit.
 *
 * @param {object} result - 본체 hook 의 반환값 (HookOutput.deny/passthrough/block/context)
 * @param {{ cli: 'codex'|'antigravity', eventName?: string }} opts
 */
export function emit(result, opts = {}) {
  const emission = buildCliEmission(result, opts);
  if (emission.stdout) process.stdout.write(emission.stdout);
  if (emission.stderr) process.stderr.write(emission.stderr);
  process.exit(emission.exitCode);
}

/**
 * 어댑터의 표준 진입점. 본체 hook 의 run(data) 함수를 호출한다.
 *
 * @param {Function} runFn - 본체 hook 의 export 된 run(data) async 함수
 * @param {{ cli: 'codex'|'antigravity', eventName?: string }} opts
 */
export async function runAdapter(runFn, opts) {
  try {
    const raw = await readStdinJson();
    const normalized = normalizePayload(raw, opts.cli);
    const result = await runFn(normalized);
    emit(result, opts);
  } catch {
    // fail-open (R-CM-006 Rule 2 정합) — 어댑터 자체 실패가 본체 흐름 차단하지 않음
    process.exit(0);
  }
}
