#!/usr/bin/env node
// check-js.mjs — `node --check` over every tracked or new .js/.mjs in the extension's source dirs.
// Replaces a hand-kept file list in package.json that new files were left out of
// (scripts/debug-with-extension.mjs never got in), so no one has to remember to register a file.
//
// Uses the shared cross-worktree scratchpad (`js-syntax-v1.json`) to skip spawning
// `node --check` on files whose content SHA-256 has already been verified, and runs
// remaining checks with bounded concurrency instead of sequential `spawnSync` calls.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  filterUncachedJsFiles,
  recordJsSyntaxPassed,
  resolveScratchpadDir,
} from './agent-scratchpad.mjs';

const SOURCE_DIRS = ['background', 'content', 'sidepanel', 'options', 'offscreen', 'lib', 'scripts'];
const CONCURRENCY = 8;

export function listSourceFiles(root) {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_DIRS],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return [...new Set(out.split('\n'))]
    .filter((f) => /\.m?js$/.test(f) && existsSync(join(root, f)))
    .sort();
}

function checkFileAsync(root, relFile) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, ['--check', relFile], { cwd: root }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      resolvePromise({ rel: relFile, ok: !err });
    });
  });
}

export async function runCheckJs(root, { noCache = false, scratchDir = resolveScratchpadDir(root) } = {}) {
  const files = listSourceFiles(root);
  const { uncached, cachedCount } = noCache
    ? { uncached: files.map((rel) => ({ rel, sha256: null })), cachedCount: 0 }
    : filterUncachedJsFiles(root, files, scratchDir);

  const failed = [];
  const passedHashes = [];

  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    const batch = uncached.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((item) => checkFileAsync(root, item.rel)));
    for (let j = 0; j < results.length; j++) {
      if (results[j].ok) {
        if (batch[j].sha256) passedHashes.push(batch[j].sha256);
      } else {
        failed.push(batch[j].rel);
      }
    }
  }

  if (!noCache && passedHashes.length > 0) {
    recordJsSyntaxPassed(passedHashes, scratchDir);
  }

  return { total: files.length, cachedCount, checkedCount: uncached.length, failed };
}

const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const noCache = process.argv.includes('--no-cache');
  const { total, cachedCount, failed } = await runCheckJs(root, { noCache });
  if (failed.length) {
    console.error(`syntax errors in ${failed.length} file(s): ${failed.join(', ')}`);
    process.exit(1);
  }
  const cacheNote = cachedCount > 0 ? `, ${cachedCount} cached` : '';
  console.log(`syntax OK (${total} files${cacheNote})`);
}
