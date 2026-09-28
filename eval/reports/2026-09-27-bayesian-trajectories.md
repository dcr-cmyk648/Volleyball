# Overall Bayesian skill trajectories

Historical report: the display-only calibration in
`2026-09-28-bayesian-display-scale.md` supersedes the public range and point
units below. Model fitting and predictive validation results remain unchanged.

Implemented locally from deployed commit `4e4eb16`. No commit or publication.
The change applies to the Overall/All Games Bayesian board and its history
overlay. Big Team/Small Team retain their existing batch model; Season Ranking,
Trend, Game History, and team assignment retain their existing rating models.

## Model and display

- Display posterior mean as `1500 + 50 * (mu - 25)`, including the history
  curve, uncertainty bounds, and external league reference. Neutral skill is
  exactly 1500. No percentile remapping, forced range, or population recentering.
- Starting skill SD: 180 public points, up from 45. Players can differ
  substantially without changing the slow temporal prior.
- Lasting process SD remains 20 points per square-root month.
- Add independent player/date form with SD 100 points. All games a player
  plays on that date share this temporary effect. It enters the game
  likelihood and is integrated into the skill covariance, but is excluded
  from published skill and the next date's lasting state.
- Keep the partially pooled, exposure-based growth model, with population
  rate prior mean changed from +1 to 0. Growth and decline are learned rather
  than awarded for playing. Population rate SD 2 and individual deviation
  SD 3 are unchanged.
- External league context SD remains 25. Existing distinct opponent contexts,
  bracket adjustment, full per-game likelihood weight (10), and league
  individual uncertainty remain intact. Wider context priors were explored
  but performed worse on held-out games.
- New model/storage identity invalidates old Overall snapshots. Existing
  manual Calculate action creates the new snapshot; old saved values cannot
  silently appear on the new scale. Service-worker and application versions
  are bumped. User-facing explanatory copy is unchanged.

## Data and observed range

Fresh direct stats endpoint response: 384 games, 76 players, source
`vballstats_2026-09-27_validated.json`, updated `2026-09-27T20:51:34.200Z`.
The refreshed local `default_database` is intentionally excluded from changes
to publish.

Deployed range reproduced exactly: 2737–2935. Subtracting only the erroneous
1250-point offset would give 1487–1685. The selected model gives **1350–1744**
(KellieM to MattA), both across all played players and with the 10-game filter.
The range follows the data and can expand with stronger evidence.

## Forward checks

`eval/overall_dynamic_validation.mjs` fits only games on dates strictly before
each test date, holds out the whole session, then predicts point share. It
does not call point-share probabilities match-win probabilities. New session
form has expectation zero; skill forecasts include the learned exposure drift
from the previous completed appearance. No current-day game enters the fit.

Initial comparison used the latest 8 dates (September 3–27), 37 games. Broader
starting/context alternatives were checked there; 180/25 was selected. A
separate earlier block of 16 dates (July 23–August 27), 108 games, was then
checked without further tuning. Total: 145 games on 24 held-out dates.

| Period | Metric | Deployed | Selected |
| --- | --- | ---: | ---: |
| Latest 37 games | Point-share MAE | 0.074792 | 0.075329 |
| Latest 37 games | Point-share RMSE | 0.089878 | 0.089970 |
| Earlier 108 games | Point-share MAE | 0.063691 | 0.064788 |
| Earlier 108 games | Point-share RMSE | 0.083986 | 0.084001 |
| All 145 games | Point-share MAE | 0.066524 | 0.067478 |
| All 145 games | Point-share RMSE | 0.085528 | 0.085564 |
| All 145 games | Fractional cross entropy | 0.692175 | 0.692185 |

Prediction error is effectively similar, with slightly worse MAE; this is
not evidence of a predictive accuracy improvement. The latest-date selection
is a calibration sample, not an untouched final test set. External-reference
calibration still assumes comparable opponent contexts over time.

Smoothing does not guarantee every update is smaller than the deployed,
strongly compressed model. For September 27's ten participants, average
absolute skill movement is 13.385 points versus 8.601 previously, principally
because less-established players can now be calibrated more meaningfully.
The session-form regression compares otherwise identical models and verifies
that a same-day run has less lasting impact when form is included.

## Verification

- All 59 JavaScript unit tests pass, including tests for exact neutral display,
  no automatic growth from balanced exposure, evidence-supported wide skill
  gaps, same-day form smoothing, shared externally evidenced improvement,
  genuine decline, deterministic fitting, and posterior/history endpoints.
- Full browser regression passes. Season Ranking, Trend, and Game History
  match at 2300 / 55 games on the reference fixture, and at 2409 / 49 games
  with the advanced settings. Existing filtered board behavior is preserved.
- Dynamic-history browser regression passes, including table/chart endpoint,
  uncertainty-band width, league reference, cache invalidation/reuse, rank
  movement, and mobile layout.
- Current-data fitting takes roughly four seconds on this host; worker
  calculation also performs a previous-session fit. Performance depends on
  the number of player/date states.

Local preview: `http://127.0.0.1:5192/stats.html?tab=allTime&mode=composite`.

Reproduce from the worktree with Node:

```powershell
$env:VBALL_BASE_SOURCE = '../pair-3x-main/overall-dynamic-ratings.js'
node eval/overall_dynamic_validation.mjs
$env:VBALL_VALIDATION_DATES = '16'
$env:VBALL_VALIDATION_SKIP_LATEST = '8'
node eval/overall_dynamic_validation.mjs
```

Without `VBALL_BASE_SOURCE`, the harness reads the deployed module with
`git show 4e4eb16:overall-dynamic-ratings.js` (requires child-process access).
