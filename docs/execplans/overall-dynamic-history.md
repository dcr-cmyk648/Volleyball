# Overall Dynamic Rating and Skill History

## Goal

Replace only the Bayesian Overall scoreboard's single-value player model with a
time-varying Bayesian model measured against one stable pooled league opponent.
Keep the scoreboard compact, include the pooled league team as a ranked row,
and open a player's absolute-skill history graph when their name is activated.

## Requirements

- Use every valid league game, across every recorded court type, tier, and
  league label. League observations retain the same base likelihood/update
  impact as internal games; no hidden league downweight is allowed.
- Model one time-invariant pooled league opponent and time-varying player skill.
  Use the validated all-league formulation: monthly piecewise-linear player
  states, a stable training-data-only bridge/reference cohort, a 10-effective-
  point score likelihood, a 10-display-point monthly process prior, and a
  conservatively selected league-date variation term. Do not force positive
  improvement or assume a Rec/Intermediate gap.
- Preserve the current Overall scoreboard's visible rating scale, uncertainty /
  confidence-penalty behavior, ranking behavior, game-count semantics, filters,
  and concise copy unless a change is strictly required by the requested graph
  or league-team row.
- The pooled league team appears in Overall with its learned stable rating and
  league-game count. It is not a selectable real player and must not enter team
  balancing, registration, attendance, or player-only filters.
- Overall rows remain compact. Activating a real player's name opens an
  accessible overlay containing that player's rating history over time and an
  uncertainty band. The latest plotted display value must agree with the row's
  displayed rating under the active Overall options. The league row may show a
  flat history if it is made interactive, but this is not required.
- Do not change production team balancing, Season Ranking behavior, Trend,
  Game History, score-volume penalty tiers, or scoreboard explanatory copy.
- Do not stage, commit, push, or deploy.

## Constraints and Non-goals

- Preserve unrelated dirty changes in `HANDOFF.md`, `default_database`,
  `docs/CODEX_THREAD_HANDOFF.md`, `scripts/codex_handoff.py`, and
  `test/test_codex_handoff.py`.
- Keep browser computation responsive for the current 76-player / 347-game
  database and reasonable future growth. Cache a model result by the effective
  game set and rating options rather than refitting for every row interaction.
- Do not add a slope column, graph button column, long explanation, or new
  balancing signal.
- This implementation is for Overall display only; it must not become a forward
  balancing input.

## Relevant Repository State

- Branch: `mac-beta`, ahead of `origin/mac-beta`; canonical handoff generation
  1 belongs to thread `019f6c8b-f3ed-7a50-aacd-9bbe8c902efd`.
- Fresh local data source: `vballstats_2026-08-28.json`, 76 players, 347 total
  games, 344 valid scored games, 99 league games through 2026-08-27.
- Harness evidence is in temporary artifacts beginning with
  `/private/tmp/overall-all-league-`; the all-league dynamic model was
  predictively equivalent to matched static scoring.
- `HANDOFF.md` is stale relative to the three existing dirty handoff
  implementation/test files. Those files are unrelated and must be preserved.

## Decisions

- The stable league opponent is the philosophical background reference. Its
  display location must be parameterized on the existing Overall rating scale,
  not hard-coded as a misleading constant row.
- Rec, Intermediate, indoor, sand, generic, and one-day league games are pooled
  into this one background opponent for Overall.
- Historical central values use the same visible display transform as the
  current row so the graph endpoint and row agree. Posterior uncertainty is
  shown visually rather than as extra scoreboard text.
- Prefer an SVG or canvas implementation already compatible with the app; add
  no heavy chart dependency.
- Implement a dedicated browser-safe `overall-dynamic-ratings.js` module used
  only by Overall. Big and Small retain the existing static
  `bayesian-ratings.js` behavior and schema-v1 snapshots.
- Give Overall a separate schema-v2 persistence key and invalidate/recalculate
  old Overall v1 snapshots rather than interpreting them as history-capable.
- Reuse the existing ES-module worker architecture. Do not embed the solver or
  regress to `importScripts`.
- Fit with the validated fixed pooled-opponent convention, then apply one
  prediction-invariant affine shift so the latest stable reference-cohort mean
  remains on the existing 1500 display center. Apply the same shift to every
  player history state and to the time-invariant league opponent; this makes the
  league row a learned relative rating rather than a hard-coded 1500.
- Keep the existing posterior display transform (`mu`, `sigma`, and
  `ordinal = mu - 3*sigma`) and confidence-toggle path. History exposes both the
  central estimate/uncertainty and the option-consistent display value.

## Milestones

1. Discover the current Overall calculation/rendering path and define the
   production-safe dynamic model API and cache boundary.
2. Implement the all-league dynamic model, pooled league row, and deterministic
   current/history outputs with uncertainty.
3. Implement the name-activated accessible overlay without changing scoreboard
   explanatory copy.
4. Add focused model/UI regressions and update the broader browser test where
   needed.
5. Run focused checks, the full suite, the required Season Ranking / Trend /
   Game History consistency pass, and local browser audit.

## Acceptance Criteria

- All 99 current league games are included in the Overall model, with no court
  type or league-label exclusion and no league weight below internal weight.
- Overall contains one pooled league-team row with a stable learned rating and
  the correct league-game count; it never appears in balancing or registration.
- Real-player Overall ratings use the latest dynamic state. Existing active
  filters/options still work, and low-volume confidence behavior is preserved.
- A player-name activation opens a usable history graph; closing works by its
  control, backdrop, and Escape. Keyboard activation and dialog semantics work.
- The graph is finite and ordered for sparse/new players, shows uncertainty,
  and its latest visible rating equals the row rating.
- Synthetic regression: a player/team improving against a stable league
  background gets an upward history; a static dataset remains effectively flat.
- Existing balancing outputs are unchanged for a fixed fixture.
- Season Ranking, Trend, and Game History remain mutually consistent under
  sampled default and advanced settings, including league inclusion, team-size,
  rolling-window, and visible rating/rank/game-count transforms.
- Full automated tests pass, `git diff --check` passes, and a local audit URL is
  provided. No commit or push occurs.

## Validation Ladder

1. Syntax/unit checks for the dynamic rating module or embedded implementation.
2. Focused deterministic model fixtures and league-row assertions.
3. Focused browser interaction test for name tap, overlay, graph endpoint,
   accessibility, and close paths.
4. Existing full test suite.
5. Required cross-view consistency pass and local browser smoke/audit.

## Progress

- [x] Fresh-data and harness validation complete.
- [x] User approved switching Overall because dynamic and static were equivalent.
- [x] Discovery and production architecture decision.
- [x] Dynamic module, schema-v2 worker integration, and league row.
- [x] Focused dynamic-model regression coverage.
- [x] Name-activated history overlay and focused browser coverage.
- [x] Full integration verification and local audit.

## Discoveries

- The authoritative all-league audit contains 99 league games across 23 dates:
  16 indoor generic league games and 83 sand/identified league games, with
  five- through eight-player recorded rosters.
- Wide league-date variation did not beat zero/modest variation. The production
  implementation should remain conservative and must not imply a detected
  positive trend.
- Overall currently uses a module worker around static BFGS and schema-v1
  snapshots. A dedicated analytic Newton/Hessian module avoids rewriting the
  static Big/Small consumers and permits history covariance without a finite-
  difference Hessian.
- The accepted current-data fit uses 176 dimensions, includes all 99 league
  games, converges in about 207 ms, and selects 30 bridge-cohort players using
  the `appearances>=8-span>=45` rule. The learned pooled row currently displays
  2487 over 99 games.
- The process prior is 10 public points per month (0.024 latent), applies only
  between monthly states, and each player receives a zero prior only at their
  first state. Every history knot and the pooled opponent use an actual Hessian
  marginal rather than a placeholder variance.
- The focused dynamic/static rating suites pass 32/32, including all-context
  league pooling, deterministic improvement/static fixtures, endpoint equality,
  sparse players, bridge fallback/order invariance, uncertainty, schema
  rejection, and unchanged static Bayesian behavior.
- The accepted overlay is scoped to real-player names in dynamic All Games.
  Its SVG uses true elapsed-time x positions, current display transforms and
  cumulative game counts, a posterior-uncertainty band, and an endpoint equal to
  the row rating. League Team and static Big/Small rows remain noninteractive.
- The focused Chrome regression passes real Enter activation, Tab/Shift+Tab
  containment, focus return, button/backdrop/Escape closure, dialog semantics,
  finite line/band geometry, elapsed-time spacing, sparse history, static-mode
  scoping, and League Team isolation.
- The complete Node application suite passes 41/41. The broad browser regression
  also passes after migrating its composite expectation to schema v2 while
  preserving static Big/Small assertions.
- The required default and advanced consistency pass remains aligned for JoeM:
  Season Ranking, Trend, and Game History show 2258 over 55 games by default;
  with league games hidden and confidence penalties removed they show 2409 over
  49 games.
- The final current-data audit fits 76 players and all 347 games (344 scored,
  three winner-only, zero skipped), includes all 99 league games, produces 175
  finite history knots with exact row endpoints, converges in 272 ms, and shows
  League Team at 2487 over 99 games.
- A 390px-wide Chrome audit opened MattA's history with a 2659 row/endpoint,
  finite five-knot line and ten-point band, correct dialog focus, no page
  exceptions, and a clean phone layout. The healthy audit server is
  `http://127.0.0.1:5173/`.

## Exact Next Action

Implementation and verification are complete. On 2026-08-28 the user explicitly
authorized publishing this verified version to GitHub `main`. Release scope is
limited to the dynamic Overall implementation, its tests, this plan, and the
required PWA cache-generation update; protected unrelated dirty files remain
local. Git history and the GitHub Pages workflow are the source of truth for the
resulting publication status.

## Release Preflight

- Remote `main` still matched the verified local base commit `2acad77` before
  release, so the scoped publication is a clean fast-forward.
- The PWA cache generation is bumped to
  `vball-static-v25-overall-dynamic-history`, and the new dynamic module is part
  of the offline app shell so phones cannot remain on the previous scoreboard.
