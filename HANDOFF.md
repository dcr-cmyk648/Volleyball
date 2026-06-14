# Volleyball App — Session Handoff

Working doc to resume balancing/algorithm work in a fresh thread. Read this first.

---

## 1. Repo, branch, workflow rules

- Repo: `C:\Users\rowla\Documents\Volleyball` — static HTML/JS app served via GitHub Pages.
- **Work only on `beta`. Never touch `main`.** `main` is the stable production branch.
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

- `export const VERSION = 'beta-YYYYMMDD-N';` near top of `ratings.js` (currently `beta-20260613-14`).
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

- `default_database` — modified (user testing). **Do not commit.**
- Untracked diagnostic scripts (decide whether to keep/commit): `eval/blowouts.mjs`,
  `eval/blowout_features.mjs`, `eval/blowout_imbalance.mjs`.

## 7. How the model works now

- **Strength weights** (`DEFAULT_VOLLEYBALL_BALANCE_OPTIONS`, depth-emphasis):
  top 0.30, second 0.24, average 0.28, depth 0.10, worst 0.08 (sum 1.0).
  `worstPlayerWeight` is scaled down in lopsided matchups via `matchCloseness`
  (flagged as possibly counter to "weak players should drag"; not yet changed).
- **Win prob**: sigmoid(strengthDiff / probabilityScale), probabilityScale 4.4.
- **Margin model** (`calibrateMarginModel`): fits expected GAP =
  `baseMargin + slope·|strengthDiff|` via OLS on |actualMargin| vs |strengthDiff|
  over scored non-league games. Magnitude form = immune to the winner=red
  convention in 3+-team games. `predictExpectedMargin` returns the gap (≥0).
  Calibrated values on current data: baseMargin ≈ 4.88, slope ≈ 0.148.
- **Rating update** (`rateSingleGame`): `baseUpdateMultiplier = clamp(marginFactor ·
  surpriseMultiplier, finalUpdateMultiplierMin, finalUpdateMultiplierMax) · seasonalWeight`,
  then per-team size damping. Cap is **[0.5, 1.75]** on the margin×surprise core
  (NOT including seasonalWeight, so seasonal taper is preserved). Surprise =
  clamp(volleyballSurprise/openSkillSurprise, 0.35, 2.0).
- **Burn-in / calibration**: `replayRatings` and `getPlayerRatingTimeline` both
  apply burn-in (amplify early-career updates) and a two-pass calibration freeze.
  These are now consistent between the two functions.
- **League opponent model**: current local trial pools all league games into one
  synthetic `League Team` (`leagueTeamRatingMode:'pooled'`). Current default uses
  `leagueOpponentUpdateMultiplier:4`, `leagueOpponentBurnInGames:4`,
  `leagueOpponentBurnInMultiplier:2.25`, chosen from the league-team sweep by the
  internal weighted quality metric below.
- **League bracket games**: bracket/championship league games can be tagged with
  `leaguePhase:'bracket'`. The current pooled local trial keeps them in replay
  and folds them into the same displayed/modelled `League Team` as all other
  league games.
- **League scoreboard display**: league-team rows use a Bayesian posterior mean
  for display (`leagueDisplayRatingMode:'bayesian'`). Intervals are intentionally
  not shown in UI. Callers must set `leagueDisplayEstimateEnabled:true`; repeated
  internal replays must leave it false for performance. Stats league context rows
  display this league rating directly instead of applying the player public-rating
  scale, because component league teams are aggregate opponents rather than
  player-like leaderboard entries.
- **Stats League scoreboard exception**: only the Stats page's League scoreboard
  uses `leagueTeamRatingMode:'context'` so league opponents are broken out into
  Rec/Intermediate/Sand/Bracket components. All other pages/modes keep pooled
  `League Team`.
- **Replay caching**: Play and Stats use a shared `sessionStorage` replay-result
  cache keyed by `VERSION`, players, games, season length, league inclusion, and
  replay options. Any new/imported/deleted game changes the key and recalculates.
  Stats also keeps multi-entry public rating scale cache entries and avoids
  rendering hidden standings tab content during `renderAll()`.

## 8. Eval harness (`eval/`)

All run as `node --import ./register.mjs <file>` from `eval/`.
**Config that matches the live app QC: `volleyballAdjusted:true, includeLeagueGames:true, season 6 months`** (verified to reproduce in-app 80%/MAE numbers).

- `quality.mjs` — sweeps strength-weight sets, reports acc / MAE / within5 / avgDiff / blowouts / slope.
- `stability.mjs` — sweeps update-cap / softening / probabilityScale.
- `match.mjs` — finds which replay config reproduces in-app QC numbers.
- `blowouts.mjs` — blowout rate by strength-gap tertile.
- `blowout_features.mjs` — absolute features vs blowout occurrence.
- `blowout_imbalance.mjs` — between-team imbalance features vs blowout occurrence.
- `loader.mjs` / `register.mjs` — CDN→local OpenSkill redirect.
- `league_team_sweep.mjs` — league opponent identity/update/burn-in sweep. Use
  `intQ` as the primary internal comparison metric when judging close candidates:
  predictive score = margin quality 45 + Brier 25 + balanced-rate 20 + winner
  accuracy 10; back/explanatory score = margin quality 50 + Brier 30 + winner
  accuracy 20; `intQ` = predictive 60 + back/explanatory 40. Keep the old
  `score` column as a secondary tie-breaker, not the main decision rule.

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

## 10. Decisions locked in

- Depth-emphasis weights (above). Keep.
- Volatility cap [0.5, 1.75]. Keep.
- Intercept gap margin model. Keep.
- League opponent update/burn-in default: context opponent x4.0 with first 4
  synthetic-opponent games amplified 2.25x. Chosen because the narrow sweep had
  the best internal weighted quality score (`intQ 81.84` vs current/default
  pre-change `81.68`).
- League bracket games are included in default analysis/replay and currently
  pooled with all other league games for the local display/model trial.
- **Reframed goals:** primary = avoid blowouts; secondary = even games within
  statistical limits. But data says balancing has little blowout leverage.
- Do NOT build: fragility/shape balancing penalties, a full blowout-risk predictor,
  excessResidual rating coupling — all would overfit ~10 noise events.

## 11. Open action items / next steps (recommended order)

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

## 14. The honest strategic summary

The rating/strength model is near its achievable ceiling. Blowouts are mostly
variance, not pregame-predictable, so the balancer cannot meaningfully reduce them.
The current balancer is already near-optimal for the secondary goal (even games in
expectation). The remaining genuinely-useful work is: (a) instrumentation for
trustworthy future QC, (b) a monitoring dashboard to detect regressions, and (c) a
single low-risk new-player-balancing lever (weak but plausible signal), validated
counterfactually before shipping. Avoid building complex blowout-prediction
machinery — there is no signal to support it on the current data.
