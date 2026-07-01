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
        self.assertIn("Worktree 承認依頼レビュー", audit.stdout)
        self.assertIn("11 セクション", audit.stdout)
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
        self.assertIn("# PR 承認後の完了報告", cleanup.stdout)
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
        self.assertIn("# PR 承認後の完了報告", cleanup.stdout)
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

    def test_mark_merged_and_cleanup_reconcile_stale_entry_after_directory_already_gone(self) -> None:
        # Mirrors a real zombie-ledger incident: a worktree's directory is removed by some
        # OTHER flow (e.g. a plain `git worktree remove` outside this guard, or the PR merged
        # via GitHub's web UI) before this ledger's bookkeeping ever recorded pr_merged_at.
        # The owner marker lives *inside* that directory, so once it's gone, `mark-merged` and
        # `cleanup` used to hard-fail forever with "Owner marker missing or invalid" — a stale
        # entry like this permanently blocked bare `cleanup --confirmed` for the WHOLE ledger,
        # not just itself.
        run(["init"], self.repo)
        wt = self.repo / ".worktrees" / "feature" / "goneexternally"
        run(["add", str(wt)], self.repo)
        (wt / "f.txt").write_text("work\n", encoding="utf-8")
        subprocess.run(["git", "add", "f.txt"], cwd=wt, check=True)
        subprocess.run(["git", "commit", "-m", "work"], cwd=wt, check=True, stdout=subprocess.PIPE)
        run(["mark-done", str(wt), "--reason", "commit"], self.repo)

        subprocess.run(["git", "worktree", "remove", str(wt), "--force"], cwd=self.repo, check=True)
        self.assertFalse(wt.exists())

        mark = run(["mark-merged", str(wt)], self.repo, check=False)
        self.assertEqual(mark.returncode, 0, f"stdout={mark.stdout}\nstderr={mark.stderr}")
        ledger = json.loads((self.repo / ".tmp/worktree-guard-ledger/test-session.json").read_text())
        self.assertTrue(ledger["worktrees"][0]["pr_merged_at"])

        cleanup = run(["cleanup", "--confirmed"], self.repo)
        self.assertIn("cleaned 1 worktree", cleanup.stdout)
        ledger = json.loads((self.repo / ".tmp/worktree-guard-ledger/test-session.json").read_text())
        self.assertEqual(ledger["worktrees"][0]["status"], "cleaned")

    def _git_out(self, args: list[str], cwd: Path) -> str:
        return subprocess.run(
            ["git", *args], cwd=cwd, text=True, stdout=subprocess.PIPE, check=True
        ).stdout.strip()

    def _branch_exists(self, branch: str) -> bool:
        return (
            subprocess.run(
                ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=self.repo
            ).returncode
            == 0
        )

    def test_cleanup_deletes_merged_branch(self) -> None:
        run(["init"], self.repo)
        wt = self._make_merged_worktree("branchgone")
        self.assertTrue(self._branch_exists("feature/branchgone"))

        cleanup = run(["cleanup", "--confirmed"], self.repo)
        self.assertIn("cleaned 1 worktree", cleanup.stdout)
        self.assertIn("branches deleted: 1", cleanup.stdout)
        self.assertIn("# PR 承認後の完了報告", cleanup.stdout)
        self.assertFalse(wt.exists())
        self.assertFalse(self._branch_exists("feature/branchgone"))
        # origin 未設定なので remote 削除は skip され、completion report にその旨が出る。
        self.assertIn("Remote branch cleanup:", cleanup.stdout)
        self.assertIn("skipped (remote 未設定 / main)", cleanup.stdout)
        self.assertNotIn("remote branches deleted:", cleanup.stdout)

    def test_cleanup_deletes_merged_remote_branch(self) -> None:
        # bare remote を origin に設定し worktree branch を push → cleanup が remote からも削除する。
        remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=self.repo, check=True)
        run(["init"], self.repo)
        wt = self._make_merged_worktree("remotegone")
        subprocess.run(
            ["git", "push", "origin", "feature/remotegone"],
            cwd=wt, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertIn("feature/remotegone", self._git_out(["ls-remote", "--heads", "origin"], self.repo))

        cleanup = run(["cleanup", "--confirmed"], self.repo)
        self.assertIn("cleaned 1 worktree", cleanup.stdout)
        self.assertIn("remote branches deleted: 1", cleanup.stdout)
        self.assertIn("Remote branch cleanup: feature/remotegone: deleted", cleanup.stdout)
        self.assertFalse(wt.exists())
        # remote からも消えている。
        self.assertEqual(self._git_out(["ls-remote", "--heads", "origin", "feature/remotegone"], self.repo), "")

    def test_cleanup_remote_branch_already_absent(self) -> None:
        # origin はあるが当該 branch を push していない(gh --delete-branch 済み相当)。
        # push --delete の stderr 'remote ref does not exist' から already-absent と判定し failed にしない。
        remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=self.repo, check=True)
        run(["init"], self.repo)
        wt = self._make_merged_worktree("absent")  # feature/absent は origin に push しない

        cleanup = run(["cleanup", "--confirmed"], self.repo)
        self.assertIn("cleaned 1 worktree", cleanup.stdout)
        # 'already absent' ラベルが出る = failed/deleted/skipped ではない(push stderr から判定成功)。
        self.assertIn("Remote branch cleanup: feature/absent: already absent", cleanup.stdout)
        self.assertNotIn("remote branches deleted:", cleanup.stdout)  # "deleted" のみ計上
        self.assertFalse(wt.exists())

    def test_cleanup_event_records_remote_branch_deleted(self) -> None:
        # 引数なし cleanup でも ledger の cleanup event に remote_branch_deleted が記録される
        # (PR #64 で引数なし経路だけ取りこぼした非対称の回帰ガード。3経路で payload helper を共有)。
        run(["init"], self.repo)
        wt = self._make_merged_worktree("evt")
        run(["cleanup", "--confirmed"], self.repo)  # no --path → 引数なし主経路
        self.assertFalse(wt.exists())
        ledger = json.loads((self.repo / ".tmp/worktree-guard-ledger/test-session.json").read_text())
        cleanup_events = [e for e in ledger.get("events", []) if e.get("event") == "cleanup"]
        self.assertTrue(cleanup_events, "no cleanup event recorded")
        self.assertIn("remote_branch_deleted", cleanup_events[-1])
        self.assertEqual(cleanup_events[-1]["remote_branch_deleted"], "skipped")  # origin 未設定

    def test_cleanup_drops_only_matching_branch_stash(self) -> None:
        run(["init"], self.repo)
        default_branch = self._git_out(["rev-parse", "--abbrev-ref", "HEAD"], self.repo)
        wt = self._make_merged_worktree("stashed")

        # stash on the worktree branch (worktree stays clean → removable).
        (wt / "wip.txt").write_text("wip\n", encoding="utf-8")
        subprocess.run(["git", "add", "wip.txt"], cwd=wt, check=True)
        subprocess.run(["git", "stash", "push", "-m", "wt-wip"], cwd=wt, check=True, stdout=subprocess.PIPE)
        # unrelated stash on the default branch in the main checkout.
        (self.repo / "main-wip.txt").write_text("wip\n", encoding="utf-8")
        subprocess.run(["git", "add", "main-wip.txt"], cwd=self.repo, check=True)
        subprocess.run(["git", "stash", "push", "-m", "main-wip"], cwd=self.repo, check=True, stdout=subprocess.PIPE)

        before = self._git_out(["stash", "list"], self.repo)
        self.assertEqual(len(before.splitlines()), 2)

        cleanup = run(["cleanup", "--confirmed"], self.repo)
        self.assertIn("cleaned 1 worktree", cleanup.stdout)
        self.assertIn("stashes dropped: 1", cleanup.stdout)
        self.assertIn("# PR 承認後の完了報告", cleanup.stdout)
        self.assertFalse(wt.exists())

        after = self._git_out(["stash", "list"], self.repo)
        self.assertEqual(len(after.splitlines()), 1)
        self.assertIn(default_branch, after)
        self.assertNotIn("feature/stashed", after)

    def _make_committed_worktree(self, name: str) -> Path:
        wt = self.repo / ".worktrees" / "feature" / name
        run(["add", str(wt)], self.repo)
        (wt / "f.txt").write_text("work\n", encoding="utf-8")
        subprocess.run(["git", "add", "f.txt"], cwd=wt, check=True)
        subprocess.run(["git", "commit", "-m", "work"], cwd=wt, check=True, stdout=subprocess.PIPE)
        run(["mark-done", str(wt), "--reason", "manual"], self.repo)
        return wt

    def test_briefing_includes_review_report(self) -> None:
        run(["init"], self.repo)
        wt = self._make_committed_worktree("reviewed")
        review_dir = wt / ".tmp" / "worktree-feature__reviewed"
        review_dir.mkdir(parents=True, exist_ok=True)
        (review_dir / "REVIEW.md").write_text(
            "# Worktree 承認依頼レビュー — feature/reviewed\n\n"
            "## Summary / 概要 (作業内容)\nクリーンアップ強化の要点。\n\n"
            "## Trade-offs / トレードオフ\nstash 全消しではなく branch 一致のみ。\n",
            encoding="utf-8",
        )

        audit = run(["audit"], self.repo)
        self.assertIn("REVIEW.md:", audit.stdout)
        self.assertIn("概要", audit.stdout)
        self.assertIn("クリーンアップ強化の要点", audit.stdout)
        self.assertIn("トレードオフ", audit.stdout)

    def test_briefing_notes_missing_review(self) -> None:
        run(["init"], self.repo)
        self._make_committed_worktree("noreview")

        audit = run(["audit"], self.repo)
        self.assertIn("REVIEW.md: 未作成", audit.stdout)
        self.assertIn("mark-worktree-reviewed.mjs", audit.stdout)


if __name__ == "__main__":
    unittest.main()
