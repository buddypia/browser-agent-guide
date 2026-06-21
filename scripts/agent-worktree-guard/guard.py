#!/usr/bin/env python3
"""Agent Worktree Guard."""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import io
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


PROMPT_QUESTION = (
    "すべてのworktreeの作業が完了しました。PR（プルリクエスト）を作成しますか？\n"
    "(모든 worktree 작업이 완료되었습니다. PR(풀 리퀘스트)을 생성하시겠습니까?)"
)
PROMPT = PROMPT_QUESTION

TOOL_NAME = "Agent Worktree Guard"
SCHEMA_VERSION = "1.0"
STATUS_REL = Path(".tmp/.worktree_status.md")
OWNER_REL = Path(".tmp/.agent_worktree_owner.json")
LEDGER_DIR_REL = Path(".tmp/worktree-guard-ledger")
GITIGNORE_ENTRIES = [
    ".tmp/.worktree_status.md",
    ".tmp/worktree-guard-ledger/",
    ".tmp/.agent_worktree_owner.json",
]


class GuardError(RuntimeError):
    """User-facing guard failure."""


def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def run_cmd(
    args: list[str],
    cwd: Path | None = None,
    *,
    check: bool = True,
    stdin: str | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise GuardError(f"{' '.join(args)} failed ({result.returncode}): {detail}")
    return result


def git(args: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run_cmd(["git", *args], cwd=cwd, check=check)


def git_root(cwd: Path | None = None) -> Path:
    base = cwd or Path.cwd()
    result = git(["rev-parse", "--show-toplevel"], base)
    return Path(result.stdout.strip()).resolve()


def safe_session_id(value: str | None) -> str:
    raw = (value or "manual").strip() or "manual"
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", raw).strip("._-")
    return (safe or "manual")[:120]


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as exc:
        raise GuardError(f"Malformed JSON: {path}: {exc}") from exc


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def real(path: Path) -> str:
    return str(path.expanduser().resolve(strict=False))


def is_relative_to(child: Path, parent: Path) -> bool:
    try:
        child.resolve(strict=False).relative_to(parent.resolve(strict=False))
        return True
    except ValueError:
        return False


def current_session_id(payload: dict[str, Any] | None = None, explicit: str | None = None) -> str:
    if explicit:
        return safe_session_id(explicit)
    if payload and payload.get("session_id"):
        return safe_session_id(str(payload["session_id"]))
    for key in ("AGENT_WORKTREE_GUARD_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID"):
        if os.environ.get(key):
            return safe_session_id(os.environ[key])
    marker = Path.cwd().joinpath(OWNER_REL)
    if marker.exists():
        data = read_json(marker, {})
        if data.get("session_id"):
            return safe_session_id(str(data["session_id"]))
    return "manual"


def resolve_guard_root(cwd: Path | None = None) -> Path:
    if os.environ.get("AGENT_WORKTREE_GUARD_ROOT"):
        return Path(os.environ["AGENT_WORKTREE_GUARD_ROOT"]).expanduser().resolve()

    root = git_root(cwd or Path.cwd())
    marker = root / OWNER_REL
    if marker.exists():
        data = read_json(marker, {})
        ledger_root = data.get("ledger_root")
        if ledger_root:
            return Path(ledger_root).expanduser().resolve()
    return root


def ledger_path(root: Path, session_id: str) -> Path:
    return root / LEDGER_DIR_REL / f"{safe_session_id(session_id)}.json"


def status_path(root: Path) -> Path:
    return root / STATUS_REL


def owner_path(worktree_path: Path) -> Path:
    return worktree_path / OWNER_REL


def empty_ledger(root: Path, session_id: str) -> dict[str, Any]:
    now = utc_now()
    return {
        "schema_version": SCHEMA_VERSION,
        "tool": TOOL_NAME,
        "session_id": safe_session_id(session_id),
        "ledger_root": real(root),
        "created_at": now,
        "updated_at": now,
        "pr_confirmation_prompted": False,
        "pr_confirmation_prompted_at": None,
        "pr_confirmation_confirmed": False,
        "pr_confirmation_confirmed_at": None,
        "worktrees": [],
        "events": [],
    }


def load_ledger(root: Path, session_id: str, *, create: bool = False) -> dict[str, Any]:
    path = ledger_path(root, session_id)
    if not path.exists():
        if not create:
            raise GuardError(f"Ledger does not exist: {path}")
        ledger = empty_ledger(root, session_id)
        save_ledger(root, ledger)
        return ledger
    ledger = read_json(path, {})
    if not isinstance(ledger, dict):
        raise GuardError(f"Ledger is not an object: {path}")
    return ledger


def save_ledger(root: Path, ledger: dict[str, Any]) -> None:
    ledger["updated_at"] = utc_now()
    atomic_write_json(ledger_path(root, ledger["session_id"]), ledger)


def append_event(ledger: dict[str, Any], event: str, details: dict[str, Any]) -> None:
    ledger.setdefault("events", []).append({"at": utc_now(), "event": event, **details})
    ledger["events"] = ledger["events"][-200:]


def ensure_gitignore(root: Path) -> None:
    path = root / ".gitignore"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = existing.splitlines()
    missing = [entry for entry in GITIGNORE_ENTRIES if entry not in lines]
    if not missing:
        return
    section = ["", "# Agent Worktree Guard runtime state", *missing]
    path.write_text(existing.rstrip("\n") + "\n" + "\n".join(section) + "\n", encoding="utf-8")


def render_status(root: Path, ledger: dict[str, Any]) -> None:
    path = status_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        "# Agent Worktree Guard Status",
        "",
        f"- Session: `{ledger['session_id']}`",
        f"- Ledger: `{LEDGER_DIR_REL / (ledger['session_id'] + '.json')}`",
        f"- Updated: `{ledger.get('updated_at', utc_now())}`",
        "",
        "## Worktrees",
        "",
    ]
    worktrees = ledger.get("worktrees", [])
    if not worktrees:
        rows.append("_No worktrees registered for this session._")
    for item in worktrees:
        checked = "x" if item.get("done") else " "
        branch = item.get("branch") or "(detached)"
        status = item.get("status", "open")
        reason = item.get("done_reason")
        suffix = f" - {status}"
        if reason:
            suffix += f" ({reason})"
        if item.get("pr_created_at"):
            suffix += " / pr-created"
        if item.get("pr_merged_at"):
            suffix += " / pr-merged"
        rows.append(f"- [{checked}] `{branch}` - `{item.get('path')}`{suffix}")
    rows.append("")
    path.write_text("\n".join(rows), encoding="utf-8")


def ensure_runtime(root: Path, session_id: str) -> dict[str, Any]:
    (root / LEDGER_DIR_REL).mkdir(parents=True, exist_ok=True)
    ledger = load_ledger(root, session_id, create=True)
    ensure_gitignore(root)
    render_status(root, ledger)
    return ledger


def parse_worktree_porcelain_z(stdout: str) -> list[dict[str, str | None]]:
    entries: list[dict[str, str | None]] = []
    current: dict[str, str | None] = {}
    for field in stdout.split("\0"):
        if field == "":
            if current:
                entries.append(current)
                current = {}
            continue
        key, _, value = field.partition(" ")
        if key == "worktree":
            current["path"] = value
        elif key == "branch":
            current["branch"] = value.removeprefix("refs/heads/")
        elif key in {"HEAD", "detached", "bare", "locked", "prunable"}:
            current[key] = value or "true"
    if current:
        entries.append(current)
    return entries


def list_git_worktrees(root: Path) -> list[dict[str, str | None]]:
    result = git(["worktree", "list", "--porcelain", "-z"], root)
    return parse_worktree_porcelain_z(result.stdout)


def branch_exists(root: Path, branch: str) -> bool:
    result = git(["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], root, check=False)
    return result.returncode == 0


def infer_branch_from_path(path: Path) -> str | None:
    parts = list(path.parts)
    if ".worktrees" not in parts:
        return None
    idx = len(parts) - 1 - list(reversed(parts)).index(".worktrees")
    tail = parts[idx + 1 :]
    if len(tail) >= 2:
        return f"{tail[0]}/{tail[1]}"
    if len(tail) == 1 and "__" in tail[0]:
        prefix, rest = tail[0].split("__", 1)
        if prefix and rest:
            return f"{prefix}/{rest}"
    return None


def current_branch(path: Path) -> str | None:
    result = git(["branch", "--show-current"], path, check=False)
    branch = result.stdout.strip()
    return branch or None


def find_ledger_item(ledger: dict[str, Any], path: Path) -> dict[str, Any] | None:
    needle = real(path)
    for item in ledger.get("worktrees", []):
        if item.get("realpath") == needle or real(Path(str(item.get("path", "")))) == needle:
            return item
    return None


def write_owner_marker(
    root: Path,
    session_id: str,
    worktree_path: Path,
    branch: str | None,
    base: str | None,
) -> Path:
    marker = owner_path(worktree_path)
    atomic_write_json(
        marker,
        {
            "schema_version": SCHEMA_VERSION,
            "tool": TOOL_NAME,
            "session_id": safe_session_id(session_id),
            "ledger_root": real(root),
            "worktree_path": real(worktree_path),
            "branch": branch,
            "base": base,
            "created_at": utc_now(),
        },
    )
    return marker


def verify_owner_marker(item: dict[str, Any], session_id: str, root: Path) -> dict[str, Any]:
    path = Path(str(item["path"]))
    marker = owner_path(path)
    data = read_json(marker, None)
    if not isinstance(data, dict):
        raise GuardError(f"Owner marker missing or invalid: {marker}")
    if safe_session_id(str(data.get("session_id", ""))) != safe_session_id(session_id):
        raise GuardError(f"Owner marker session mismatch: {marker}")
    if real(Path(str(data.get("ledger_root", "")))) != real(root):
        raise GuardError(f"Owner marker ledger root mismatch: {marker}")
    if real(Path(str(data.get("worktree_path", "")))) != real(path):
        raise GuardError(f"Owner marker worktree path mismatch: {marker}")
    return data


def upsert_worktree(
    ledger: dict[str, Any],
    *,
    path: Path,
    branch: str | None,
    base: str | None,
    owner_marker: Path,
) -> None:
    now = utc_now()
    existing = find_ledger_item(ledger, path)
    if existing:
        existing.update(
            {
                "path": real(path),
                "realpath": real(path),
                "branch": branch,
                "base": base,
                "owner_marker": real(owner_marker),
                "status": "open" if not existing.get("done") else existing.get("status", "done"),
                "updated_at": now,
            }
        )
        existing.setdefault("pr_created_at", None)
        existing.setdefault("pr_merged_at", None)
        return
    ledger.setdefault("worktrees", []).append(
        {
            "path": real(path),
            "realpath": real(path),
            "branch": branch,
            "base": base,
            "owner_marker": real(owner_marker),
            "status": "open",
            "done": False,
            "done_reason": None,
            "created_at": now,
            "updated_at": now,
            "cleaned_at": None,
            "pr_created_at": None,
            "pr_merged_at": None,
        }
    )


def cmd_init(args: argparse.Namespace) -> int:
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = ensure_runtime(root, session_id)
    print(f"Initialized {TOOL_NAME}")
    print(f"status={status_path(root)}")
    print(f"ledger={ledger_path(root, ledger['session_id'])}")
    return 0


def cmd_add(args: argparse.Namespace) -> int:
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = ensure_runtime(root, session_id)
    wt_path = Path(args.path).expanduser()
    if not wt_path.is_absolute():
        wt_path = (root / wt_path).resolve(strict=False)
    base = args.base
    branch = args.branch or infer_branch_from_path(wt_path)

    if branch:
        if branch_exists(root, branch):
            cmd = ["worktree", "add", str(wt_path), branch]
        else:
            cmd = ["worktree", "add", str(wt_path), "-b", branch, base or "HEAD"]
    else:
        cmd = ["worktree", "add", str(wt_path)]
        if base:
            cmd.append(base)

    git(cmd, root)
    branch = current_branch(wt_path) or branch
    marker = write_owner_marker(root, session_id, wt_path, branch, base)
    upsert_worktree(ledger, path=wt_path, branch=branch, base=base, owner_marker=marker)
    append_event(ledger, "add", {"path": real(wt_path), "branch": branch, "base": base})
    save_ledger(root, ledger)
    render_status(root, ledger)
    print(f"registered {real(wt_path)}")
    return 0


def cmd_register(args: argparse.Namespace) -> int:
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = ensure_runtime(root, session_id)
    wt_path = Path(args.path).expanduser()
    if not wt_path.is_absolute():
        wt_path = (root / wt_path).resolve(strict=False)
    known = {real(Path(str(wt["path"]))): wt for wt in list_git_worktrees(root) if wt.get("path")}
    if real(wt_path) not in known:
        raise GuardError(f"Not a Git worktree for this repository: {wt_path}")
    branch = str(known[real(wt_path)].get("branch") or "") or current_branch(wt_path)
    marker = write_owner_marker(root, session_id, wt_path, branch, None)
    upsert_worktree(ledger, path=wt_path, branch=branch, base=None, owner_marker=marker)
    append_event(ledger, "register", {"path": real(wt_path), "branch": branch})
    save_ledger(root, ledger)
    render_status(root, ledger)
    print(f"registered {real(wt_path)}")
    return 0


def cmd_mark_done(args: argparse.Namespace) -> int:
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = load_ledger(root, session_id)
    wt_path = Path(args.path).expanduser()
    if not wt_path.is_absolute():
        wt_path = (root / wt_path).resolve(strict=False)
    item = find_ledger_item(ledger, wt_path)
    if not item:
        raise GuardError(f"Worktree is not in this session ledger: {wt_path}")
    verify_owner_marker(item, session_id, root)
    item["done"] = True
    item["status"] = "done"
    item["done_reason"] = args.reason
    item["updated_at"] = utc_now()
    if args.reason == "pr":
        item["pr_created_at"] = utc_now()
    append_event(ledger, "mark-done", {"path": item["path"], "reason": args.reason})
    save_ledger(root, ledger)
    render_status(root, ledger)
    print(f"marked done: {item['path']} ({args.reason})")
    return 0


def git_text(args: list[str], cwd: Path, *, timeout: int = 3000) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout / 1000,
            check=False,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def relative_display(path: Path, root: Path) -> str:
    try:
        return str(path.resolve(strict=False).relative_to(root.resolve(strict=False)))
    except ValueError:
        return real(path)


def candidate_bases(item: dict[str, Any]) -> list[str]:
    bases: list[str] = []
    raw = item.get("base")
    if isinstance(raw, str) and raw and raw != "HEAD":
        bases.append(raw)
    bases.extend(["origin/main", "main", "HEAD~1"])
    seen: set[str] = set()
    return [b for b in bases if not (b in seen or seen.add(b))]


def first_git_range(worktree: Path, item: dict[str, Any]) -> tuple[str | None, str | None]:
    for base in candidate_bases(item):
        out = git_text(["rev-list", "--count", f"{base}..HEAD"], worktree)
        if out is not None and out.isdigit():
            return base, out
    return None, None


def clipped_lines(text: str | None, limit: int) -> list[str]:
    if not text:
        return []
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) <= limit:
        return lines
    return [*lines[:limit], f"... ({len(lines) - limit} more)"]


def render_worktree_brief(root: Path, item: dict[str, Any]) -> list[str]:
    wt_path = Path(str(item["path"]))
    branch = item.get("branch") or "(detached)"
    base, commit_count = first_git_range(wt_path, item)
    done_reason = item.get("done_reason") or "done"
    lines = [
        f"- branch: {branch}",
        f"  path: {relative_display(wt_path, root)}",
        f"  state: {item.get('status', 'open')} / {done_reason}",
    ]
    if commit_count is not None:
        lines.append(f"  commits ahead of {base}: {commit_count}")
    else:
        lines.append("  commits ahead: unavailable")

    if base:
        log = clipped_lines(git_text(["log", "--oneline", "--max-count=5", f"{base}..HEAD"], wt_path), 5)
        if log:
            lines.append("  recent commits:")
            lines.extend([f"    {line}" for line in log])
        changed = clipped_lines(git_text(["diff", "--name-status", f"{base}...HEAD"], wt_path), 12)
        if changed:
            lines.append("  changed files:")
            lines.extend([f"    {line}" for line in changed])
    return lines


def build_pr_briefing(root: Path, items: list[dict[str, Any]]) -> str:
    lines = [
        PROMPT_QUESTION,
        "",
        "作業ブリーフィング / Work briefing:",
    ]
    for item in items:
        lines.extend(render_worktree_brief(root, item))
    lines.extend(
        [
            "",
            "Human decision required:",
            "  - Yes / 進行: PR 作成を許可。AI は `agent-worktree-guard confirm-pr --confirmed` を実行してから `gh pr create` へ進む。",
            "  - Stop / 停止: PR 作成・merge・cleanup を行わない。",
            "  - Fix needed / 修正必要: worktree に戻って追加修正する。",
        ]
    )
    return "\n".join(lines)


def build_merge_required_message(root: Path, items: list[dict[str, Any]]) -> str:
    lines = [
        "[agent-worktree-guard] PR confirmation recorded, but the PR has not been merged yet.",
        "",
        "Next required steps:",
        "  1. Create or reuse the PR from the owned worktree.",
        "  2. Complete the existing Pre-Ship Human Review Panel before `gh pr merge`.",
        "  3. After `gh pr merge` succeeds, this guard records the worktree as merged.",
        "",
        "Waiting worktrees:",
    ]
    for item in items:
        lines.append(f"  - {item.get('branch')}: {relative_display(Path(str(item['path'])), root)}")
    return "\n".join(lines)


def build_cleanup_required_message(root: Path, items: list[dict[str, Any]]) -> str:
    lines = [
        "[agent-worktree-guard] PR merge is recorded. Cleanup is now mandatory.",
        "",
        "Run:",
        "  agent-worktree-guard cleanup --confirmed",
        "",
        "Merged worktrees waiting for cleanup:",
    ]
    for item in items:
        lines.append(f"  - {item.get('branch')}: {relative_display(Path(str(item['path'])), root)}")
    return "\n".join(lines)


def audit_result(ledger: dict[str, Any]) -> dict[str, Any]:
    active = [item for item in ledger.get("worktrees", []) if item.get("status") != "cleaned"]
    incomplete = [item for item in active if not item.get("done")]
    all_done = bool(active) and not incomplete
    confirmed = bool(ledger.get("pr_confirmation_confirmed"))
    unmerged = [item for item in active if item.get("done") and not item.get("pr_merged_at")]
    merged = [item for item in active if item.get("pr_merged_at")]
    prompt_needed = all_done and not confirmed
    merge_needed = all_done and confirmed and bool(unmerged)
    cleanup_needed = all_done and confirmed and not unmerged and bool(merged)
    return {
        "active": active,
        "incomplete": incomplete,
        "all_done": all_done,
        "confirmed": confirmed,
        "unmerged": unmerged,
        "merged": merged,
        "prompt_needed": prompt_needed,
        "merge_needed": merge_needed,
        "cleanup_needed": cleanup_needed,
    }


def mark_prompted(root: Path, ledger: dict[str, Any]) -> None:
    if not ledger.get("pr_confirmation_prompted"):
        ledger["pr_confirmation_prompted"] = True
        ledger["pr_confirmation_prompted_at"] = utc_now()
        append_event(ledger, "pr-confirmation-prompted", {"message": PROMPT_QUESTION})
    save_ledger(root, ledger)
    render_status(root, ledger)


def cmd_confirm_pr(args: argparse.Namespace) -> int:
    if not args.confirmed:
        raise GuardError("confirm-pr requires --confirmed after a human Yes/進行 decision")
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = load_ledger(root, session_id)
    result = audit_result(ledger)
    if not result["active"]:
        raise GuardError("No active worktrees in this session ledger")
    if result["incomplete"]:
        raise GuardError("Cannot confirm PR while ledger worktrees are still incomplete")
    for item in result["active"]:
        verify_owner_marker(item, session_id, root)
    ledger["pr_confirmation_prompted"] = True
    ledger["pr_confirmation_prompted_at"] = ledger.get("pr_confirmation_prompted_at") or utc_now()
    ledger["pr_confirmation_confirmed"] = True
    ledger["pr_confirmation_confirmed_at"] = utc_now()
    append_event(ledger, "pr-confirmation-confirmed", {"source": "human"})
    save_ledger(root, ledger)
    render_status(root, ledger)
    print("PR confirmation recorded. Proceed with PR create/merge, then cleanup after merge.")
    return 0


def select_ledger_item(
    ledger: dict[str, Any],
    root: Path,
    *,
    path_arg: str | None = None,
    cwd: Path | None = None,
) -> dict[str, Any] | None:
    if path_arg:
        target = Path(path_arg).expanduser()
        if not target.is_absolute():
            target = (root / target).resolve(strict=False)
        return find_ledger_item(ledger, target)
    if cwd:
        matches = [
            item
            for item in ledger.get("worktrees", [])
            if is_relative_to(cwd, Path(str(item["path"]))) and item.get("status") != "cleaned"
        ]
        if len(matches) == 1:
            return matches[0]
    open_items = [item for item in ledger.get("worktrees", []) if item.get("status") != "cleaned"]
    if len(open_items) == 1:
        return open_items[0]
    return None


def mark_item_merged(ledger: dict[str, Any], item: dict[str, Any], *, source: str, pr: str | None = None) -> None:
    now = utc_now()
    item["done"] = True
    item["status"] = "merged"
    item["done_reason"] = item.get("done_reason") or "pr"
    item["pr_merged_at"] = item.get("pr_merged_at") or now
    item["updated_at"] = now
    if pr:
        item["pr"] = pr
    append_event(ledger, "mark-merged", {"path": item["path"], "branch": item.get("branch"), "source": source, "pr": pr})


def cmd_mark_merged(args: argparse.Namespace) -> int:
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = load_ledger(root, session_id)
    item = select_ledger_item(ledger, root, path_arg=args.path, cwd=Path.cwd().resolve(strict=False))
    if not item:
        raise GuardError("Could not resolve a single active ledger worktree to mark merged")
    verify_owner_marker(item, session_id, root)
    mark_item_merged(ledger, item, source="manual", pr=args.pr)
    save_ledger(root, ledger)
    render_status(root, ledger)
    print(f"marked merged: {item['path']}")
    return 0


def cmd_audit(args: argparse.Namespace) -> int:
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = load_ledger(root, session_id, create=args.create)
    result = audit_result(ledger)
    for item in ledger.get("worktrees", []):
        if item.get("status") == "cleaned":
            continue
        try:
            verify_owner_marker(item, session_id, root)
        except GuardError as exc:
            eprint(f"[agent-worktree-guard] {exc}")
    if result["prompt_needed"]:
        print(build_pr_briefing(root, result["active"]))
        if not args.no_mark_prompted:
            mark_prompted(root, ledger)
    elif result["merge_needed"]:
        print(build_merge_required_message(root, result["unmerged"]))
    elif result["cleanup_needed"]:
        print(build_cleanup_required_message(root, result["merged"]))
    else:
        print(
            f"Agent Worktree Guard: {len(result['active'])} active, "
            f"{len(result['incomplete'])} incomplete"
        )
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = load_ledger(root, session_id, create=args.create)
    render_status(root, ledger)
    print(status_path(root).read_text(encoding="utf-8"), end="")
    return 0


def cmd_cleanup(args: argparse.Namespace) -> int:
    if not args.confirmed:
        raise GuardError("cleanup requires --confirmed")
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    ledger = load_ledger(root, session_id)
    selected = ledger.get("worktrees", [])
    if args.path:
        target = Path(args.path).expanduser()
        if not target.is_absolute():
            target = (root / target).resolve(strict=False)
        selected = [item for item in selected if item.get("realpath") == real(target)]
        if not selected:
            raise GuardError(f"Worktree is not in this session ledger: {target}")

    not_merged = [item for item in selected if item.get("status") != "cleaned" and not item.get("pr_merged_at")]
    if not_merged:
        details = ", ".join(str(item.get("branch") or item.get("path")) for item in not_merged)
        raise GuardError(
            "cleanup is allowed only after the PR merge is recorded. "
            f"Run `gh pr merge` first or `agent-worktree-guard mark-merged <path>` after verifying GitHub. Pending: {details}"
        )

    removed = []
    for item in selected:
        if item.get("status") == "cleaned":
            continue
        marker_data = verify_owner_marker(item, session_id, root)
        marker = owner_path(Path(str(item["path"])))
        try:
            marker.unlink()
            marker.parent.rmdir()
            marker.parent.parent.rmdir()
        except FileNotFoundError:
            pass
        except OSError:
            pass
        cmd = ["worktree", "remove", str(item["path"])]
        if args.force:
            cmd.append("--force")
        try:
            git(cmd, root)
        except GuardError:
            atomic_write_json(marker, marker_data)
            raise
        item["status"] = "cleaned"
        item["cleaned_at"] = utc_now()
        item["updated_at"] = utc_now()
        removed.append(item["path"])
        append_event(ledger, "cleanup", {"path": item["path"], "force": bool(args.force)})

    save_ledger(root, ledger)
    status = status_path(root)
    if status.exists():
        status.unlink()
    print(f"cleaned {len(removed)} worktree(s)")
    return 0


def hook_json(obj: dict[str, Any]) -> int:
    if obj:
        print(json.dumps(obj, ensure_ascii=False))
    return 0


def hook_deny(reason: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def hook_context(event: str, message: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": message}}


def hook_block(reason: str) -> dict[str, Any]:
    return {"decision": "block", "reason": reason}


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def normalize_tool_name(data: dict[str, Any]) -> str:
    if data.get("tool_name"):
        name = str(data["tool_name"])
        if name in {"shell", "run_shell", "run_shell_command", "exec_command", "run_command"}:
            return "Bash"
        return name
    tool = data.get("tool")
    if isinstance(tool, dict) and tool.get("name"):
        name = str(tool["name"])
        if name in {"shell", "run_shell", "run_shell_command", "exec_command", "run_command"}:
            return "Bash"
        return name
    return ""


def normalize_tool_input(data: dict[str, Any]) -> dict[str, Any]:
    if isinstance(data.get("tool_input"), dict):
        return data["tool_input"]
    tool = data.get("tool")
    if isinstance(tool, dict) and isinstance(tool.get("input"), dict):
        return tool["input"]
    if isinstance(data.get("input"), dict):
        return data["input"]
    return {}


def command_succeeded(data: dict[str, Any]) -> bool:
    response = data.get("tool_response")
    if isinstance(response, dict):
        for key in ("exit_code", "exitCode", "status"):
            if isinstance(response.get(key), int):
                return int(response[key]) == 0
    if isinstance(data.get("error"), str) and data["error"]:
        return False
    return True


def shell_segments(command: str) -> list[list[str]]:
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    segments: list[list[str]] = []
    current: list[str] = []
    try:
        tokens = list(lexer)
    except ValueError:
        return []
    separators = {";", "&&", "||", "|", "\n"}
    for token in tokens:
        if token in separators or set(token) <= {";"}:
            if current:
                segments.append(current)
                current = []
            continue
        current.append(token)
    if current:
        segments.append(current)
    return segments


def git_invocation(tokens: list[str]) -> list[str] | None:
    if not tokens:
        return None
    try:
        idx = tokens.index("git")
    except ValueError:
        return None
    args = tokens[idx + 1 :]
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}:
            i += 2
            continue
        if (
            arg.startswith("-C")
            or arg.startswith("-c")
            or arg.startswith("--git-dir=")
            or arg.startswith("--work-tree=")
            or arg in {"--no-pager", "--literal-pathspecs", "--no-optional-locks"}
        ):
            i += 1
            continue
        break
    return args[i:]


def gh_pr_action(tokens: list[str]) -> str | None:
    if not tokens:
        return None
    try:
        idx = tokens.index("gh")
    except ValueError:
        return None
    args = tokens[idx + 1 :]
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "pr" and i + 1 < len(args):
            return args[i + 1]
        if arg in {"--repo", "-R", "--hostname"}:
            i += 2
            continue
        i += 1
    return None


def rm_rf_targets(tokens: list[str]) -> list[str]:
    if not tokens or tokens[0] != "rm":
        return []
    recursive = False
    force = False
    targets: list[str] = []
    for token in tokens[1:]:
        if token == "--":
            continue
        if token.startswith("-") and token != "-":
            if "r" in token or "R" in token or token == "--recursive":
                recursive = True
            if "f" in token or token == "--force":
                force = True
            continue
        targets.append(token)
    return targets if recursive and force else []


def path_from_token(token: str, cwd: Path) -> Path:
    path = Path(token).expanduser()
    if not path.is_absolute():
        path = cwd / path
    return path.resolve(strict=False)


def registered_paths(ledger: dict[str, Any]) -> set[str]:
    return {str(item.get("realpath") or item.get("path")) for item in ledger.get("worktrees", [])}


def detect_pretool_violation(command: str, root: Path, session_id: str, cwd: Path) -> str | None:
    ledger = load_ledger(root, session_id, create=True)
    worktrees = list_git_worktrees(root)
    registered = registered_paths(ledger)
    for tokens in shell_segments(command):
        gargs = git_invocation(tokens)
        if gargs and len(gargs) >= 2 and gargs[0] == "worktree" and gargs[1] in {"add", "remove"}:
            return (
                f"Raw `git worktree {gargs[1]}` is blocked. "
                "Use `agent-worktree-guard add` or `agent-worktree-guard cleanup --confirmed`."
            )
        if gargs and gargs and gargs[0] == "push" and "--no-verify" in gargs:
            return "`git push --no-verify` is blocked by Agent Worktree Guard."

        pr_action = gh_pr_action(tokens)
        if pr_action in {"create", "merge"}:
            result = audit_result(ledger)
            if result["active"] and not result["confirmed"]:
                return (
                    "PR operations are blocked until the work briefing is shown and the human answers Yes/進行.\n\n"
                    f"{build_pr_briefing(root, result['active'])}\n\n"
                    "After the human confirms, run:\n"
                    "  agent-worktree-guard confirm-pr --confirmed"
                )

        for target in rm_rf_targets(tokens):
            target_path = path_from_token(target, cwd)
            for wt in worktrees:
                wt_path = Path(str(wt.get("path"))).resolve(strict=False)
                if target_path == wt_path or is_relative_to(wt_path, target_path):
                    ownership = "registered" if real(wt_path) in registered else "outside this session ledger"
                    return (
                        f"`rm -rf` targets a Git worktree ({ownership}): {wt_path}. "
                        "Use `agent-worktree-guard cleanup --confirmed` after PR/user confirmation."
                    )
    return None


def hook_pre_tool(args: argparse.Namespace) -> int:
    data = read_stdin_json()
    if normalize_tool_name(data) != "Bash":
        return hook_json({})
    tool_input = normalize_tool_input(data)
    command = tool_input.get("command")
    if not isinstance(command, str):
        return hook_json({})
    cwd = Path(str(data.get("cwd") or os.getcwd())).resolve(strict=False)
    try:
        root = resolve_guard_root(cwd)
        session_id = current_session_id(data, args.session_id)
        reason = detect_pretool_violation(command, root, session_id, cwd)
    except Exception:
        return hook_json({})
    return hook_json(hook_deny(reason) if reason else {})


def classify_completion_reason(command: str) -> str | None:
    for tokens in shell_segments(command):
        gargs = git_invocation(tokens)
        if gargs:
            if gargs and gargs[0] == "commit":
                return "commit"
            if gargs and gargs[0] == "push":
                return "push"
        pr_action = gh_pr_action(tokens)
        if pr_action == "create":
            return "pr"
        if pr_action == "merge":
            return "merge"
    return None


def worktree_from_command_or_cwd(command: str, cwd: Path, ledger: dict[str, Any]) -> dict[str, Any] | None:
    for tokens in shell_segments(command):
        if "git" in tokens:
            for i, token in enumerate(tokens):
                if token == "-C" and i + 1 < len(tokens):
                    candidate = path_from_token(tokens[i + 1], cwd)
                    for item in ledger.get("worktrees", []):
                        if is_relative_to(candidate, Path(str(item["path"]))):
                            return item
    matches = [
        item
        for item in ledger.get("worktrees", [])
        if is_relative_to(cwd, Path(str(item["path"]))) and item.get("status") != "cleaned"
    ]
    if len(matches) == 1:
        return matches[0]
    open_items = [item for item in ledger.get("worktrees", []) if not item.get("done") and item.get("status") != "cleaned"]
    if len(open_items) == 1:
        return open_items[0]
    return None


def maybe_prompt_after_completion(root: Path, ledger: dict[str, Any]) -> dict[str, Any]:
    result = audit_result(ledger)
    if result["prompt_needed"]:
        mark_prompted(root, ledger)
        return hook_block(build_pr_briefing(root, result["active"]))
    if result["merge_needed"]:
        return hook_block(build_merge_required_message(root, result["unmerged"]))
    if result["cleanup_needed"]:
        return hook_block(build_cleanup_required_message(root, result["merged"]))
    return {}


def hook_post_tool(args: argparse.Namespace) -> int:
    data = read_stdin_json()
    if normalize_tool_name(data) != "Bash" or not command_succeeded(data):
        return hook_json({})
    tool_input = normalize_tool_input(data)
    command = tool_input.get("command")
    if not isinstance(command, str):
        return hook_json({})
    reason = classify_completion_reason(command)
    if not reason:
        return hook_json({})
    cwd = Path(str(data.get("cwd") or os.getcwd())).resolve(strict=False)
    try:
        root = resolve_guard_root(cwd)
        session_id = current_session_id(data, args.session_id)
        ledger = load_ledger(root, session_id, create=True)
        item = worktree_from_command_or_cwd(command, cwd, ledger)
        if item:
            verify_owner_marker(item, session_id, root)
            if reason == "merge":
                mark_item_merged(ledger, item, source="hook")
            else:
                item["done"] = True
                item["status"] = "done"
                item["done_reason"] = reason
                item["updated_at"] = utc_now()
                if reason == "pr":
                    item["pr_created_at"] = utc_now()
                append_event(ledger, "mark-done", {"path": item["path"], "reason": reason, "source": "hook"})
            save_ledger(root, ledger)
            render_status(root, ledger)
        return hook_json(maybe_prompt_after_completion(root, ledger))
    except Exception:
        return hook_json({})


def hook_stop(args: argparse.Namespace) -> int:
    data = read_stdin_json()
    if data.get("stop_hook_active"):
        return hook_json({})
    cwd = Path(str(data.get("cwd") or os.getcwd())).resolve(strict=False)
    try:
        root = resolve_guard_root(cwd)
        session_id = current_session_id(data, args.session_id)
        ledger = load_ledger(root, session_id, create=True)
        return hook_json(maybe_prompt_after_completion(root, ledger))
    except Exception:
        return hook_json({})


def hook_session_start(args: argparse.Namespace) -> int:
    data = read_stdin_json()
    cwd = Path(str(data.get("cwd") or os.getcwd())).resolve(strict=False)
    try:
        root = resolve_guard_root(cwd)
        session_id = current_session_id(data, args.session_id)
        ledger = ensure_runtime(root, session_id)
        result = audit_result(ledger)
        message = (
            "Agent Worktree Guard ledger loaded.\n"
            f"- session: {ledger['session_id']}\n"
            f"- active worktrees: {len(result['active'])}\n"
            f"- incomplete worktrees: {len(result['incomplete'])}\n"
            f"- awaiting PR confirmation: {'yes' if result['prompt_needed'] else 'no'}\n"
            f"- awaiting PR merge: {len(result['unmerged']) if result['merge_needed'] else 0}\n"
            f"- awaiting cleanup: {len(result['merged']) if result['cleanup_needed'] else 0}\n"
            "- cleanup is allowed only through `agent-worktree-guard cleanup --confirmed`."
        )
        return hook_json(hook_context("SessionStart", message))
    except Exception:
        return hook_json({})


def hook_worktree_create(args: argparse.Namespace) -> int:
    data = read_stdin_json()
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(data.get("name") or "agent-worktree")).strip("-")
    if not name:
        name = "agent-worktree"
    cwd = Path(str(data.get("cwd") or os.getcwd())).resolve(strict=False)
    root = resolve_guard_root(cwd)
    session_id = current_session_id(data, args.session_id)
    path = root / ".worktrees" / "feature" / f"claude-{name}"
    branch = f"feature/claude-{name}"
    ns = argparse.Namespace(path=str(path), base="HEAD", branch=branch, repo=str(root), session_id=session_id)
    with contextlib.redirect_stdout(io.StringIO()):
        cmd_add(ns)
    print(real(path))
    return 0


def hook_worktree_remove(args: argparse.Namespace) -> int:
    data = read_stdin_json()
    path = data.get("worktree_path")
    if not path:
        return 0
    cwd = Path(str(data.get("cwd") or os.getcwd())).resolve(strict=False)
    root = resolve_guard_root(cwd)
    session_id = current_session_id(data, args.session_id)
    ns = argparse.Namespace(path=str(path), confirmed=True, force=False, repo=str(root), session_id=session_id)
    try:
        cmd_cleanup(ns)
    except Exception:
        pass
    return 0


def git_hook_pre_push(args: argparse.Namespace) -> int:
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    try:
        ledger = load_ledger(root, session_id)
    except GuardError:
        return 0
    cwd = git_root(Path.cwd())
    in_registered_worktree = any(
        is_relative_to(cwd, Path(str(item.get("path"))))
        for item in ledger.get("worktrees", [])
        if item.get("status") != "cleaned"
    )
    if in_registered_worktree and not status_path(root).exists():
        eprint("[pre-push] Agent Worktree Guard status file is missing. Run `agent-worktree-guard init`.")
        return 1

    updates = sys.stdin.read().splitlines()
    branch_by_ref = {
        f"refs/heads/{item.get('branch')}": item
        for item in ledger.get("worktrees", [])
        if item.get("branch") and item.get("status") != "cleaned"
    }
    for line in updates:
        parts = line.split()
        if len(parts) < 4:
            continue
        local_ref = parts[0]
        item = branch_by_ref.get(local_ref)
        if item and not item.get("done"):
            eprint(
                "[pre-push] Branch belongs to an incomplete Agent Worktree Guard entry. "
                f"Run `agent-worktree-guard mark-done {item['path']} --reason push` after confirming completion."
            )
            return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-worktree-guard")
    parser.add_argument("--session-id", help="Override hook/session id.")
    parser.add_argument("--repo", help="Repository or worktree path to use as the guard root.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init")

    p_add = sub.add_parser("add")
    p_add.add_argument("path")
    p_add.add_argument("base", nargs="?")
    p_add.add_argument("--branch")

    p_register = sub.add_parser("register")
    p_register.add_argument("path")

    p_done = sub.add_parser("mark-done")
    p_done.add_argument("path")
    p_done.add_argument("--reason", required=True, choices=["commit", "push", "pr", "manual"])

    p_confirm = sub.add_parser("confirm-pr")
    p_confirm.add_argument("--confirmed", action="store_true")

    p_merged = sub.add_parser("mark-merged")
    p_merged.add_argument("path", nargs="?")
    p_merged.add_argument("--pr")

    p_audit = sub.add_parser("audit")
    p_audit.add_argument("--create", action="store_true")
    p_audit.add_argument("--no-mark-prompted", action="store_true")

    p_cleanup = sub.add_parser("cleanup")
    p_cleanup.add_argument("--confirmed", action="store_true")
    p_cleanup.add_argument("--force", action="store_true")
    p_cleanup.add_argument("--path")

    p_status = sub.add_parser("status")
    p_status.add_argument("--create", action="store_true")

    p_hook = sub.add_parser("hook")
    hook_sub = p_hook.add_subparsers(dest="hook_command", required=True)
    for name in ("pre-tool", "post-tool", "stop", "session-start", "worktree-create", "worktree-remove"):
        hook_sub.add_parser(name)

    p_git_hook = sub.add_parser("git-hook")
    git_hook_sub = p_git_hook.add_subparsers(dest="git_hook_command", required=True)
    git_hook_sub.add_parser("pre-push")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            return cmd_init(args)
        if args.command == "add":
            return cmd_add(args)
        if args.command == "register":
            return cmd_register(args)
        if args.command == "mark-done":
            return cmd_mark_done(args)
        if args.command == "confirm-pr":
            return cmd_confirm_pr(args)
        if args.command == "mark-merged":
            return cmd_mark_merged(args)
        if args.command == "audit":
            return cmd_audit(args)
        if args.command == "cleanup":
            return cmd_cleanup(args)
        if args.command == "status":
            return cmd_status(args)
        if args.command == "hook":
            return {
                "pre-tool": hook_pre_tool,
                "post-tool": hook_post_tool,
                "stop": hook_stop,
                "session-start": hook_session_start,
                "worktree-create": hook_worktree_create,
                "worktree-remove": hook_worktree_remove,
            }[args.hook_command](args)
        if args.command == "git-hook" and args.git_hook_command == "pre-push":
            return git_hook_pre_push(args)
        parser.error("unknown command")
        return 2
    except GuardError as exc:
        eprint(f"agent-worktree-guard: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
