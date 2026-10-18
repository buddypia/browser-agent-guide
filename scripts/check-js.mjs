#!/usr/bin/env node
// check-js.mjs — `node --check` over every tracked or new .js/.mjs in the extension's source dirs.
// Replaces a hand-kept file list in package.json that new files were left out of
// (scripts/debug-with-extension.mjs never got in), so no one has to remember to register a file.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIRS = ['background', 'content', 'sidepanel', 'options', 'offscreen', 'lib', 'scripts'];

function listSourceFiles(root) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_DIRS], {
    cwd: root,
    encoding: 'utf8',
  });
  return [...new Set(out.split('\n'))].filter((f) => /\.m?js$/.test(f) && existsSync(join(root, f))).sort();
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = listSourceFiles(root);
const failed = files.filter((f) => {
  const r = spawnSync(process.execPath, ['--check', f], { cwd: root, stdio: 'inherit' });
  return r.status !== 0;
});
if (failed.length) {
  console.error(`syntax errors in ${failed.length} file(s): ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`syntax OK (${files.length} files)`);
