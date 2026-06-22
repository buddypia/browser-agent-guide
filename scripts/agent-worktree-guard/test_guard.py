#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


CLI = Path(__file__).with_name("agent-worktree-guard")
SESSION = "test-session"
PROMPT = (
    "すべてのworktreeの作業が完了しました。PR（プルリクエスト）を作成しますか？\n"
    "(모든 worktree 작업이 완료되었습니다. PR(풀 리퀘스트)을 생성하시겠습니까?)"
)


def run(args: list[str], cwd: Path, *, stdin: str | None = None, check: bool = True, session: str = SESSION):
    result = subprocess.run(
        [str(CLI), "--session-id", session, *args],
        cwd=cwd,
        input=stdin,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode != 0:
        raise AssertionError(f"{args} failed\nstdout={result.stdout}\nstderr={result.stderr}")
    return result


class AgentWorktreeGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="awtg-"))
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init"], cwd=self.repo, check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=self.repo, check=True)
        (self.repo / "README.md").write_text("test\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=self.repo, check=True, stdout=subprocess.PIPE)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp)

    def test_lifecycle_and_hooks(self) -> None:
        wt = self.repo / ".worktrees" / "feature" / "sample"

        run(["init"], self.repo)
        self.assertTrue((self.repo / ".tmp/.worktree_status.md").exists())
        gitignore = (self.repo / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(".tmp/.worktree_status.md", gitignore)
        self.assertIn(".tmp/worktree-guard-ledger/", gitignore)
        self.assertIn(".tmp/.agent_worktree_owner.json", gitignore)

        run(["add", str(wt)], self.repo)
        ledger = json.loads((self.repo / ".tmp/worktree-guard-ledger/test-session.json").read_text())
        self.assertEqual(len(ledger["worktrees"]), 1)
        self.assertTrue((wt / ".tmp/.agent_worktree_owner.json").exists())
        self.assertIn("- [ ]", (self.repo / ".tmp/.worktree_status.md").read_text(encoding="utf-8"))

        (wt / "feature.txt").write_text("work\n", encoding="utf-8")
        subprocess.run(["git", "add", "feature.txt"], cwd=wt, check=True)
        subprocess.run(["git", "commit", "-m", "feature work"], cwd=wt, check=True, stdout=subprocess.PIPE)

        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=wt, text=True, stdout=subprocess.PIPE, check=True).stdout.strip()
        pre_push = run(
            ["git-hook", "pre-push"],
            wt,
            stdin=f"refs/heads/feature/sample {head} refs/heads/feature/sample {'0' * 40}\n",
            check=False,
        )
        self.assertNotEqual(pre_push.returncode, 0)
        self.assertIn("incomplete Agent Worktree Guard entry", pre_push.stderr)

        raw_payload = json.dumps(
            {
                "session_id": SESSION,
                "cwd": str(self.repo),
                "tool_name": "Bash",
                "tool_input": {"command": "git worktree add ../raw"},
            }
        )
        denied = run(["hook", "pre-tool"], self.repo, stdin=raw_payload)
        self.assertIn("permissionDecision", denied.stdout)
        self.assertIn("deny", denied.stdout)

        run(["mark-done", str(wt), "--reason", "manual"], self.repo)
        status = (self.repo / ".tmp/.worktree_status.md").read_text(encoding="utf-8")
        self.assertIn("- [x]", status)

        audit = run(["audit"], self.repo)
        self.assertIn(PROMPT, audit.stdout)
        self.assertIn("Work briefing", audit.stdout)
        self.assertIn("agent-worktree-guard confirm-pr --confirmed", audit.stdout)

        pr_create_payload = json.dumps(
            {
                "session_id": SESSION,
                "cwd": str(wt),
                "tool_name": "Bash",
                "tool_input": {"command": "gh pr create --title test --body test"},
            }
        )
        pr_denied = run(["hook", "pre-tool"], self.repo, stdin=pr_create_payload)
        self.assertIn("permissionDecision", pr_denied.stdout)
        self.assertIn("confirm-pr --confirmed", pr_denied.stdout)

        antigravity_payload = json.dumps(
            {
                "session_id": SESSION,
                "cwd": str(wt),
                "tool": {
                    "name": "run_command",
                    "input": {"command": "gh pr create --title test --body test"},
                },
            }
        )
        antigravity_denied = run(["hook", "pre-tool"], self.repo, stdin=antigravity_payload)
        self.assertIn("permissionDecision", antigravity_denied.stdout)
        self.assertIn("confirm-pr --confirmed", antigravity_denied.stdout)

        early_cleanup = run(["cleanup", "--confirmed"], self.repo, check=False)
        self.assertNotEqual(early_cleanup.returncode, 0)
        self.assertIn("after the PR merge is recorded", early_cleanup.stderr)

        confirm = run(["confirm-pr", "--confirmed"], self.repo)
        self.assertIn("PR confirmation recorded", confirm.stdout)

        pr_allowed = run(["hook", "pre-tool"], self.repo, stdin=pr_create_payload)
        self.assertEqual(pr_allowed.stdout.strip(), "")

        merge_payload = json.dumps(
            {
                "session_id": SESSION,
                "cwd": str(wt),
                "tool_name": "Bash",
                "tool_input": {"command": "gh pr merge 1 --squash"},
                "tool_response": {"exit_code": 0},
            }
        )
        merged = run(["hook", "post-tool"], self.repo, stdin=merge_payload)
        self.assertIn("Cleanup is now mandatory", merged.stdout)
        ledger = json.loads((self.repo / ".tmp/worktree-guard-ledger/test-session.json").read_text())
        self.assertTrue(ledger["worktrees"][0]["pr_merged_at"])

        outside = self.repo / ".worktrees" / "feature" / "outside"
        subprocess.run(["git", "worktree", "add", str(outside), "-b", "feature/outside"], cwd=self.repo, check=True)
        cleanup = run(["cleanup", "--confirmed"], self.repo)
        self.assertIn("cleaned 1 worktree", cleanup.stdout)
        self.assertFalse(wt.exists())
        self.assertTrue(outside.exists())
        subprocess.run(["git", "worktree", "remove", str(outside), "--force"], cwd=self.repo, check=True)

    def test_post_tool_registers_standard_worktree_create(self) -> None:
        wt = self.repo / ".worktrees" / "feature" / "hooked"
        outside = self.repo / ".worktrees" / "feature" / "outside"

        run(["init"], self.repo)
        subprocess.run(["git", "worktree", "add", str(wt), "-b", "feature/hooked"], cwd=self.repo, check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "worktree", "add", str(outside), "-b", "feature/outside"], cwd=self.repo, check=True, stdout=subprocess.PIPE)

        payload = json.dumps(
            {
                "session_id": SESSION,
                "cwd": str(self.repo),
                "tool_name": "Bash",
                "tool_input": {"command": "make wt.new BR=feature/hooked"},
                "tool_response": {"exit_code": 0},
            }
        )
        run(["hook", "post-tool"], self.repo, stdin=payload)

        ledger = json.loads((self.repo / ".tmp/worktree-guard-ledger/test-session.json").read_text())
        self.assertEqual(len(ledger["worktrees"]), 1)
        self.assertEqual(ledger["worktrees"][0]["branch"], "feature/hooked")
        self.assertTrue((wt / ".tmp/.agent_worktree_owner.json").exists())

        early_cleanup = run(["cleanup", "--confirmed"], self.repo, check=False)
        self.assertNotEqual(early_cleanup.returncode, 0)
        self.assertTrue(wt.exists())
        self.assertTrue(outside.exists())

        run(["mark-done", str(wt), "--reason", "manual"], self.repo)
        run(["confirm-pr", "--confirmed"], self.repo)
        run(["mark-merged", str(wt)], self.repo)
        cleanup = run(["cleanup", "--confirmed"], self.repo)
        self.assertIn("cleaned 1 worktree", cleanup.stdout)
        self.assertFalse(wt.exists())
        self.assertTrue(outside.exists())
        subprocess.run(["git", "worktree", "remove", str(outside), "--force"], cwd=self.repo, check=True)

    def _make_merged_worktree(self, name: str) -> Path:
        wt = self.repo / ".worktrees" / "feature" / name
        run(["add", str(wt)], self.repo)
        (wt / "f.txt").write_text("work\n", encoding="utf-8")
        subprocess.run(["git", "add", "f.txt"], cwd=wt, check=True)
        subprocess.run(["git", "commit", "-m", "work"], cwd=wt, check=True, stdout=subprocess.PIPE)
        run(["mark-done", str(wt), "--reason", "manual"], self.repo)
        run(["confirm-pr", "--confirmed"], self.repo)
        run(["mark-merged", str(wt)], self.repo)
        return wt

    def test_cleanup_cross_session_resolves_owner_marker(self) -> None:
        # owned by test-session; a DIFFERENT session runs `cleanup` with no path
        # (mimics a manual cleanup from main where session_id resolves to "manual"/empty).
        run(["init"], self.repo)
        wt = self._make_merged_worktree("owned")

        result = run(["cleanup", "--confirmed"], self.repo, session="unrelated-session")
        self.assertIn("cleaned 1 worktree", result.stdout)
        self.assertFalse(wt.exists())
        ledger = json.loads((self.repo / ".tmp/worktree-guard-ledger/test-session.json").read_text())
        self.assertEqual(ledger["worktrees"][0]["status"], "cleaned")

    def test_cleanup_by_path_resolves_owner_session(self) -> None:
        run(["init"], self.repo)
        wt = self._make_merged_worktree("bypath")

        result = run(["cleanup", "--confirmed", "--path", str(wt)], self.repo, session="unrelated-session")
        self.assertIn("cleaned 1 worktree", result.stdout)
        self.assertFalse(wt.exists())

    def test_cleanup_cross_session_warns_when_unmerged(self) -> None:
        run(["init"], self.repo)
        wt = self.repo / ".worktrees" / "feature" / "pending"
        run(["add", str(wt)], self.repo)

        # unmerged worktree owned by another session: must NOT be removed, and must warn loudly.
        result = run(["cleanup", "--confirmed"], self.repo, session="unrelated-session")
        self.assertIn("cleaned 0 worktree", result.stdout)
        self.assertIn("not yet merged", result.stderr)
        self.assertTrue(wt.exists())
        subprocess.run(["git", "worktree", "remove", str(wt), "--force"], cwd=self.repo, check=True)


if __name__ == "__main__":
    unittest.main()
