#!/usr/bin/env python3
"""Coordinate one write-capable Codex thread for a repository worktree."""

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
from typing import Any, Dict, Iterator, List, Optional, Tuple


SCHEMA_VERSION = 1
STATE_NAME = ".codex-handoff.local.json"
LOCK_NAME = ".codex-handoff.local.lock"
TMP_NAME = ".codex-handoff.local.tmp"
RECONCILE_PROMPTS = {
    "accept handoff",
    "accept handoff.",
    "reconcile handoff",
    "reconcile handoff.",
}


class HandoffError(RuntimeError):
    pass


def utc_now() -> str:
    return (
        dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def run_git(root: Path, *args: str, binary: bool = False) -> Any:
    result = subprocess.run(
        ["git", *args],
        cwd=str(root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise HandoffError(message or "Git command failed")
    if binary:
        return result.stdout
    return result.stdout.decode("utf-8", errors="replace").strip()


def discover_root(cwd: Optional[str] = None) -> Path:
    override = os.environ.get("CODEX_HANDOFF_REPO_ROOT")
    start = Path(override or cwd or os.getcwd()).expanduser().resolve()
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=str(start),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise HandoffError(f"Not inside a Git worktree: {start}")
    return Path(result.stdout.strip()).resolve()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def worktree_snapshot(root: Path) -> Dict[str, Optional[str]]:
    handoff = root / "HANDOFF.md"
    return {
        "branch": run_git(root, "branch", "--show-current") or "(detached)",
        "head": run_git(root, "rev-parse", "HEAD"),
        "git_status_sha256": sha256_bytes(
            run_git(
                root,
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                binary=True,
            )
        ),
        "handoff_sha256": (
            sha256_bytes(handoff.read_bytes()) if handoff.exists() else None
        ),
    }


def snapshot_differences(
    expected: Dict[str, Optional[str]], observed: Dict[str, Optional[str]]
) -> List[str]:
    labels = {
        "branch": "branch",
        "head": "HEAD",
        "git_status_sha256": "working-tree status",
        "handoff_sha256": "HANDOFF.md",
    }
    return [
        labels[key]
        for key in labels
        if expected.get(key) != observed.get(key)
    ]


def state_path(root: Path) -> Path:
    return root / STATE_NAME


@contextlib.contextmanager
def state_lock(root: Path) -> Iterator[None]:
    lock_path = root / LOCK_NAME
    with lock_path.open("a+", encoding="utf-8") as handle:
        try:
            os.chmod(str(lock_path), 0o600)
        except OSError:
            pass
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def load_state(root: Path) -> Optional[Dict[str, Any]]:
    path = state_path(root)
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HandoffError(f"Cannot read {STATE_NAME}: {exc}")
    if value.get("schema_version") != SCHEMA_VERSION:
        raise HandoffError(
            f"Unsupported {STATE_NAME} schema: {value.get('schema_version')!r}"
        )
    if Path(value.get("repository_root", "")).resolve() != root:
        raise HandoffError(f"{STATE_NAME} belongs to a different worktree")
    if not value.get("canonical_thread_id"):
        raise HandoffError(f"{STATE_NAME} has no canonical thread id")
    return value


def write_state(root: Path, value: Dict[str, Any]) -> None:
    value["updated_at"] = utc_now()
    temp = root / TMP_NAME
    payload = json.dumps(value, indent=2, sort_keys=True) + "\n"
    with temp.open("w", encoding="utf-8") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(str(temp), 0o600)
    os.replace(str(temp), str(state_path(root)))


def current_session_id(explicit: Optional[str] = None) -> str:
    session_id = explicit or os.environ.get("CODEX_THREAD_ID")
    if not session_id:
        raise HandoffError(
            "No Codex thread id is available. Run this inside Codex or pass --session-id."
        )
    return session_id


def transcript_parent(path_value: Optional[str]) -> Optional[str]:
    if not path_value:
        return None
    path = Path(path_value).expanduser()
    try:
        with path.open("r", encoding="utf-8") as handle:
            for _ in range(20):
                line = handle.readline()
                if not line:
                    break
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get("type") != "session_meta":
                    continue
                payload = item.get("payload") or {}
                parent = payload.get("forked_from_id")
                return parent if isinstance(parent, str) and parent else None
    except OSError:
        return None
    return None


def locate_transcript(session_id: str) -> Optional[Path]:
    override = os.environ.get("CODEX_TRANSCRIPT_PATH")
    if override:
        path = Path(override).expanduser()
        return path if path.exists() else None
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    sessions = home / "sessions"
    if not sessions.exists():
        return None
    matches = list(sessions.rglob(f"*{session_id}*.jsonl"))
    if not matches:
        return None
    return max(matches, key=lambda item: item.stat().st_mtime)


def session_parent(
    session_id: str, transcript_path_value: Optional[str] = None
) -> Optional[str]:
    path = (
        Path(transcript_path_value)
        if transcript_path_value
        else locate_transcript(session_id)
    )
    return transcript_parent(str(path)) if path else None


def transition(
    value: Dict[str, Any], kind: str, old_id: Optional[str], new_id: str, **extra: Any
) -> None:
    record = {
        "at": utc_now(),
        "kind": kind,
        "from_thread_id": old_id,
        "to_thread_id": new_id,
    }
    record.update(extra)
    value["last_transition"] = record


def new_state(root: Path, session_id: str) -> Dict[str, Any]:
    now = utc_now()
    return {
        "schema_version": SCHEMA_VERSION,
        "repository_root": str(root),
        "canonical_thread_id": session_id,
        "previous_thread_id": None,
        "generation": 1,
        "status": "active",
        "prepared_target": None,
        "prepared_at": None,
        "prepared_by_thread_id": None,
        "active_turn": None,
        "reconciliation": None,
        "snapshot": worktree_snapshot(root),
        "created_at": now,
        "updated_at": now,
        "last_transition": {
            "at": now,
            "kind": "initial-adopt",
            "from_thread_id": None,
            "to_thread_id": session_id,
        },
    }


def clear_prepared(value: Dict[str, Any]) -> None:
    value["status"] = "active"
    value["prepared_target"] = None
    value["prepared_at"] = None
    value["prepared_by_thread_id"] = None


def claim_thread(
    value: Dict[str, Any], session_id: str, kind: str, target: Optional[str] = None
) -> None:
    old_id = value["canonical_thread_id"]
    value["previous_thread_id"] = old_id
    value["canonical_thread_id"] = session_id
    value["generation"] = int(value.get("generation", 0)) + 1
    clear_prepared(value)
    value["reconciliation"] = None
    transition(value, kind, old_id, session_id, target=target)


def active_other_thread(value: Dict[str, Any], session_id: str) -> Optional[str]:
    active = value.get("active_turn") or {}
    active_id = active.get("thread_id")
    if active_id and active_id != session_id:
        return active_id
    return None


def set_active_turn(value: Dict[str, Any], session_id: str, turn_id: Any) -> None:
    value["active_turn"] = {
        "thread_id": session_id,
        "turn_id": str(turn_id or "unknown"),
        "started_at": utc_now(),
    }


def relation(value: Dict[str, Any], session_id: Optional[str], parent: Optional[str]) -> str:
    if not session_id:
        return "terminal"
    if session_id == value["canonical_thread_id"]:
        return "canonical"
    if parent == value["canonical_thread_id"]:
        return "direct-child"
    return "stale"


def resume_argv(root: Path, canonical_id: str, prompt: Optional[str] = None) -> List[str]:
    codex = os.environ.get("CODEX_BIN") or shutil.which("codex")
    if not codex:
        candidate = Path.home() / ".local" / "bin" / "codex"
        if candidate.exists():
            codex = str(candidate)
    if not codex:
        raise HandoffError("Cannot find the codex executable; set CODEX_BIN.")
    result = [
        codex,
        "resume",
        "--all",
        "--include-non-interactive",
        "-C",
        str(root),
        canonical_id,
    ]
    if prompt:
        result.append(prompt)
    return result


def render_status(
    root: Path,
    value: Optional[Dict[str, Any]],
    session_id: Optional[str],
    parent: Optional[str],
) -> Dict[str, Any]:
    if value is None:
        return {
            "initialized": False,
            "repository_root": str(root),
            "current_thread_id": session_id,
            "relation": "uninitialized",
            "next_action": "The first Codex prompt will adopt its thread as canonical.",
        }
    observed = worktree_snapshot(root)
    differences = snapshot_differences(value.get("snapshot") or {}, observed)
    current_relation = relation(value, session_id, parent)
    if current_relation == "canonical":
        next_action = "This thread may work. Follow the repository startup procedure."
    elif current_relation == "direct-child":
        next_action = "Send a prompt to reconcile this direct fork, or run accept inside it."
    elif current_relation == "stale":
        next_action = "Do not edit here. Resume the canonical thread from a terminal."
    else:
        next_action = "Run the resume command to open the canonical thread."
    return {
        "initialized": True,
        "repository_root": str(root),
        "status": value.get("status"),
        "canonical_thread_id": value.get("canonical_thread_id"),
        "previous_thread_id": value.get("previous_thread_id"),
        "current_thread_id": session_id,
        "current_parent_thread_id": parent,
        "relation": current_relation,
        "generation": value.get("generation"),
        "prepared_target": value.get("prepared_target"),
        "active_turn": value.get("active_turn"),
        "snapshot_matches": not differences,
        "snapshot_differences": differences,
        "last_transition": value.get("last_transition"),
        "next_action": next_action,
        "resume_command": " ".join(
            shlex.quote(part)
            for part in resume_argv(root, value["canonical_thread_id"])
        ),
    }


def print_human_status(result: Dict[str, Any]) -> None:
    if not result["initialized"]:
        print("Handoff state: uninitialized")
        print(f"Repository: {result['repository_root']}")
        print(f"Current thread: {result.get('current_thread_id') or '(terminal)'}")
        print(f"Next: {result['next_action']}")
        return
    print(f"Handoff state: {result['status']}")
    print(f"Canonical thread: {result['canonical_thread_id']}")
    print(f"Current thread: {result.get('current_thread_id') or '(terminal)'}")
    print(f"Relation: {result['relation']}")
    print(f"Generation: {result['generation']}")
    if result.get("prepared_target"):
        print(f"Prepared target: {result['prepared_target']}")
    active = result.get("active_turn")
    if active:
        print(
            "Active turn: "
            f"{active.get('thread_id')} ({active.get('turn_id')}, {active.get('started_at')})"
        )
    if result["snapshot_matches"]:
        print("Recorded worktree snapshot: matches")
    else:
        print(
            "Recorded worktree snapshot: differs ("
            + ", ".join(result["snapshot_differences"])
            + ")"
        )
    print(f"Next: {result['next_action']}")
    print(f"Resume: {result['resume_command']}")


def command_status(args: argparse.Namespace) -> int:
    root = discover_root(args.repo)
    session_id = args.session_id or os.environ.get("CODEX_THREAD_ID")
    parent = session_parent(session_id, args.transcript_path) if session_id else None
    with state_lock(root):
        value = load_state(root)
        result = render_status(root, value, session_id, parent)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print_human_status(result)
    return 0


def command_adopt(args: argparse.Namespace) -> int:
    root = discover_root(args.repo)
    session_id = current_session_id(args.session_id)
    with state_lock(root):
        value = load_state(root)
        if value is None:
            value = new_state(root, session_id)
        elif value["canonical_thread_id"] != session_id:
            raise HandoffError(
                "A different canonical thread already exists. Use reconcile --adopt-current "
                "only after confirming no other turn is active."
            )
        else:
            value["snapshot"] = worktree_snapshot(root)
            value["active_turn"] = None
            clear_prepared(value)
            value["reconciliation"] = None
            transition(value, "canonical-refresh", session_id, session_id)
        write_state(root, value)
    print(f"Canonical thread: {session_id} (generation {value['generation']})")
    return 0


def command_prepare(args: argparse.Namespace) -> int:
    root = discover_root(args.repo)
    session_id = current_session_id(args.session_id)
    with state_lock(root):
        value = load_state(root)
        if value is None:
            value = new_state(root, session_id)
        if value["canonical_thread_id"] != session_id:
            raise HandoffError(
                f"This thread is stale; canonical is {value['canonical_thread_id']}."
            )
        other = active_other_thread(value, session_id)
        if other:
            raise HandoffError(f"Thread {other} still has an active turn.")
        value["status"] = "prepared"
        value["prepared_target"] = args.target
        value["prepared_at"] = utc_now()
        value["prepared_by_thread_id"] = session_id
        value["snapshot"] = worktree_snapshot(root)
        value["reconciliation"] = None
        transition(
            value,
            "handoff-prepared",
            session_id,
            session_id,
            target=args.target,
        )
        write_state(root, value)
    if args.target == "phone":
        print(
            "Phone handoff prepared. Open this conversation on the phone and send the "
            "next prompt; a direct fork will claim the lease if the snapshot still matches."
        )
    else:
        print(
            "Mac handoff prepared. From the repository terminal run "
            "./scripts/codex-handoff resume."
        )
    return 0


def command_accept(args: argparse.Namespace) -> int:
    root = discover_root(args.repo)
    session_id = current_session_id(args.session_id)
    parent = session_parent(session_id, args.transcript_path)
    with state_lock(root):
        value = load_state(root)
        if value is None:
            value = new_state(root, session_id)
        elif session_id == value["canonical_thread_id"]:
            pass
        elif parent != value["canonical_thread_id"]:
            raise HandoffError(
                "This is not a direct child of the canonical thread. Resume the canonical "
                "thread or use explicit reconciliation from a terminal."
            )
        else:
            other = active_other_thread(value, session_id)
            if other:
                raise HandoffError(f"Thread {other} still has an active turn.")
            observed = worktree_snapshot(root)
            differences = snapshot_differences(value.get("snapshot") or {}, observed)
            if differences:
                raise HandoffError(
                    "The worktree changed since the last canonical stop: "
                    + ", ".join(differences)
                    + ". Use reconcile --adopt-current only after reviewing the discrepancy."
                )
            claim_thread(
                value,
                session_id,
                "manual-direct-fork-claim",
                value.get("prepared_target"),
            )
        value["snapshot"] = worktree_snapshot(root)
        write_state(root, value)
    print(f"Canonical thread: {session_id} (generation {value['generation']})")
    return 0


def command_reconcile(args: argparse.Namespace) -> int:
    root = discover_root(args.repo)
    session_id = current_session_id(args.session_id)
    with state_lock(root):
        value = load_state(root)
        if value is None:
            value = new_state(root, session_id)
        else:
            old_id = value["canonical_thread_id"]
            if old_id != session_id:
                value["previous_thread_id"] = old_id
                value["canonical_thread_id"] = session_id
                value["generation"] = int(value.get("generation", 0)) + 1
            clear_prepared(value)
            value["active_turn"] = None
            value["reconciliation"] = None
            value["snapshot"] = worktree_snapshot(root)
            transition(value, "explicit-reconciliation", old_id, session_id)
        write_state(root, value)
    print(
        f"Explicit reconciliation complete. Canonical thread: {session_id} "
        f"(generation {value['generation']})"
    )
    return 0


def command_recover_turn(args: argparse.Namespace) -> int:
    root = discover_root(args.repo)
    session_id = current_session_id(args.session_id)
    with state_lock(root):
        value = load_state(root)
        if value is None:
            raise HandoffError("Handoff state is not initialized.")
        if value["canonical_thread_id"] != session_id:
            raise HandoffError(
                f"This thread is stale; canonical is {value['canonical_thread_id']}."
            )
        value["active_turn"] = None
        value["snapshot"] = worktree_snapshot(root)
        transition(value, "active-turn-recovered", session_id, session_id)
        write_state(root, value)
    print("Cleared the interrupted-turn marker for the canonical thread.")
    return 0


def command_resume(args: argparse.Namespace) -> int:
    root = discover_root(args.repo)
    with state_lock(root):
        value = load_state(root)
        if value is None:
            raise HandoffError("Handoff state is not initialized.")
        active = value.get("active_turn") or {}
        if active and not args.allow_active:
            raise HandoffError(
                "A Codex turn is still marked active in thread "
                f"{active.get('thread_id')}. Wait for it to finish or run recover-turn "
                "after confirming it is no longer running."
            )
        argv = resume_argv(root, value["canonical_thread_id"], args.prompt)
    if args.print_only:
        print(" ".join(shlex.quote(part) for part in argv))
        return 0
    os.chdir(str(root))
    os.execv(argv[0], argv)
    return 0


def additional_context(event: str, message: str) -> Dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": message,
        }
    }


def block_prompt(reason: str) -> Dict[str, Any]:
    return {"decision": "block", "reason": reason}


def deny_tool(reason: str) -> Dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def hook_session_start(
    root: Path,
    value: Optional[Dict[str, Any]],
    session_id: str,
    parent: Optional[str],
    source: Optional[str],
) -> Dict[str, Any]:
    if value is None:
        return additional_context(
            "SessionStart",
            "Thread handoff state is uninitialized. The first user prompt will adopt "
            "this thread as the repository's canonical write-capable thread.",
        )
    current_relation = relation(value, session_id, parent)
    if current_relation == "canonical":
        if (
            source == "resume"
            and value.get("status") == "prepared"
            and value.get("prepared_target") == "mac"
        ):
            observed = worktree_snapshot(root)
            differences = snapshot_differences(value.get("snapshot") or {}, observed)
            if differences:
                expected = value.get("snapshot")
                clear_prepared(value)
                value["status"] = "needs-reconciliation"
                value["reconciliation"] = {
                    "accepted_at": utc_now(),
                    "differences": differences,
                    "expected_snapshot": expected,
                    "observed_snapshot": observed,
                }
                transition(
                    value,
                    "mac-resume-needs-reconciliation",
                    session_id,
                    session_id,
                )
                write_state(root, value)
                return additional_context(
                    "SessionStart",
                    "The worktree changed after the Mac handoff was prepared. This "
                    "canonical thread is in read-only reconciliation mode; run the full "
                    "AGENTS.md startup comparison and report the discrepancy before editing.",
                )
            clear_prepared(value)
            value["snapshot"] = observed
            transition(value, "canonical-resumed-on-mac", session_id, session_id)
            write_state(root, value)
        return additional_context(
            "SessionStart",
            f"Thread handoff guard: this is canonical thread {session_id}, generation "
            f"{value['generation']}. Follow AGENTS.md startup checks before editing.",
        )
    if current_relation == "direct-child":
        return additional_context(
            "SessionStart",
            "This session is a direct fork of the canonical thread. Do not edit before "
            "the first user prompt; UserPromptSubmit will reconcile it only when the "
            "recorded worktree snapshot is still safe.",
        )
    return additional_context(
        "SessionStart",
        f"This thread is stale. Canonical thread is {value['canonical_thread_id']}. "
        "Do not edit, commit, or push from this thread. Run "
        "./scripts/codex-handoff resume from a terminal.",
    )


def hook_user_prompt(
    root: Path,
    value: Optional[Dict[str, Any]],
    session_id: str,
    parent: Optional[str],
    turn_id: Any,
    prompt: str,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    if value is None:
        value = new_state(root, session_id)
        set_active_turn(value, session_id, turn_id)
        write_state(root, value)
        return value, additional_context(
            "UserPromptSubmit",
            f"This thread was initialized as canonical generation {value['generation']}. "
            "Run the full AGENTS.md startup procedure before acting.",
        )

    current_relation = relation(value, session_id, parent)
    if current_relation == "canonical":
        if value.get("status") == "needs-reconciliation":
            set_active_turn(value, session_id, turn_id)
            write_state(root, value)
            return value, additional_context(
                "UserPromptSubmit",
                "This canonical thread is in read-only reconciliation mode. Compare Git "
                "and HANDOFF.md, report discrepancies, and do not edit until the "
                "author approves `./scripts/codex-handoff reconcile --adopt-current`.",
            )
        if value.get("status") == "prepared":
            clear_prepared(value)
            transition(value, "prepared-handoff-cancelled", session_id, session_id)
        set_active_turn(value, session_id, turn_id)
        write_state(root, value)
        return value, additional_context(
            "UserPromptSubmit",
            f"Thread handoff guard confirms canonical generation {value['generation']}.",
        )

    if current_relation != "direct-child":
        return value, block_prompt(
            f"This thread is stale. Canonical thread is {value['canonical_thread_id']}. "
            "No prompt was sent. From the repository terminal run "
            "./scripts/codex-handoff resume."
        )

    other = active_other_thread(value, session_id)
    if other:
        return value, block_prompt(
            f"Canonical thread {other} still has an active turn. Wait for that response "
            "to finish before switching surfaces."
        )

    observed = worktree_snapshot(root)
    differences = snapshot_differences(value.get("snapshot") or {}, observed)
    if differences and prompt.strip().lower() not in RECONCILE_PROMPTS:
        return value, block_prompt(
            "The worktree changed after the last canonical snapshot ("
            + ", ".join(differences)
            + "). No prompt was sent. Review the old thread, then send the exact prompt "
            "`Accept handoff` to enter read-only reconciliation mode."
        )

    prepared_target = value.get("prepared_target")
    claim_thread(value, session_id, "automatic-direct-fork-claim", prepared_target)
    if differences:
        value["status"] = "needs-reconciliation"
        value["reconciliation"] = {
            "accepted_at": utc_now(),
            "differences": differences,
            "expected_snapshot": value.get("snapshot"),
            "observed_snapshot": observed,
        }
    else:
        value["snapshot"] = observed
    set_active_turn(value, session_id, turn_id)
    write_state(root, value)
    if differences:
        context = (
            "This direct fork is now canonical in read-only reconciliation mode. Run the "
            "full AGENTS.md startup comparison, report the recorded drift, and do not edit "
            "until explicit reconciliation is approved."
        )
    else:
        context = (
            f"This direct fork is now canonical generation {value['generation']}. Run the "
            "full AGENTS.md startup procedure and compare the repository state before acting."
        )
    return value, additional_context("UserPromptSubmit", context)


def hook_pre_tool(
    value: Optional[Dict[str, Any]], session_id: str, tool_name: Optional[str]
) -> Dict[str, Any]:
    if value is None:
        return deny_tool(
            "Thread handoff state is uninitialized; submit a user prompt before using tools."
        )
    if value["canonical_thread_id"] != session_id:
        return deny_tool(
            f"Stale thread blocked. Canonical thread is {value['canonical_thread_id']}."
        )
    if value.get("status") == "needs-reconciliation" and tool_name != "Bash":
        return deny_tool(
            "File-changing tools are blocked until handoff reconciliation is resolved."
        )
    return {}


def hook_stop(
    root: Path, value: Optional[Dict[str, Any]], session_id: str
) -> Dict[str, Any]:
    if value is None or value["canonical_thread_id"] != session_id:
        return {}
    value["active_turn"] = None
    if value.get("status") != "needs-reconciliation":
        value["snapshot"] = worktree_snapshot(root)
    write_state(root, value)
    return {}


def process_hook(data: Dict[str, Any]) -> Dict[str, Any]:
    event = data.get("hook_event_name")
    session_id = data.get("session_id")
    if not isinstance(event, str) or not isinstance(session_id, str):
        raise HandoffError("Hook input lacks hook_event_name or session_id")
    root = discover_root(data.get("cwd"))
    parent = session_parent(session_id, data.get("transcript_path"))
    with state_lock(root):
        value = load_state(root)
        if event == "SessionStart":
            return hook_session_start(
                root, value, session_id, parent, data.get("source")
            )
        if event == "UserPromptSubmit":
            _, output = hook_user_prompt(
                root,
                value,
                session_id,
                parent,
                data.get("turn_id"),
                str(data.get("prompt") or ""),
            )
            return output
        if event == "PreToolUse":
            return hook_pre_tool(value, session_id, data.get("tool_name"))
        if event == "Stop":
            return hook_stop(root, value, session_id)
    return {}


def command_hook(_args: argparse.Namespace) -> int:
    try:
        data = json.load(sys.stdin)
        output = process_hook(data)
    except (HandoffError, json.JSONDecodeError, OSError) as exc:
        event = None
        try:
            event = data.get("hook_event_name")  # type: ignore[name-defined]
        except (NameError, AttributeError):
            pass
        message = f"Thread handoff hook failed closed: {exc}"
        if event == "PreToolUse":
            output = deny_tool(message)
        elif event == "Stop":
            output = {"systemMessage": message}
        elif event == "SessionStart":
            output = additional_context("SessionStart", message)
        else:
            output = block_prompt(message)
    print(json.dumps(output, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Coordinate one canonical Codex thread for this Git worktree."
    )
    parser.add_argument("--repo", help=argparse.SUPPRESS)
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("status", help="Show canonical thread and drift state")
    status.add_argument("--json", action="store_true")
    status.add_argument("--session-id")
    status.add_argument("--transcript-path")
    status.set_defaults(func=command_status)

    adopt = subparsers.add_parser(
        "adopt-current", help="Initialize or refresh this canonical thread"
    )
    adopt.add_argument("--session-id")
    adopt.set_defaults(func=command_adopt)

    prepare = subparsers.add_parser("prepare", help="Prepare a phone or Mac handoff")
    prepare.add_argument("target", choices=("phone", "mac"))
    prepare.add_argument("--session-id")
    prepare.set_defaults(func=command_prepare)

    accept = subparsers.add_parser("accept", help="Accept a safe direct fork")
    accept.add_argument("--session-id")
    accept.add_argument("--transcript-path")
    accept.set_defaults(func=command_accept)

    reconcile = subparsers.add_parser(
        "reconcile", help="Explicitly make the current thread canonical after review"
    )
    reconcile.add_argument("--adopt-current", action="store_true", required=True)
    reconcile.add_argument("--session-id")
    reconcile.set_defaults(func=command_reconcile)

    recover = subparsers.add_parser(
        "recover-turn", help="Clear a stranded active-turn marker"
    )
    recover.add_argument("--session-id")
    recover.set_defaults(func=command_recover_turn)

    resume = subparsers.add_parser("resume", help="Resume the canonical thread")
    resume.add_argument("--print", dest="print_only", action="store_true")
    resume.add_argument("--allow-active", action="store_true", help=argparse.SUPPRESS)
    resume.add_argument("--prompt")
    resume.set_defaults(func=command_resume)

    hook = subparsers.add_parser("hook", help="Internal lifecycle-hook entry point")
    hook.set_defaults(func=command_hook)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except HandoffError as exc:
        print(f"handoff error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
