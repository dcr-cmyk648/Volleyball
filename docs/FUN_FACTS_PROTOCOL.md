# Game-Day Fun Facts Protocol

Use this protocol when the user asks for game-day fun facts. The purpose is to
produce exactly ten accurate, upbeat observations about the newest recorded
play date, compare that play with the earlier dataset, format the result for a
group text, and save a verified copy to Google Drive.

## Trigger and authorization

Natural requests such as `Generate today's fun facts`, `Make the game-day fun
facts`, or `Publish fun facts for the latest games` trigger the workflow.

That request authorizes:

- a fresh read of the configured Google Drive stats source;
- analysis of the canonical volleyball dataset;
- creation or replacement of the dated fun-facts Google Doc described below.

It does not authorize application/rating changes, staging, committing, pushing,
sharing changes, or publication anywhere outside the selected Drive document.

## 1. Freeze the source and play date

1. Follow the repository startup and canonical-thread checks in `AGENTS.md`.
2. Force a fresh, direct Google Drive stats read with cache bypassed. A cached
   response or `default_database` fallback is not acceptable for fun-facts
   publication, even if it loads successfully for other repository analysis.
3. Prove freshness from the Drive file's modification time or another reliable
   source timestamp. A date encoded in the source filename may be used as a
   secondary check. If the freshest provable source is more than two calendar
   days old, its timestamp is unavailable, the direct fetch fails, or the
   requested recent game day is absent, stop without generating facts or
   writing a Drive document. Tell the user the newest source timestamp and play
   date that could be observed, when available.
4. If the verified fresh source is newer than `default_database`, refresh the
   local fallback as required by `AGENTS.md` while leaving it unstaged unless
   the user separately asks otherwise.
5. Validate the database shape and ignore malformed records rather than
   silently treating them as games.
6. Set the focus date to the greatest valid `game.date` in the refreshed
   canonical dataset. Never assume that it equals the calendar date.
7. If the focus date is not today, say so plainly in the final report. If the
   user indicated that newer games should exist, treat the mismatch as a stale
   source and stop rather than publishing an older date.
8. Define:
   - `focus games`: valid games dated exactly on the focus date;
   - `historical baseline`: valid games strictly before the focus date;
   - `through-date totals`: valid games on or before the focus date.
9. Exclude later-dated games from every comparison when regenerating facts for
   a past or backfilled date.

Record the source filename, focus date, focus-game count, focus-player count,
and historical-game count for verification. Do not put game IDs, raw source
records, prompts, tokens, or private connector metadata in the published Doc.

## 2. Build candidate facts

Generate more than ten candidates, including a candidate pass for every person
who played on the focus date, then select the strongest non-overlapping set.
Every candidate must be directly supported by recorded fields or a deterministic
calculation from them.

Useful candidate families include:

- session participation: games, players, teams, total points, and court mix;
- competitive games: one-point games, games within three or five, and the
  focus date's close-game rate compared with earlier play dates;
- player-day results: wins, win rate, games played, and tied/personal-best days;
- milestones reached on the focus date: 10th, 25th, 50th, 75th, 100th, or later
  games/wins, plus genuine debuts and returns after a long gap;
- positive streaks that are still active through the focus date;
- teammate and opponent variety achieved on the focus date;
- successful pairs or groups, provided the stated shared-game sample is clear;
- league, court-type, or team-size achievements using like-for-like history;
- rating movement only when replayed with the same production options and
  clearly labeled as a rating fact rather than an observed game result.

Look for legitimate shared achievements that can recognize several people in
one readable fact: tied milestones, strong shared records, successful groups,
first-time combinations, or a set of players who all reached the same meaningful
threshold. Do not manufacture a group merely to add names.

Do not infer unrecorded events such as comebacks, aces, blocks, saves, momentum,
captaincy, or who personally caused a team result.

## 3. Positive-selection rules

The final ten facts must:

- be anchored to something that happened on the focus date;
- be celebratory, warm, and suitable for the whole group;
- prefer comparisons with the historical baseline over context-free totals;
- compare like with like when league status, court type, scoring format, or
  team size materially changes the meaning;
- describe a tie as `tied` rather than claiming a unique record;
- include the relevant sample count when a pair, streak, win rate, or other
  small-sample statistic could otherwise sound stronger than it is;
- avoid negative leaderboards, blame, losing streaks, `worst` facts, or praise
  that depends on embarrassing another player;
- avoid repeating the same achievement in different words.

After accuracy, positivity, and interestingness, maximize the number of distinct
focus-date players recognized by name. Prefer an equally strong fact that adds
new people over one that repeats already-mentioned standouts. When the data
supports it, use at least three session/team-wide facts, recognize every focus-
date participant who has a genuinely worthwhile achievement, and use no more
than two facts centered on one person.

Broad recognition never justifies filler. Do not use bare attendance, ordinary
participation, routine totals, awkward name lists, or contrived micro-records
solely to mention someone. A shorter list of names attached to memorable facts
is better than making people feel patronized. If someone lacks a strong
individual fact, a legitimate multi-person or team-wide achievement is the
preferred way to include them.

If ten accurate positive facts genuinely cannot be supported, stop and explain
the shortfall. Never pad the list with invented or misleading claims.

## 4. Verification gate

Before drafting the text message:

1. Recompute every selected number from the frozen source.
2. Confirm every named player was actually present in at least one focus game.
3. Confirm record and percentile claims against complete comparable history.
4. Confirm milestone totals immediately before and after the focus date.
5. Confirm streaks in chronological game order and that they end on the focus
   date, not on a later date.
6. Confirm the ten facts are distinct, positive, and free of unsupported causal
   language.
7. Count distinct named focus-date players, review every omitted participant's
   candidates, and confirm that adding another name would require a weaker,
   repetitive, negative, or contrived fact.
8. Reconfirm that the source used for every calculation came from the successful
   direct Drive refresh for this run, not a cache or local fallback.
9. Keep a temporary internal evidence note while working, but do not publish or
   persist raw game IDs, prompts, secrets, or private data.

## 5. Text-message format

Produce a plain-text copy-and-paste block with:

- the heading `🏐 Volleyball Fun Facts!`;
- facts numbered `1)` through `10)`;
- one short sentence per fact;
- an upbeat closing such as `Great games, everyone! 🙌`;
- no Markdown table, citations, raw URLs, technical model terms, or methodology.

Target 1,600 characters or fewer. Prefer approximately 80–120 characters per
fact, but do not drop worthwhile people merely to hit that target. If accuracy
and meaningful recognition make one message unreasonably long, produce two
clearly labeled blocks (`Text 1 of 2` and `Text 2 of 2`) without splitting a
fact.

## 6. Google Drive publication

1. Search Drive for the exact existing project folder `Volleyball`; do not
   persist its private ID in the repository.
2. Inside it, use an exact `Fun Facts` subfolder. Create that subfolder only if
   none exists. If multiple plausible project or destination folders exist,
   stop and ask rather than guessing.
3. Use one native Google Doc per focus date named
   `Volleyball Fun Facts — YYYY-MM-DD`.
4. If an exact dated Doc already exists in that folder, update that Doc instead
   of creating a duplicate.
5. The Doc should contain:
   - title: `Volleyball Fun Facts`;
   - the focus date as a native Google Docs date chip;
   - a `Text message` heading followed by the exact copy-and-paste block;
   - a short `Verification` section with the source filename and the focus,
     player, named-player, and historical game counts.
6. Preserve existing folder organization and sharing settings. Do not broaden
   access unless the user explicitly asks.
7. Read the completed Doc back and verify the date, all ten numbered facts, the
   closing, and the verification counts before reporting success.
8. Return the exact text-message block and the verified Google Doc link.

The requested fun-facts command is sufficient approval for the dated Doc write;
do not require a second confirmation unless the destination is ambiguous or an
existing document contains unexpected unrelated content.
