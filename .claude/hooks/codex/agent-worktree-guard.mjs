#!/usr/bin/env node

/**
 * codex/agent-worktree-guard.mjs — Codex CLI adapter for Agent Worktree Guard.
 *
 * The domain logic lives in scripts/agent-worktree-guard/guard.py so Claude,
 * Codex, and Git hooks share the same ledger and owner-marker rules.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const guard = path.join(repoRoot, 'scripts/agent-worktree-guard/guard.py');
const mode = process.argv.slice(2);

if (mode.length === 0) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const input = readFileSync(0, 'utf8');

const PRETOOL_CMD_RE = /\b(?:git|gh|rm)\b/;
const PRETOOL_ACTION_RE = /\b(?:worktree|push|pr|rm)\b/;
const POSTTOOL_CMD_RE = /\b(?:commit|push|pr|worktree)\b|\bBR=|\bBRANCH=|--branch|\s-[bB]\b/;

function extractBashCommand(raw) {
  try {
    const data = JSON.parse(raw);
    const cmd =
      data?.tool_input?.command ??
      data?.tool?.input?.command ??
      data?.input?.command;
    return typeof cmd === 'string' ? cmd : null;
  } catch {
    return null;
  }
}

if (mode[0] === 'pre-tool') {
  const cmd = extractBashCommand(input);
  if (cmd !== null && (!PRETOOL_CMD_RE.test(cmd) || !PRETOOL_ACTION_RE.test(cmd))) {
    process.exit(0);
  }
} else if (mode[0] === 'post-tool') {
  const cmd = extractBashCommand(input);
  if (cmd !== null && !POSTTOOL_CMD_RE.test(cmd)) {
    process.exit(0);
  }
}

const result = spawnSync('python3', [guard, 'hook', ...mode], {
  cwd: process.cwd(),
  env: process.env,
  input,
  encoding: 'utf8',
});

if (result.error) process.exit(0);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 0);
