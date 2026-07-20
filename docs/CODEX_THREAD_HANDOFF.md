# Codex Phone and CLI Thread Handoff

This repository uses one canonical, write-capable Codex thread per local Git worktree. The mechanism is designed for leaving CLI threads open on the Mac, allowing the phone client to create automatic forks, and returning to the correct thread without relying on the normal resume picker.

It coordinates threads that use the same Mac worktree through Codex remote control. It does not synchronize two different clones or computers, merge Git changes, or replace the durable project handoff in `HANDOFF.md`.

## Components

- `scripts/codex-handoff`: operator command.
- `scripts/codex_handoff.py`: standard-library state machine and hook handler.
- `.codex/hooks.json`: lifecycle hooks for session start, prompt submission, edit-tool checks, and turn stop.
- `.codex-handoff.local.json`: gitignored local lease and worktree fingerprint.
- `.codex-handoff.local.lock`: gitignored process lock.
- `.codex-handoff.local.tmp`: gitignored atomic-write temporary file.

The local state contains thread IDs, direct-fork lineage, generation, explicit target, active-turn status, branch/HEAD/status fingerprints, and a hash of `HANDOFF.md`. It does not store prompts, prose, comments, reader codes, tokens, or other repository content.

During this one-time setup and review, the state may remain uninitialized. Do not run `/hooks` until the implementation and verification have been reviewed. After trust, the first hooked user prompt adopts that thread as canonical.

## One-Time Setup

Project hooks run only after the repository and the exact hook definitions are trusted.

1. Start or resume Codex in this repository.
2. Run `/hooks` in the Codex CLI.
3. Review and trust the hooks from `.codex/hooks.json`.
4. Resume or restart the thread so `SessionStart` runs with the trusted hooks.
5. Check the lease:

```sh
./scripts/codex-handoff status
```

The hooks are deterministic guardrails, but current Codex hook coverage does not intercept every possible tool path. `AGENTS.md` and the startup check remain required.

## Mac to Phone

Tell the current canonical thread:

```text
Prepare phone handoff
```

Codex must finish the current operation, ensure no writing command or background process is active, update durable project state if needed, and run this last:

```sh
./scripts/codex-handoff prepare phone
```

Then open that conversation through remote control on the phone and send the next command. If the phone client creates a direct fork, the first prompt claims the lease only when:

- its parent is the canonical thread
- the canonical thread has no active turn
- branch, HEAD, working-tree status, and `HANDOFF.md` still match the recorded snapshot

The Mac thread may remain open. After the phone fork claims the lease, a later prompt in that old thread is blocked and reports the new canonical thread ID.

## Phone to Mac

Tell the canonical phone thread:

```text
Prepare Mac handoff
```

After it finishes, use a normal Mac terminal, not the stale Codex prompt:

```sh
cd /Users/dustinrowland/Projects/Volleyball
./scripts/codex-handoff resume
```

The wrapper resolves the canonical ID and runs `codex resume --all --include-non-interactive -C <repo> <thread-id>`. This avoids the filtering that can make the ordinary resume picker appear empty.

## Switching Without Preparation

A direct phone fork can still claim the lease on its first prompt when the last completed canonical-turn snapshot matches and no turn is active. This supports the phone client's automatic-fork behavior when the explicit prepare step was forgotten.

Preparation remains preferable because it records intent and catches an unfinished turn before the switch.

The old CLI does not receive an asynchronous message while idle. Its next submitted prompt runs the hook, sees that the lease moved, blocks the prompt, and prints the canonical ID and resume command. This is the reliable notification boundary available to separate Codex threads.

## Status and Natural Commands

Use:

```sh
./scripts/codex-handoff status
```

The result includes the canonical ID, current relation, generation, prepared target, active turn, snapshot match, and exact resume command.

These author phrases have durable meanings:

- `Prepare phone handoff`: prepare the current canonical thread for a direct phone fork.
- `Prepare Mac handoff`: prepare the canonical phone thread for CLI resume.
- `Handoff status`: report the lease without changing it.
- `Accept handoff`: accept a direct child only under the documented safety checks; it is not approval for any application or Git change.
- `Pick up from phone`: check the lease first, then resume or reconcile before application work.

## Drift and Recovery

If the worktree changes after the recorded stop, an automatic fork is blocked. Sending the exact prompt `Accept handoff` from that direct fork enters read-only reconciliation mode. The thread must run the repository startup comparison, report discrepancies, and wait before editing.

After the author confirms which live state should be retained, the canonical reconciliation thread may run:

```sh
./scripts/codex-handoff reconcile --adopt-current
```

This command changes only the local lease and fingerprint. It does not reset, restore, stage, commit, or push files.

If Codex was interrupted and the `Stop` hook could not clear its active-turn marker, first confirm that no response, tool call, or background write is still running. Then, from the canonical thread, run:

```sh
./scripts/codex-handoff recover-turn
```

For an exceptional case where neither the canonical thread nor a direct child can be resumed, inspect Git and `HANDOFF.md`, choose the thread deliberately, and use the explicit reconciliation command in that thread. There is no timed lease expiry.

## Existing Threads in This Repository

Paste this into any already-open CLI thread after this workflow is committed and hooks are trusted:

```text
Reload this repository's coordination rules before doing more work. Read AGENTS.md and docs/CODEX_THREAD_HANDOFF.md, then run `./scripts/codex-handoff status`. Do not edit, commit, or push unless the script reports that this thread is canonical. If it is stale, report the canonical thread ID and stop so I can run `./scripts/codex-handoff resume` from a normal terminal. If it is canonical, follow the full AGENTS.md startup procedure and continue from HANDOFF.md.
```

## Bootstrap Prompt for Another Repository

Paste this into a CLI thread for another local repository to give that repository the same coordination model:

```text
Set up a repository-local Codex phone/CLI thread handoff workflow. First read this repository's AGENTS.md and current state and report any dirty-tree discrepancy. Use the implementation in `/Users/dustinrowland/Projects/Volleyball/scripts/codex_handoff.py`, `/Users/dustinrowland/Projects/Volleyball/scripts/codex-handoff`, and `/Users/dustinrowland/Projects/Volleyball/.codex/hooks.json` as the tested reference, but copy/adapt the files into this repository so it has no runtime dependency on the book repo. Add gitignored local lease/lock files; one canonical write-capable thread per worktree; explicit `prepare phone`, `prepare mac`, `status`, `resume`, direct-fork reconciliation, active-turn and worktree-snapshot guards; stale-thread edit blocking; no timed expiry; no prompt/content/secret storage; and no automatic stage/commit/push. Add repository instructions and tests appropriate to this repo. Preserve all unrelated changes, do not push, and show me the implementation and verification before asking me to trust the project hooks with `/hooks`.
```

If the other repository has stricter rules, those rules win. The setup thread must adapt the reference rather than overwrite existing `AGENTS.md`, hook configuration, or workflow conventions.

## Limits

- Codex does not expose trustworthy phone-versus-computer identity in the session metadata used here. Explicit prepare targets and direct fork ancestry are used instead.
- Transcript parsing is used only for best-effort direct-parent detection because the hook payload does not currently provide `forked_from_id` directly.
- The hook is a coordination guardrail, not an access-control or security boundary.
- A handoff does not make uncommitted work durable across clones or machines. Normal Git and repository checkpoint rules still apply.
