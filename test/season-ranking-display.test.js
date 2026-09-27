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
  COURT_TYPE_GRASS,
  getCourtType,
  getLargeTeamUpdateDamper,
  getLeagueContext,
  getOverallStandingsRawOrdinal,
  getSeasonRankingDisplayRawOrdinal,
  getSeasonRankingGameCountPenaltyPoints,
  getSeasonRankingMaxUnpenalizedDisplayRating,
  getSeasonRankingPenaltyPhase,
  getSeasonRankingReplay,
  toDisplayRating,
} = ratings;

test('season ratings use each player last 50 games while keeping monthly counts and history', () => {
  const games = [];
  for (const [id, total, monthGames] of [['under', 49, 9], ['exact', 50, 10], ['older', 80, 10], ['busy', 80, 70], ['inactive', 80, 0]]) {
    for (let i = 0; i < total; i++) {
      games.push({ id: `${id}-${i}`, date: i < total - monthGames ? '2026-08-01' : '2026-09-20',
        createdAt: games.length, redTeam: [{ id }], blueTeam: [], isLeagueGame: i % 2 === 0 });
    }
  }
  games.reverse();
  const windowGames = games.filter(game => game.date >= '2026-08-27');
  const replay = selected => {
    const counts = new Map();
    const history = ratings.getGamesSortedOldestFirst(selected).map(game => {
      const id = game.redTeam[0].id;
      const count = counts.get(id) || 0;
      counts.set(id, count + 1);
      return { game, before: { red: [{ id, mu: count }], blue: [] },
        after: { red: [{ id, mu: count + 1 }], blue: [] } };
    });
    return { history, standings: [...counts].map(([id, games]) => ({ id, games, mu: games, sigma: 2, wins: games, rawOrdinal: games - 7 })) };
  };
  const monthly = replay(windowGames);
  const snapshot = structuredClone(monthly);
  const result = getSeasonRankingReplay({ games, windowGames, replay: selected => selected === windowGames ? monthly : replay(selected) });
  assert.deepEqual(monthly, snapshot, 'cached monthly replay is not mutated');
  assert.equal(result.history.length, windowGames.length);
  assert.ok(!result.standings.some(row => row.id === 'inactive'));
  for (const row of result.standings) {
    const expected = monthly.standings.find(player => player.id === row.id);
    assert.equal(row.games, expected.games);
    assert.equal(row.wins, expected.wins);
    assert.equal(row.mu, row.id === 'under' ? 9 : 50);
    const latest = result.history.filter(entry => entry.game.redTeam[0].id === row.id).at(-1);
    assert.equal(latest.after.red[0].mu, row.mu);
    assert.equal(getSeasonRankingGameCountPenaltyPoints(row.games, 70, 1800),
      getSeasonRankingGameCountPenaltyPoints(expected.games, 70, 1800));
  }
  assert.equal(result.seasonPlayerReplays.get('older').games.filter(game => game.redTeam[0].id === 'older').length, 50);
  assert.equal(result.seasonPlayerReplays.get('busy').games.filter(game => game.redTeam[0].id === 'busy').length, 50);
  assert.ok(!result.seasonPlayerReplays.has('under'));
});

test('grass is preserved as a court type and league context', () => {
  const game = {
    isLeagueGame: true,
    level: 'rec',
    courtType: 'grass',
  };

  assert.equal(COURT_TYPE_GRASS, 'grass');
  assert.equal(getCourtType(game), 'grass');
  assert.equal(getLeagueContext(game).key, 'rec_grass');
  assert.equal(getLeagueContext(game).name, 'Rec League Grass');
});

test('massive-team update damping preserves the current 6/team-size baseline', () => {
  assert.equal(getLargeTeamUpdateDamper(6), 1);
  assert.equal(getLargeTeamUpdateDamper(7), 6 / 7);
  assert.equal(getLargeTeamUpdateDamper(8), 0.75);
  assert.equal(getLargeTeamUpdateDamper(8, {
    largeTeamUpdateDampingExponent: 0,
  }), 1);
  assert.equal(getLargeTeamUpdateDamper(8, {
    largeTeamUpdateDampingReferenceSize: 7,
  }), 7 / 8);
});

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
