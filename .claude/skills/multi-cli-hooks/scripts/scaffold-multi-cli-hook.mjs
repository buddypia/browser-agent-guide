#!/usr/bin/env node

/**
 * scaffold-multi-cli-hook.mjs — 기존 Claude 본체 hook 을 다중 CLI(Codex)로 확장
 *
 * 무엇을 하는가 (갭 closer):
 *   - regen-hooks-settings.mjs 는 Claude `.claude/settings.json` 만 codegen 한다.
 *     `.codex/hooks.json` 은 수동 유지 → 드리프트 위험. 본 스크립트가 그 갭을 닫는다.
 *   - 입력: 이미 존재하는 본체 hook (`.claude/hooks/<name>.mjs`, export run()).
 *   - 출력: (1) Codex 어댑터 `.claude/hooks/codex/<name>.mjs` (runAdapter 3줄 위임)
 *           (2) `.codex/hooks.json` 의 해당 이벤트에 entry 추가 (idempotent, atomic).
 *
 * 무엇을 안 하는가:
 *   - Claude 본체 hook 생성/등록은 hook-creator + R-CM-006 절차(hook-registry → regen → audit)가 담당.
 *     본 스크립트는 Codex 쪽만 wire-up 한다. 결정 로직 SSOT 는 본체 1벌.
 *
 * 공식 계약 SSOT: ../references/codex-cli-hooks.md, ../references/claude-code-hooks.md,
 *               ../references/cross-cli-hook-mapping.md (tool 이름 매핑 표).
 *
 * Usage:
 *   node scaffold-multi-cli-hook.mjs --name <hook> --event <Event> --tools <bash,write,edit> [옵션]
 *   옵션: --matcher <regex>(자동 계산 override) --timeout <초,기본5> --status "<메시지>"
 *         --dry-run(쓰지 않고 계획만) --json(기계 판독 출력) --force(이미 wired 여도 재작성)
 *
 * 예:
 *   node scaffold-multi-cli-hook.mjs --name commit-guard --event PreToolUse --tools bash --dry-run
 *
 * Boundary: 관점 1 (brief2dev 자체) 전용 — R-CM-028. fail-soft (검증 실패 시 명확한 에러 + exit 1).
 */

import { execSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(SCRIPT_DIR);

/**
 * 중립 tool 토큰 → CLI 별 matcher 조각. SSOT: ../references/cross-cli-hook-mapping.md.
 * 공식 Codex 문서(references/codex-cli-hooks.md)가 canonical 로 명시하는 tool 은 Bash / apply_patch / MCP 뿐이다.
 * shell/run_shell/run_shell_command/exec_command 별칭은 brief2dev 관례(기존 .codex/hooks.json) — Codex tool명 변종에 대한
 * 방어적 확장이며 공식 문서로는 미검증(UNVERIFIED). apply_patch 는 Edit/Write/MultiEdit 를 모두 흡수(Codex 단일 파일 tool).
 */
const TOOL_MATCH = {
  bash:      { claude: ['Bash'],      codex: ['Bash', 'shell', 'run_shell', 'run_shell_command', 'exec_command'] },
  write:     { claude: ['Write'],     codex: ['Write', 'apply_patch'] },
  edit:      { claude: ['Edit'],      codex: ['Edit', 'apply_patch'] },
  multiedit: { claude: ['MultiEdit'], codex: ['MultiEdit', 'apply_patch'] },
  read:      { claude: ['Read'],      codex: ['Read'] },
};

/** Codex 공식 문서가 정의하는 이벤트 (references/codex-cli-hooks.md). */
const CODEX_EVENTS = new Set([
  'SessionStart', 'SubagentStart', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStop', 'Stop',
]);

/** flag → [destKey, kind]. table-driven 파서 (cyclomatic 최소화). */
const FLAG_SPEC = {
  '--name': ['name', 'value'], '--event': ['event', 'value'], '--tools': ['tools', 'list'],
  '--matcher': ['matcher', 'value'], '--timeout': ['timeout', 'int'], '--status': ['status', 'value'],
  '--dry-run': ['dryRun', 'bool'], '--json': ['json', 'bool'], '--force': ['force', 'bool'],
  '--help': ['help', 'bool'], '-h': ['help', 'bool'],
};

function parseArgs(argv) {
  const a = { tools: [], dryRun: false, json: false, force: false, timeout: 5 };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const spec = FLAG_SPEC[flag];
    if (!spec) continue;
    const [key, kind] = spec;
    if (kind === 'bool') { a[key] = true; continue; }
    // value/list/int: 다음 토큰 필요 — 마지막 위치면 값 누락 (TypeError 회피)
    if (i + 1 >= argv.length) {
      process.stderr.write(`오류: ${flag} 플래그는 값이 필요합니다.\n`);
      process.exit(1);
    }
    const val = argv[++i];
    if (kind === 'int') a[key] = parseInt(val, 10) || 5;
    else if (kind === 'list') a[key] = val.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else a[key] = val;
  }
  return a;
}

function repoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    // worktree/CI fallback: skill 경로에서 .claude 위로 4단계
    return join(SKILL_DIR, '..', '..', '..');
  }
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

function computeCodexMatcher(args) {
  if (args.matcher) return args.matcher;
  if (!args.tools.length) return null; // 이벤트가 tool-less (Stop/SessionStart) — matcher 생략
  const set = [];
  for (const t of args.tools) {
    const m = TOOL_MATCH[t];
    if (!m) throw new Error(`알 수 없는 tool 토큰 "${t}". 허용: ${Object.keys(TOOL_MATCH).join(', ')}`);
    for (const name of m.codex) if (!set.includes(name)) set.push(name);
  }
  return `^(${set.join('|')})$`;
}

function buildAdapter(name, event) {
  const tplPath = join(SKILL_DIR, 'templates', 'codex-adapter.template.mjs');
  const tpl = readFileSync(tplPath, 'utf8');
  return tpl.replaceAll('__NAME__', name).replaceAll('__EVENT__', event);
}

function loadCodexHooks(root) {
  const p = join(root, '.codex', 'hooks.json');
  if (!existsSync(p)) {
    return { path: p, data: { hooks: {} } };
  }
  try {
    return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    throw new Error(`${p} 파싱 실패 (${e.message}). 유효한 JSON 인지 확인 후 재실행하세요.`);
  }
}

function codexCommand(name) {
  return `node "$(git rev-parse --show-toplevel)/.claude/hooks/codex/${name}.mjs"`;
}

/** 이미 같은 command 가 해당 이벤트에 등록돼 있으면 true (idempotency). */
function alreadyWired(data, event, command) {
  const groups = data.hooks?.[event] || [];
  return groups.some((g) => (g.hooks || []).some((h) => h.command === command));
}

function patchCodexHooks(data, event, matcher, command, timeout, status) {
  if (!data.hooks) data.hooks = {};
  if (!data.hooks[event]) data.hooks[event] = [];
  // 멱등 replace: 같은 command 의 기존 hook 을 먼저 제거 (--force 재패치 시 중복 누적 방지).
  data.hooks[event] = data.hooks[event]
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => h.command !== command) }))
    .filter((g) => (g.hooks || []).length > 0);
  const hookEntry = { type: 'command', command, timeout };
  if (status) hookEntry.statusMessage = status;
  const group = matcher ? { matcher, hooks: [hookEntry] } : { hooks: [hookEntry] };
  data.hooks[event].push(group);
  return data;
}

function printUsage() {
  process.stdout.write(
    'Usage: node scaffold-multi-cli-hook.mjs --name <hook> --event <Event> --tools <bash,write,edit> [--matcher <re>] [--timeout <s>] [--status "<msg>"] [--dry-run] [--json] [--force]\n'
    + `이벤트(Codex): ${[...CODEX_EVENTS].join(', ')}\n`
    + `tool 토큰: ${Object.keys(TOOL_MATCH).join(', ')}\n`,
  );
}

/** 입력 검증. 치명 오류 시 result.errors 채우고 null 반환. 경고는 result.warnings 누적. */
function validateInputs(args, root, result) {
  if (!CODEX_EVENTS.has(args.event)) {
    // 오타 이벤트가 .codex/hooks.json 에 dead wiring 으로 기록되는 것 차단. --force 로만 강제.
    if (!args.force) {
      result.errors.push(`"${args.event}" 는 Codex 공식 이벤트 아님 (references/codex-cli-hooks.md). 오타 확인 또는 --force 로 강제 등록.`);
      return null;
    }
    result.warnings.push(`"${args.event}" 강제 등록 (--force) — Codex 공식 이벤트 아님. dead wiring 위험.`);
  }
  const bodyPath = join(root, '.claude', 'hooks', `${args.name}.mjs`);
  if (!existsSync(bodyPath)) {
    result.errors.push(`본체 hook 부재: ${bodyPath}. 먼저 hook-creator 또는 수동으로 본체를 만들고 hook-registry 등록 후 실행하세요.`);
    return null;
  }
  const bodySrc = readFileSync(bodyPath, 'utf8');
  if (!/export\s+(async\s+)?function\s+run\b/.test(bodySrc)) {
    result.warnings.push(`${args.name}.mjs 에 "export function run(data)" 패턴이 보이지 않음. 어댑터는 run 을 import 하므로 export 필요.`);
  }
  return bodyPath;
}

/** 어댑터 파일 + .codex/hooks.json 쓰기. 실패 시 result.errors 채우고 false 반환. */
function executeWrite(plan, args, result) {
  const { adapterDir, adapterPath, adapterSrc, codexPath, codexData, command, wired, matcher } = plan;
  try {
    if (!existsSync(adapterDir)) mkdirSync(adapterDir, { recursive: true });
    writeAtomic(adapterPath, adapterSrc);
    if (!wired || args.force) {
      const patched = patchCodexHooks(codexData, args.event, matcher, command, args.timeout, args.status);
      if (!existsSync(dirname(codexPath))) mkdirSync(dirname(codexPath), { recursive: true });
      writeAtomic(codexPath, `${JSON.stringify(patched, null, 2)}\n`);
    }
    result.actions.push('완료 — 다음 단계: Codex 에서 [features] hooks=true + project trust 확인 (references/codex-cli-hooks.md).');
    return true;
  } catch (e) {
    result.errors.push(`쓰기 실패: ${e.message}`);
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.name || !args.event) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const root = repoRoot();
  const result = { name: args.name, event: args.event, actions: [], warnings: [], errors: [], dryRun: args.dryRun };

  if (!validateInputs(args, root, result)) return finish(result, args, 1);

  let matcher;
  try {
    matcher = computeCodexMatcher(args);
  } catch (e) {
    result.errors.push(e.message);
    return finish(result, args, 1);
  }
  result.codexMatcher = matcher;

  try {
    const adapterDir = join(root, '.claude', 'hooks', 'codex');
    const adapterPath = join(adapterDir, `${args.name}.mjs`);
    const adapterSrc = buildAdapter(args.name, args.event);
    const { path: codexPath, data: codexData } = loadCodexHooks(root); // 손상 JSON 시 throw → 아래 catch
    const command = codexCommand(args.name);
    const wired = alreadyWired(codexData, args.event, command);
    Object.assign(result, { adapterPath, codexHooksPath: codexPath, command });

    result.actions.push(wired && !args.force
      ? `.codex/hooks.json: 이미 등록됨 (${args.event} ← ${args.name}) — SKIP (idempotent). 재작성하려면 --force`
      : `.codex/hooks.json: ${args.event} 에 entry 추가 (matcher=${matcher || '(없음)'})`);
    result.actions.push(`${existsSync(adapterPath) ? '덮어쓰기' : '생성'}: ${adapterPath}`);

    if (args.dryRun) {
      result.adapterPreview = adapterSrc;
      return finish(result, args, 0);
    }

    const plan = { adapterDir, adapterPath, adapterSrc, codexPath, codexData, command, wired, matcher };
    return finish(result, args, executeWrite(plan, args, result) ? 0 : 1);
  } catch (e) {
    result.errors.push(e.message);
    return finish(result, args, 1);
  }
}

function finish(result, args, code) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`\n[multi-cli-hook scaffold] ${result.name} → ${result.event}\n`);
    if (result.codexMatcher) process.stdout.write(`  Codex matcher: ${result.codexMatcher}\n`);
    for (const a of result.actions) process.stdout.write(`  • ${a}\n`);
    for (const w of result.warnings) process.stdout.write(`  ⚠ ${w}\n`);
    for (const e of result.errors) process.stdout.write(`  ✗ ${e}\n`);
    if (args.dryRun && result.adapterPreview) {
      process.stdout.write('\n--- 어댑터 미리보기 (.claude/hooks/codex/' + result.name + '.mjs) ---\n');
      process.stdout.write(result.adapterPreview + '\n');
    }
  }
  process.exit(code);
}

main();
