#!/usr/bin/env node
// run-checks.mjs — run package.json scripts concurrently, print each one's output as a block, fail if any fail.
// `npm run a && npm run b && …` paid one npm start per step (≈1.5 s each when parallel sessions load the machine)
// and ran node-only checks one after another; this runs them side by side without npm in between.
// Usage: node scripts/run-checks.mjs <script> [<script> …]   (names are package.json "scripts" keys)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const names = process.argv.slice(2);
const unknown = names.filter((n) => !scripts[n]);
if (!names.length || unknown.length) {
  console.error(unknown.length ? `unknown package.json script(s): ${unknown.join(', ')}` : 'usage: run-checks.mjs <script>…');
  process.exit(2);
}

// npm puts node_modules/.bin on PATH for its scripts; keep that without starting npm.
const env = { ...process.env, PATH: `${join(root, 'node_modules/.bin')}:${process.env.PATH}` };

function runOne(name) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn('sh', ['-c', scripts[name]], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => done({ name, code, out, secs: ((Date.now() - started) / 1000).toFixed(1) }));
  });
}

const queue = [...names];
const results = [];
const workers = Array.from({ length: Math.min(names.length, Math.max(2, Math.floor(availableParallelism() / 2))) }, async () => {
  while (queue.length) {
    const r = await runOne(queue.shift());
    results.push(r);
    // Passing steps print one line; a failing step prints its whole output so the cause is in the log.
    console.log(r.code === 0 ? `ok   ${r.name} (${r.secs}s)` : `FAIL ${r.name} (${r.secs}s, exit ${r.code})\n${r.out.trimEnd()}\n`);
  }
});
await Promise.all(workers);
const failed = results.filter((r) => r.code !== 0).map((r) => r.name);
if (failed.length) {
  console.error(`\n${failed.length}/${names.length} failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nall ${names.length} passed`);
