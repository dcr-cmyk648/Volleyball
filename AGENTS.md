# Project Constraints

- League games must materially contribute to ratings. Keep league update impact at least `1.0x`; do not add hidden league `mu` or `sigma` dampeners below `1.0`.
- After every change touching ratings, rating display, league handling, Season Ranking, Trend, or Game History, run a consistency pass across Season Ranking, Trend, and Game History. Verify they use the same rating options, league inclusion rules, team-size filtering, rolling-window game set, and visible rating/rank/game-count transform for sampled players.
- After every interface/UI change, start or continue a local server and report the exact server URL in chat so the user can open the app and audit the change.
- The user-approved Season Ranking missing-game display penalty is tiered: `10` points per missing game below 10 games, `5` points per missing game from 10 through 50 games, and `1` point per missing game above 50 games when the player's pre-volume display rating is at least 1500. Do not tune or change these tiers for accuracy experiments unless the user explicitly asks for a penalty change.
- At the start of a new day, refresh from the Google Drive stats source before running analysis or sweeps. If the Google Drive database is newer than `default_database`, update `default_database` from that source so local experiments do not use stale game data.
