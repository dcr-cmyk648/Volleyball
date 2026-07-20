import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const ratingsSource = fs.readFileSync(
  new URL('../ratings.js', import.meta.url),
  'utf8'
);
const localOpenSkillUrl = new URL(
  '../eval/node_modules/openskill/dist/index.js',
  import.meta.url
).href;
const nodeRatingsSource = ratingsSource.replace(
  'https://esm.sh/openskill@4.1.1',
  localOpenSkillUrl
);
const ratings = await import(
  `data:text/javascript;base64,${Buffer.from(nodeRatingsSource).toString('base64')}`
);

const {
  getOverallStandingsRawOrdinal,
  getSeasonRankingDisplayRawOrdinal,
  getSeasonRankingGameCountPenaltyPoints,
  getSeasonRankingMaxUnpenalizedDisplayRating,
  getSeasonRankingPenaltyPhase,
  toDisplayRating,
} = ratings;

const rawFromDisplay = displayRating => (displayRating - 1500) / 50;
const displaySeasonRating = player => toDisplayRating(
  getSeasonRankingDisplayRawOrdinal(player)
);

test('Season Ranking penalty phase is linear from 1500 to the board maximum', () => {
  assert.equal(getSeasonRankingPenaltyPhase(1499, 2300), 0);
  assert.equal(getSeasonRankingPenaltyPhase(1500, 2300), 0);
  assert.equal(getSeasonRankingPenaltyPhase(1900, 2300), 0.5);
  assert.equal(getSeasonRankingPenaltyPhase(2300, 2300), 1);
  assert.equal(getSeasonRankingPenaltyPhase(2400, 2300), 1);
});

test('Season Ranking keeps the approved missing-game tier totals', () => {
  assert.equal(getSeasonRankingGameCountPenaltyPoints(5, 66, 1800), 266);
  assert.equal(getSeasonRankingGameCountPenaltyPoints(21, 66, 1800), 161);
  assert.equal(getSeasonRankingGameCountPenaltyPoints(22, 66, 1800), 156);
});

test('highest unpenalized board rating is computed before confidence penalties', () => {
  assert.equal(getSeasonRankingMaxUnpenalizedDisplayRating([
    { rawOrdinal: rawFromDisplay(1450) },
    { rawOrdinal: rawFromDisplay(1900) },
    { rawOrdinal: rawFromDisplay(1750) },
  ]), 1900);
});

test('phasing prevents Richa-style upset wins from losing display points at 1500', () => {
  const boardMax = 2300;
  const before = displaySeasonRating({
    rawOrdinal: rawFromDisplay(1457),
    games: 20,
    scoreboardMaxGames: 66,
    scoreboardMaxUnpenalizedDisplayRating: boardMax,
  });
  const after = displaySeasonRating({
    rawOrdinal: rawFromDisplay(1561),
    games: 21,
    scoreboardMaxGames: 66,
    scoreboardMaxUnpenalizedDisplayRating: boardMax,
  });

  assert.equal(Math.round(before), 1457);
  assert.ok(after > before, `${before} should be below ${after}`);
  assert.ok(Math.round(after) >= 1545, `expected a small phased penalty, got ${after}`);
});

test('the board maximum receives the full legacy penalty and the toggle removes it', () => {
  const rawOrdinal = rawFromDisplay(2300);
  const games = 21;
  const scoreboardMaxGames = 66;
  const fullyConfidenceAdjusted = getOverallStandingsRawOrdinal(rawOrdinal, games);
  const fullPenaltyPoints = getSeasonRankingGameCountPenaltyPoints(
    games,
    scoreboardMaxGames,
    toDisplayRating(fullyConfidenceAdjusted)
  );
  const expected = fullyConfidenceAdjusted - fullPenaltyPoints / 50;
  const player = {
    rawOrdinal,
    games,
    scoreboardMaxGames,
    scoreboardMaxUnpenalizedDisplayRating: 2300,
  };

  assert.equal(getSeasonRankingDisplayRawOrdinal(player), expected);
  assert.equal(
    getSeasonRankingDisplayRawOrdinal(player, { removeConfidencePenalty: true }),
    rawOrdinal
  );
});
