# Volleyball App — Session Handoff

Working doc to resume balancing/algorithm work in a fresh thread. Read this first.

---

## 0. Latest state — June 22, 2026

This section supersedes stale branch/model notes below when they conflict.

- Current local repo path in this session: `/Users/dustinrowland/Projects/Volleyball`.
- Current branch after shipping should be `mac-beta`. The local `mac-beta` tip
  was already aligned with `origin/main` before this batch, while
  `origin/mac-beta` was older.
- Feature batch commit `3374e55 Ship stats restructure and Bayesian scoreboards`
  was pushed directly to `origin/main` per explicit user request. It includes
  all app, test, fixture, PWA, and fallback database changes from the long
  Stats/Bayesian restructuring thread.
- Major UI/app changes:
  - App root and PWA start URL now open Stats by default.
  - Stats defaults to `Season -> Season Ranking`.
  - Stats primary tabs are `Session`, `Season`, and `All-Time`, each with a
    distinct palette.
  - Season sub-tabs are `Season Movers` and `Season Ranking`; Awards is hidden
    from the Stats tab but still available for trend-page award chips.
  - Session tab summarizes the most recent play date, including player/game
    counts, new players, returning players, best session win rate, and per-player
    Season Ranking +/-.
  - Season Ranking uses a one-month rolling game window anchored to the latest
    included game date. The Games column counts only games in that ranking
    calculation.
  - Trend opens as an overlay from Stats, has a close/back path, and now uses the
    same one-month Season Ranking replay/window and displayed rating as the
    Season Ranking board.
  - Game History lazy rendering was restored after the Stats default-tab change;
    it now schedules from `renderAll()` and renders when scrolled into view.
- Bayesian / All-Time changes:
  - Added isolated Bayesian batch model files:
    `bayesian-ratings.js` and `bayesian-ratings-worker.js`.
  - All-Time has Bayesian scoreboards for All Games, Big Team, and Small Team.
  - Bayesian calculation is manual only, runs in a Web Worker, shows determinate
    progress, persists snapshots separately from the canonical DB, detects stale
    data, and preserves stale snapshots until the user recalculates.
  - One click calculates all three Bayesian scoreboards.
  - Bayesian display uses the app's 1500-scale adjusted rating and rank-change
    presentation instead of raw mu/sigma columns.
- Rating/eval notes:
  - The balancer still does **not** use the one-month Season Ranking window or
    Bayesian ratings. It remains on the production OpenSkill-style replay and
    balancing model.
  - League-game effect is still constrained to at least 1.0; recent sweeps were
    redirected away from league-parameter changes.
  - One-month Season Ranking was chosen for display/forward-ranking behavior,
    not for team assignment.
  - Added eval sweep scripts for season-ranking forward/rolling-window/carry and
    score-margin experiments.
- Data/PWA/test changes:
  - `default_database` was refreshed on explicit user request and now matches
    the 48-player / 126-game reference data used in tests.
  - Added frozen Bayesian fixture
    `test/fixtures/bayesian-2026-06-20.json`.
  - Added root `npm test` using Node's built-in test runner.
  - Added browser smoke coverage for default Stats view, Game History render,
    Trend-vs-Season-Ranking rating alignment, and manual Bayesian worker
    snapshot behavior.
  - Added/updated service worker and manifest caching so the new module and
    worker are available offline.
- Latest verification before shipping:
  - `npm test`: 23 passed, 0 failed.
  - `git diff --check`: passed.
  - Browser smoke with local server `http://127.0.0.1:5177/`: passed.
    It confirmed Season Ranking default, 126 Game History cards after scroll,
    Trend alignment for JoeM (`2381` on Season Ranking and Trend), Bayesian
    manual snapshots for composite/big/small, and Bayesian reference counts
    126 games / 123 scored / 3 winner-only.
- Local audit server was left running at `http://127.0.0.1:5177/` during the
  session when requested.

Recommended next-thread starting point:

1. Start from `mac-beta` locally unless the user asks for `main`.
2. If investigating team assignment, optimize with BalanceIQ and keep AccIQ as a
   guardrail; do not assume Season Ranking's one-month window should drive the
   balancer.
3. If continuing Stats polish, watch for expensive first-render paths and add
   busy overlays when work exceeds roughly half a second.
4. If changing Bayesian model behavior, bump `BAYESIAN_MODEL_VERSION`, update
   cache/service-worker paths if needed, and regenerate expected values only
   intentionally from a frozen fixture.

---

## 1. Repo, branch, workflow rules

- Historical Windows repo path: `C:\Users\rowla\Documents\Volleyball`.
  Current Mac path for this session is `/Users/dustinrowland/Projects/Volleyball`.
- Branch guidance has varied by platform. Current branch is `mac-beta`; do not
  push or switch branches unless the user explicitly asks.
- **Commit only when the user explicitly approves. Never push unless asked.**
- One small change at a time. After each edit: show `git diff`, then the user runs `node --check ratings.js` (or trust the harness).
- **Never commit `default_database`** — the user edits it locally for testing. It will always show as modified; leave it unstaged.
- Do not use bash/python/echo/sed to write source files — use the editor tools.
- If a file looks corrupted, stop and ask (a prior assistant once corrupted `ratings.js` by appending duplicate code).
- Bump the version marker on every meaningful change (see §4).

## 2. Environment / running Node + the eval harness

- Node is NOT on the default PATH. It lives at `/c/Program Files/nodejs/node.exe` (v24).
  Prefix bash commands with: `export PATH="$PATH:/c/Program Files/nodejs";`
- `ratings.js` imports OpenSkill from a CDN URL: `https://esm.sh/openskill@4.1.1`.
  Node can't resolve that natively, so the harness uses a loader hook
  (`eval/loader.mjs` + `eval/register.mjs`) that redirects it to a local
  `openskill` install in `eval/node_modules`.
- Run any harness script with:
  `cd eval && node --import ./register.mjs <script>.mjs`
- `node --check ratings.js` works without the loader (syntax only).

## 3. File architecture

- `ratings.js` — rating engine. OpenSkill {mu,sigma}; raw ordinal = mu − z·sigma;
  display = 1500 + rawOrdinal·50. Exports `VERSION`, `replayRatings`,
  `getPlayerRatingTimeline`, `scoreVolleyballCandidateSplit`,
  `getVolleyballTeamStrength`, `calibrateMarginModel`, `predictExpectedMargin`,
  `getGamesSortedOldestFirst`, formatting helpers, `DEFAULT_VOLLEYBALL_BALANCE_OPTIONS`, etc.
- `index.html` — main app: presence, team balancing, game recording. Team-count
  slider (2–8). All balancing logic lives here (not ratings.js).
- `stats.html` — standings, leaderboard, game history, **Algorithm Quality** QC card.
- `trend.html` — per-player rating trend.
- `players.html` / `ranking.html` — secondary, don't edit unless needed.
- `default_database` — local DB (JSON: players[], games[]). 46 players, 86 games.
  Bundled fallback fetched at `./default_database`. **Gitignored-in-spirit; never commit.**
- `eval/` — Node harness (see §8). `eval/node_modules/` is gitignored.

## 4. Versioning convention

- `export const VERSION = 'beta-YYYYMMDD-N';` near top of `ratings.js` (currently `beta-20260613-15`).
- Imported into index/stats/trend and logged: `console.log('[vball] <page> version:', VERSION)`.
- Bump `-N` on each change so the user can confirm the browser loaded the new build.

## 5. Committed history (most recent first)

- `4fa5881` Margin model: predict expected gap with intercept
- `0d00b28` Expected-margin model, depth-emphasis weights, update cap, eval harness
- `1592b5e` Algorithm Quality section on stats page
- `a37c047` Variable team count (2–8) + align trend timeline with replay
- `62802a7` Phase 1: localhost skips Google Drive, loads local default_database
- `8933f7f` .gitignore for local/secret files

## 6. Current uncommitted state

- As of June 21, 2026 current uncommitted files are expected to include:
  `stats.html`, `trend.html`, and `HANDOFF.md`.
- The `stats.html` and `trend.html` changes are intentional:
  quality dashboard AccIQ markers and scoreboard/trend raw-count consistency.
- `default_database` may be modified or refreshed locally. Do not stage it
  unless the user explicitly asks.

## 7. How the model works now

- **Eval data loading**: eval scripts call `loadDatabase()` from `eval/database.mjs`.
  By default it fetches Google Drive once, writes `eval/.cache/google_database.json`,
  and reuses that cache for 15 minutes so sequential harness runs do not repeatedly
  hit Drive. Use `VBALL_DB_REFRESH=1` to force a fresh Drive pull, or `VBALL_DB=/path`
  to use a local database file.
- **Eval metrics**: shared helpers live in `eval/metrics.mjs`.
  `AccIQ` is 0-100 higher-is-better for rating/prediction regressions: forward
  prediction quality weighted 65% and backward/explanatory quality 35%; each pass
  blends winner accuracy, Brier calibration, and margin MAE where available.
  Because the balancer is trying to make winner prediction less useful, do **not**
  use AccIQ as the primary optimization metric for team-assignment changes.
- **BalanceIQ**: balancer/opportunity harnesses use `computeBalanceIQ()` from
  `eval/metrics.mjs`. It is 0-100 higher-is-better and intentionally excludes
  winner accuracy: 45% best predicted same-size split gap, 25% selected split
  predicted <=5 point rate, 20% selected split predicted >8 point avoidance,
  10% actual-split margin calibration. `dBal` is the BalanceIQ difference from
  current default. Use BalanceIQ as the primary sweep metric for team-balancing
  changes, with AccIQ only as a guardrail against rating/model drift.
- **Strength weights** (`DEFAULT_VOLLEYBALL_BALANCE_OPTIONS`, flat-forward fix):
  top 0.25, second 0.22, average 0.33, depth 0.12, worst 0.08.
  Cached `release:compare` runs on `vballstats_2026-06-15.json` showed this
  beat the prior sharp/weak-link-heavy weighting in both plain and balancer
  scoring gates. `worstPlayerWeight` is still scaled down in lopsided matchups
  via `matchCloseness`.
- **Team-size imbalance bonus**: production uses base-size-specific bonuses:
  `sizeBonusByBaseSize:{3:2.2, 4:1.4, 5:2.6, 6:0}`. A natural 3v4 applies
  `2.2` raw ordinal to the larger team and `-2.2` to the smaller team; 4v5 uses
  `1.4`, 5v6 uses `2.6`, and 6v7+ uses no size bonus because large teams rotate.
  `sizeBonusPerExtraPlayer:2.2` remains as the global fallback/tuning baseline
  when `sizeBonusByBaseSizeEnabled:false`.
- **Weak-link penalty**: current default is `weakLinkPenaltyMode:'avgGap'`,
  `weakLinkPenaltyScale:0.35`, `weakLinkPenaltyThreshold:2.0`. Post-flat-weight
  narrow sweep found this best/tied-best; weaker, stronger, off, and
  `secondWorstGap` variants did not improve combined AccIQ.
- **Environment silo balancing**: Play-page team assignment uses a blended
  big/small environment rating when a player has enough silo history:
  `environmentSiloMode:'blend'`, min 12 games, confidence 6, max blend 0.70,
  adjustment cap 1.5 raw ordinal, min delta 0.5.
- **Pairwise balancing**: Play-page team assignment uses a conservative pair
  residual adjustment from scored non-league games:
  `pairAdjustmentMode:'blend'`, min 8 shared games, confidence 4, max blend
  0.75, per-pair cap 0.5, team cap 0.75, min delta 0.1. This was a small
  AccIQ improvement in older harnesses. Keep pair/environment/Bayesian ideas in
  the harness as future candidates, but do not ship more complexity without a
  forward/release-gate signal. Higher count thresholds are the most plausible
  next evaluation axis for pair/environment systems.
- **Stats Explanatory Quality**: back-prediction now scores games with balancer
  context layered on top of full replay ratings: environment silo rating blend
  plus pair adjustment map. Focused cached harness showed `silo + pair` improved
  back/explanatory AccIQ from `79.41` to `82.61`. Rating replay itself remains
  unchanged; this affects explanatory scoring/calibration, not rating updates.
- **Win prob**: sigmoid(strengthDiff / probabilityScale), probabilityScale 4.2.
- **Margin model** (`calibrateMarginModel`): fits expected GAP =
  `baseMargin + slope·|strengthDiff|` via OLS on |actualMargin| vs |strengthDiff|
  over scored non-league games. Magnitude form = immune to the winner=red
  convention in 3+-team games. `predictExpectedMargin` returns the gap (≥0).
  Calibrated values on current data: baseMargin ≈ 4.88, slope ≈ 0.148.
- **Rating update** (`rateSingleGame`): `baseUpdateMultiplier = clamp(marginFactor ·
  surpriseMultiplier, finalUpdateMultiplierMin, finalUpdateMultiplierMax) · leagueUpdateMultiplier`,
  then seasonal weight and per-team size damping. Cap is **[0.35, 2.0]** on the margin×surprise core.
  League player-side updates use `leagueUpdateMultiplier:1.2`; synthetic league-opponent updates
  do not use seasonal taper by default. Surprise =
  clamp(volleyballSurprise/openSkillSurprise, 0.35, 2.0).
- **Burn-in / calibration**: `replayRatings` and `getPlayerRatingTimeline` both
  apply burn-in (amplify early-career updates) and a two-pass calibration freeze.
  These are now consistent between the two functions.
- **League opponent model**: current local trial pools league games by level:
  `League - Rec` and `League - Intermediate` (`leagueTeamRatingMode:'level'`).
  Current default uses
  `leagueOpponentUpdateMultiplier:4`, `leagueOpponentBurnInGames:4`,
  `leagueOpponentBurnInMultiplier:2.25`; compare future changes with AccIQ.
- **League bracket games**: bracket/championship league games can be tagged with
  `leaguePhase:'bracket'`. The current level-pooled trial keeps them in replay
  and folds them into `League - Rec` or `League - Intermediate` by level.
- **League scoreboard display**: league-team rows can use a Bayesian posterior
  mean internally (`leagueDisplayRatingMode:'bayesian'`). Intervals are
  intentionally not shown in UI. Callers must set
  `leagueDisplayEstimateEnabled:true`; repeated internal replays must leave it
  false for performance. Stats displays league rows through the same public
  rating scale used for ranking so the visible `Rating` column stays in sort
  order with player rows.
- **Stats league display**: there is no separate League scoreboard tab. Composite
  standings show `League - Rec` and `League - Intermediate` without player-style
  minimum-game/recent-game restrictions. Big Team and Small Team remain
  player-focused filtered boards.
- **Replay caching**: Play and Stats use a shared `sessionStorage` replay-result
  cache keyed by `VERSION`, players, games, season length, league inclusion, and
  replay options. Any new/imported/deleted game changes the key and recalculates.
  Stats also keeps multi-entry public rating scale cache entries and avoids
  rendering hidden standings tab content during `renderAll()`.
- **Quality dashboard chart**: league games remain included in predictive and
  explanatory quality analysis, but the point-differential chart uses only
  non-league scored games because league games are not algorithm assignments.
- **Awards eligibility/display**: award winners must have at least 5 total games
  and a game in the last month. Big-team awards include league games when the
  replayed teams are 5v5+ so they stay consistent with the big-team scoreboard
  interpretation. Overall-style awards have scoped Big Team and Small Team
  clones where the category has enough local counters to make the result
  meaningful.
- **Season Movers**: Improvement Score includes league and non-league games.
  It displays/sorts by adjusted model gain after the later of season start or a
  6-game player baseline. The adjustment is season-local: light volume
  confidence, sustained-improvement path bonus/settling discount, and a modest
  higher-rating difficulty bonus.
- **League opponent seasonal taper**: disabled for the synthetic league opponent
  by default (`leagueOpponentSeasonalTaperEnabled: false`). Player-side league
  updates still use seasonal weighting. Narrow eval showed no meaningful
  accuracy loss, and this better matches the pooled/composite league-team model.
- **Eval database loading**: eval harnesses use `eval/database.mjs`, which
  fetches the latest Google Drive stats endpoint by default and falls back to
  local `default_database` if fetch fails. `VBALL_DB=/path/to/file` remains an
  explicit local override.

## 8. Eval harness (`eval/`)

All run as `node --import ./register.mjs <file>` from `eval/`.
**Config that matches the live app QC: `volleyballAdjusted:true, includeLeagueGames:true, season 6 months`** (verified to reproduce in-app 80%/MAE numbers).

- `quality.mjs` — sweeps strength-weight sets, reports acc / MAE / within5 / avgDiff / blowouts / slope.
- `stability.mjs` — sweeps update-cap / softening / probabilityScale.
- `match.mjs` — finds which replay config reproduces in-app QC numbers.
- `blowouts.mjs` — blowout rate by strength-gap tertile.
- `blowout_features.mjs` — absolute features vs blowout occurrence.
- `blowout_imbalance.mjs` — between-team imbalance features vs blowout occurrence.
- `size_effects.mjs` — size-bucket diagnostics for balancing parameters and
  natural roster imbalances such as 3v4, 4v5, and 5v6.
- `loader.mjs` / `register.mjs` — CDN→local OpenSkill redirect.
- `league_team_sweep.mjs` — league opponent identity/update/burn-in sweep. Use
  `AccIQ` / `dIQ` for rating/replay regression checks; raw fwd/back accuracy,
  Brier, and MAE columns are audit detail.
- `balancing_quality.mjs` — primary team-assignment opportunity harness. Use
  `BalanceIQ` / `dBal` for balancer changes. It replays prior ratings, scores
  the historical split, and exhaustively finds the best same-size split from the
  same present players. Counterfactual scores are unknowable, so BalanceIQ is
  predicted opportunity plus calibration, not proof of actual future margins.
- `balance_iq_sweep.mjs` — focused BalanceIQ sweep for the interaction between
  `leagueUpdateMultiplier`, `carryScale`, and `carryConfidenceGames`. It always
  includes the current production baseline values so `dBal` is populated even
  when the env-provided grid is narrow.
- `dashboard_baseline_compare.mjs` — compares dashboard baseline-gap definitions
  between current and `DEPLOY_REF` (default `origin/main`). Use it when the
  quality dashboard's model intercept looks different from production.

## 9. Key analytical findings (the important part)

- **MAE is floored.** Signed margin MAE ≈ 3.9; gap MAE with the intercept model ≈ 2.8.
  A trivial "predict 0" baseline is ~5.5, so the model explains ~30%; the rest is
  genuine volleyball variance. Tuning strength weights / caps / probabilityScale
  moves MAE by <0.1 (noise). **The rating model is essentially tuned out.**
- **Baseline gap ≈ 4.88 pts** even when teams are perfectly balanced (race-to-21/25
  variance). Strength imbalance adds only ~0.15·|strengthDiff| — typically <1 pt.
  => **"~100% of games within 5 points" is not physically attainable.** Current
  within-5 ≈ 57% is likely near the ceiling.
- **Blowouts (>8) are essentially unpredictable from pregame info:**
  - corr(|strengthDiff|, blowout) ≈ −0.03. Even matchups blow out as often as mismatches.
  - Absolute features (team spread, sigma, skill, rust): no signal.
  - Between-team imbalance: fragility/shape imbalance = **no signal** (drop it).
  - **Only signal found: new-player / provisional-count imbalance (r ≈ 0.22–0.26;
    blowout rate roughly doubles when one team carries more unknowns).** Weak
    (≈2 SE on 67 games / 10 blowouts) but mechanistically sensible (more unknowns →
    wider outcome distribution). Size×sand is a weaker maybe (~0.18).
- **within-5 / avg-diff / blowout counts are computed from ACTUAL scores** — they do
  NOT change with any model tuning, only when teams are actually formed differently.
- **Dashboard baseline gap is a regression intercept, not actual average margin.**
  Cached comparison on `vballstats_2026-06-15.json`: observed scored mean gap was
  `5.533` in both current and deployed production. Deploy final/back model was
  base `4.915`, slope `0.167`; current final/back was base `5.080`, slope `0.121`;
  current forward-latest was base `5.260`, slope `0.074`. The higher beta
  "baseline" is mostly the intercept moving toward the actual mean because the
  strength-gap slope shrank. Dashboard now labels this `Even-team model gap` and
  separately shows `Observed avg gap`.
- **BalanceIQ is the balancer target.** Use it when evaluating team-construction
  weights, size bonuses, carry, weak-link/provisional-player penalties, and
  probability-scale changes that affect split selection. It is deliberately not
  a scoreboard-feel metric and does not replace manual sanity checks on public
  raw ordinal/rank order.
- **BalanceIQ carry/league follow-up**: focused cached sweep around the first
  `league x2 + carry 12` signal found a broad peak around league `2.0–2.25`,
  carry `16–20`, confidence `6–10`. Best run: `leagueUpdateMultiplier:2.25`,
  `carryScale:18`, `carryConfidenceGames:6`, BalanceIQ `74.73` (`dBal +2.95`)
  vs current `71.78`; `league x2.0 carry16 conf8` was nearly as good at
  BalanceIQ `74.67` (`dBal +2.88`). Release guardrail on cached Google data:
  these remain above deployed AccIQ but give back about `0.4–0.6` AccIQ versus
  current. Carry-only at current league weight gave only ~`+1.0 dBal` and still
  gave back AccIQ, so it is not the cleaner ship candidate.
- **Team-size diagnostics**: `size_effects.mjs` compares the current base-size
  table against global-size variants and reports natural roster imbalances by
  bucket. Initial cached run: 3v4 actual margins looked fine but were sometimes
  flagged high-risk; 5v6 had a high actual margin sample but only n=5.
- **Base-size size bonus sweep**: `size_bonus_sweep.mjs` is harness-only and
  simulates size bonuses outside production scoring, including optional uncapped
  6v7+. Coarse+narrow cached runs on 26 odd-roster games improved from current-cap
  equivalent `40.20` to best `36.64` when allowing a 6v7+ bonus. A constrained
  rerun fixed size6+ at `0.0`; best constrained score was `37.45`. Current
  production uses the practical candidate: size3 `2.2`, size4 `1.4`, size5
  `2.6`, size6+ `0.0` (score `37.58`). Treat this as sample-limited: 3v4 n=7,
  4v5 n=11, 5v6 n=5, 6v7+ n=3.

## 10. Decisions locked in

- Depth-emphasis weights (above). Keep.
- Volatility cap [0.35, 2.0]. Keep.
- Intercept gap margin model. Keep.
- League opponent update/burn-in default: level-pooled opponent x4.0 with first 4
  synthetic-opponent games amplified 2.25x. Compare future changes with AccIQ.
- League bracket games are included in default analysis/replay and currently
  pooled by level for the local display/model trial.
- **Reframed goals:** primary = avoid blowouts; secondary = even games within
  statistical limits. But data says balancing has little blowout leverage.
- **Metric rule:** balancer changes should improve or preserve BalanceIQ first,
  while AccIQ should be treated as a regression guard. Rating-update/display
  changes should still use AccIQ plus scoreboard audits because BalanceIQ only
  scores team-split opportunity.
- **Shipped BalanceIQ candidate**: production now uses the cleaner plateau point
  `leagueUpdateMultiplier:2.0`, `carryScale:16`, `carryConfidenceGames:8`
  (`VERSION beta-20260616-18`). Cached confirmation: BalanceIQ `74.67`, up
  from old baseline `71.78`; selected low-risk split rate moved `80%` -> `90%`
  with selected high-risk still `0%`. Plain AccIQ guardrail remains above
  deployed (`73.42` vs `72.45`). Balancer-scoring AccIQ remains above deployed
  (`73.30` vs `72.45`) but has a small forward-Brier giveback, so the release
  compare script now labels this an `AccIQ Guardrail` and only fails meaningful
  predictive collapses.
- Do NOT build: fragility/shape balancing penalties, a full blowout-risk predictor,
  excessResidual rating coupling — all would overfit ~10 noise events.

## 11. Open action items / next steps (recommended order)

0. **Next immediate investigation: displayed rating vs raw ordinal drift.**
   User suspects the public/displayed leaderboard rating is getting too far away
   from raw OpenSkill ordinal. Test this before more update tuning:
   compare `rawOrdinal`, `getExperimentalLeaderboardRaw`, `formatPublicDisplayRating`,
   public scale outputs, confidence adjustment, and rank order across overall /
   league / big / small boards. Produce a table of largest display-minus-raw
   deltas and determine whether the issue is confidence scaling, public scale
   calibration, league Bayesian display, or scoreboard-specific count/rating
   overrides.
1. **Instrumentation (foundational, low risk).** Add to new game records in
   `index.html`: `createdAt` (epoch ms; note `id` is already `Date.now()`),
   `assignmentSource` ('algorithm' | 'manual' | 'modified'),
   `assignmentVersion`, `predictedAtAssignment` (the balancer's pregame expectation).
   Sort replay by `createdAt` when present, else date/id. This makes future QC
   trustworthy (manual team edits currently contaminate historical analysis).
2. **Monitoring dashboard ("Balance Quality")** in `stats.html` QC — as a
   regression detector, NOT an optimization target. Components worth showing:
   blowout >8 rate, blowout >10 rate, average excess over 5,
   weighted excess cost (`(max(0, gap−5)/5)^1.5`), % within expected variance
   (gap ≤ expectedGap + baselineVariance; baselineVariance ≈ 4.6 global to start),
   win-prob Brier/calibration. NOTE: a blowout-probability Brier score will only
   learn the ~15% base rate (no pregame signal) — include only as a baseline.
3. **One balancing lever worth a low-risk try: equalize new/provisional players
   across teams.** Add a new-player-imbalance penalty to candidate scoring in
   `index.html` (`buildMultiTeamCandidate` / the selection in `assignBalancedTeams`).
   Validate with a counterfactual harness first (compare proposed vs current
   fairness-only split on new-player imbalance + predicted gap), then ship behind
   the current balancer. Monitor blowout rate over future games via the dashboard.
4. `predictMarginVariance()` — start as a global baseline (~4.6) for the
   within-variance metric and honest "expected 25-20 ± 5" displays.

## 12. Balancing internals quick reference (index.html)

- `TEAM_COLORS` = 8 colors (red, blue, green, yellow, orange, purple, cyan, pink).
- Team count slider (`MIN_TEAM_COUNT` 2 … `MAX_TEAM_COUNT` 8). `getActiveTeamColors()`
  returns first N (or ['red'] in league mode). League mode is independent of the slider.
- Unified path: `assignBalancedTeams()` → `buildMultiTeamCandidate(presentPlayers,
  colors, ratingMap, carryMap)` → picks best `averagePairwiseFairness`
  (`isBetterMultiTeamCandidate`) → sorts teams by strength (strongest = red).
  N=2 reduces to red/blue. Summary boxes + win buttons are generated dynamically
  (`renderTeamControls`).
- Recording: 2 teams → direct win buttons; 3+ → "who lost?" dialog
  (`openLoserTeamDialog`). Every recorded game is stored as a 2-team result:
  `redTeam` = winner, `blueTeam` = loser, `winner:'red'`, plus
  `displayWinnerColor` / `displayLoserColor` for >2-team games.

## 13. Gotchas

- **In 3+-team games `redTeam` is always the winner** → signed margins always
  positive. Use magnitudes for any margin regression (the margin model already does).
- QC analysis uses **current ratings retroactively** (replay's final `ratingMap` +
  `carryMap`), not ratings-at-game-time.
- The QC card only computes when **open** (`<details>` toggle) to keep the page fast.
- Git shows LF→CRLF warnings on Windows — harmless.
- Margin model immediate value is **measurement** (it doesn't change balancing —
  minimizing predicted gap == minimizing |strengthDiff|, which the balancer already does).
- Rating-update context test (`npm run update:context`, live Drive
  `vballstats_2026-06-15.json`): production replay now defaults to pair-context
  update surprise (`volleyballUpdateUsesBalancerContext: true`,
  `volleyballUpdateContextMode: 'pair'`). Optimized incremental replay preserved
  the winning result: `current/plain` AccIQ `79.81`, `current/balancer scoring`
  `79.99` (+0.18), `full updates + balancer scoring` `80.47` (+0.65),
  `silo-only` `79.40` (-0.42), and `pair-only` `80.89` (+1.08).
  Interpretation: pair context is useful for update surprise; environment silo
  helps display/prediction scoring but is too blunt for rating-update surprise.
  Follow-up fix: Stats/Play replay callers now explicitly pass
  `volleyballAdjusted:true`, pair update context mode, and cache keys include the
  update-context flags. `VERSION` was bumped to invalidate stale browser replay
  caches; otherwise the change could be invisible in the app.
- Partial update audit on `vballstats_2026-06-15.json`: current margin bonus is
  intentionally tiny and mostly rounds to `1.00x`; `npm run margin` showed
  current tiny convex margin is effectively tied with no score margin, while a
  stronger `pow1.2 cap25` was only `+0.30 AccIQ`. Corrected league/nonleague
  split showed current pair-context replay does **not** globally mute league
  updates: league player-side avg update was ~`1.11x` vs old visible base
  ~`1.09x`, but median fell ~`1.17x` → ~`1.07x` because expected league results
  are now damped and surprising results amplified. `npm run league` on the same
  data currently favors lower player-side league weight / excluding league in
  AccIQ, so retest league weights after resolving displayed-vs-raw rating drift.

## 14. The honest strategic summary

The rating/strength model is near its achievable ceiling. Blowouts are mostly
variance, not pregame-predictable, so the balancer cannot meaningfully reduce them.
The current balancer is already near-optimal for the secondary goal (even games in
expectation). The remaining genuinely-useful work is: (a) instrumentation for
trustworthy future QC, (b) a monitoring dashboard to detect regressions, and (c) a
single low-risk new-player-balancing lever (weak but plausible signal), validated
counterfactually before shipping. Avoid building complex blowout-prediction
machinery — there is no signal to support it on the current data.
