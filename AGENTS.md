# Project Constraints

- League games must materially contribute to ratings. Keep league update impact at least `1.0x`; do not add hidden league `mu` or `sigma` dampeners below `1.0`.
- After every change touching ratings, rating display, league handling, Season Ranking, Trend, or Game History, run a consistency pass across Season Ranking, Trend, and Game History. Verify they use the same rating options, league inclusion rules, team-size filtering, rolling-window game set, and visible rating/rank/game-count transform for sampled players.
- After every interface/UI change, start or continue a local server and report the exact server URL in chat so the user can open the app and audit the change.
- The user-approved Season Ranking missing-game display penalty is tiered: `10` points per missing game below 10 games, `5` points per missing game from 10 through 50 games, and `1` point per missing game above 50 games when the player's pre-volume display rating is at least 1500. Do not tune or change these tiers for accuracy experiments unless the user explicitly asks for a penalty change.
- At the start of a new day, refresh from the Google Drive stats source before running analysis or sweeps. If the Google Drive database is newer than `default_database`, update `default_database` from that source so local experiments do not use stale game data.

## Codex Thread Handoff

- Before modifying files, read `AGENTS.md`, read the newest authoritative snapshot in `HANDOFF.md`, run `pwd`, run `git status --short --branch`, and run `./scripts/codex-handoff status` when the handoff tool exists. Report any discrepancy between Git and `HANDOFF.md` before editing.
- Follow `docs/CODEX_THREAD_HANDOFF.md` for phone/CLI switching. The gitignored `.codex-handoff.local.json` file is a local thread lease, not project memory and not a replacement for `HANDOFF.md`.
- Once the hooks are trusted and the lease is initialized, only the thread reported as `canonical` by `./scripts/codex-handoff status` may modify files, commit, or push in this worktree. During the one-time setup/review before hook trust, the setup thread may add and verify these repository-local files without creating a lease. If the lease is uninitialized after trust, the first hooked user prompt adopts its thread as canonical.
- If the user says `Prepare phone handoff`, finish the current operation, ensure no file-writing command or background process remains active, update `HANDOFF.md` when durable project state changed, and run `./scripts/codex-handoff prepare phone` as the final command.
- If the user says `Prepare Mac handoff`, perform the same checks and run `./scripts/codex-handoff prepare mac` as the final command.
- If the user says `Handoff status`, run `./scripts/codex-handoff status` and report the canonical thread, current relation, snapshot state, and exact next action.
- If the user says `Accept handoff`, follow the safe direct-fork or explicit reconciliation path. That phrase is not approval for an application change or Git operation.
- If the user says `pick up`, `pick up from phone`, `reconcile phone work`, or equivalent, run handoff status before normal startup. A stale thread must stop and direct the user to `./scripts/codex-handoff resume`; it must not reconcile repository files itself.
- A direct child fork may become canonical automatically on its first prompt only when no other turn is active and the recorded branch, HEAD, full working-tree status, and `HANDOFF.md` hash still match. Drift requires the documented read-only reconciliation checkpoint.
- Never infer phone versus Mac from session metadata. Explicit preparation records the target; direct-parent ancestry only establishes whether an automatic fork claim is eligible.
- Thread handoff commands never stage, commit, push, merge, reset, restore, or otherwise change application files. There is no timed lease expiry.
- Project hooks are defense in depth, not a complete security boundary. These repository instructions and startup checks remain mandatory after the hooks are trusted.

## Game-Day Fun Facts

- When the user asks for game-day or latest-game fun facts, follow `docs/FUN_FACTS_PROTOCOL.md`.
- Use the greatest valid recorded game date rather than assuming the calendar date, compare only against games before that focus date, and publish exactly ten verified, positive, text-ready facts when the data supports them.
- Maximize meaningful recognition across the people who played that day without using filler, contrived records, awkward name lists, or negative facts.
- Fun-facts publication requires a successful direct Google Drive refresh with freshness evidence no more than two calendar days old. Never generate or publish from cache or `default_database`; report the unavailable or stale source instead.
- The fun-facts request authorizes the protocol's fresh stats read and dated Google Doc create/update. It does not authorize application changes, Git writes beyond a required local database refresh, Drive sharing changes, or publication elsewhere.
