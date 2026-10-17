// .agents/hooks.json — Antigravity(agy) 훅 등록 계약.
//
// 계약 출처: agy 바이너리 내장 "Lifecycle Hooks (`hooks.json`)" 문서 + 2026-10-17 실측.
//   - 최상위 키 = hook 이름. PreToolUse/PostToolUse 만 `{ matcher, hooks: [...] }` 로 감싸고 SessionStart/Stop 은
//     handler 를 직접 나열한다. 하나라도 어긋나면 agy 는 파일 전체를 버린다 (이 파일은 그렇게 29회 버려졌다:
//     `invalid hook "agent-worktree-guard": command hook must specify 'command'`).
//   - 입력은 camelCase (`toolCall.args.CommandLine` · `conversationId`), 출력은 protojson 이라 모르는 키
//     (`hookSpecificOutput` 등)가 섞이면 결과 전체가 버려진다 — Claude 규약으로 답하는 가드는 agy 에서 아무것도 막지 못한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_DIR = join(ROOT, '.agents');
const HOOKS = JSON.parse(readFileSync(join(AGENTS_DIR, 'hooks.json'), 'utf8'));
const BRIDGE = join(ROOT, '.claude/hooks/antigravity/agy-bridge.mjs');
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const isCommand = (h) => typeof h?.command === 'string' && h.command.trim().length > 0;

function schemaViolations(config) {
  const violations = [];
  for (const [name, events] of Object.entries(config)) {
    for (const [event, entries] of Object.entries(events)) {
      if (event === 'enabled') {
        if (typeof entries !== 'boolean') violations.push(`${name}.enabled: boolean`);
        continue;
      }
      for (const [i, entry] of (Array.isArray(entries) ? entries : [null]).entries()) {
        const ok = TOOL_EVENTS.has(event)
          ? typeof entry?.matcher === 'string' && Array.isArray(entry.hooks) && entry.hooks.length > 0 && entry.hooks.every(isCommand)
          : isCommand(entry);
        if (!ok) violations.push(`${name}.${event}[${i}]`);
      }
    }
  }
  return violations;
}

const commands = (event) =>
  Object.values(HOOKS)
    .flatMap((spec) => spec[event] || [])
    .flatMap((entry) => (TOOL_EVENTS.has(event) ? entry.hooks : [entry]))
    .map((h) => h.command);

// 실제 저장소의 .tmp (ledger·소유 기록)를 건드리지 않도록 가드는 임시 저장소에서 판정한다.
function withTempRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'bag-agy-repo-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// agy 와 같은 방식 — 등록 문자열 그대로, hooks.json 디렉터리에서 `sh -c`.
function runRegistered(event, pattern, payload) {
  const command = commands(event).find((c) => pattern.test(c));
  assert.ok(command, `${event}: ${pattern} 미등록`);
  return spawnSync('sh', ['-c', command], { cwd: AGENTS_DIR, input: JSON.stringify(payload), encoding: 'utf8' });
}

// 가짜 가드로 브리지를 돌린다 — 가드가 받은 stdin 은 SEEN 에 남고, 출력은 지정한 대로 낸다.
function runBridge(event, payload, { stdout = '', stderr = '', status = 0 } = {}) {
  const script = "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{require('fs').writeFileSync(process.env.SEEN,b);"
    + `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${status});});`;
  const dir = mkdtempSync(join(tmpdir(), 'bag-agy-bridge-'));
  const seen = join(dir, 'seen.json');
  try {
    const result = spawnSync('node', [BRIDGE, event, 'node', '-e', script], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, SEEN: seen },
    });
    assert.equal(result.status, 0, result.stderr);
    return {
      stdout: result.stdout,
      output: result.stdout.trim() ? JSON.parse(result.stdout) : {},
      seen: existsSync(seen) ? JSON.parse(readFileSync(seen, 'utf8')) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hooks.json 이 agy 가 받는 형태다 (하나라도 어긋나면 파일 전체가 버려진다)', () => {
  assert.deepEqual(schemaViolations(HOOKS), []);
  assert.equal(schemaViolations({ x: { Stop: [{ hooks: [{ command: 'x' }] }] } }).length, 1); // 2026-10 까지의 형태
  assert.equal(schemaViolations({ x: { PreToolUse: [{ command: 'x' }] } }).length, 1);
});

test('모든 명령이 agy 브리지를 거친다 (가드는 Claude 규약만 말한다)', () => {
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const list = commands(event);
    assert.ok(list.length > 0, event);
    for (const c of list) assert.match(c, new RegExp(`agy-bridge\\.mjs" ${event} `), c);
  }
  assert.ok(commands('Stop').some((c) => /worktree-shipping-guard\.mjs/.test(c)));
});

test('실제 agy run_command 입력으로 raw git worktree add 를 막고 사유를 전달한다', () => {
  const result = withTempRepo((repo) => runRegistered('PreToolUse', /agent-worktree-guard\.mjs" pre-tool/, {
    toolCall: { name: 'run_command', args: { CommandLine: 'git worktree add /nonexistent-agy/q no-such-ref', Cwd: repo } },
    conversationId: 'agy-test',
    workspacePaths: [repo],
  }));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.allow_tool, false);
  assert.match(output.deny_reason, /Raw `git worktree add` is blocked/);
});

test('브리지: 입력 번역과 통과 시 무출력', () => {
  const { seen, stdout } = runBridge('PreToolUse', {
    toolCall: { name: 'run_command', args: { CommandLine: 'ls', Cwd: '/w' } },
    conversationId: 'c-1',
    workspacePaths: ['/ws'],
  });
  assert.equal(seen.tool_name, 'run_command');
  assert.equal(seen.tool_input.command, 'ls');
  assert.equal(seen.cwd, '/w');
  assert.equal(seen.session_id, 'c-1');
  assert.equal(seen.hook_event_name, 'PreToolUse');
  // 통과는 `{}` 가 아니라 무출력 — agy 는 `{}` 도 결과로 세어 뒤 훅의 차단 사유를 빈칸으로 덮는다 (실측)
  assert.equal(stdout, '');
  assert.equal(runBridge('PreToolUse', { workspacePaths: ['/ws'] }).seen.cwd, '/ws');
});

test('브리지: Claude 의 차단 두 형태가 agy 차단이 된다', () => {
  const deny = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'r1' } });
  assert.deepEqual(runBridge('PreToolUse', {}, { stdout: deny }).output, { allow_tool: false, deny_reason: 'r1' });
  assert.deepEqual(runBridge('PreToolUse', {}, { stderr: 'r2\n', status: 2 }).output, { allow_tool: false, deny_reason: 'r2' });
  const block = JSON.stringify({ decision: 'block', reason: 'r3' });
  assert.deepEqual(runBridge('Stop', {}, { stdout: block }).output, { decision: 'continue', reason: 'r3' });
  assert.deepEqual(runBridge('PostToolUse', {}, { stdout: block }).output, {}); // PostToolUse 는 빈 객체만 받는다
});

test('브리지: Stop — executionNum 은 0 부터, 사용자 취소에는 가드를 돌리지 않는다', () => {
  assert.equal(runBridge('Stop', {}).seen.stop_hook_active, false);
  assert.equal(runBridge('Stop', { executionNum: 0 }).seen.stop_hook_active, false);
  assert.equal(runBridge('Stop', { executionNum: 1 }).seen.stop_hook_active, true); // continue 로 되돌아온 Stop
  const block = JSON.stringify({ decision: 'block', reason: 'r' });
  const canceled = runBridge('Stop', { terminationReason: 'USER_CANCELED' }, { stdout: block });
  assert.equal(canceled.seen, null);
  assert.equal(canceled.stdout, '');
});

test('브리지: SessionStart 컨텍스트는 injectSteps 가 된다', () => {
  const ctx = JSON.stringify({ hookSpecificOutput: { additionalContext: 'ledger' } });
  assert.deepEqual(runBridge('SessionStart', {}, { stdout: ctx }).output, {
    injectSteps: [{ systemMessage: { systemMessage: 'ledger' } }],
  });
});

test('브리지: PostToolUse 의 agy error 문자열이 exit_code 가 된다', () => {
  assert.equal(runBridge('PostToolUse', { error: 'exit status 3' }).seen.tool_response.exit_code, 3);
  assert.equal(runBridge('PostToolUse', { result: 'ok' }).seen.tool_response.exit_code, 0);
});
