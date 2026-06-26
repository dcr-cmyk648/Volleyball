# Project Constraints

- League games must materially contribute to ratings. Keep league update impact at least `1.0x`; do not add hidden league `mu` or `sigma` dampeners below `1.0`.
- After every change touching ratings, rating display, league handling, Season Ranking, Trend, or Game History, verify that Season Ranking, Trend, and Game History are using the same rating options and rolling-window game set.
- The Season Ranking missing-game display penalty is `5` points per missing game. Do not tune or change it for accuracy experiments unless the user explicitly asks for that penalty to change.
- At the start of a new day, refresh from the Google Drive stats source before running analysis or sweeps. If the Google Drive database is newer than `default_database`, update `default_database` from that source so local experiments do not use stale game data.
