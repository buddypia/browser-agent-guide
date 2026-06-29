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
    "以下の worktree 作業は完了状態です。\n"
    "内容を確認し、merge / cleanup に進めてよいか承認してください。"
)

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
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise GuardError(f"{' '.join(args)} failed ({result.returncode}): {detail}")
    return result


def git(args: list[str], cwd: Path, *, check: bool = True, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    return run_cmd(["git", *args], cwd=cwd, check=check, timeout=timeout)


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


def _cleanup_event_payload(item: dict[str, Any], *, force: bool, cross_session: bool = False) -> dict[str, Any]:
    """cleanup の append_event payload を3経路(by-path / 引数なし / 横断)で共有する。
    PR #64 で remote_branch_deleted を足した際、引数なし経路だけ取りこぼした(3経路の手書き dict 重複が
    原因)ので、payload を1箇所に集約してフィールド追加時のドリフトを構造的に防ぐ。"""
    payload: dict[str, Any] = {
        "path": item["path"],
        "force": bool(force),
        "branch_deleted": bool(item.get("branch_deleted")),
        "remote_branch_deleted": item.get("remote_branch_deleted"),
        "stashes_dropped": len(item.get("stashes_dropped") or []),
    }
    if cross_session:
        payload["cross_session"] = True
    return payload


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


def safe_branch_key(branch: str | None) -> str:
    """branch を REVIEW.md ディレクトリ名の安全キーに変換 (`/`,`\\` → `__`)。
    SSOT は .claude/scripts/lib/worktree-plan-path.mjs#safeBranchKey。Python から REVIEW.md を
    読むため経路算出のみを最小複製する (検証ロジック本体は review-report.mjs のまま)。"""
    return re.sub(r"[/\\]", "__", branch or "staged")


def find_review_report(worktree_path: Path, branch: str | None) -> tuple[Path | None, str | None]:
    """worktree-local の REVIEW.md (`.tmp/worktree-<safeBranch>/REVIEW.md`) を探す。
    branch から導いたパスを最優先し、無ければ `.tmp/worktree-*/REVIEW.md` を glob で補完する
    (branch 推論差異への頑健性)。中身が空のものは無視する。"""
    candidates: list[Path] = []
    if branch:
        candidates.append(worktree_path / ".tmp" / f"worktree-{safe_branch_key(branch)}" / "REVIEW.md")
    tmp_dir = worktree_path / ".tmp"
    if tmp_dir.is_dir():
        for sub in sorted(tmp_dir.glob("worktree-*/REVIEW.md")):
            if sub not in candidates:
                candidates.append(sub)
    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if text.strip():
            return path, text
    return None, None


def strip_review_stamp(content: str) -> str:
    """REVIEW.md の HEAD stamp は gate 用メタデータなので human briefing からは外す。"""
    return re.sub(r"<!--\s*bag-review:\s*head\s*=[0-9a-fA-F_]+[^>]*-->\n?", "", content).strip()


def render_review_brief(root: Path, wt_path: Path, branch: str | None) -> list[str]:
    """worktree の REVIEW.md(= 承認依頼レビュー)を briefing 用に出力。
    存在すれば 11 セクション本文をそのまま出し、無ければ scaffold 作成を促す
    (Stop の review gate が完成まで block する)。"""
    review_path, review_text = find_review_report(wt_path, branch)
    if review_text:
        body = strip_review_stamp(review_text)
        return [
            f"REVIEW.md: {relative_display(review_path, root)}",
            "",
            body,
        ]
    scaffold_branch = branch if branch else "<branch>"
    return [
        "# Worktree 承認依頼レビュー",
        "",
        f"REVIEW.md: 未作成 — {relative_display(wt_path, root)}",
        "",
        "11 セクションの承認依頼レビューを作成してください:",
        f"  node .claude/scripts/mark-worktree-reviewed.mjs {scaffold_branch} --scaffold",
        "  (Stop の worktree-review-report-guard が REVIEW.md 完成まで停止を block します)",
    ]


def render_worktree_brief(root: Path, item: dict[str, Any]) -> list[str]:
    wt_path = Path(str(item["path"]))
    branch_raw = item.get("branch")
    return render_review_brief(root, wt_path, branch_raw if isinstance(branch_raw, str) and branch_raw else None)


def build_pr_briefing(root: Path, items: list[dict[str, Any]]) -> str:
    lines = []
    for item in items:
        if lines:
            lines.extend(["", "---", ""])
        lines.extend(render_worktree_brief(root, item))
    lines.extend(
        [
            "",
            "Human decision required / ユーザー確認:",
            "  - 承認して進める: AI は `agent-worktree-guard confirm-pr --confirmed` を実行してから `gh pr create` へ進む。",
            "  - 修正が必要: worktree に戻って追加修正する。",
            "  - 停止する: PR 作成・merge・cleanup を行わない。",
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
        "The cleanup command prints `# PR 承認後の完了報告` after the worktree/branch cleanup finishes.",
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


def _clear_status(root: Path) -> None:
    status = status_path(root)
    if status.exists():
        status.unlink()


def delete_local_branch(root: Path, branch: str | None) -> bool:
    """merge 済みローカル branch を強制削除する。cleanup は pr_merged_at 記録後にのみ到達するため、
    squash-merge でローカル main に ff されていなくても安全に削除できる(-D)。
    削除失敗は致命にしない — worktree 除去という主目的は既に完了している。"""
    if not branch or branch in {"main", "master"}:
        return False
    if not branch_exists(root, branch):
        return False
    return git(["branch", "-D", branch], root, check=False).returncode == 0


def remote_exists(root: Path, remote: str) -> bool:
    """`remote` が設定済みかを返す。origin が無いローカル/テストリポでは remote 削除をそもそも試みない
    ための前段ガード(余計な push と紛らわしい失敗ログを避ける)。`git remote` はローカル設定の参照のみで
    ネットワークアクセスしない。"""
    result = git(["remote"], root, check=False)
    if result.returncode != 0:
        return False
    return remote in (result.stdout or "").split()


# `git push --delete <absent>` の正確な文言のみを already-absent と見なす。広く `does not exist` を
# 拾うと別エラー(認証・接続等)を already-absent に誤分類し「verify on GitHub」警告を握り潰すため、
# 文言が将来変わった場合は安全側(=failed, 警告を出す)に倒す。
_REMOTE_ABSENT_RE = re.compile(r"remote ref does not exist", re.IGNORECASE)


def delete_remote_branch(root: Path, branch: str | None, *, remote: str = "origin") -> str:
    """merge 済みリモート branch を削除する(best-effort, ネットワーク操作)。返り値:
      "deleted"        — `git push <remote> --delete` 成功
      "already-absent" — remote に当該 ref が無い(`gh pr merge --delete-branch` 等で既に削除済み)
      "skipped"        — branch 無し / main・master / remote 未設定
      "failed"         — ネットワーク/認証/タイムアウト等で削除できず(要 GitHub 確認)
    ネットワーク失敗は致命にしない — worktree / local branch 除去という主目的は既に完了している。
    `git push --delete` を1往復だけ実行し、その結果で分類する。以前は ls-remote で事前確認していたが
    (1) GitHub の SSH レイテンシ(接続だけで数秒)で ls-remote の短い timeout に当たると push へ到達せず
    failed になる、(2) ls-remote の tail-match が別 ref を取り違えうる、という脆さがあったため廃止した。
    既に消えている branch は push の stderr(`remote ref does not exist`)で already-absent と判定する
    (push --delete は ls-remote と違い常に厳密一致なので別 ref を誤爆しない)。timeout は SSH の実
    レイテンシに余裕を持たせて 60s。"""
    if not branch or branch in {"main", "master"}:
        return "skipped"
    if not remote_exists(root, remote):
        return "skipped"
    try:
        push = git(["push", remote, "--delete", branch], root, check=False, timeout=60)
    except subprocess.TimeoutExpired:
        return "failed"
    if push.returncode == 0:
        return "deleted"
    if _REMOTE_ABSENT_RE.search(f"{push.stderr or ''}\n{push.stdout or ''}"):
        return "already-absent"
    return "failed"


_STASH_BRANCH_RE = re.compile(r"^[^:]*:\s*(?:WIP on|On)\s+([^:]+):")


def drop_branch_stashes(root: Path, branch: str | None) -> list[str]:
    """指定 branch を起点とする stash だけを drop する(他 branch の stash には触れない)。
    index ずれを避けるため降順に drop し、drop した stash の説明文を返す(silent 破壊を避け報告する)。"""
    if not branch:
        return []
    listing = git_text(["stash", "list"], root)
    if not listing:
        return []
    targets: list[tuple[int, str]] = []
    for line in listing.splitlines():
        ref_match = re.match(r"^stash@\{(\d+)\}", line)
        branch_match = _STASH_BRANCH_RE.match(line)
        if ref_match and branch_match and branch_match.group(1).strip() == branch:
            targets.append((int(ref_match.group(1)), line.strip()))
    dropped: list[str] = []
    for idx, desc in sorted(targets, key=lambda t: t[0], reverse=True):
        if git(["stash", "drop", f"stash@{{{idx}}}"], root, check=False).returncode == 0:
            dropped.append(desc)
    return dropped


def _remove_worktree_item(item: dict[str, Any], root: Path, session_id: str, *, force: bool) -> None:
    """1 件の worktree を git から除去し、ledger item を cleaned に更新する(save は呼び出し側)。
    git remove に失敗したら owner marker を復元して raise する(原子性)。worktree 除去後に、
    merge 済みローカル branch と当該 branch を起点とする stash も掃除する(best-effort, 除去成功後)。"""
    capture_cleanup_snapshot(item)
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
    if force:
        cmd.append("--force")
    try:
        git(cmd, root)
    except GuardError:
        atomic_write_json(marker, marker_data)
        raise
    item["status"] = "cleaned"
    item["cleaned_at"] = utc_now()
    item["updated_at"] = utc_now()
    # worktree 除去成功後にのみ local branch / remote branch / stash を掃除
    # (原子性は worktree remove までで担保済み。以降は best-effort)。
    branch = item.get("branch")
    branch = branch if isinstance(branch, str) and branch else None
    item["branch_deleted"] = delete_local_branch(root, branch)
    item["remote_branch_deleted"] = delete_remote_branch(root, branch)
    item["stashes_dropped"] = drop_branch_stashes(root, branch)
    if item["branch_deleted"]:
        eprint(f"[agent-worktree-guard] deleted merged local branch: {branch}")
    remote_status = item["remote_branch_deleted"]
    if remote_status == "deleted":
        eprint(f"[agent-worktree-guard] deleted merged remote branch: origin/{branch}")
    elif remote_status == "failed":
        eprint(
            f"[agent-worktree-guard] could NOT delete remote branch origin/{branch} "
            "(offline / auth / network?) — verify on GitHub and delete manually if it still exists"
        )
    for desc in item["stashes_dropped"]:
        eprint(f"[agent-worktree-guard] dropped stash for {branch}: {desc}")


def discover_merged_across_sessions(
    root: Path,
) -> tuple[list[tuple[str, dict[str, Any]]], dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """全 git worktree を owner marker 経由で所属 session に解決し、その session ledger で
    pr_merged_at あり & not cleaned のものを集める。current_session_id が解決できない
    (メイン repo から手動 cleanup を実行するなど、env も marker も無い)状況でも、各 worktree の
    owner marker を真実として merged worktree を確実に片付けられるようにするための横断検出。

    returns (matches, ledgers, leftover_unmerged):
      matches:          [(session_id, item)] — 片付け対象(merged & not cleaned)
      ledgers:          {session_id: ledger}  — mutate 後に save する対象(load を共有しキャッシュ)
      leftover_unmerged:[item]                — marker はあるが未 merged(fail-loud 警告用)
    """
    ledgers: dict[str, dict[str, Any]] = {}
    matches: list[tuple[str, dict[str, Any]]] = []
    leftover_unmerged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in list_git_worktrees(root):
        path = entry.get("path")
        if not path:
            continue
        wt = Path(str(path))
        if real(wt) == real(root):
            continue  # main checkout 自体は対象外
        data = read_json(owner_path(wt), None)
        if not isinstance(data, dict):
            continue  # guard 管理外の worktree(marker 無し)は触らない
        sid_raw = data.get("session_id")
        if not sid_raw:
            continue
        sid = safe_session_id(str(sid_raw))
        if sid not in ledgers:
            ledgers[sid] = load_ledger(root, sid)
        item = find_ledger_item(ledgers[sid], wt)
        if not item or item.get("status") == "cleaned":
            continue
        key = str(item.get("realpath") or real(wt))
        if key in seen:
            continue
        seen.add(key)
        if item.get("pr_merged_at"):
            matches.append((sid, item))
        else:
            leftover_unmerged.append(item)
    return matches, ledgers, leftover_unmerged


def cleanup_summary_line(count: int, items: list[dict[str, Any]]) -> str:
    """`cleaned N worktree(s)` に branch / stash の掃除件数を付記する。
    `cleaned N worktree` substring は保たれるので既存の assert と互換。"""
    branches = sum(1 for it in items if it.get("branch_deleted"))
    remotes = sum(1 for it in items if it.get("remote_branch_deleted") == "deleted")
    stashes = sum(len(it.get("stashes_dropped") or []) for it in items)
    extra = []
    if branches:
        extra.append(f"branches deleted: {branches}")
    if remotes:
        extra.append(f"remote branches deleted: {remotes}")
    if stashes:
        extra.append(f"stashes dropped: {stashes}")
    suffix = f" ({', '.join(extra)})" if extra else ""
    return f"cleaned {count} worktree(s){suffix}"


def parse_name_status_paths(status_text: str | None) -> list[str]:
    paths: list[str] = []
    if not status_text:
        return paths
    for line in status_text.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            paths.append(parts[-1])
    return paths


def changed_files_tree(status_text: str | None) -> str:
    paths = parse_name_status_paths(status_text)
    if not paths:
        return "(changed files unavailable)"
    return "\n".join(f"- {path}" for path in paths)


def capture_cleanup_snapshot(item: dict[str, Any]) -> None:
    """worktree を削除する前に completion report 用の差分情報を保存する。"""
    wt_path = Path(str(item["path"]))
    base, commit_count = first_git_range(wt_path, item)
    snapshot: dict[str, Any] = {
        "base": base,
        "commit_count": commit_count,
        "log": None,
        "changed_files": None,
    }
    if base:
        snapshot["log"] = git_text(["log", "--oneline", f"{base}..HEAD"], wt_path)
        snapshot["changed_files"] = git_text(["diff", "--name-status", f"{base}...HEAD"], wt_path)
    item["cleanup_snapshot"] = snapshot


def pr_display(item: dict[str, Any]) -> str:
    pr = item.get("pr")
    if isinstance(pr, str) and pr.strip():
        return pr.strip()
    return "未取得 / not captured"


def _remote_status_label(status: Any) -> str:
    """delete_remote_branch の状態を completion report 用の人間可読ラベルへ写像する。"""
    return {
        "deleted": "deleted",
        "already-absent": "already absent (gh --delete-branch 済み等)",
        "skipped": "skipped (remote 未設定 / main)",
        "failed": "未削除 / verify on GitHub",
    }.get(status, "未確認 / unknown")


def render_completion_report(root: Path, items: list[dict[str, Any]]) -> str:
    cleaned_paths = [relative_display(Path(str(item["path"])), root) for item in items]
    branch_cleanup = [
        f"{item.get('branch')}: {'deleted' if item.get('branch_deleted') else 'not deleted / already absent'}"
        for item in items
    ]
    remote_cleanup = [
        f"{item.get('branch')}: {_remote_status_label(item.get('remote_branch_deleted'))}"
        for item in items
    ]
    stash_count = sum(len(item.get("stashes_dropped") or []) for item in items)
    active_stash = git_text(["stash", "list"], root)
    active_stash_text = active_stash if active_stash else "なし"

    lines = [
        "# PR 承認後の完了報告",
        "## 1. PR",
        f"- PR URL: {', '.join(pr_display(item) for item in items)}",
        "- PR Merged 状況: merged recorded by agent-worktree-guard",
        "- Merge commit / squash commit: 未取得 / not captured",
        "- CI status: 未取得 / not captured",
        "## 2. Cleanup 状況",
        f"- Local worktree cleanup: removed {len(items)} ({', '.join(cleaned_paths)})",
        f"- Local branch cleanup: {', '.join(branch_cleanup)}",
        f"- Remote branch cleanup: {', '.join(remote_cleanup)}",
        "- main への ff 状況: 未実行 / local main not fast-forwarded by cleanup",
        "- stash の復元状況: 対象外 / no restore performed",
        f"- active stash: {active_stash_text}",
        "## 3. 反映されたファイル",
        "```text",
    ]
    for item in items:
        snapshot = item.get("cleanup_snapshot") if isinstance(item.get("cleanup_snapshot"), dict) else {}
        lines.append(f"# {item.get('branch') or '(detached)'}")
        lines.append(changed_files_tree(snapshot.get("changed_files")))
    lines.extend(
        [
            "```",
            "## 4. 残った対応",
            "- 残タスク: なし (guard 観測範囲)",
            "- 手動対応が必要なもの: 上記 Remote branch cleanup が「未削除 / verify on GitHub」の場合のみ GitHub で削除確認。CI も必要に応じて確認",
            "- 次回セッションへの引き継ぎ: なし",
            "## 5. 問題 / 改善メモ",
            "- 発生した問題: なし",
            "- 回避策: なし",
            "- 仕組みに反映したい改善: なし",
        ]
    )
    if stash_count:
        lines.append(f"- cleanup note: dropped {stash_count} branch-local stash item(s)")
    return "\n".join(lines)


def cmd_cleanup(args: argparse.Namespace) -> int:
    if not args.confirmed:
        raise GuardError("cleanup requires --confirmed")
    root = resolve_guard_root(Path(args.repo).resolve() if args.repo else None)
    session_id = current_session_id(explicit=args.session_id)
    removed: list[str] = []
    cleaned_items: list[dict[str, Any]] = []

    if args.path:
        target = Path(args.path).expanduser()
        if not target.is_absolute():
            target = (root / target).resolve(strict=False)
        # 対象 worktree の owner marker から所属 session を解決し、正しい ledger を引く。
        # メイン repo から実行して current_session_id が "manual" に落ちても、marker を真実として
        # その worktree を所有する session の ledger を見つける(取りこぼし防止の核心)。
        owner = read_json(owner_path(target), None)
        owner_sid = owner.get("session_id") if isinstance(owner, dict) else None
        sid = safe_session_id(str(owner_sid)) if owner_sid else session_id
        try:
            ledger = load_ledger(root, sid)
        except GuardError:
            ledger = empty_ledger(root, sid)
        item = find_ledger_item(ledger, target)
        if item is None:
            raise GuardError(f"Worktree is not in any session ledger: {target}")
        if item.get("status") != "cleaned":
            if not item.get("pr_merged_at"):
                raise GuardError(
                    "cleanup is allowed only after the PR merge is recorded. "
                    "Run `gh pr merge` first or `agent-worktree-guard mark-merged <path>` after verifying GitHub. "
                    f"Pending: {item.get('branch') or item.get('path')}"
                )
            _remove_worktree_item(item, root, sid, force=args.force)
            append_event(ledger, "cleanup", _cleanup_event_payload(item, force=args.force))
            save_ledger(root, ledger)
            removed.append(item["path"])
            cleaned_items.append(item)
        _clear_status(root)
        print(cleanup_summary_line(len(removed), cleaned_items))
        if cleaned_items:
            print()
            print(render_completion_report(root, cleaned_items))
        return 0

    # 引数なし: まず現 session ledger を処理(後方互換の主経路)。
    # 現 session の ledger が無い(メイン repo から手動実行で session_id を解決できないなど)場合は
    # 空として扱い、下の横断検出に委ねる(存在しないだけでは失敗にしない)。
    try:
        ledger = load_ledger(root, session_id)
    except GuardError:
        ledger = empty_ledger(root, session_id)
    selected = [item for item in ledger.get("worktrees", []) if item.get("status") != "cleaned"]
    not_merged = [item for item in selected if not item.get("pr_merged_at")]
    if not_merged:
        details = ", ".join(str(item.get("branch") or item.get("path")) for item in not_merged)
        raise GuardError(
            "cleanup is allowed only after the PR merge is recorded. "
            f"Run `gh pr merge` first or `agent-worktree-guard mark-merged <path>` after verifying GitHub. Pending: {details}"
        )
    for item in selected:
        _remove_worktree_item(item, root, session_id, force=args.force)
        append_event(ledger, "cleanup", _cleanup_event_payload(item, force=args.force))
        removed.append(item["path"])
        cleaned_items.append(item)
    if removed:
        save_ledger(root, ledger)

    # 現 session で何も片付かなかった場合のみ、git worktree を owner marker 経由で横断解決し、
    # 別 session 所有の merged worktree も片付ける。session_id を解決できず(メイン repo からの手動
    # 実行など)空 ledger を見て黙って `cleaned 0` を返し、merged worktree を取りこぼすのを防ぐ。
    if not removed:
        matches, ledgers, leftover_unmerged = discover_merged_across_sessions(root)
        touched: set[str] = set()
        for sid, item in matches:
            _remove_worktree_item(item, root, sid, force=args.force)
            append_event(ledgers[sid], "cleanup", _cleanup_event_payload(item, force=args.force, cross_session=True))
            removed.append(item["path"])
            cleaned_items.append(item)
            touched.add(sid)
        for sid in touched:
            save_ledger(root, ledgers[sid])
        # fail-loud: それでも 0 件で、marker 付き worktree が未 merged のまま残るなら明示警告
        # (黙って 0 を返さず、merge → cleanup の正しい順序を促す)。
        if not removed and leftover_unmerged:
            details = ", ".join(str(i.get("branch") or i.get("path")) for i in leftover_unmerged)
            eprint(
                "[agent-worktree-guard] cleaned 0, but registered worktrees are not yet merged: "
                f"{details}. Run `gh pr merge` (or `agent-worktree-guard mark-merged <path>`) first, then cleanup."
            )

    _clear_status(root)
    print(cleanup_summary_line(len(removed), cleaned_items))
    if cleaned_items:
        print()
        print(render_completion_report(root, cleaned_items))
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


def gh_pr_target(command: str, action: str) -> str | None:
    for tokens in shell_segments(command):
        try:
            idx = tokens.index("gh")
        except ValueError:
            continue
        args = tokens[idx + 1 :]
        i = 0
        while i < len(args):
            arg = args[i]
            if arg in {"--repo", "-R", "--hostname"}:
                i += 2
                continue
            if arg == "pr" and i + 1 < len(args) and args[i + 1] == action:
                j = i + 2
                while j < len(args):
                    candidate = args[j]
                    if candidate == "--":
                        j += 1
                        continue
                    if candidate.startswith("-"):
                        j += 1
                        continue
                    return candidate
                return None
            i += 1
    return None


def worktree_create_branch(command: str) -> str | None:
    for tokens in shell_segments(command):
        for token in tokens:
            if token.startswith("BR=") and len(token) > 3:
                return token[3:]
            if token.startswith("BRANCH=") and len(token) > 7:
                return token[7:]
        for flag in ("--branch", "-b"):
            if flag in tokens:
                idx = tokens.index(flag)
                if idx + 1 < len(tokens):
                    return tokens[idx + 1]
        gargs = git_invocation(tokens)
        if gargs and len(gargs) >= 2 and gargs[0] == "worktree" and gargs[1] == "add":
            for flag in ("-b", "-B"):
                if flag in gargs:
                    idx = gargs.index(flag)
                    if idx + 1 < len(gargs):
                        return gargs[idx + 1]
            positional = [arg for arg in gargs[2:] if not arg.startswith("-")]
            if len(positional) >= 2:
                return positional[-1]
    return None


def maybe_register_created_worktree(root: Path, session_id: str, ledger: dict[str, Any], command: str) -> dict[str, Any] | None:
    branch = worktree_create_branch(command)
    if not branch:
        return None
    known = {
        real(Path(str(wt["path"]))): wt
        for wt in list_git_worktrees(root)
        if wt.get("path") and wt.get("branch") == branch
    }
    if not known:
        return None
    wt_path = Path(next(iter(known))).resolve(strict=False)
    marker = write_owner_marker(root, session_id, wt_path, branch, None)
    upsert_worktree(ledger, path=wt_path, branch=branch, base=None, owner_marker=marker)
    item = find_ledger_item(ledger, wt_path)
    append_event(ledger, "register", {"path": real(wt_path), "branch": branch, "source": "hook"})
    return item


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
    cwd = Path(str(data.get("cwd") or os.getcwd())).resolve(strict=False)
    try:
        root = resolve_guard_root(cwd)
        session_id = current_session_id(data, args.session_id)
        ledger = load_ledger(root, session_id, create=True)
        created = maybe_register_created_worktree(root, session_id, ledger, command)
        if created:
            save_ledger(root, ledger)
            render_status(root, ledger)
        reason = classify_completion_reason(command)
        if not reason:
            return hook_json({})
        item = worktree_from_command_or_cwd(command, cwd, ledger)
        if item:
            verify_owner_marker(item, session_id, root)
            if reason == "merge":
                mark_item_merged(ledger, item, source="hook", pr=gh_pr_target(command, "merge"))
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
