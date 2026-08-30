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
- [x] Commit scoped files, push to origin/main, and verify deployment.

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

The weekly Overall release is deployed. Let the user audit the production and
local URLs; make no further rating or chart changes without new feedback.

### Release Result

- Scoped commit `918037967cfe10c929ef5e0232ece0116ac90fc8` was pushed to
  `origin/main`; the five protected local files remained unstaged.
- GitHub Pages run `33199720521` completed successfully.
- Production `stats.html`, `overall-dynamic-ratings.js`, and `sw.js` matched the
  reviewed local files byte-for-byte by SHA-256. The live model/storage identity
  is `overall-dynamic-weekly-v3` / `gameDayBayesianScoreboardSnapshotV3:composite`,
  and the live PWA cache generation is `vball-static-v28-overall-dynamic-history`.

## Investigation — Dynamic Smoothing and Shared Improvement

### Goal

Determine why the deployed weekly Overall paths are effectively flat and test
whether a better-calibrated process prior or a shared, league-anchored group
trend can produce defensible absolute-skill histories. This is harness-only:
do not modify, stage, commit, push, or deploy application code.

### Current Evidence

- The refreshed August 28 source has 76 players and 347 games through August
  27, including all 99 league games at full likelihood impact.
- Over the latest ten weeks, all 27 players with at least four weekly states
  have under one public point of fitted central-skill range. The median is 0.18
  points and the maximum is 0.82; AlexaY moves only 0.064 points over eight
  weekly states despite growing from 51 to 140 cumulative games.
- A preliminary full-data sensitivity check shows median ten-week central
  ranges of 0.18, 0.71, 2.75, 10.41, and 33.29 points at monthly process SDs of
  10, 20, 40, 80, and 160. These are descriptive fits, not sufficient for
  choosing a model.

### Requirements and Model Candidates

- Reproduce the exact deployed Monday-anchored weekly model before trusting
  comparisons. Preserve the 10-effective-point score-share likelihood, exact
  elapsed-day Brownian scaling, stable pooled league opponent, full league
  weight, current affine reference convention, and hold-last prediction.
- Evaluate independent player random walks at monthly public process SDs 10
  (current), 20, 40, 60, 80, 100, 120, and 160.
- Evaluate a hierarchical shared-trend formulation in which each player's
  change is centered on a common weekly cohort change learned relative to the
  stable league opponent, with a separate smaller player-deviation process.
  Sweep group movement SDs 20, 40, 60, 80, 100, and 120 against individual
  deviation SDs 5, 10, 20, and 40. Anchor the first group state and preserve
  identifiable static player and league baselines.
- Shared movement must cancel from same-date local-vs-local comparisons and be
  identified materially by league evidence; it must not manufacture a trend
  merely from the changing composition of internal teams.
- Make no monotonic-improvement assumption. The learned shared trend and every
  player path may rise or fall.

### Evaluation

- Use expanding, blocked future-date validation with nonoverlapping play-date
  test blocks. Report score-share log loss, winner Brier score and accuracy for
  all games, league games, and internal games separately.
- Compare each candidate with the current 10-point model using paired
  play-date-clustered uncertainty. Treat differences whose intervals cross zero
  as predictive ties.
- On full-data fits report convergence/runtime, ten-week path ranges, AlexaY
  and representative-player paths, learned group movement, individual residual
  movement, current uncertainty, current-rating shifts, rank correlation,
  top-10 overlap, and League Player rating.
- Explicitly distinguish central skill, conservative ordinal, and the visible
  leaderboard path with confidence/volume penalties. Do not select a model
  because penalties create movement or because a line merely looks active.
- If the broad grid exposes a plausible predictive plateau, run a narrower
  deterministic refinement around its boundary. Report winners, losers,
  tradeoffs, identifiability limitations, and recommended follow-up without
  changing production.

### Acceptance Criteria

- Exact current-model equivalence is proven numerically on the 347-game source.
- Every candidate includes all 99 league games at 1.0 weight and produces
  finite deterministic fits and predictions.
- The shared trend is explicitly anchored and its internal-game cancellation is
  regression-tested.
- Recommendations are based on held-out evidence plus calibration/path
  diagnostics, with uncertainty and ranking impact stated clearly.
- No application, protected handoff, database, Git, or deployment state changes.

### Progress

- [x] Confirm flatness is in the fitted skill path rather than only rendering.
- [x] Build and validate the exact process-noise/shared-trend harness.
- [x] Run broad blocked-validation and full-data sweeps.
- [x] Refine promising candidates and report conclusions.

### Harness Architecture Decision

- The exact independent 10-point baseline reproduces the deployed weekly model
  with zero numeric difference: 347 observations, 99 league games, 389 player
  states / 390 dimensions, and the same three-iteration converged solution.
- Accept the identified additive shared formulation for the experiment:
  `skill = static player baseline + anchored cohort state + player deviation`.
  The first cohort and per-player deviation states are fixed at zero; static
  player and pooled-league baselines retain proper priors.
- The cohort term has exactly zero coefficient in same-date internal game
  contrasts. Mirrored synthetic league evidence produces equal-and-opposite
  cohort movement, and deterministic/sparse-input checks pass.
- Full-data uncertainty and conservative ratings must use the covariance of the
  complete baseline + group + deviation linear combination, not a sum of
  marginal variances. Evaluate a player's current skill at their last observed
  appearance so an inactive player does not inherit later cohort drift without
  evidence.

### Broad Sweep Results

- Thirty-two candidates completed four expanding-date folds covering 255 held-
  out games. Every fit converged, retained full league weight, produced finite
  endpoints, and passed deterministic repeat checks.
- The current independent 10-point model scores 0.6924443 log loss, 0.2452080
  winner Brier, and 57.25% accuracy. Every broad candidate is statistically tied
  with it by paired play-date bootstrap intervals.
- The apparent all-game log-loss winner is shared group-80 / deviation-5 at
  0.6924413, but its future league log loss is slightly worse than baseline.
  Its negligible player deviations and roughly 52-point common decline improve
  only the internal-game regularization; they are not evidence that the league
  anchor detected group improvement.
- High shared-process candidates are structurally fragile: group-80 moves the
  League Player from 2155 to about 1908 and changes current conservative ratings
  by roughly 59 points RMS / 124 maximum while losing one top-10 member.
- Independent SD 40 retains all ten top players with a 2.32-point median recent
  central range; SD 60 also retains all ten with a 4.95-point range. SD 80 and
  above increasingly alter current ratings/ranks without a predictive gain.
- A modest shared group-20 process produces about an eight-point common decline,
  a six-point median recent path range, top-10 overlap 10/10, and League Player
  near 2119. The broad data still cannot distinguish this from zero shared
  movement.

### Refinement Results

- The refinement evaluated independent monthly process SDs 45 through 75 and
  shared group SDs 5 through 30 crossed with deviation SDs 40, 60, and 80. All
  candidates converged, included all 99 league games at full weight, retained
  finite equal endpoints, and remained predictively tied with the deployed
  10-point model over the same four folds / 255 held-out games.
- Independent SD 45 is the conservative edge of a useful display compromise:
  its recent ten-week central-skill range is 2.91 points median, 9.31 p90, and
  13.30 maximum. It retains all ten baseline top-10 players, leaves League
  Player near 2152, and changes current conservative ratings by 15.83 points
  RMS / 45.67 maximum. AlexaY's full central path range is 2.16 points.
- Independent SD 50 gives slightly more movement (3.54 median, 11.29 p90,
  16.14 maximum; AlexaY 2.67) while retaining the baseline top 10. Current
  conservative-rating shifts grow to 19.46 points RMS / 56.23 maximum and
  League Player remains near 2151.
- Independent SD 60 remains the upper conservative boundary with 4.95 median,
  15.62 p90, and 22.34 maximum recent central movement and 10/10 top-10
  overlap, but current-rating shifts reach 27.53 points RMS / 79.72 maximum.
  At SD 65 the top-10 overlap first falls to 9/10, and larger values continue
  increasing rating/rank movement without held-out improvement.
- Every shared candidate's posterior 95% interval for net cohort movement
  includes zero. For group-10 / deviation-60, the fitted net is -2.21 points
  with interval [-43.55, 39.12]; group-20 / deviation-60 is -8.03 with
  interval [-87.00, 70.95]. Leave-one-league-date-out fits are sign-unstable:
  removing the ten August 19 league games flips each tested shared fit from a
  decline to an increase. The shared trend is therefore not identified.
- The apparent shared-model gains do not improve future league-game scoring.
  They arise from alternative regularization of internal games, where the
  shared same-date coefficient is exactly zero, and should not be interpreted
  as evidence of absolute group improvement or decline.
- Central skill, conservative ordinal, and visible leaderboard history remain
  materially different quantities. Large visible early changes are primarily
  confidence and missing-game penalty washout; they are not fitted skill
  movement. A future absolute-skill graph should use central skill for its line
  and show uncertainty separately, while leaving the compact leaderboard row
  on its existing conservative display transform.

### Conclusions and Recommendation

- There is no chart-sampling bug: the deployed 10-point process prior makes the
  weekly central-skill model effectively static. The data do not identify one
  statistically superior process SD; all tested values are on a predictive
  plateau, so selecting more movement is a product/prior choice rather than a
  discovered accuracy gain.
- Reject the shared cohort-trend addition on the current data. It is weakly
  anchored, date-sensitive, does not improve held-out league prediction, and
  can materially distort League Player and current ratings.
- If the goal is the most assumption-minimal statistical model, retain SD 10.
  If the goal is a credible but readable absolute-skill history, independent SD
  45 is the recommended conservative compromise; SD 50 is a reasonable more-
  responsive alternative. Do not exceed SD 60 without accepting larger current
  rating shifts, and SD 65 is the observed rank-stability boundary.
- Even SD 45-50 central paths are small relative to a fixed 100- or 200-point
  chart scale. A production follow-up should therefore pair any approved model
  change with a locally adaptive Y domain and exact-value interaction rather
  than increasing process noise solely to make the line look active.

### Exact Next Action

Report the harness results and await an explicit user decision. Make no
production model, chart, test, Git, or deployment change. If the user chooses a
candidate, first audit central-skill graph behavior at SD 45 and SD 50 with an
adaptive Y scale before implementing either one.

## Investigation — Individualized Back-Explanatory Skill Paths

### User Reframing

- Overall is intentionally not the forward-balancing model. OpenSkill-style
  ratings already own that job and should not be displaced or used as the
  principal selection criterion for this experiment.
- The desired model should explain the complete historical record as coherently
  as possible: different players may improve, decline, flatten, enter at
  different levels, or return differently after long absences.
- Do not impose one linear or nonlinear cohort trajectory on every player.
  Population change may emerge through the network of individualized player
  states and external evidence, but it must not be a mandatory shared slope.
- A 95% change interval containing zero is not a rejection criterion for this
  low-stakes exploratory display. Report posterior change probabilities and
  uncertainty honestly instead of converting them into significance tests.

### Goal

Build and compare harness-only individualized state-space formulations that use
league results, newcomer calibration, and return-gap behavior as distinct
sources of retrospective evidence. Identify which formulation best explains
the observed record without changing production or optimizing for team
balancing.

### Model Architecture

- Represent each player with an individual time-varying latent path. Compare a
  first-order random walk with a smooth changing-slope/local-linear formulation;
  no player is required to share another player's direction or rate of change.
- Keep internal-game observations as team-average player-state contrasts. They
  identify relative contemporaneous ability and connect player histories across
  the participation graph.
- Attach each league observation directly to the contemporaneous states of the
  participating local players. Model the outside side as a partially pooled
  opponent/date latent value around a learned league distribution rather than
  as a perfectly identical opponent on every date. Retain every league game at
  full 1.0 likelihood weight.
- When the data contain usable league/tier/court/opponent labels, test strongly
  pooled offsets rather than assuming meaningful gaps. If opponent identity is
  unavailable, treat league date as the observable external-context unit and
  sweep a conservative opponent-date variance.
- Learn a broad newcomer entry distribution and report each entrant's
  retrospectively smoothed debut level relative to the active pool at entry.
  Entry evidence updates the entrant and entry-prior calibration, not existing
  players through a forced cohort adjustment.
- Give long inactivity gaps their own transition behavior. Compare ordinary
  elapsed-time variance with a gap-specific variance and a hierarchically
  learned mean return effect. A returning player does not inherit changes made
  by active players while absent; their post-return games determine the update.
- Keep the external league benchmark/calibration layer separate from the
  synthetic League Player display transform. Movement of that display row is a
  diagnostic, not a veto criterion for this experimental Overall model.

### Candidate Ladder

1. Exact deployed weekly model and the previously identified independent SD
   45/50 random-walk candidates.
2. Individual changing-slope paths with strongly shrunk initial slopes and
   swept slope-change smoothness.
3. The best individual-path candidates with partially pooled league-date or
   opponent effects.
4. The best anchored candidate with learned newcomer entry calibration.
5. The best anchored candidate with gap-specific return mean/variance, then the
   combined entrant-and-return formulation when both effects are supported.

### Back-Explanatory Evaluation

- Primary: full-record posterior fit and date-blocked retrospective
  reconstruction in which held-out dates are inferred using both earlier and
  later evidence. Report score-share residuals/deviance, winner calibration,
  complexity-adjusted fit where tractable, and separate league/internal
  reconstruction. This is interpolation/backcasting, not forward forecasting.
- Directly test the user's league-calibration question by constructing local
  team ratings without the target league date and measuring whether comparable
  rated teams perform differently against outside opposition over calendar
  time. Use date clusters and report the estimated effect/probability rather
  than requiring conventional significance.
- Report newcomer debut offsets, their relationship with entry date, subsequent
  shrinkage, and sensitivity to the definition of an established newcomer.
- Report pre-gap versus post-return residuals over several gap thresholds,
  learned mean return effects, added gap uncertainty, and whether the effect
  remains after conditioning on league-anchored contemporaneous skill.
- For each player report central path movement, changing-slope behavior,
  posterior probability of improvement over useful recent windows, uncertainty,
  direction changes, and representative histories. Distinguish these from
  conservative ordinal and scoreboard volume/confidence transforms.
- Use synthetic recovery checks for individualized improvement, decline,
  newcomers, return rust, stable players, and variable outside opponents.
  Include deterministic reruns and leave-one-league-date-out robustness.
- Forward held-out prediction remains a secondary overfit sanity check only.
  Do not select a model merely because it resembles the balancing model or wins
  a microscopic future-game metric.

### Constraints and Acceptance

- Use the refreshed Drive-matched August 28 database: 76 players, 347 games
  through August 27, including all 99 league games at full likelihood impact.
- Harness and artifacts live outside production source except for durable
  conclusions recorded in this ExecPlan. Do not change application behavior,
  tests, scoreboard copy, balancing, Git history, or deployment state.
- Preserve all unrelated dirty files. A useful result may be probabilistic and
  exploratory, but it must state which conclusions come from observations and
  which depend materially on priors or identifiability assumptions.

### Progress

- [x] Refresh and verify the authoritative Drive source for the new local day.
- [x] Reframe the architecture and selection criteria around retrospective
  explanation.
- [x] Build the initial individualized explanatory harness and schema inventory.
- [x] Prove exact numeric baseline equivalence and validate the joint
  level/slope derivatives and posterior covariance.
- [x] Run the individualized path-form and league-calibration comparisons.
- [x] Run formal entrant-prior and return-gap component comparisons; the first
  final-grid output measured these only as post-fit diagnostics.
- [x] Refine the best candidates and report conclusions.

### Initial Broad Harness Results

- Scratch artifacts are
  `/private/tmp/vball-individual-explanatory-harness.mjs` and
  `/private/tmp/vball-individual-explanatory-results.json`; the repository and
  production application were not changed.
- The source spans 2026-04-12 through 2026-08-27. Its 99 league games occur on
  23 dates and use five persistent league-context pseudo-opponent IDs: base,
  Rec, Intermediate, Rec sand, and Intermediate sand. These are useful pooled
  contexts but are not verified identities for individual outside teams.
  League-level metadata is blank for 70 games and Intermediate for 29; courts
  are 299 sand, 36 indoor, and 12 grass across all games.
- There are 36 players with at least ten recorded games after their observed
  debut. Inter-appearance gaps number 22 at 28+ days, seven at 42+ days, and
  five at 56+ days. This supports one strongly shrunk 28-day return diagnostic,
  but not a reliable multi-threshold return model.
- Five date-blocked retrospective reconstructions used all 344 scored games.
  RW10 scores 0.692527 score-share log loss / 0.241722 winner Brier. RW45 and
  RW50 improve slightly to 0.692508 / 0.241621 and 0.692504 / 0.241598.
- The initial individualized local-linear candidates use per-player level and
  slope states, strongly shrunk initial slopes, persistent league-context
  effects, and league-date effects at public SD 10 or 35. Context-35 improves
  retrospective log loss to 0.692269 and league-only log loss to 0.687180,
  compared with RW10 at 0.687811. Its overall Brier is worse at 0.241839 and
  internal Brier is worse at 0.245248 versus 0.244178, consistent with a
  back-explanatory-versus-balancing tradeoff rather than a forward advantage.
- Representative context-35 central-skill path ranges are 23.3 points for
  MelissaR, 19.9 for DustinR, 17.3 for JayY, 11.9 for JoshR, and 11.4 for BenT.
  These are fitted central paths, not ordinal or volume/confidence transforms.
- Leave-target-date league residual means still vary materially by date, from
  approximately -0.167 to +0.137 score share. The current output does not yet
  isolate a calibrated same-score calendar effect from league-context noise.
- Deterministic, finite-state, and individualized-decline synthetic checks pass.
  The RW10 structure matches production at 77 rows, 390 dimensions, all 99
  league games, and three Newton iterations, but the harness has not yet proven
  exact affine-shift, marginal-sigma, and history-knot equivalence.
- The local-linear transition also needs analytic/numeric joint
  gradient-Hessian validation and synthetic improvement/stable/entrant/return
  recovery before its uncertainty or apparent fit advantage is decision-grade.
- Refinement found and corrected a missing prior-slope contribution in the
  experimental level-transition gradient/Hessian for
  `level_t - level_(t-1) - dt*slope_(t-1)`. After correction, context-10 scores
  0.692340 retrospective log loss / 0.241284 Brier and context-35 scores
  0.692313 / 0.241238, both better than RW10 at 0.692527 / 0.241722. This
  correction remains provisional until central-finite-difference derivative
  checks and exact production-baseline comparison pass.
- Corrective validation imports and exercises the actual scratch solver. The
  existing exact weekly oracle remains an exact zero-difference RW10 comparison
  on the unchanged source (344 scored, three winner-only, 99 league, 390
  dimensions, three iterations). The actual local-linear gradient differs from
  central differences by at most `9.91e-10`; its Hessian differs by at most
  `1.22e-9`, and current-data covariance solves are finite and positive.
- Actual fitted synthetic cases deterministically recover a stable path,
  `+54.29` improvement, `-54.29` decline, variable outside-context ordering
  without absorbing the whole context shift, and a strong weak-to-strong-to-
  weak direction change at slope SD 35. The 27-week reversal midpoint is about
  215 points above its start and 252 above its end; repeat state difference is
  exactly zero. Validation artifacts are the importable scratch core and the
  v2-v4 validation scripts/results under `/private/tmp/vball-individual-*`.
- Primary review found that the first `vball-individual-explanatory-core.mjs`
  merely re-exported the broad harness, whose top-level body performs a 52-
  second sweep and rewrites its result file on every import. The final repeated
  LOO/newcomer/return study must not run on that side-effectful foundation.
  Split the definitions into a genuinely side-effect-free scratch core and
  rerun the real validation imports before the final grid.
- The isolated final grid compared 27 candidates: independent weekly random
  walks at public process SD 10/45/50 and individual local-linear paths crossed
  over slope SD 20/35/50, league-date SD 0/10/20/35, and persistent league-
  context SD 10/25. Five chronological date blocks were reconstructed from all
  other dates, so this is smoothing/backcasting rather than forward prediction.
- Primary review corrected a reporting bug that had averaged an empty league
  fold as zero for non-finalists and rejected the harness's invalid winner-
  accuracy field. Recomputed game-weighted and equal-nonempty-block rankings
  both select `ll45-s50-d35-c25`. Its game-weighted all-game log loss is
  `0.691853466`, versus `0.692119825` for RW50 and `0.692176900` for deployed-
  structure RW10. The best two local-linear candidates differ by only
  `0.000002492`; the result supports the model family, not precise hyperparameter
  certainty. The deterministic corrected summaries are under
  `/private/tmp/vball-individual-explanatory-final-*`.
- The selected full fit has 807 dimensions and converges in three Newton steps.
  Primary review later found that the scratch path report converted latent
  movement with `x50`, while the actual Overall display chain is
  `x(25/3)x50`. Thus its originally reported `0.848` / `1.679` adjacent-knot
  movement corresponds to about `7.07` / `13.99` displayed rating points. This
  scale correction does not affect likelihoods, candidate ordering, direction,
  or posterior probabilities, but it supersedes the path magnitudes previously
  described as public points.
- The fitted league-date calendar diagnostic has only a `0.512` probability of
  a positive first-to-last effect; its equal-date bootstrap 95% range on the
  expected logit is `[-0.397, 0.419]`. The data therefore do not identify an
  across-calendar league improvement factor, although partially pooled
  date/context variation improves retrospective reconstruction slightly.
- Entrant-date slope is effectively zero in the post-fit diagnostic. Only nine
  entrants have at least five later games and five have at least ten; their
  apparent positive debut offsets are prior-sensitive. Fifteen usable 28-day
  return events across 13 players show a small mean residual change of `-0.244`
  public points (bootstrap 95% `[-0.488, -0.028]`), but this has not yet been
  tested as a fitted transition component and must not be presented as retained.

### Formal Entrant and Return Factor Results

- A scratch-only integrated ladder fitted the selected local-linear family with
  baseline, entrant offset, entrant offset plus entry-date slope, 28-day return
  mean, fixed 20-point extra return transition SD, and supported combinations.
  Every variant used the same five target-date-excluded reconstruction blocks
  and all 99 league games at likelihood weight 1.0.
- No factor wins robustly enough to retain. Game-weighted log loss nominally
  favors return mean plus extra SD at `0.691850301`, only `0.000003165` below
  the no-factor baseline. Equal-nonempty-block log loss instead nominally favors
  entrant offset plus date slope at `0.691985460`, only `0.000004490` below
  baseline. These gains total roughly `0.0011` log-likelihood units across all
  347 reconstructed games and are far too small and weighting-sensitive to
  justify extra assumptions.
- Full-record fitted effects are also negligible: entrant offset `-0.24` public
  points, entrant-date slope `-0.96` public points per 30 days, and return mean
  about `-0.76` public points. The 20-point return extra-SD candidate is fixed,
  not an empirically identified optimum. The integrated entrant coefficient is
  centered on the common latent reference rather than a literal contemporaneous
  pool-average contrast; its near-zero effect provides no reason to add the more
  complicated coupling now.
- Actual integrated derivatives match central finite differences within
  `1.74e-10` for the gradient and `1.66e-10` for the Hessian. Deterministic
  repeats are exact, and fitted synthetic fixtures recover entrant-above,
  entrant-below, return-rust, and no-rust directions. The formal artifacts are
  `/private/tmp/vball-individual-explanatory-factor-*`.
- Final recommendation for any later Overall experiment is therefore the
  no-factor individualized local-linear model with partially pooled league
  context/date variation. Do not add a shared cohort trend, newcomer adjustment,
  or return penalty on the current evidence. This is an explanatory display
  choice, not a balancing-model proposal, and the family-level reconstruction
  advantage over simpler random walks remains very small.

### Exact Next Action

Report the completed harness-only conclusions and await the user's decision.
Make no production, scoreboard, balancing, test, Git, or deployment change.

## Investigation — Absolute Versus Relative Skill Attribution

### User Observation and Goal

- Several players with negative individualized central-path changes have
  visibly improved substantially in real volleyball skill and also perform
  better in later league play. A line that calls this absolute decline is not
  credible merely because those players may have improved less than the local
  pool.
- Diagnose whether the model is reporting relative pool position as absolute
  skill, whether league opponent/date flexibility absorbs real local-pool
  improvement, or whether team composition prevents league evidence from being
  assigned to the correct individuals. This remains harness-only.

### Required Diagnostics

- For every materially negative 12-week path, separate internal-game and league-
  game evidence by date, score share, teammate composition, opponent context,
  and model residual. Do not equate raw league win rate with individual effect.
- Refit the selected individualized model across a bounded anchor ladder:
  pooled stable league opponent only; persistent league context without date
  effects; the selected context-plus-date hierarchy; and a decomposition with
  an explicit pool-level absolute component learned only from league evidence
  plus zero-centered individual relative deviations.
- Show how each assumption changes the direction and magnitude of representative
  player paths and the inferred pool trajectory. Identify affine/gauge or
  participation-network non-identifiability explicitly rather than allowing a
  smoothing prior to choose an apparently objective absolute direction.
- Test whether removing influential league dates or lineups flips the inferred
  pool direction. Keep every included league observation at full 1.0 likelihood
  weight and distinguish an outside-opponent-quality adjustment from a hidden
  league dampener.
- Use held-date retrospective reconstruction only as an overfit check. The
  primary result is explanatory attribution and sensitivity, not future-game
  winner accuracy.

### Progress

- [x] Confirm that the apparent declines are central estimates of roughly
  80–161 displayed points after correcting the scratch scale, with extremely
  broad posterior intervals; they are large central lines but not confident
  claims of deterioration.
- [x] Decompose negative-path player evidence and league lineup connectivity.
- [x] Run the anchor/pool-decomposition sensitivity ladder.
- [x] Report what is identifiable, what needs an explicit external assumption,
  and the next defensible Overall model formulation.

### Results and Diagnosis

- The negative directions are robust to the existing league-anchor details.
  Across a stable pooled opponent, persistent context only, and context plus
  date SD 10/35, MelissaR remains about `-17` in the scratch's incorrect x50
  units and JoshR about `-9` there. The date/context layer is not what creates
  their relative decline.
- Correcting to the actual displayed-rating scale changes the selected model's
  representative 12-week central paths to approximately DustinR `+146`, JayY
  `+112`, AlexaY `+3`, JoshR `-79`, MelissaR `-141`, PeterA `-161`, and KimK
  `-91`. Their posterior intervals remain several hundred points wide and all
  include zero. The model is selecting a direction under weak information, not
  establishing physical decline.
- League observations are team-average measurements and cannot assign a team
  change uniquely to one member. Early/late teammate-set Jaccard overlap for
  the strongest negative paths is only about `0.25` to `0.62`. For example,
  MelissaR's early/late league score share is `0.533` / `0.529`, while JoshR's
  is `0.560` / `0.540`; opponent and lineup changes prevent those raw numbers
  from measuring individual physical improvement.
- The exact identification problem is `theta_i(t)=P(t)+d_i(t)`. The pool term
  `P(t)` cancels from every same-date internal game, so internal balanced games
  identify only relative deviations `d_i(t)`. A league observation identifies
  `mean(d_local)+P(t)-O(t)`. If outside date quality is free, adding the same
  function to `P(t)` and `O(t)` leaves the likelihood unchanged. Zero-sum and
  gauge constraints name a reference frame but do not create the missing
  outside information.
- A validated conditional two-stage diagnostic makes that distinction explicit:
  internal games fit individualized local-linear relative paths and are exactly
  recentered to a fixed 28-player reference cohort; league games then fit only
  the cohort's absolute path. Recentring preserves every internal contrast to
  `1.11e-16` and the reference mean is zero to `2.58e-17`.
- With a middle 20-point pool process and stable recorded opponent contexts,
  league evidence estimates only about `+23.9` displayed points over the full
  April-August span and `+7.1` over the latest 12 weeks. Adding that to the
  internal relative paths still gives MelissaR `-106`, JoshR `-69`, KimK `-87`,
  and PeterA `-24`. Reasonable outside/date structures at the same pool process
  put the latest 12-week pool movement at only about `+4.4` to `+8.0`.
- The pool estimate is highly event-sensitive. Removing the ten August 19 Rec
  league games (4-6 record, mean local score share about `0.438`) changes the
  middle estimate from `+7.1` to `+17.1` over 12 weeks. Across all leave-one-
  league-date fits it ranges from about `+4.0` to `+17.1`.
- The two-stage diagnostic is conditional, not a final joint posterior; it does
  not propagate relative-path uncertainty into the pool path. Its purpose is to
  prove the attribution problem and expose assumptions. All 99 league games use
  full weight and N=10. Deterministic repeats are exact, finite-difference
  gradient/Hessian checks pass at the appropriate step size, and a synthetic
  fixture recovers common improvement plus an individual relative decline while
  preserving positive absolute improvement.
- The current record therefore cannot support the label "absolute skill" by
  outcomes alone. To recover the improvement known from observation, a future
  model needs independent repeated-opponent/tier calibration, periodic physical-
  skill observations, or an explicit domain prior on the pool reference path.
  A common reference-scale component is mathematically necessary, but it need
  not force identical individual slopes: each displayed path remains `P+d_i`.

### Bracket-Phase Follow-up

- The source tags six earlier indoor games as `leaguePhase: "bracket"` (three
  on April 30, one on May 6, and two on May 7), but leaves all ten August 19 Rec
  games and all five August 20 Intermediate games untagged even though those
  dates were the final seeded/bracket competitions. No source or production
  data was changed during this investigation.
- The existing experiment does not read `leaguePhase`; it keys outside quality
  only from `leagueOpponent.id`. Correcting the tags alone would therefore be a
  necessary data-integrity fix but would not change the fitted paths unless the
  model explicitly treats bracket play as a different outside-opponent context.
- In an in-memory sensitivity run, all 99 league games remained at full N=10 and
  likelihood weight 1.0. The 78 regular-phase games had local score share
  `0.555`, versus `0.484` across the 21 bracket games after assigning August 19
  and 20 to bracket phase. August 19 itself was 4-6 with `0.438` score share;
  August 20 was 4-1 with `0.593`, so the two new bracket dates are materially
  heterogeneous.
- Under the middle 20-point pool process, adding one global bracket-strength
  effect raises the inferred latest-12-week pool movement only modestly: from
  `+7.1` displayed points with no phase term to `+8.3` under a moderate prior or
  `+10.5` under a wider prior. Representative negative absolute paths remain
  negative, and 13 cohort members remain below zero over the interval.
- Omitting August 19 still raises the 12-week pool estimate to roughly `+17.1`
  under every phase formulation. August 19 is the only Rec-bracket date, so a
  Rec opponent shift, bracket difficulty, and the pool reference path cannot be
  independently learned from this record. Opponent-by-phase interactions are
  correspondingly prior-driven.
- Bracket context is directionally real and belongs on the outside-opponent side
  of a future explanatory model, not as a penalty to the participating players.
  It makes the August 19 leverage less interpretable as physical decline, but it
  does not supply enough independent calibration to make the current paths
  objective absolute-skill estimates.

### Exact Next Action

Report the diagnosis and bracket sensitivity. Await a user decision about
whether to correct the authoritative August 19/20 phase metadata and whether a
future explanatory model should include bracket as an outside-opponent context,
along with what external assumption or additional observation should define the
absolute reference scale. Do not change application code, tests, data, Git
history, or deploy.

## Investigation — Plausibility-Constrained Individual Improvement

### Goal

- Incorporate the domain observation that persistent absolute physical-skill
  decline is implausible for highly active players who visibly improve, while
  preserving the ability to represent an off day, a short slump, return rust,
  roster/opponent changes, and genuinely strong contrary evidence.
- Keep this as a harness-only explanatory-model test. It is not a proposal for
  team balancing, production ratings, database mutation, or deployment.

### Model Families to Compare

- Retain the identified decomposition `theta_i(t)=P(t)+d_i(t)`, full 1.0 league
  likelihood weight, individualized paths, and in-memory bracket classification
  for August 19 and 20.
- Compare the unconstrained two-stage reference against: a soft asymmetric
  long-run change prior that permits but disfavors persistent decline; a
  hierarchical individualized improvement prior with a nonnegative cohort
  center and player-specific deviations; a monotone or near-monotone long-run
  skill path plus zero-centered date/session form shocks; and a hard-monotone
  sensitivity bound. Do not force a shared player slope.
- Separate durable skill from temporary performance. Bracket phase and recorded
  opponent context belong on the outside-opponent term; same-day residual shocks
  must not permanently rewrite player skill.

### Evaluation

- Report individual 12-week/full-span changes, number and magnitude of remaining
  durable declines, temporary-form amplitudes, league/internal residuals, and
  fit loss relative to the unconstrained reference.
- Because the goal is retrospective explanation rather than forward balancing,
  emphasize posterior likelihood or penalized explanatory fit, held-date
  reconstruction only as an overfit warning, and sensitivity to prior strength.
- Test whether the constraint merely relabels unexplained losses as noise, or
  whether a skill-plus-form decomposition explains the record comparably without
  implausible persistent declines. Include exact scale/unit and deterministic
  checks plus at least one synthetic improving-player/off-day fixture.

### Progress

- [x] Implement and validate a bounded conditional anchor refit outside
  production.
- [x] Quantify what becomes identifiable only because of the domain prior.
- [x] Test the focused durable-skill plus temporary league-session-form
  extension before recommending any later UI experiment.

### Conditional Anchor-Refit Results

- Stage 1 retains the individualized internal-game relative paths and exact
  cohort recentering. Stage 2 refits the weekly pool reference, stable recorded
  outside contexts, and one global bracket effect while adding a downside-only
  prior to each eligible player's absolute endpoint change. Positive changes
  receive no extra reward. All 99 league observations remain N=10 and weight
  1.0; August 19 and 20 are tagged as bracket only in memory.
- In the primary 20-point pool process, the unconstrained fit estimates only
  `+25.8` pool points over the full record and `+8.3` over 12 weeks. Thirteen of
  28 sufficiently observed players have negative persistent endpoint changes,
  with a minimum of `-128.8`.
- A moderate 25-point downside scale moves the pool to `+124.1` full-span and
  `+87.6` over 12 weeks, leaving three negative endpoints with a minimum of
  `-27.3`. It changes representative paths from JoshR `-70` to `+21`, PeterA
  `-21` to `+57`, KimK `-125` to `-24`, and MelissaR `-129` to `-27` while
  retaining individualized relative differences.
- A stronger 10-point downside scale moves the pool to `+143.7` full-span and
  `+100.6` over 12 weeks. Remaining declines are only a few points (minimum
  `-7.1`), while JoshR is `+37`, PeterA `+72`, KimK `-3`, and MelissaR `-7`.
  A near-hard 2-point scale moves the pool to `+150.1` and leaves only numerical-
  scale negative endpoints.
- The raw league-likelihood costs are small: `+0.608`, `+1.049`, and `+1.220`
  total NLL for the 25-, 10-, and 2-point priors, respectively, or roughly
  `0.006` to `0.012` per league game. Leave-one-league-date-out NLL likewise
  changes from `6.8801` per game unconstrained to `6.8886`, `6.8935`, and
  `6.8953`. August 19 is the clearest conflict: held-date NLL rises from
  `6.9664` to `7.1299` under the moderate prior.
- A descriptive linear reference shift of about `+155.5` across the full grid
  is required to make every player with at least 50 internal appearances
  nonnegative; MelissaR is binding. Applying the belief to every sufficiently
  observed player requires about `+165.1`, with BenT binding.
- The data cannot select this absolute shift by itself. Under the moderate
  prior, the learned Rec and Intermediate outside-context coefficients move by
  about `+19.0` and `+11.7` points and the bracket effect moves by `+8.6`, while
  the generic league-team context barely moves. This is the explicit domain
  prior choosing among weakly identified pool-versus-outside decompositions.
- A fitted synthetic true-decline case exposes the tradeoff: a baseline
  `-235.2` absolute decline is attenuated to `-30.6` by the moderate prior at a
  raw likelihood cost of `6.16`, and to `-0.2` by the near-hard prior at a cost
  of `7.29`. The prior must therefore remain soft and visibly documented in the
  model, even though the real record pays very little fit cost for it.
- All primary fits and leave-date folds converge. Public-scale, deterministic,
  recenter/contrast, and active-branch gradient/Hessian checks pass. The model
  is still conditional rather than a joint posterior and has no explicit form
  variable, so it cannot yet distinguish an off day from other transient error.

### League-Session Form Follow-up

- A second conditional Stage 2 comparison adds one equal-session-mean-zero local
  team form effect to each league date, with the same stable outside contexts,
  global bracket term, full league weight, and downside prior. This represents a
  temporary team/day residual; it cannot identify which player had an off day
  and does not alter internal-game relative paths.
- With the moderate 25-point downside and 25-point form scales, August 19 is
  assigned `-13.8` displayed points of temporary form while August 20 is
  `-1.4`. Session-form RMS is `4.35` and August 19 is the largest absolute
  residual. The durable pool result is essentially unchanged at `+124.4` full-
  span and `+87.8` over 12 weeks, with the same three negative endpoints and a
  minimum of `-27.1`.
- The 25-point form term improves retrospective raw league NLL by `0.638`
  relative to the matching no-form moderate-downside fit. A 10-point form scale
  improves it by only `0.109` and assigns August 19 about `-2.35`; a 50-point
  scale improves it by `2.08` but creates date effects as large as `45.8`, which
  is too flexible to treat as independently supported.
- Held-date scoring does not improve, as expected for an unobserved off day:
  moderate downside changes from `6.88864` per game without form to `6.88900`
  with 25-point form and `6.88991` with 50-point form. The session term is a
  retrospective explanatory decomposition, not a forward predictor.
- A sign mismatch in the first scratch reporting function was found during
  primary review and corrected; fitted and separately reported likelihoods now
  agree within `1e-8`. All primary and held-date fits converge, equal-session
  gauges are centered, deterministic repeats are exact, and the combined
  likelihood/prior/gauge/downside gradient and Hessian checks pass.
- Synthetic fixtures show the intended separation: an improving durable path
  retains positive change with a negative final-session residual, while
  deterioration repeated across many sessions remains a durable negative under
  the moderate prior rather than being erased by independent form effects. The
  stronger downside prior, not the form term, is what attenuates that decline.
- The defensible conceptual candidate is therefore individualized relative
  paths plus an explicitly assumed positive absolute reference, a soft rather
  than hard downside prior, bracket-aware outside context, and modest temporary
  league-session form. The match record cannot choose the absolute-reference or
  downside-prior strength; those remain transparent domain assumptions.

### Exact Next Action

Report the completed harness findings and await the user's decision about a
later full joint player-level skill/form experiment or UI candidate. Do not
change application code, production data, tests, Git history, or deploy.

## Investigation — Exposure-Based Individual Improvement

### Goal

- Test whether durable improvement is explained more plausibly by recorded
  playing exposure than by a shared calendar-time pool trend. Preserve player-
  specific rates, temporary performance variation, and a small possibility of
  genuine decline.
- This remains harness-only. Do not change the Overall board, balancing model,
  confidence/volume display penalty, source database, Git history, or deploy.

### Joint Model

- Fit one skill state per player per appearance date. Every game on a date uses
  the skill entering that date; all of that date's recorded experience affects
  only the player's next state, preventing same-session look-ahead.
- Use the transition
  `skill_i,next - skill_i,current = beta_i * exposure_i,date + residual`,
  with calendar-gap-scaled process noise. Internal and league likelihoods then
  refit the entire path jointly, avoiding a post-hoc `points * games` bonus and
  double counting.
- Keep all league games at N=10 and likelihood weight 1.0. Use stable recorded
  outside contexts, the in-memory August 19/20 bracket classification, one
  bracket-strength term, and test the validated modest league-session form term
  only on finalists.
- Model rates hierarchically and convexly where possible: a population rate with
  an explicit prior-center sweep, partially pooled player deviations, and a
  soft negative-rate tail. Do not estimate unconstrained independent rates for
  sparse players.

### Exposure Families and Sweep

- Per-session exposure is `1 + lambda * (games_on_date - 1)`, with `lambda` at
  least `0` (play dates), `0.1`, `0.25`, and `1` (raw games).
- Compare linear cumulative exposure with diminishing-return transforms such as
  `k * log(1 + exposure/k)` for meaningful `k` values. Count a session's
  exposure only after that session completes.
- Coarse-sweep shared rate centers including `0`, `1`, `2`, `3`, and `4` public
  points per effective exposure and reasonable process scales. Narrow promising
  regions before adding individual-rate SDs and session-form variation.
- Include the user's explicit `+3 per raw game` proposal even if it is
  implausibly large, so its consequences are measured rather than assumed.

### Evaluation

- Compare static single-value, no-drift dynamic, shared exposure-rate, and
  partially pooled individual-rate models using raw retrospective likelihood,
  separated prior/objective components, and held-date reconstruction only as an
  overfit warning.
- Report population and player-specific rate estimates with uncertainty or
  curvature diagnostics, full-span/current durable changes, remaining negative
  trends, implied changes for high-volume players, residual/form amplitudes,
  bracket/outside effects, and sensitivity to exposure definition.
- Penalize or reject models that gain fit by giving implausible rates to sparse
  players, assigning enormous same-day gains, or absorbing genuine synthetic
  decline into exposure. Validate causal exposure accounting, units,
  determinism, derivatives, and synthetic different-rate/off-day/true-decline
  fixtures.

### Progress

- [x] Implement and validate the joint exposure-drift harness.
- [x] Run the coarse sweep and narrow promising exposure/rate/process regions.
- [x] Test partial pooling, diminishing returns, and session form on finalists.
- [x] Report winners, losers, identifiability, and the next defensible candidate.

### Validated Joint-Core and Coarse Results

- The scratch joint model fits 636 player/date entry states plus five stable
  recorded league-context effects and one bracket effect. All 99 league games
  retain N=10 and likelihood weight 1.0; August 19 and 20 are classified as
  bracket only in memory. The repository, source database, and production app
  remain unchanged.
- Causal accounting is executable rather than assumed. Across 588 repeated
  player/date appearances, every same-day game resolves to the same entry-state
  index. A constructed extra same-day game changes neither that date's state
  index nor its fixed-state likelihood, leaves the incoming transition
  unchanged, and changes only the outgoing transition mean by the exact
  `w_lambda` / `H` increment.
- A separate 82-dimensional true-static comparator converges in two Newton
  steps at raw NLL `2400.092009` (`1717.305515` internal and `682.786494`
  league). The process-45 dynamic no-drift fit improves to `2397.593048`.
  At the same fixed process scale, raw-game exposure at +1 point/game and the
  blended exposure `lambda=0.25` at +2 points/effective exposure are
  effectively tied: raw NLL `2396.332958` versus `2396.339059`, with objectives
  `2398.675861` versus `2398.640041`.
- The user's explicit +3-per-raw-game proposal is a clear coarse-grid loser at
  raw NLL about `2403.6231` and objective about `2412.3252`. It overshoots the
  observed record rather than merely losing on a complexity penalty.
- Linear exposure and a mild diminishing transform (`k=75`) are effectively
  tied in the initial region; `k=25` saturates too quickly. Process SD cannot be
  selected by in-sample raw NLL because additional process flexibility always
  improves fit, and the current unnormalised MAP objective is not comparable
  across SD values. A held-date reconstruction is required before narrowing
  process noise.
- Static and joint likelihood/evaluator partitions, deterministic repeats,
  public-unit conversion, and finite-difference gradient/Hessian checks pass.
  Measured static partition and objective-sum errors are at most `4.55e-13`;
  derivative errors are below `4.1e-8` for the gradient and `1.9e-10` for the
  Hessian at their best tested steps.
- Fitted synthetics validate the intended interpretation. With 18 appearance
  dates, a planted +12-point rate, `lambda=0.5`, and three versus one games per
  date, the fixed-process objective selects +12 from the ladder and recovers
  about +408 versus +204 points of calendar-span gain. A planted durable
  decline remains about -32 points under a moderate +8 exposure prior; forcing
  +12 instead costs `5.72` raw likelihood units and `16.21` objective units.
  Thus exposure drift guides the path but does not make genuine decline
  impossible.

### Held-Date Narrowing Results

- Five deterministic contiguous date blocks cover all 52 play dates and all
  347 games. Target games remain in the participation/exposure topology but
  contribute no score likelihood. Perturbing every target score on a masked
  date changes the fitted states and held predictions by exactly zero, proving
  there is no score leakage.
- Process SD 20, 45, and 80 remain on one broad held-date plateau. Their best
  game-weighted NLLs are `6.918471`, `6.917544`, and `6.915820` per game. The
  numerical SD80 lead is not identified: for its best exposure candidate, the
  date-clustered interval versus matched no drift is
  `[-0.01068, +0.00660]` NLL/game.
- The blended definition `lambda=0.25, beta=2` is the numerical leader at every
  tested process scale. At SD80 it reconstructs all games at `6.915820`,
  internal games at `6.928117`, and league games at `6.885015` NLL/game. Its
  99 league targets occur in four nonempty blocks; all retain full weight.
- At the deliberately simpler SD20 edge of the plateau, refinement nominally
  favors `lambda=0.25, beta=2.5, k=75` at `6.918110`. Linear versus mildly
  diminishing exposure and exposure drift versus no drift remain tied; the
  date-clustered interval for the nominal finalist is
  `[-0.01714, +0.00735]`.
- Raw +3 points per game is worse in every held-date process setting. At SD20
  it loses by `0.04588` NLL/game with interval `[+0.00241, +0.10179]`; at SD45
  and SD80 its losses shrink to `0.03601` and `0.02439` but their intervals
  cross zero. The proposal is therefore directionally and sometimes clearly
  inconsistent with the record, not a viable default.
- Use SD20 and `lambda=0.25` as the conservative hierarchy-development point,
  while retaining SD45 as a finalist sensitivity check. Treat `k=75` and
  linear exposure as unresolved variants rather than declaring the tiny point
  estimate a discovered optimum.

### Hierarchical Player-Rate Coarse Results

- The convex hierarchy learns one population improvement rate plus Gaussian-
  shrunk player deviations. Players with no transition inherit the population
  rate rather than receiving an unsupported estimate. Marginal curvature uses
  the full covariance of population plus deviation, not a sum of marginal
  standard deviations.
- Deterministic, independent-likelihood, component-sum, masked-score, and
  finite-difference checks pass. The general gradient/Hessian errors are about
  `1.2e-9` / `1.0e-7`; the active one-sided negative-rate branch checks at
  `8.1e-8` / `1.1e-7`. Masked target-score changes again leave topology,
  states, and predictions exactly unchanged.
- Fitted synthetics recover the ordering of two well-observed different-rate
  players, shrink a deliberately sparse high-rate player almost exactly to the
  population rate, and retain a planted declining player at a negative rate
  even with a finite downside penalty. This confirms both partial pooling and
  the escape path for genuine decline.
- On the real SD20 / `lambda=0.25` / `k=75` grid, moderate player-rate SD 3 is
  the stable useful region. With prior centers 1 and 2 it reconstructs held
  dates at `6.917005` and `6.917093` NLL/game, versus `6.918257` and `6.918302`
  for their matched shared-rate models. Correct game-weighted date-cluster
  intervals are `[-0.00268, -0.00003]` and
  `[-0.00254, -0.00006]`; equal-date intervals are also narrowly below zero.
- This is a small family-level signal, not precise individual-rate certainty.
  The center-1 fit learns population rate `2.04 +/- 1.20` public points per
  effective exposure and shrinks player rates into `0.77` through `3.69`; the
  center-2 fit learns `2.40 +/- 1.20` with rates `0.96` through `4.00`.
- Rate SD 6 lowers the point estimate further to about `6.9161`, but both
  bootstrap estimands cross zero, marginal population uncertainty grows to
  about `1.43`, and two to five player rates become negative depending on the
  population prior center. Treat this as the beginning of overfitting rather
  than a preferred explanatory model.
- Primary review found and corrected an initial bootstrap-unit bug: date-cluster
  NLL totals had been divided by dates rather than sampled games. All intervals
  above come from the regenerated 2,000-replicate game-weighted and separately
  labeled equal-date bootstraps.

### Finalist Exposure, Process, and Prior Results

- Exposure-family priors were normalized to the same median total prior gain,
  `10.4821` points, before comparing raw games with blended session/game
  exposure. This prevents the exposure unit itself from deciding the result.
  All scaling checks are exact to `1.78e-15`; all candidate factorizations use
  zero numerical jitter.
- Mildly diminishing raw-game exposure (`lambda=1`, `k=75`) is the numerical
  held-date leader at `6.916876` NLL/game. The conservative blended exposure
  (`lambda=0.25`, `k=75`) is `6.917005`. Their direct game-weighted date-cluster
  interval is `[-0.00107, +0.00069]`, and the equal-date interval is
  `[-0.00071, +0.00083]`; therefore the data do not identify which exposure
  definition is better. Their normalized Laplace evidence differs by only
  `0.47` log units, also too small to choose a shape.
- The fitted median population rate-component gain across the observed span is
  about `21.4` points for the blended finalist and `23.8` for the raw-game
  finalist. These are total observed-span gains, not points awarded after every
  game. The fitted raw-game rates are roughly `0.52` to `1.76` before
  cumulative diminishing exposure; the blended rates are `0.77` to `3.69` in
  their different effective-exposure units.
- Process SD 20 remains the conservative choice. On the raw-game finalist,
  process SD 45 and 80 improve held reconstruction by `0.00066` and `0.00197`
  NLL/game, but their date-cluster intervals versus SD20 cross zero and their
  normalized Laplace evidence is lower by about `1.10` and `3.71` log units.
  The extra path motion is not identified strongly enough to justify it.
- Changing the population-rate prior center between 1 and 3 moves the fitted
  population rate materially, while held NLL changes only from `6.917005` to
  `6.917377`. This is direct evidence that the absolute improvement scale is
  still prior-sensitive even though positive durable improvement is the stable
  qualitative result.
- A dedicated normalized-evidence sweep confirms the partial-pooling tradeoff.
  Relative to one shared rate, player-rate SDs `0.5`, `1.5`, `3`, and `6`
  monotonically improve held-date NLL/game from `6.918257` to `6.916128`, but
  monotonically reduce normalized Laplace evidence by `0.06`, `0.52`, `1.79`,
  and `4.99` log units. Rate SD 3 is the bounded explanatory compromise:
  it gives the small held-date improvement already reported, keeps all fitted
  rates positive, and avoids the three negative and highly dispersed rates at
  SD 6. It is not an evidence-selected winner over the simpler shared-rate
  model.
- Individual slopes remain uncertain. Under the two rate-SD-3 finalists,
  representative full-span durable rate-component gains are about `+147` to
  `+165` for Dustin, `+146` to `+168` for Matt, `+139` to `+158` for Joe,
  `+116` to `+129` for Jack, `+103` to `+113` for Jay, about `+90` to `+96`
  for Josh and Alexa, and about `+36` to `+48` for Kim and Melissa. Individual
  rate standard deviations are often as large as the fitted rates, so these
  values support smooth positive paths but not precise player-to-player slope
  rankings.

### League-Session Form Results

- A zero-sum league-date form effect was added only to the league likelihood,
  with all 99 league games still at full weight. Its 22 coordinates exactly
  sum to zero; no-form fits exactly reproduce the accepted finalist metrics.
  Determinism, likelihood partitions, derivatives, masked-score isolation, and
  Helmert-basis checks pass.
- Synthetic tests show the term behaves as intended: it isolates one planted
  severe league off-day while retaining positive player improvement, and it
  does not absorb a repeatedly planted durable decline.
- The real data reject the extra form term as a default. Form SD 10, 25, and 50
  improve in-sample NLL but worsen held-date NLL for both exposure finalists;
  every interval crosses zero, and normalized Laplace evidence also declines.
  At SD50 the fitted form RMS grows to about `14.5` points and assigns August 19
  roughly `-42` points, demonstrating residual absorption rather than a stable
  explanatory gain. Keep the bracket classification, but omit league-session
  form from the candidate.

### Conclusions and Recommendation

- A fixed `+3` points per raw game is decisively too aggressive. The useful
  model is a jointly fitted latent transition prior based on completed exposure,
  with residual state motion free to contradict it when the games require that.
- The stable result is modest positive population improvement associated with
  playing exposure. The record does not identify raw games versus a
  session-heavy blended exposure, and it does not contain enough independent
  information to rank precise player improvement slopes confidently.
- If an individualized explanatory graph is desired despite that uncertainty,
  the defensible bounded candidate is process SD 20, hierarchical player-rate
  SD 3, no league-session form, and a sensitivity band spanning both
  `lambda=0.25, k=75` and raw-game `lambda=1, k=75` exposure. The displayed
  interpretation should be a smooth partially pooled improvement path, not an
  earned point bonus or a claim that the fitted slopes are exact.
- No application code, production data, rating behavior, tests, Git history,
  or deployment changed during this investigation.

### Exact Next Action

Report the completed harness findings and await the user's explicit decision
about any later implementation or additional sensitivity test. Do not change
application code, production data, rating behavior, tests, Git history, or
deploy.

## Implementation — Session-Weighted Individual Improvement

### User Decision

- On August 30, 2026 the user approved applying the session-weighted exposure
  model and the moderately partially pooled individualized-rate model to the
  Bayesian Overall scoreboard and its player graphs.
- The user explicitly chose individualized slopes as a reality-based modeling
  assumption even though normalized evidence prefers the simpler shared-rate
  model. Preserve that product decision while keeping the slopes partially
  pooled and the uncertainty honest.
- This approval covers local implementation and verification. It does not
  authorize staging, committing, pushing, or deployment.

### Goal

- Replace only Overall's current zero-mean weekly random-walk transition with
  the validated causal exposure transition and hierarchical player-specific
  improvement rates. The compact table remains Rating and Games; the existing
  player overlay shows the new model's history.
- Keep team balancing, static Big/Small Bayesian boards, Season Ranking, Trend,
  Game History, and every non-Overall rating path unchanged.

### Approved Model

- Fit one entry-skill state per player per recorded appearance date. Every game
  on the same date uses the same entry state. That date's completed exposure
  can affect only the transition to a later appearance, never another result
  from the same session.
- Session exposure is `1 + 0.25 * (games_on_date - 1)`. Apply the approved mild
  cumulative diminishing transform `H(E) = 75 * log(1 + E / 75)` and use
  `beta_i * delta_H` as the transition mean.
- Model `beta_i = beta_population + beta_deviation_i`. Use the validated public-
  scale priors: population center 1, population SD 2, player-deviation SD 3,
  and calendar-gap process SD 20 per square-root month. Convert those values
  through the existing public/latent scale exactly once.
- Do not add a downside penalty or hard nonnegative constraint. A well-supported
  genuine decline must remain possible. Do not add league-session form.
- Retain every league game at N=10 and likelihood weight 1.0. Preserve the
  accepted stable recorded outside-context and bracket treatment, including the
  in-model August 19/20 bracket classification, without mutating source data or
  weakening league impact.
- Keep one noninteractive `League Player` display row using the existing
  same-roster-size individual interpretation. If outside contexts require a
  pooled display reference, derive it deterministically from the fitted league
  observations rather than hard-coding a rating.

### Display and Persistence Requirements

- Overall row ratings and ranks use each player's latest fitted entry state,
  posterior uncertainty, and the existing confidence/volume display transform.
  The active confidence toggle continues to control only its existing display
  adjustment; it must not silently disable or rescale the fitted exposure model.
- Preserve the current compact mobile table, graph dialog, adaptive axes,
  monthly date labels, league-average reference, accessibility, and close/focus
  behavior. Do not add a slope column, model explanation, label, or help text.
- Preserve the user-selected weekly graph distribution by exposing at most one
  plotted checkpoint per active Monday-anchored week, selected deterministically
  from the fitted appearance-date path. The final checkpoint must equal the
  current table row under the active display options.
- Store the partially pooled player rate and its posterior uncertainty in the
  Overall-only snapshot for deterministic graph/model reuse, but do not expose
  new UI copy or an extra scoreboard field.
- Introduce a new Overall model/storage identity and reject deployed weekly-v3
  snapshots. Keep static Big/Small snapshot behavior unchanged and include all
  model-defining parameters in the cache identity.

### Constraints and Non-goals

- Preserve the six pre-existing dirty files reported at startup. Limit edits to
  the Overall implementation, its worker/integration path, focused tests, PWA
  cache generation, and this ExecPlan.
- Do not alter source game data, production databases, balancing ratings,
  scoreboard penalty tiers, or user-facing explanatory copy.
- Do not stage, commit, push, or deploy.

### Milestones

1. Adapt the validated scratch model into a browser-safe production core,
   introduce the new snapshot schema/model identity, and add deterministic
   model tests.
2. Integrate the model with the Overall worker/table/history graph while
   preserving the compact UI and weekly graph distribution.
3. Add focused browser regressions and update the PWA cache generation.
4. Run the full test suite, required Season Ranking/Trend/Game History
   consistency pass, balancing-invariance check, current-data audit, and a
   phone-width local browser audit.

### Acceptance Criteria

- Current data fit all 76 players and all 347 games, including all 99 league
  games at full weight; every finite row/history endpoint is deterministic.
- Same-day games share one entry state and cannot learn from exposure earned
  later that day. Synthetic different-rate, sparse-player shrinkage, stable,
  improving, and genuine-decline fixtures recover the intended behavior.
- The production candidate reproduces the accepted harness parameterization
  and current-data outputs within documented numerical tolerance.
- Overall's latest graph point exactly equals its table row under default and
  advanced display options. Weekly checkpoint density, League Player reference,
  mobile geometry, keyboard/dialog behavior, and static Big/Small scoping pass.
- A fixed balancing fixture is byte-for-byte unchanged. Season Ranking, Trend,
  and Game History remain mutually aligned under sampled default and advanced
  options with the same game set, league inclusion, team-size, rolling-window,
  visible rating/rank, and game-count transforms.
- The current-data fit is responsive enough for the existing worker/cache
  workflow, all automated tests pass, `git diff --check` passes, and an exact
  local audit URL is reported.

### Progress

- [x] Verify the August 30 direct Drive source and local-data equivalence.
- [x] Record the approved production parameterization and boundaries.
- [x] Implement and validate the production model core and snapshot schema.
- [x] Integrate and verify the Overall table and graphs.
- [x] Complete the repository-wide consistency and local phone audit.

### Milestone 1 Validation

- `overall-dynamic-ratings.js` now implements the appearance-date causal model,
  hierarchical player rates, stable league contexts, all existing bracket tags
  plus the in-model August 19/20 classification, and Overall snapshot schema 3
  under the new v4 storage identity.
- An exact scratch comparison on the refreshed 76-player / 347-game source
  matches the accepted finalist at objective `2398.750695879797`, population
  rate `2.036900186663914`, 693 dimensions, and 636 appearance states. Three
  representative player rates match exactly; context and bracket differences
  are no larger than `1.25e-14`.
- The final Hessian is factored once and reused for all state, context, league,
  population-rate, and player-rate covariance solves. Current-data model plus
  posterior formatting fell from about 8.3 seconds in the first draft to about
  1.63 seconds.
- Focused dynamic tests pass 11/11 and the unchanged static Bayesian tests pass
  23/23. They cover causal same-day exposure, exact units, full league weight,
  source-tagged and added bracket dates, partial pooling, sparse inheritance,
  different-rate and genuine-decline recovery, snapshot rejection, League
  Player conversion, endpoint/uncertainty/order invariants, weekly helper
  compatibility, and invalid-history rejection. Syntax and diff checks pass.

### Milestone 2 Validation

- Composite/Overall now sends raw recorded games to the dynamic worker, so the
  five stable outside contexts and all bracket metadata reach the accepted
  model. Static Big/Small continue to receive their existing pooled league
  opponent and remain on the static Bayesian path.
- Stats recognizes only schema 3 plus the new model identity as dynamic Overall.
  The v4 storage key isolates it from deployed weekly-v3 snapshots, while the
  model's `playerRates` remain persisted but absent from table/UI rendering.
- Appearance-date history is projected to the latest fitted entry state in each
  Monday-anchored week before the unchanged display transform. This preserves
  the weekly graph distribution and makes the final projected knot the actual
  latest state used by the table.
- Composite calculation, staleness checks, and League Player display conversion
  use the same raw snapshot-scoped games. A deterministic audit reports a fresh
  schema-3 snapshot as not stale with zero added/modified games; editing one raw
  score reports exactly one modified game. Current-data harmonic effective size
  remains exactly `6.404805914972282`.
- Focused dynamic tests remain 11/11, the worker syntax check and diff check
  pass, and no new user-facing copy or static-scoreboard behavior was added.

### Milestone 3 Validation

- The focused dynamic-history browser regression now seeds and rejects an old
  weekly-v3 payload, waits for schema 3 plus the new model identity, verifies
  persisted player-rate metadata remains absent from the compact UI, and keeps
  the exact existing `Trend / # / Player / Rating / Games` headers.
- At 390px it verifies the graph has exactly one marker per active Monday week
  despite retaining the full appearance-date posterior in storage, preserves
  true elapsed-time spacing, derives the exact adaptive month ticks, and keeps
  the final endpoint equal to the table row.
- The displayed League Player row and dashed graph reference agree exactly
  after snapshot-scoped roster-size conversion. Table geometry, visible focus,
  dialog containment/return, all close paths, sparse history, and noninteractive
  League Player/static Big mode all pass.
- Exact focused command:
  `VBALL_BROWSER_SMOKE=1 node test/overall-dynamic-history-browser.mjs
  http://127.0.0.1:5176 http://127.0.0.1:9444` reports
  `Dynamic Overall history overlay browser test passed.` The isolated browser
  was terminated after the run.
- The PWA cache generation is now
  `vball-static-v29-session-exposure-overall`; the revised dynamic module and
  worker remain in the offline app shell. Browser-test/service-worker syntax,
  focused Overall tests 11/11, and diff checks pass.

### Milestone 4 Validation

- Final review caught a multi-context League Player aggregation defect before
  publication. Averaging all 99 fitted outside terms before converting the
  posterior team average to one player over-shrank uncertainty and would have
  displayed the synthetic row first at about 2644. The corrected row converts
  every league observation with its own fitted context plus bracket covariance
  and recorded local roster size, then takes the game-weighted mean individual
  posterior. It is persisted as already individual so the display layer cannot
  apply the roster conversion twice.
- The corrected current-data League Player has `mu 25.054284483826823`,
  `sigma 1.271383865679414`, and `ordinal 21.24013288678858`, displaying as
  2562 at rank 5. This remains higher than the prior weekly model's 2155 because
  the approved exposure model treats five stable league contexts as tightly
  calibrated anchors; no context prior or other approved model parameter was
  silently retuned.
- `npm test` passes 43/43, `npm run test:handoff` passes 25/25, and worker,
  service-worker, browser-test syntax plus `git diff --check` pass. The focused
  dynamic suite remains 11/11. The PWA cache generation is
  `vball-static-v30-session-exposure-league-individual` so the final League
  correction cannot be hidden behind the earlier candidate cache.
- The broad clean-profile browser regression passes end to end. Its required
  cross-view consistency sample remains aligned across Season Ranking, Trend,
  and Game History: JoeM is 2258 over 55 games under the default one-month,
  league-included, confidence-adjusted options and 2409 over 49 games when the
  season window and confidence penalty are removed and league games are hidden.
  Play-tab new-data/correction guards and the four-hour action throttle also
  complete normally. `index.html` and `ratings.js` have no task diff and no
  Overall-v4/player-rate dependency, preserving balancing behavior.
- The fresh current-data browser audit uses all 76 players and 347 games through
  August 27, including all 99 league games and 21 bracket games. The production
  core exactly retains objective `2398.750695879797`, 693 dimensions, 636
  appearance-date states, five league contexts, 50 individual rate deviations,
  zero Cholesky jitter, and the accepted population rate
  `2.036900186663913 +/- 1.198789125313495` public points per effective
  exposure. It converges in three Newton iterations.
- Representative fitted player rates remain individualized and partially
  pooled: DustinR `2.886 +/- 2.026`, MattA `3.506 +/- 2.424`, AlexaY
  `2.368 +/- 2.659`, RichaP `1.954 +/- 3.123`, and MelissaR
  `0.774 +/- 2.206`. Their fitted first-to-last central paths are respectively
  positive by about 167, 175, 95, 43, and 35 public rating points. These rates
  stay in snapshot metadata and are not exposed as a new table field or copy.
- At 390x844 the exact compact headers remain
  `Trend / # / Player / Rating / Games`, the table fits without horizontal
  overflow, and the current top four are MattA 2604, DustinR 2593, JoeM 2587,
  and JackT 2582. DustinR's overlay has 20 weekly markers, seven readable
  Y ticks, monthly April-through-August labels, a 14px minimum label size,
  exact 2593 graph/table endpoint equality, an exact 2562 League reference,
  contained dialog geometry, correct close-button focus, and no console errors.
  The audited screenshots are
  `/private/tmp/vball-current-session-exposure-table.png` and
  `/private/tmp/vball-current-session-exposure-graph.png`.
- The final focused mobile/history regression and full browser smoke both pass
  against the healthy local audit URL
  `http://127.0.0.1:5176/stats.html?tab=allTime&mode=composite`.

### Exact Next Action

The individualized session-weighted Overall model is deployed. Let the user
audit the production page; make no further model, rating, graph, or scoreboard
changes without new feedback.

### Release Result

- Scoped commit `58e27129d2910acf7a7d1fc675c938cc15ea199a` was pushed to
  `origin/main`; the protected local database and handoff files remained
  unstaged.
- GitHub Pages run `33333109907` completed successfully.
- Cache-busted production `stats.html`, `overall-dynamic-ratings.js`, and
  `sw.js` matched the local commit's SHA-256 hashes exactly.
- Release validation passed 43/43 application tests, 25/25 handoff tests, the
  focused phone/history regression, the complete clean-profile browser smoke,
  syntax checks, and `git diff --check`. The required default and advanced
  Season Ranking/Trend/Game History consistency samples remained aligned.

## Follow-up — Central Skill History and Irreducible League-Player Variance

### User Decision and Diagnosis

- On August 30, 2026 the user rejected the newly deployed graph's implausible
  common decline among high-volume top players and the 2562 synthetic League
  Player row, then explicitly approved both scoped corrections below.
- The apparent decline is a display artifact. Over the latest eight weeks the
  fitted central means for MattA, DustinR, JoeM, JackT, JayY, AlexaY, AlexS,
  and JoshR all rise by roughly 34–70 public points, while their visible
  `mu - 3*sigma` histories fall by roughly 45–80 because posterior uncertainty
  widens at the right boundary of a dynamic smoother.
- League Player's posterior team-average mean is reasonably identified, but
  its 1.27 sigma measures precision of a repeatedly observed team average, not
  irreducible variation of one unknown opponent player. Treating it as the
  latter makes the synthetic player artificially certain and highly ranked.

### Approved Corrections

- Keep the compact Overall table and all real-player ranks on the existing
  conservative display transform. Change only the player-history graph's solid
  line to the posterior central mean `mu`, expressed on the existing public
  display scale without confidence or missing-game penalties.
- Center the existing uncertainty band on that mean and retain its existing
  one-posterior-sigma width. The latest graph point is intentionally no longer
  required to equal the conservative table row; it must equal the transformed
  latest posterior mean instead.
- Keep graph quantities comparable: the dashed `League avg` reference uses the
  fitted League Player central mean on the same scale as the central player
  line. The compact League Player table row remains conservative.
- Preserve learning of the league team-average mean, but add an irreducible
  individual-player variation component of `3.75` rating-scale sigma in
  quadrature with the inferred team-average/roster uncertainty. This component
  never shrinks with the number of league games. Apply it idempotently to both
  newly calculated and already cached dynamic Overall snapshots.
- The expected current-data League Player row is approximately 2155–2160 and
  should return near its prior rank. Derive the exact result in verification;
  do not hard-code a display score or rank.
- Preserve full league likelihood weight/N=10, every fitted player/history
  state and mean, all player-specific exposure rates, balancing, static
  Big/Small boards, Season Ranking, Trend, Game History, table copy, and mobile
  interaction behavior. Add no explanatory UI copy.
- Bump only the PWA app-shell cache identity needed to deliver the display fix.
  Do not stage, commit, push, or deploy without a new explicit publication
  request.

### Milestone and Acceptance

- [x] Implement the variance floor and central-history rendering with focused
  model/browser regressions.
- [x] Run the complete application suite, handoff suite, focused mobile/history
  test, full cross-view browser consistency pass, current-data numeric audit,
  and 390px local visual audit.
- League Player's mean remains unchanged, its sigma cannot fall below the
  irreducible component, cached/new formatting is idempotent, and its current
  row returns near 2155–2160.
- Every plotted player line/band is centered on posterior `mu`; the latest line
  point equals the latest transformed mean, while the table retains its prior
  rating and rank. The graph's league reference is the transformed central
  League Player mean.
- No production, database, Git, or publication state changes during local
  implementation and verification.

### Validation and Result

- `overall-dynamic-ratings.js` adds the approved fixed `3.75` individual-player
  sigma in quadrature after the snapshot-scoped same-roster interpretation.
  The formatter marks the result and is idempotent for both newly calculated
  and cached dynamic snapshots; the fitted league mean and every real-player
  posterior remain unchanged.
- `stats.html` now plots each history knot at transformed posterior `mu`, with
  its band centered at `mu +/- sigma`. The dashed league reference uses the
  transformed fitted League Player mean, while the compact table continues to
  use the existing conservative ordinal and confidence/volume transforms.
- On the current 76-player / 347-game source, including all 99 league games at
  full weight, the stored League Player mean remains exactly
  `25.054284483826823`. Its pre-floor sigma is `1.2713838656794136`; after the
  fixed component the displayed individual sigma is `3.959661214537164`, its
  ordinal is `13.17530084021533`, and the compact row displays `2159` at shown
  rank `74` over 99 source matches. No score or rank is hard-coded.
- The 390px current-data audit opens DustinR with a central graph endpoint of
  `2916`, versus the intentionally unchanged conservative table row of `2593`.
  The path rises across 20 weekly markers, the one-sigma band is centered on
  it, and the dashed central league reference is `2753`. Six readable Y ticks,
  April-through-August labels, 14px minimum axis text, contained dialog
  geometry, correct Close focus, and zero page exceptions all pass. The audit
  screenshot is `/private/tmp/vball-current-session-exposure-graph.png`.
- The focused dynamic suite and 390px history regression pass. `npm test`
  passes 44/44, `npm run test:handoff` passes 25/25, all three JavaScript syntax
  checks pass, and `git diff --check` passes. The full clean-profile browser
  regression passes end to end, including the required Season Ranking / Trend /
  Game History consistency samples: JoeM remains 2258 over 55 games by default
  and 2409 over 49 games with the rolling window and confidence penalty removed
  and league games hidden. Play-tab sync/correction and four-hour throttle
  guards also remain green.
- The PWA app-shell cache identity is
  `vball-static-v31-central-history-league-variance`. Nothing was staged,
  committed, pushed, or deployed.
- The verified local audit server is listening at
  `http://127.0.0.1:5176/stats.html?tab=allTime&mode=composite`. The existing
  Tailscale client was reopened, but its prior private hostname remains
  DNS-unreachable and the CLI cannot load preferences, so remote audit access
  must not be represented as healthy until Tailscale reconnects.

### Exact Next Action

The user explicitly authorized publication on August 30, 2026. Commit only the
six reviewed implementation, test, cache, and ExecPlan files; preserve the five
unrelated database/handoff changes unstaged. Push the resulting `mac-beta` HEAD
to `origin/main`, then verify the GitHub Pages run and production file hashes.

### Release Preflight

- Refreshed `origin/main` exactly matches the verified base commit
  `58e27129d2910acf7a7d1fc675c938cc15ea199a`, so this release is a clean
  fast-forward containing only the scoped follow-up.
- The verified release scope is `overall-dynamic-ratings.js`, `stats.html`,
  `sw.js`, `test/overall-dynamic-history-browser.mjs`,
  `test/overall-dynamic-ratings.test.js`, and this ExecPlan.
- Preserve `HANDOFF.md`, `default_database`,
  `docs/CODEX_THREAD_HANDOFF.md`, `scripts/codex_handoff.py`, and
  `test/test_codex_handoff.py` unstaged and uncommitted.
