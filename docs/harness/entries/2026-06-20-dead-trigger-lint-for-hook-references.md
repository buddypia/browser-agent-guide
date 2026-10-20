# Lint hook references so a removed dependency cannot silently disable a guard

- **date**: 2026-06-20
- **dimension**: INV
- **motivation**: `pre-ship-review-guard` matched only the deleted `ops.mjs ship-*` command, so the Pre-Ship panel gate passed everything without any signal; hooks fail OPEN on a broken import (`docs/retros/retro-2026-06-20-orphaned-ship-gate.md`, `docs/retros/retro-2026-06-20-dead-trigger-detector.md`, PR #19).

## Edits

### `.claude/scripts/check-hook-refs.mjs`
- **change**: New lint: every relative import in `.claude/hooks` and `.claude/scripts` resolves and every concrete `.claude/…*.mjs` path literal exists; a test scans the live tree.
- **observed**: No orphaned-guard-trigger retro since. But PR #145 found the CLI's own main detection (`file://` + argv[1]) exited 0 without linting under symlinked or non-ASCII paths, so only the import-based live-tree test was reliably enforcing it; no execution isolates how much the lint prevented.
- **verdict**: confounded

## Lesson

- **cue**: A check script whose CLI entry point decides by itself whether to run, so "exit 0" cannot tell "passed" from "never ran".
- **lesson**: Give every check script under `scripts/` or `.claude/scripts/` a test that spawns its CLI (also through a symlinked path) on a failing fixture and asserts a non-zero exit; a test that only imports the module cannot see an inert CLI.
- **evidence**: `.claude/scripts/check-hook-refs.mjs` row — the CLI skipped silently until #145; `test/check-harness.test.mjs` "the CLI still fails when run through a symlinked path" now covers the same failure for check-harness.
- **confidence**: low — the only supporting row is confounded; the inert CLI is a fact, its cost is not measured.
