# AGENTS.md

This repository uses the worktree safety ecosystem transplanted from
`brief2dev/.tmp/worktree-ecosystem-transplant`.

## Worktree Workflow

Code changes to tracked source must be made in a Git worktree, preferably under
`.worktrees/<branch>`.

Create new worktrees with:

```bash
make wt.new BR=feature/<task>
```

or, when `make` is unavailable:

```bash
node .claude/scripts/worktree-new.mjs --branch feature/<task>
```

Do not use raw `git worktree add` as the normal entrypoint. The standard
entrypoint fetches `origin/<base>`, fast-forwards the local base when safe,
creates the worktree from `origin/<base>`, initializes shared worktree state,
and creates a `PLAN.md`.

During work:

- Edit only inside the owned worktree.
- Use explicit paths or `git -C <worktree>` because AI shells can reset `cwd`.
- Do not stage unrelated user changes.
- Do not edit or commit another session's worktree.
- Do not commit directly on `main`.
- Do not run `git commit --amend`, rebase, force push, `git reset --hard`, or
  `git clean -fd` from AI tool calls.

Before shipping:

1. Commit only your own changes inside the worktree.
2. Run `make q.check` for this project.
3. Present a Pre-Ship Human Review Panel with summary, evidence, changed files,
   impact, trade-offs, risks, and rollback notes.
4. After human confirmation, create the marker:

```bash
node .claude/scripts/mark-pre-ship-confirmed.mjs feature/<task> --quality agent_go
```

5. Ship with:

```bash
node .claude/scripts/create-pr/ops.mjs ship-worktree \
  --worktree .worktrees/feature/<task> \
  --title "feat: ..." \
  --body "<summary>"
```

Use `make wt.run CMD="<command>"` when you need to run a command in the active
worktree from the main checkout.
