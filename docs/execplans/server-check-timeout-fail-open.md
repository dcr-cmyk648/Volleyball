# Server Check Timeout and Balancer Fail-Open

## Goal

Stop a slow or unavailable stats server from leaving the app in a permanent
"Checking server for updates" state, and guarantee that team assignment remains
usable with the device's local data when live verification cannot finish.

## Requirements

- Bound every live Google stats request used by the Play and Stats pages.
- Preserve the four-hour Play-action check cache and the existing behavior that
  blocks registration and balancing when a completed check proves local data is
  stale.
- If a Play-page verification request is unavailable or does not finish within
  a short interaction deadline, allow team balancing to continue with the
  already-loaded local data.
- A server failure must produce a settled state and release every busy overlay;
  it must never leave a permanently pending promise or disabled interaction.
- Keep new-player registration protected from known stale data. Do not silently
  register against an unverified server state.
- Preserve existing concise UI copy unless a minimal failure status is needed.
- Bump the service-worker cache generation so phones receive the repair.
- Push the verified scoped change to GitHub `main` for Pages deployment.

## Constraints and Non-goals

- Preserve unrelated dirty changes in `HANDOFF.md`, `default_database`,
  `docs/CODEX_THREAD_HANDOFF.md`, `scripts/codex_handoff.py`, and
  `test/test_codex_handoff.py`.
- Do not change ratings, balancing math, league handling, or scoreboard copy.
- Do not stage or publish unrelated files.
- The Google Apps Script endpoint is currently slow but still responds; this
  change must tolerate both slow success and a true hang.

## Relevant Repository State

- Branch `mac-beta`; `HEAD` and `origin/main` began at
  `1f40040e70917e44ff7b8fbf53a6378db30724f1`.
- Canonical handoff generation 1 belongs to the current root thread and matched
  the working-tree snapshot at startup.
- The newest Drive source is still `vballstats_2026-08-28.json` (76 players,
  347 games through 2026-08-27), matching local `default_database`.
- A cache-busted direct endpoint request returned HTTP 200 but took about 33.2
  seconds to first byte, reproducing the perceived hang.
- `index.html` and `stats.html` currently use unbounded `fetch()` calls. The Play
  action gate awaits its shared in-flight check under a modal busy overlay.

## Decisions

- Give the network request a finite hard timeout so all server-check paths
  settle and their existing `finally` cleanup executes.
- Give interactive team assignment a much shorter wait budget than the hard
  network timeout. On that deadline only balancing fails open; the underlying
  shared check may finish and refresh the four-hour cache for later actions.
- A completed response showing server changes remains authoritative and opens
  the existing sync-required dialog before balancing.
- Registration retains the existing full verification path, but the network
  hard timeout prevents a permanent spinner.

## Milestones

1. Implement bounded endpoint requests and the balancing-only fail-open gate.
2. Add deterministic browser regressions for a never-resolving server and
   preserve existing stale/ready behavior.
3. Run focused and full validation, audit locally, and publish only the scoped
   files to `main`.

## Acceptance Criteria

- A never-resolving live endpoint cannot keep a Play or Stats busy overlay open
  past its configured deadline.
- Team assignment succeeds from local data within the short interaction budget
  when the live endpoint hangs.
- A promptly completed stale response still blocks balancing and registration
  until synchronization.
- Existing four-hour caching behavior still passes.
- Full automated tests and `git diff --check` pass.
- A local audit URL is reported, only scoped files are committed, and GitHub
  Pages deploys the pushed `main` revision successfully.

## Validation Ladder

1. Focused browser regression with a deliberately unresolved endpoint.
2. Existing Play safety/throttle browser scenarios.
3. Full Node suite and handoff suite.
4. Complete browser smoke plus local mobile-width audit.
5. Verify GitHub `main`, Pages workflow success, and production asset revision.

## Progress

- [x] Startup, canonical handoff, dirty-tree discrepancy, Drive freshness, and
  live-endpoint latency checks completed.
- [x] Implementation and focused fail-open regression.
- [x] Node application suite, handoff suite, syntax checks, diff check, and
  local-server verification.
- [x] Final local audit and scoped release checks.
- [x] Scoped release to GitHub `main` and Pages verification.

## Discoveries

- The server currently responds successfully but slowly enough (about 33
  seconds) to make the unbounded busy overlay look frozen.
- The four-hour cache already supports an `unavailable` fail-open state, but an
  unresolved fetch never reaches that state; the missing element is a deadline.
- The accepted implementation uses a 45-second abortable network deadline and
  a balancing-only three-second interaction deadline. Registration still waits
  for a definitive bounded check, while known stale data retains the existing
  sync gate.
- All 44 Node application tests and all 25 handoff tests pass. The broad browser
  smoke reached and passed the new stalled-server assignment regression, then
  stopped at its later pre-existing semantic-correction assertion; an earlier
  run stopped at a different pre-existing advanced-settings assertion, which
  confirms unrelated nondeterminism rather than a failure of the new scenario.
- Both local servers expose cache generation
  `vball-static-v33-server-check-timeout`; the primary audit URL is
  `http://127.0.0.1:5173/index.html`.
- Scoped commit `cd2c18cf8921486c7b823c60887392d00bd49b08` was pushed as a
  clean fast-forward to GitHub `main`. Pages run `33815095273` completed
  successfully, and cache-busted production reads verified the v33 service
  worker plus the 45-second request and three-second balance deadlines.

## Exact Next Action

The repair is implemented, tested, pushed, and verified in production. Preserve
the five unrelated local dirty files for their owning work; no further action is
required for this incident.
