# Bayesian public-scale calibration

The user requested that the Overall Bayesian board use numbers comparable to
the normal board, with 1500 fixed as neutral. This change is display-only;
the preceding skill/trajectory/session-form implementation is preserved.

## Calibration

Frozen data: 384 games, 76 players, refreshed September 28 from the stats
endpoint, source `vballstats_2026-09-27_validated.json`, last updated
`2026-09-27T20:51:34.200Z`.

Compare the same 37 real players with at least ten Bayesian games against
normal Season Ranking with its date cutoff removed, league games included,
and default confidence penalties. The replay uses the existing six-month
taper and normal board's display rules. Use the interquartile range so a
single minimum/maximum does not determine the conversion.

| Matched-player distribution | Normal board | Previous Bayesian | Scaled Bayesian |
| --- | ---: | ---: | ---: |
| 25th percentile | 1504.79 | 1488.89 | 1444.43 |
| 75th percentile | 1981.10 | 1586.96 | 1934.81 |
| Middle-50% width | 476.31 | 98.08 | 490.38 |

Measured width ratio: **4.85652**. Freeze a rounded **5x** multiplier, applied
to displacement from 1500. The live app never recomputes this multiplier
from current players, filters, ratings, or games.

```
newDisplay = 1500 + 5 * (previousDisplay - 1500)
           = 1500 + 250 * (mu - 25)
```

Current real-player range: **750–2718** (KellieM to MattA), versus the normal
board's roughly 969–2885 with all played players. Different ranks, neutral
definitions, and confidence treatment mean their endpoints need not match.
No clamping, forced endpoints, percentile ranks, or population recentering.

The same conversion handles the table, previous-session ranking, history
curve, uncertainty bands, and league reference. Every public difference,
including a change over time and an uncertainty width, is expressed in the
new units. Smoothing and the ratio of update size to skill differences stay
unchanged. The model's legacy PUBLIC_POINTS constants retain their original
values because they are also used to set priors and temporal dynamics.

## Verification

- Compare fresh calculation against a saved snapshot from immediately before
  the display change: ratings, full history, playerRates, diagnostics, and
  constants are deeply identical. Prediction behavior is therefore unchanged;
  repeating predictive model sweeps is unnecessary.
- All 60 JavaScript unit tests pass, including neutral centering, symmetric
  scale, uncertainty scaling, and unchanged model calibration constants.
- Full browser regression passes, including Season Ranking / Trend / Game
  History agreement under default and advanced settings.
- Dynamic history browser checks pass, including band width, league line,
  historical endpoint, rank movement, cache reuse, and mobile layout.
- A mobile-sized browser loads the Tailscale preview using a saved snapshot
  from before the display change and shows 750–2718 without recalculation.
  The snapshot calculation timestamp is unchanged and no page errors occur.

Model version and snapshot key stay unchanged: existing V5 posterior caches
are valid. App version is `beta-20260928-1`; the service-worker cache is
`vball-static-v40-bayesian-display-scale`. No explanatory UI copy changed.

Reproduce the offline calibration from this worktree:

```powershell
node --import ./eval/register.mjs eval/overall_display_calibration.mjs
```

Preview: https://cortan.taile197db.ts.net:8455/stats.html?tab=allTime&mode=composite

Port 8455 remains assigned only to this checkout's dedicated server on
127.0.0.1:5192. Existing Tailscale services are unchanged. The user authorized
deployment to `main` on September 28; `default_database` remains excluded
from the publication batch. The combined release also includes the preceding
skill/trajectory/session-form changes, so older production V4 snapshots
require one new Bayesian calculation to create a V5 snapshot.
