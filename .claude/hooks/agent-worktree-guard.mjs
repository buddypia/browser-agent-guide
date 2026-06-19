#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const guard = path.join(repoRoot, 'scripts/agent-worktree-guard/guard.py');
const mode = process.argv.slice(2);

if (mode.length === 0) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const input = readFileSync(0, 'utf8');

const result = spawnSync('python3', [guard, 'hook', ...mode], {
  cwd: process.cwd(),
  env: process.env,
  input,
  encoding: 'utf8',
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 0);
