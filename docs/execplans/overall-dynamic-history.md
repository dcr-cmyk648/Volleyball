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

## Follow-up — Mobile Table and League Individual

### User Feedback

- The deployed All-Time Bayesian table is visually broken on mobile: the
  interactive player-name button inherits the global 44px button height, names
  sit on a second line, rows are much taller than Season Ranking, and the Games
  header is ellipsized.
- Use the normal Season Ranking table in the supplied phone screenshot as the
  exact compact-format reference, while retaining name activation for history.
- Replace the misleading pooled-team leaderboard row with the comparable rating
  of one player on a same-sized league opponent.

### Mathematical Decision

- The likelihood already compares team-average skill, so replacing a league
  opponent with `n` identical weighted players would leave its learned mean and
  every prediction unchanged. The inflated-looking row comes from displaying
  the very certain pooled team-average posterior as though it were one player.
- Convert only the synthetic display row from team-average uncertainty to
  individual uncertainty. For each included league game, the assumed opponent
  roster size equals the recorded local roster size. With varying sizes, use
  the harmonic effective size `n_eff = 1 / mean(1 / n)` because an average of
  `n` independent comparable players has variance `individual_variance / n`.
  Therefore `individual_sigma = team_average_sigma * sqrt(n_eff)`; mean skill,
  game likelihood, league weight, and every real-player result remain unchanged.
- The current 99 league games contain three 5-player, 54 6-player, 34 7-player,
  and eight 8-player rosters. `n_eff = 6.4048`, converting the synthetic row
  from 2487/rank 4 to approximately 2155/rank 17 under current display options.
- Label the dynamic Overall synthetic row `League Player`; keep its Games value
  at 99 pooled source matches and keep it noninteractive/non-player-only.
- Apply this as a display interpretation of existing dynamic snapshots so the
  deployed schema-v2 cache does not require a recalculation. Use snapshot game
  fingerprints (and prior fingerprints when available) so stale/new games do
  not silently alter the saved row or rank-movement comparison.

### Follow-up Requirements

- Give the Bayesian table the same constrained scroll wrapper, fixed columns,
  compact mobile padding, non-ellipsized headers, single-line blue bold player
  names, and row height as the normal Season Ranking table.
- Preserve click, Enter/Space activation, history overlay behavior, and visible
  focus. League Player and static Big/Small league rows remain plain text.
- Do not change scoreboard explanatory copy, real-player ratings/ranks, forward
  balancing, Season Ranking, Trend, Game History, or league likelihood impact.
- Add focused unit/browser regression coverage for same-size conversion,
  snapshot scoping, expected current-data result, compact mobile geometry,
  header visibility, row alignment, overlay activation, and static-mode scope.
- Do not stage, commit, push, or deploy without a new explicit publication
  request. Preserve the five unrelated dirty files.

### Follow-up Progress

- [x] Supplied mobile screenshots inspected and root cause identified.
- [x] Current-data same-size individual calculation validated.
- [x] Display conversion, compact table styling, and focused tests.
- [x] Full consistency regression and phone-sized local audit.

### Follow-up Validation

- `npm test`: 43/43 tests passed. The individual conversion tests use fixed,
  constructed rosters rather than the mutable local `default_database`.
- The focused Chrome regression passed at 390px. It verifies compact row
  geometry aligned with Season Ranking, a fully visible Games header, no
  resting underline/border, a visible keyboard focus ring, history overlay
  behavior, a plain noninteractive League Player row, and unchanged static
  Big-Team scope.
- The broad browser smoke reached and passed the default and advanced Season
  Ranking/Trend/Game History alignment assertions. It later stopped at the
  unrelated Play-tab stale-server registration assertion because the UI was
  still in `Checking Google Drive stats...` instead of opening the sync dialog
  within that test's fixed wait. No sync or registration code changed here.
- A current-data audit used all 347 source games and all 99 league games. The
  roster harmonic effective size is `6.404805914972282`; the displayed League
  Player is 2155, rank 17, with 99 pooled source matches. At 390px the audited
  row height is 31px, the interactive real-player name is 14px high and one
  line, Games fits, and the history endpoint exactly matches the current row.
- Visual audit screenshots are
  `/private/tmp/vball-current-mobile-audit.png` and
  `/private/tmp/vball-league-row-mobile-audit.png`.
- JavaScript syntax checks and `git diff --check` passed. The PWA cache version
  is `vball-static-v26-overall-dynamic-history`.

### Follow-up Exact Next Action

The user explicitly authorized publication on August 28, 2026. Commit only the
seven reviewed follow-up implementation, test, cache, and ExecPlan files; keep
the five protected local changes unstaged. Push the resulting `mac-beta` HEAD
to `origin/main`, then verify the GitHub Pages run and production file hashes.

## Follow-up — Mobile Chart Granularity and League Reference

### Goal

Make the dynamic Overall player-history overlay readable and meaningfully
granular on a phone, and add a horizontal reference for the comparable average
league player requested by the user.

### Requirements and Decisions

- Replace the current min/max-only Y labels with rounded rating ticks and subtle
  horizontal grid lines. Labels must render at a legible effective phone size.
- Replace the two endpoint-only date labels with monthly ticks across the
  observed interval, reducing tick density deterministically only if a future
  history becomes too long to fit. Preserve true elapsed-time X positioning.
- Add visible point markers at the modeled monthly player states while keeping
  the existing skill line and posterior-uncertainty band.
- Draw a distinct dashed horizontal line labeled `League avg <rating>`. Its
  value must be the same snapshot-scoped League Player display rating used in
  the dynamic Overall table, and the chart domain must include it even when it
  lies outside the player's confidence band.
- Keep the endpoint exactly equal to the scoreboard row. Preserve overlay
  focus/close semantics, sparse-player handling, and noninteractive league/static
  rows.
- This is display-only. Do not change the dynamic fit, rating transforms,
  league impact, real-player ratings/ranks, balancing, Season Ranking, Trend,
  Game History, or unrelated scoreboard copy.
- Add deterministic browser coverage for tick count/labels, mobile label size,
  grid and point geometry, the league-reference value/label/domain, endpoint
  equality, and existing overlay behavior. Bump the PWA cache generation.
- Preserve the five protected local files. Do not stage, commit, push, or deploy
  without a new explicit publication request.

### Milestones

- [x] Inspect supplied phone screenshot and current SVG implementation.
- [x] Implement the chart scale/ticks/markers/reference and focused regression.
- [x] Run full rating-view consistency checks and a current-data 390px visual
  audit, then present the local URL and screenshot for approval.

### Validation

- `npm test`: 43/43 tests passed. The focused fixed-fixture Chrome regression
  also passed, including granular scales, compact month labels, non-overlap,
  modeled-state markers, the snapshot-scoped league reference, sparse history,
  endpoint equality, keyboard/dialog behavior, mobile table geometry, and
  unchanged static Big-Team scope.
- The full browser regression passed in a clean profile. The required default
  consistency sample remained JoeM at 2258 over 55 games in Season Ranking,
  Trend, and Game History. The advanced league-excluded, all-history,
  no-confidence-penalty sample remained 2409 over 49 games in all three views.
- The 390px current-data audit opened DustinR at 2476 and verified an exact 2476
  history endpoint, seven 100-point Y ticks from 2100 through 2700, monthly
  labels from `Apr '26` through `Aug`, five finite monthly markers, no label
  overlap, and 12.18px effective axis text.
- The chart's dashed yellow `League avg 2155` line exactly matches the current
  dynamic League Player row and lies inside the plotted domain. The overlay fit
  the 390x844 viewport, retained Close focus, and emitted no page exceptions.
- Current visual audit: `/private/tmp/vball-current-chart-mobile-audit.png`.
  JavaScript syntax checks and `git diff --check` passed. The PWA cache is v27.

### Exact Next Action

Let the user audit the local chart at the running server, then await explicit
publication approval. Do not stage, commit, push, or deploy this follow-up
before that approval.

## Investigation — Finer Dynamic-State Resolution

### Goal

Evaluate whether the dynamic Overall model should estimate skill more often
than one active calendar-month state per player, and show how credible finer
paths would look before any production decision.

### Scope and Constraints

- Harness-only investigation. Do not change production model, chart, snapshot
  schema, tests, cache, or rating behavior during the sweep.
- Use the already-refreshed 76-player, 347-game local data through 2026-08-27.
  Include every league game at full likelihood impact and retain the single
  learned pooled league-opponent anchor.
- Compare the exact current active-calendar-month baseline against active
  21-day, 14-day, 7-day, and distinct-play-date state grids.
- Keep process smoothing comparable by scaling transition variance with exact
  elapsed time: 10 public rating points of standard deviation per square root
  month. Finer grids must not silently receive a stronger or weaker prior.
- Preserve exact-date interpolation between adjacent states and hold the latest
  trained state constant for future prediction.

### Evaluation

- Run chronological expanding-window validation on nonoverlapping future-date
  blocks. Report paired score-share log loss, winner Brier score/accuracy, test
  game count, and date-clustered uncertainty versus the monthly baseline.
- On full-data fits report state count, optimizer iterations/runtime, current
  uncertainty, path total variation/adjacent movement, rank correlation and
  top-10 overlap versus monthly, and maximum/current rating shifts.
- Confirm the exact monthly harness reproduces the production dynamic snapshot
  within numerical tolerance before trusting comparisons.
- Export resolution paths for every eligible player plus representative default
  players and the League Player reference for an interactive, in-conversation
  comparison. The visualization is outside the repository and contains no
  secrets or network calls.
- Treat negligible held-out differences as ties. Prefer the coarsest resolution
  on a statistical plateau; do not recommend extra states solely because they
  make a more visually active line.

### Progress

- [x] Resolution candidates, fair smoothing rule, and evaluation metrics set.
- [x] Build and validate the harness-only generalized solver.
- [x] Run full-data and chronological holdout sweeps.
- [x] Create and verify the interactive comparison, then report winners,
  losers, tradeoffs, and any recommended follow-up.

### Results

- The generalized monthly harness exactly reproduced the production dynamic
  model across all 347 games, including convergence, ratings, history dates,
  cumulative history game counts, and every history endpoint.
- Four expanding-window folds evaluated 255 future games over 32 held-out play
  dates. Monthly, 21-day, 14-day, 7-day, and distinct-play-date models all had
  identical 57.25% winner accuracy. Their log-loss and Brier-score differences
  were microscopic, and every 2,000-resample date-clustered 95% interval versus
  monthly crossed zero. A seven-day phase shift of the 14-day buckets was also
  tied.
- The apparent best log loss was the play-date grid at 0.692444140 versus
  monthly at 0.692444448, a difference of only 0.000000308 with a 95% interval
  of approximately -0.000001403 to +0.000001107. Its Brier score was
  directionally worse by 0.000000402, also an indistinguishable tie.
- Full-data state counts grew from 175 monthly states to 222 at 21 days, 270 at
  14 days, 389 at 7 days, and 639 by play date. The play-date fit took about
  1.07 seconds in the recorded run versus 73 ms monthly. Runtime is warmup- and
  machine-sensitive, but the extra state complexity is real.
- Every finer grid preserved all ten monthly top-10 players, had Spearman rank
  correlation at least 0.99994, and changed any current conservative rating by
  less than 0.024 public points. League Player stayed between 2154.5 and 2154.6.
- Finer graphs visibly add intermediate knots, but the underlying modeled
  conservative skill paths barely change: the largest adjacent movement in any
  full-data grid was under 1.7 public points. Most of the visible early rise in
  the scoreboard graph comes from evaluating the existing confidence and
  missing-game penalties at more cumulative-game checkpoints, not from newly
  detected skill movement.
- Deterministic reruns passed for monthly and the apparent play-date winner.
  The scratch artifacts are
  `/private/tmp/vball-overall-resolution-sweep.mjs` and
  `/private/tmp/vball-overall-resolution-sweep-results.json`. The verified
  task-owned comparison is
  `/Users/dustinrowland/.codex/visualizations/2026/07/16/019f6c8b-f3ed-7a50-aacd-9bbe8c902efd/overall-resolution-sweep.html`;
  it passed 736px and 360px light/dark rendering, tooltip, series-toggle,
  12px-label, no-overflow, and no-console-error checks.

### Exact Next Action

Make no production resolution change. Monthly is the coarsest member of the
statistical plateau and therefore remains the justified default. If the user
wants a more responsive underlying skill line rather than merely more plotted
checkpoints, the next informative harness test is a blocked-validation sweep of
the process-noise/smoothing magnitude, optionally crossed with monthly and
14-day grids. No publication is in scope.

## Implementation — Weekly Overall States and Deployment

### User Decision

On August 28, 2026 the user explicitly chose the tested weekly resolution and
authorized deployment. This product preference overrides the investigation's
parsimony recommendation. The selected variant is the exact 7-day candidate
from the verified sweep, not a new or retuned model.

### Requirements and Decisions

- Change only Bayesian Overall's dynamic player-state grid from active calendar
  months to active anchored 7-day buckets. Use the tested Monday UTC anchor
  2000-01-03; a player gets a state only for a bucket in which they appear.
- Preserve the tested smoothing equivalence: transition variance is the current
  10-public-point monthly Brownian variance multiplied by exact elapsed days
  divided by 365.2425 / 12. Do not give weekly states a stronger or weaker
  effective time prior.
- Keep exact-date interpolation between adjacent active states and hold the
  latest trained state constant thereafter. History cumulative games include
  all games whose weekly bucket is at or before the history knot's bucket.
- Preserve all league games at 1.0 likelihood impact, the stable pooled league
  opponent, bridge/reference cohort, score likelihood, affine reference shift,
  confidence and missing-game display transforms, League Player interpretation,
  filters, and all balancing/Season Ranking/Trend/Game History behavior.
- Invalidate persisted monthly Overall snapshots with a new weekly model/storage
  identity while retaining the existing snapshot shape when practical. Never
  reinterpret a monthly snapshot as weekly.
- Keep the concise scoreboard text unchanged. Do not add a resolution label,
  explanation, or other UI copy.
- Retain the pending mobile chart/table improvements. Weekly current-data
  history should expose the expected denser knots without changing the endpoint,
  league reference, accessibility, or mobile layout.
- Add deterministic model and browser regressions for the Monday anchor,
  elapsed-day transition scaling, bucket assignment/interpolation, cumulative
  games, sparse players, cache invalidation, weekly marker count, and unchanged
  endpoint/league/static-mode behavior.
- Bump the PWA cache generation, run the complete validation ladder and required
  Season Ranking/Trend/Game History consistency pass, then commit only the
  reviewed Overall/chart implementation, tests, cache, and this ExecPlan.
  Preserve the five protected dirty files. Push the accepted commit to
  origin/main, verify GitHub Pages, and verify production file hashes.

### Acceptance Criteria

- The current 76-player / 347-game database produces the verified weekly model
  topology (389 player states plus the pooled opponent) and includes all 99
  league games.
- Current real-player ratings remain within the sweep's verified weekly-versus-
  monthly tolerance, the top 10 is unchanged, League Player remains about 2155,
  and each graph endpoint exactly equals its table row under active options.
- DustinR's current history has 20 weekly knots/markers rather than five monthly
  knots while keeping readable monthly axis ticks and League avg 2155.
- All focused and full tests pass, the cross-view consistency sample is aligned,
  local phone audit is clean, and the deployed GitHub Pages revision matches the
  reviewed commit.

### Progress

- [x] Weekly candidate selected from the completed harness sweep.
- [x] Implement weekly model/storage identity and deterministic regressions.
- [x] Integrate weekly history with the pending mobile chart/table changes.
- [x] Run full validation and local phone audit.
- [ ] Commit scoped files, push to origin/main, and verify deployment.

### Validation

- `npm test`: 44/44 tests passed, including the exact Monday anchor,
  weekly-bucket assignment, elapsed-day Brownian transition variance,
  interpolation, cumulative game counts, and monthly-snapshot rejection.
- The focused 390px Chrome regression passed with the independently derived
  weekly bucket count equal to both saved history knots and rendered markers.
  Endpoint equality, monthly axis labels, League avg reference, compact table,
  accessibility, sparse history, and static Big-Team isolation remained intact.
- The broad browser regression passed in a clean isolated profile. The required
  Season Ranking / Trend / Game History sample remained aligned for JoeM at
  2258 over 55 games by default and 2409 over 49 games with league games hidden,
  the rolling window removed, and confidence penalties removed.
- The current-data audit used all 347 games and all 99 league games. It produced
  389 player weekly states plus the pooled opponent, 20 DustinR history knots,
  exact history/table endpoints, unchanged monthly-sweep top-10 membership,
  and a displayed League Player rating of 2155.
- JavaScript syntax checks and `git diff --check` passed. The healthy local
  audit server remains `http://127.0.0.1:5173/`.

### Exact Next Action

Commit only the seven reviewed Overall implementation, chart/table, test,
cache, and ExecPlan files while leaving the five protected local changes
unstaged. Push that commit to `origin/main`, verify the GitHub Pages workflow,
and compare the deployed production files with the reviewed commit.
