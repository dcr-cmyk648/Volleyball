import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "codex_handoff", ROOT / "scripts" / "codex_handoff.py"
)
HANDOFF = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(HANDOFF)


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Test User")
        self.git("config", "user.email", "test@example.com")
        (self.root / ".gitignore").write_text(
            ".codex-handoff.local.json\n"
            ".codex-handoff.local.lock\n"
            ".codex-handoff.local.tmp\n",
            encoding="utf-8",
        )
        (self.root / "HANDOFF.md").write_text("# State\n", encoding="utf-8")
        self.git("add", ".gitignore", "HANDOFF.md")
        self.git("commit", "-qm", "init")
        self.old_id = "00000000-0000-0000-0000-000000000001"
        self.child_id = "00000000-0000-0000-0000-000000000002"

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        subprocess.run(
            ["git", *args],
            cwd=str(self.root),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def git_output(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=str(self.root),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ).stdout.strip()

    def transcript(self, session_id, parent=None):
        transcript_dir = self.root / ".git" / "handoff-test-transcripts"
        transcript_dir.mkdir(exist_ok=True)
        path = transcript_dir / f"{session_id}.jsonl"
        payload = {"id": session_id, "session_id": session_id}
        if parent:
            payload["forked_from_id"] = parent
        path.write_text(
            json.dumps({"type": "session_meta", "payload": payload}) + "\n",
            encoding="utf-8",
        )
        return path

    def event(self, name, session_id, transcript, **extra):
        data = {
            "hook_event_name": name,
            "session_id": session_id,
            "transcript_path": str(transcript),
            "cwd": str(self.root),
        }
        data.update(extra)
        return HANDOFF.process_hook(data)

    def state(self):
        return json.loads(
            (self.root / ".codex-handoff.local.json").read_text(encoding="utf-8")
        )

    def test_first_prompt_adopts_and_stop_records_snapshot(self):
        transcript = self.transcript(self.old_id)
        output = self.event(
            "UserPromptSubmit",
            self.old_id,
            transcript,
            turn_id="turn-1",
            prompt="Start",
        )
        self.assertEqual(
            output["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit"
        )
        self.assertEqual(self.state()["canonical_thread_id"], self.old_id)
        self.assertIsNotNone(self.state()["active_turn"])

        self.event("Stop", self.old_id, transcript, turn_id="turn-1")
        self.assertIsNone(self.state()["active_turn"])
        self.assertEqual(self.state()["status"], "active")

    def test_safe_direct_fork_claims_and_old_thread_becomes_stale(self):
        old = self.transcript(self.old_id)
        self.event(
            "UserPromptSubmit",
            self.old_id,
            old,
            turn_id="turn-1",
            prompt="Start",
        )
        self.event("Stop", self.old_id, old, turn_id="turn-1")
        child = self.transcript(self.child_id, self.old_id)

        output = self.event(
            "UserPromptSubmit",
            self.child_id,
            child,
            turn_id="turn-2",
            prompt="Continue on phone",
        )
        self.assertIn("now canonical", output["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.state()["canonical_thread_id"], self.child_id)
        self.assertEqual(self.state()["generation"], 2)

        blocked = self.event(
            "UserPromptSubmit",
            self.old_id,
            old,
            turn_id="turn-3",
            prompt="Continue here",
        )
        self.assertEqual(blocked["decision"], "block")
        self.assertIn(self.child_id, blocked["reason"])

    def test_fork_is_blocked_while_canonical_turn_is_active(self):
        old = self.transcript(self.old_id)
        self.event(
            "UserPromptSubmit",
            self.old_id,
            old,
            turn_id="turn-1",
            prompt="Start",
        )
        child = self.transcript(self.child_id, self.old_id)
        output = self.event(
            "UserPromptSubmit",
            self.child_id,
            child,
            turn_id="turn-2",
            prompt="Switch now",
        )
        self.assertEqual(output["decision"], "block")
        self.assertIn("active turn", output["reason"])
        self.assertEqual(self.state()["canonical_thread_id"], self.old_id)

    def test_drift_requires_explicit_read_only_reconciliation(self):
        old = self.transcript(self.old_id)
        self.event(
            "UserPromptSubmit",
            self.old_id,
            old,
            turn_id="turn-1",
            prompt="Start",
        )
        self.event("Stop", self.old_id, old, turn_id="turn-1")
        (self.root / "unexpected.txt").write_text("drift\n", encoding="utf-8")
        child = self.transcript(self.child_id, self.old_id)

        blocked = self.event(
            "UserPromptSubmit",
            self.child_id,
            child,
            turn_id="turn-2",
            prompt="Do work",
        )
        self.assertEqual(blocked["decision"], "block")
        self.assertIn("Accept handoff", blocked["reason"])

        accepted = self.event(
            "UserPromptSubmit",
            self.child_id,
            child,
            turn_id="turn-3",
            prompt="Accept handoff",
        )
        self.assertIn(
            "read-only reconciliation",
            accepted["hookSpecificOutput"]["additionalContext"],
        )
        self.assertEqual(self.state()["status"], "needs-reconciliation")
        denied = self.event(
            "PreToolUse",
            self.child_id,
            child,
            turn_id="turn-3",
            tool_name="apply_patch",
            tool_input={"command": "*** Begin Patch"},
        )
        self.assertEqual(
            denied["hookSpecificOutput"]["permissionDecision"], "deny"
        )

    def test_prepare_phone_is_preserved_by_stop(self):
        value = HANDOFF.new_state(self.root, self.old_id)
        value["status"] = "prepared"
        value["prepared_target"] = "phone"
        value["prepared_at"] = HANDOFF.utc_now()
        HANDOFF.write_state(self.root, value)
        old = self.transcript(self.old_id)
        self.event("Stop", self.old_id, old, turn_id="turn-1")
        self.assertEqual(self.state()["status"], "prepared")
        self.assertEqual(self.state()["prepared_target"], "phone")

    def test_prepared_mac_clears_only_on_resume_session_start(self):
        value = HANDOFF.new_state(self.root, self.old_id)
        value["status"] = "prepared"
        value["prepared_target"] = "mac"
        value["prepared_at"] = HANDOFF.utc_now()
        HANDOFF.write_state(self.root, value)
        old = self.transcript(self.old_id)

        self.event("SessionStart", self.old_id, old, source="compact")
        self.assertEqual(self.state()["status"], "prepared")

        self.event("SessionStart", self.old_id, old, source="resume")
        self.assertEqual(self.state()["status"], "active")
        self.assertIsNone(self.state()["prepared_target"])

    def test_prepared_mac_resume_preserves_drift_for_reconciliation(self):
        value = HANDOFF.new_state(self.root, self.old_id)
        value["status"] = "prepared"
        value["prepared_target"] = "mac"
        value["prepared_at"] = HANDOFF.utc_now()
        HANDOFF.write_state(self.root, value)
        (self.root / "external-change.txt").write_text("changed\n", encoding="utf-8")
        old = self.transcript(self.old_id)

        output = self.event("SessionStart", self.old_id, old, source="resume")
        self.assertIn(
            "read-only reconciliation",
            output["hookSpecificOutput"]["additionalContext"],
        )
        self.assertEqual(self.state()["status"], "needs-reconciliation")
        self.assertIn("working-tree status", self.state()["reconciliation"]["differences"])

    def test_stale_thread_edit_tool_is_denied(self):
        value = HANDOFF.new_state(self.root, self.child_id)
        HANDOFF.write_state(self.root, value)
        old = self.transcript(self.old_id)
        denied = self.event(
            "PreToolUse",
            self.old_id,
            old,
            turn_id="turn-1",
            tool_name="apply_patch",
            tool_input={"command": "*** Begin Patch"},
        )
        self.assertEqual(
            denied["hookSpecificOutput"]["permissionDecision"], "deny"
        )
        self.assertIn(self.child_id, denied["hookSpecificOutput"]["permissionDecisionReason"])

    def test_resume_argv_includes_unfiltered_session_flags(self):
        old_codex_bin = os.environ.get("CODEX_BIN")
        os.environ["CODEX_BIN"] = "/tmp/test-codex"
        try:
            argv = HANDOFF.resume_argv(self.root, self.old_id)
        finally:
            if old_codex_bin is None:
                os.environ.pop("CODEX_BIN", None)
            else:
                os.environ["CODEX_BIN"] = old_codex_bin
        self.assertEqual(argv[0], "/tmp/test-codex")
        self.assertIn("--all", argv)
        self.assertIn("--include-non-interactive", argv)
        self.assertIn(str(self.root), argv)
        self.assertEqual(argv[-1], self.old_id)

    def test_state_never_stores_prompt_text(self):
        old = self.transcript(self.old_id)
        secret_prompt = "private prompt content should never enter the lease"
        self.event(
            "UserPromptSubmit",
            self.old_id,
            old,
            turn_id="turn-1",
            prompt=secret_prompt,
        )
        raw = (self.root / ".codex-handoff.local.json").read_text(encoding="utf-8")
        self.assertNotIn(secret_prompt, raw)

    def test_handoff_content_is_hashed_but_never_stored(self):
        secret_content = "private durable state content"
        (self.root / "HANDOFF.md").write_text(secret_content + "\n", encoding="utf-8")
        old = self.transcript(self.old_id)
        self.event(
            "UserPromptSubmit",
            self.old_id,
            old,
            turn_id="turn-1",
            prompt="Initialize",
        )
        self.event("Stop", self.old_id, old, turn_id="turn-1")

        raw = (self.root / ".codex-handoff.local.json").read_text(encoding="utf-8")
        value = json.loads(raw)
        self.assertNotIn(secret_content, raw)
        self.assertEqual(
            set(value["snapshot"]),
            {"branch", "head", "git_status_sha256", "handoff_sha256"},
        )
        self.assertEqual(len(value["snapshot"]["handoff_sha256"]), 64)

    def test_handoff_drift_is_named_and_requires_reconciliation(self):
        value = HANDOFF.new_state(self.root, self.old_id)
        HANDOFF.write_state(self.root, value)
        (self.root / "HANDOFF.md").write_text("# Changed state\n", encoding="utf-8")
        child = self.transcript(self.child_id, self.old_id)

        blocked = self.event(
            "UserPromptSubmit",
            self.child_id,
            child,
            turn_id="turn-2",
            prompt="Continue",
        )
        self.assertEqual(blocked["decision"], "block")
        self.assertIn("HANDOFF.md", blocked["reason"])
        self.assertIn("working-tree status", blocked["reason"])

    def test_head_drift_is_guarded(self):
        value = HANDOFF.new_state(self.root, self.old_id)
        HANDOFF.write_state(self.root, value)
        (self.root / "new.txt").write_text("new\n", encoding="utf-8")
        self.git("add", "new.txt")
        self.git("commit", "-qm", "advance head")
        observed = HANDOFF.worktree_snapshot(self.root)
        self.assertIn("HEAD", HANDOFF.snapshot_differences(value["snapshot"], observed))

    def test_branch_drift_is_guarded(self):
        value = HANDOFF.new_state(self.root, self.old_id)
        HANDOFF.write_state(self.root, value)
        self.git("switch", "-q", "-c", "other-worktree-branch")
        observed = HANDOFF.worktree_snapshot(self.root)
        self.assertIn("branch", HANDOFF.snapshot_differences(value["snapshot"], observed))

    def test_active_turn_has_no_timed_expiry(self):
        value = HANDOFF.new_state(self.root, self.old_id)
        HANDOFF.set_active_turn(value, self.old_id, "ancient-turn")
        value["active_turn"]["started_at"] = "2000-01-01T00:00:00Z"
        HANDOFF.write_state(self.root, value)
        child = self.transcript(self.child_id, self.old_id)

        blocked = self.event(
            "UserPromptSubmit",
            self.child_id,
            child,
            turn_id="turn-2",
            prompt="Try much later",
        )
        self.assertEqual(blocked["decision"], "block")
        self.assertIn("active turn", blocked["reason"])
        self.assertEqual(self.state()["canonical_thread_id"], self.old_id)

    def test_stale_thread_bash_is_denied(self):
        value = HANDOFF.new_state(self.root, self.child_id)
        HANDOFF.write_state(self.root, value)
        old = self.transcript(self.old_id)
        denied = self.event(
            "PreToolUse",
            self.old_id,
            old,
            turn_id="turn-1",
            tool_name="Bash",
            tool_input={"command": "touch should-not-run"},
        )
        self.assertEqual(
            denied["hookSpecificOutput"]["permissionDecision"], "deny"
        )
        self.assertFalse((self.root / "should-not-run").exists())

    def test_prepare_and_reconcile_never_mutate_git(self):
        HANDOFF.write_state(self.root, HANDOFF.new_state(self.root, self.old_id))
        before_head = self.git_output("rev-parse", "HEAD")
        before_status = self.git_output("status", "--porcelain=v1", "--untracked-files=all")

        HANDOFF.command_prepare(SimpleNamespace(
            repo=str(self.root), session_id=self.old_id, target="phone"
        ))
        HANDOFF.command_prepare(SimpleNamespace(
            repo=str(self.root), session_id=self.old_id, target="mac"
        ))
        HANDOFF.command_reconcile(SimpleNamespace(
            repo=str(self.root), session_id=self.child_id, adopt_current=True
        ))

        self.assertEqual(self.git_output("rev-parse", "HEAD"), before_head)
        self.assertEqual(
            self.git_output("status", "--porcelain=v1", "--untracked-files=all"),
            before_status,
        )

    def test_state_is_bound_to_one_worktree(self):
        value = HANDOFF.new_state(self.root, self.old_id)
        value["repository_root"] = str(self.root / "some-other-worktree")
        HANDOFF.write_state(self.root, value)
        with self.assertRaisesRegex(HANDOFF.HandoffError, "different worktree"):
            HANDOFF.load_state(self.root)

    def test_project_hook_config_covers_required_lifecycle_events(self):
        hooks = json.loads((ROOT / ".codex" / "hooks.json").read_text(encoding="utf-8"))["hooks"]
        self.assertEqual(
            set(hooks),
            {"SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"},
        )
        matcher = hooks["PreToolUse"][0]["matcher"]
        for tool_name in ("Bash", "apply_patch", "Edit", "Write"):
            self.assertIn(tool_name, matcher)

    def test_state_has_only_coordination_metadata(self):
        secret_prompt = "token=super-secret-value user private content"
        old = self.transcript(self.old_id)
        self.event(
            "UserPromptSubmit",
            self.old_id,
            old,
            turn_id="turn-1",
            prompt=secret_prompt,
        )
        value = self.state()
        raw = json.dumps(value, sort_keys=True)
        self.assertNotIn(secret_prompt, raw)
        self.assertNotIn("super-secret-value", raw)
        self.assertEqual(
            set(value),
            {
                "active_turn",
                "canonical_thread_id",
                "created_at",
                "generation",
                "last_transition",
                "prepared_at",
                "prepared_by_thread_id",
                "prepared_target",
                "previous_thread_id",
                "reconciliation",
                "repository_root",
                "schema_version",
                "snapshot",
                "status",
                "updated_at",
            },
        )


if __name__ == "__main__":
    unittest.main()
