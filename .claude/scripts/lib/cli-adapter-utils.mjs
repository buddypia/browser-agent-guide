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
 */

const STDIN_DEADLINE_MS = 1500;

export async function readStdinJson() {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve({}), STDIN_DEADLINE_MS);
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

export function mapAntigravityToolName(name) {
  if (!name) return 'Bash';
  if (name === 'run_shell' || name === 'shell' || name === 'run_shell_command') return 'Bash';
  if (name === 'write_file') return 'Write';
  if (name === 'replace') return 'Edit';
  if (name === 'multi_replace') return 'MultiEdit';
  return name;
}

export const mapGeminiToolName = mapAntigravityToolName;

function pickClaudeShape(data) {
  if (!data?.tool_name) return null;
  return {
    tool_name: data.tool_name,
    tool_input: data.tool_input || {},
    cwd: data.cwd || process.cwd(),
    session_id: data.session_id,
    stop_hook_active: data.stop_hook_active,
    hook_event_name: data.hook_event_name,
    tool_response: data.tool_response,
  };
}

function extractToolName(data) {
  return data?.tool?.name || data?.tool_name || '';
}

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

export function augmentAntigravityDenyReason(result) {
  if (result?.hookSpecificOutput?.permissionDecision !== 'deny') return result;
  if (result.reason) return result;
  const detailReason = result.hookSpecificOutput.permissionDecisionReason;
  if (!detailReason) return result;
  return { ...result, reason: detailReason };
}

export function buildCliEmission(result, opts = {}) {
  if (!result || Object.keys(result).length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  let out = result;

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

export function emit(result, opts = {}) {
  const emission = buildCliEmission(result, opts);
  if (emission.stdout) process.stdout.write(emission.stdout);
  if (emission.stderr) process.stderr.write(emission.stderr);
  process.exit(emission.exitCode);
}

export async function runAdapter(runFn, opts) {
  try {
    const raw = await readStdinJson();
    const normalized = normalizePayload(raw, opts.cli);
    const result = await runFn(normalized);
    emit(result, opts);
  } catch {
    process.exit(0);
  }
}
