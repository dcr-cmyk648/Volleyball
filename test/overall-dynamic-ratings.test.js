import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateOverallDynamicScoreboard,
  formatDynamicLeagueIndividualRating,
  getDynamicLeagueIndividualEffectiveSize,
  OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION,
  OVERALL_DYNAMIC_MONTHLY_SD_LATENT,
  OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS,
  OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
  OVERALL_DYNAMIC_SNAPSHOT_STORAGE_KEY,
  OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR,
  getOverallDynamicWeeklyBucketKey,
  getOverallDynamicWeeklyInterpolation,
  getOverallDynamicWeeklyTransitionVariance,
  validateOverallDynamicSnapshot,
} from '../overall-dynamic-ratings.js';
import { BAYESIAN_POOLED_LEAGUE_OPPONENT_ID } from '../bayesian-ratings.js';

const player = (id, name = id) => ({ id, name });
const internal = (id, date, redTeam, blueTeam, winner = 'red', scoreRed = 25, scoreBlue = 18) =>
  ({ id, createdAt: date, redTeam, blueTeam, winner, scoreRed, scoreBlue });
const league = (id, date, redTeam, winner = 'red', scoreRed = winner === 'red' ? 25 : 18, scoreBlue = winner === 'red' ? 18 : 25, extra = {}) =>
  ({ id, createdAt: date, redTeam, blueTeam: [], winner, scoreRed, scoreBlue, isLeagueGame: true, ...extra });
const row = (snapshot, id) => snapshot.ratings.find(candidate => candidate.id === id);

test('dynamic Overall pools every league context equally into one learned row', () => {
  const a = player('a', 'A');
  const snapshot = calculateOverallDynamicScoreboard({ players: [a], games: [
    league(1, '2026-01-01', [a], 'red', 25, 20, { courtType: 'indoor', leagueLevel: 'rec' }),
    league(2, '2026-02-01', [a], 'blue', 20, 25, { courtType: 'sand', leagueLevel: 'intermediate' }),
    league(3, '2026-03-01', [a], 'red', 25, 15, { courtType: 'grass', leagueLabel: 'one-day' }),
  ] });
  const pooled = row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID);
  assert.equal(snapshot.gamesConsidered, 3);
  assert.equal(snapshot.diagnostics.leagueGamesIncluded, 3);
  assert.equal(pooled.games, 3);
  assert.equal(pooled.isLeagueContext, true);
  assert.notEqual(pooled.mu, 25);
});

test('pooled league display converts team uncertainty to a fingerprint-scoped individual', () => {
  const a = player('a');
  const games = [
    league(1, '2026-01-01', Array.from({ length: 5 }, () => a)),
    league(2, '2026-01-02', Array.from({ length: 7 }, () => a)),
  ];
  const snapshot = calculateOverallDynamicScoreboard({ players: [a], games });
  const pooled = row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID);
  const nEff = getDynamicLeagueIndividualEffectiveSize(games, snapshot.gameFingerprints);
  const individual = formatDynamicLeagueIndividualRating(pooled, games, snapshot.gameFingerprints);
  assert.equal(nEff, 2 / (1 / 5 + 1 / 7));
  assert.equal(individual.mu, pooled.mu);
  assert.equal(individual.sigma, pooled.sigma * Math.sqrt(nEff));
  assert.equal(individual.ordinal, individual.mu - 3 * individual.sigma);
  assert.equal(individual.name, 'League Player');
  assert.equal(individual.games, pooled.games);
  assert.equal(getDynamicLeagueIndividualEffectiveSize([], snapshot.gameFingerprints), 1);
  assert.equal(getDynamicLeagueIndividualEffectiveSize([{ ...games[0], scoreRed: 24 }], snapshot.gameFingerprints), 1);
});

test('fixed roster distribution has deterministic individual uncertainty and display conversion', () => {
  const pooled = { id: 'league', name: 'League Team', mu: 25, sigma: 2, games: 4, wins: 2, winrate: .5 };
  const games = [5, 6, 7, 8].map((size, index) => ({
    id: index + 1,
    createdAt: `2026-01-0${index + 1}`,
    isLeagueGame: true,
    redTeam: Array.from({ length: size }, (_, playerIndex) => player(`${index}-${playerIndex}`)),
    blueTeam: [], scoreRed: 25, scoreBlue: 20, winner: 'red',
  }));
  const snapshot = calculateOverallDynamicScoreboard({ players: games.flatMap(game => game.redTeam), games });
  const nEff = getDynamicLeagueIndividualEffectiveSize(games, snapshot.gameFingerprints);
  const individual = formatDynamicLeagueIndividualRating(pooled, games, snapshot.gameFingerprints);
  assert.equal(nEff, 4 / (1 / 5 + 1 / 6 + 1 / 7 + 1 / 8));
  assert.equal(individual.sigma, 2 * Math.sqrt(nEff));
  assert.equal(Math.round(1500 + 50 * individual.ordinal), Math.round(1500 + 50 * (25 - 6 * Math.sqrt(nEff))));
  assert.equal(individual.games, 4);
});

test('history endpoint exactly matches each current real-player rating', () => {
  const a = player('a'), b = player('b');
  const snapshot = calculateOverallDynamicScoreboard({ players: [a, b], games: [
    internal(1, '2026-01-04', [a], [b]), league(2, '2026-02-04', [a]),
  ] });
  for (const id of ['a', 'b']) {
    const latest = snapshot.history[id].at(-1); const rating = row(snapshot, id);
    for (const key of ['mu', 'sigma', 'ordinal']) assert.equal(latest[key], rating[key]);
    assert.equal(rating.ordinal, rating.mu - 3 * rating.sigma);
  }
  assert.deepEqual(snapshot.history.a.map(knot => knot.games), [1, 2]);
});

test('improving player rises against a stable pooled league and fitting is deterministic', () => {
  const a = player('a'), b = player('b');
  const games = [
    league(1, '2026-01-01', [a], 'blue'), league(2, '2026-02-01', [a], 'red'), league(3, '2026-03-01', [a], 'red'),
    league(4, '2026-01-01', [b], 'red'), league(5, '2026-02-01', [b], 'blue'), league(6, '2026-03-01', [b], 'red'),
  ];
  const first = calculateOverallDynamicScoreboard({ players: [a,b], games });
  const second = calculateOverallDynamicScoreboard({ players: [a,b], games });
  const history = first.history.a;
  assert.ok(history.at(-1).mu > history[0].mu);
  assert.deepEqual(first.ratings, second.ratings);
  assert.deepEqual(first.history, second.history);
});

test('identical weekly league evidence leaves a synthetic history effectively flat', () => {
  const a = player('a');
  const games = Array.from({ length: 6 }, (_, index) =>
    league(index + 1, `2026-0${index + 1}-01`, [a], 'red', 25, 18)
  );
  const values = calculateOverallDynamicScoreboard({ players: [a], games }).history.a.map(knot => knot.mu);
  assert.ok(Math.max(...values) - Math.min(...values) < 0.01);
});

test('weekly buckets use the Monday anchor, exact interpolation, and Brownian transition variance', () => {
  assert.equal(OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT, (25 / 3) * 50);
  assert.equal(OVERALL_DYNAMIC_MONTHLY_SD_LATENT, 10 / ((25 / 3) * 50));
  assert.equal(OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR, '2000-01-03');
  assert.equal(getOverallDynamicWeeklyBucketKey('2026-01-04'), '2025-12-29');
  assert.equal(getOverallDynamicWeeklyBucketKey('2026-01-05'), '2026-01-05');
  assert.equal(getOverallDynamicWeeklyBucketKey('2026-01-11'), '2026-01-05');
  assert.equal(getOverallDynamicWeeklyInterpolation('2026-01-05', '2026-01-19', '2026-01-12'), .5);
  assert.equal(
    getOverallDynamicWeeklyTransitionVariance('2026-01-05', '2026-01-12'),
    OVERALL_DYNAMIC_MONTHLY_SD_LATENT ** 2 * 7 / OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS
  );
  const a = player('a'), b = player('b');
  const snapshot = calculateOverallDynamicScoreboard({ players: [a, b], games: [
    league(1, '2026-01-01', [a], 'red', 25, 1),
    league(2, '2026-03-01', [a], 'red', 25, 25),
    league(3, '2026-01-01', [b], 'blue', 1, 25),
    league(4, '2026-03-01', [b], 'red', 25, 25),
  ] });
  const values = snapshot.history.a.map(knot => knot.mu);
  assert.ok(values.at(-1) > 25.05, 'later state should retain early evidence through the transition prior');
});

test('weekly history assigns all games in a bucket to its cumulative knot', () => {
  const a = player('a');
  const snapshot = calculateOverallDynamicScoreboard({ players: [a], games: [
    league(1, '2026-01-05', [a]),
    league(2, '2026-01-11', [a]),
    league(3, '2026-01-12', [a]),
  ] });
  assert.deepEqual(snapshot.history.a.map(knot => knot.date), ['2026-01-05', '2026-01-12']);
  assert.deepEqual(snapshot.history.a.map(knot => knot.games), [2, 3]);
});

test('all history and league uncertainties use finite posterior marginals', () => {
  const a = player('a');
  const games = [
    league(1, '2026-01-01', [a], 'red'),
    league(2, '2026-02-01', [a], 'blue'),
    league(3, '2026-03-01', [a], 'red'),
  ];
  const snapshot = calculateOverallDynamicScoreboard({ players: [a], games });
  const leagueRow = row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID);
  snapshot.history.a.forEach(knot => assert.ok(Number.isFinite(knot.variance) && knot.variance > 0));
  assert.ok(leagueRow.sigma < 25 / 3, 'observed league uncertainty must be lower than its unit-prior sigma');
  const fewer = calculateOverallDynamicScoreboard({ players: [a], games: games.slice(0, 1) });
  assert.ok(leagueRow.sigma < row(fewer, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID).sigma);
});

test('bridge fallback includes every qualifying player and is invariant to game order', () => {
  const players = Array.from({ length: 6 }, (_, index) => player(String(index)));
  const games = players.flatMap((entry, playerIndex) => Array.from({ length: 5 }, (_, gameIndex) =>
    league(`${playerIndex}-${gameIndex}`, `2026-0${gameIndex + 1}-01`, [entry], gameIndex % 2 ? 'blue' : 'red')
  ));
  const first = calculateOverallDynamicScoreboard({ players, games });
  const shuffled = calculateOverallDynamicScoreboard({ players, games: [...games].reverse() });
  assert.deepEqual(first.diagnostics.bridgeCohort.ids, players.map(entry => entry.id));
  assert.deepEqual(first.diagnostics.bridgeCohort, shuffled.diagnostics.bridgeCohort);
  assert.deepEqual(first.ratings, shuffled.ratings);
});

test('sparse and no-league inputs remain finite and league synthetic identity is isolated', () => {
  const a = player('a'), unused = player('unused');
  const snapshot = calculateOverallDynamicScoreboard({ players: [a, unused], games: [league(1, '2026-01-01', [a])] });
  assert.equal(snapshot.history[BAYESIAN_POOLED_LEAGUE_OPPONENT_ID], undefined);
  for (const rating of snapshot.ratings) for (const key of ['mu','sigma','ordinal','games']) assert.ok(Number.isFinite(rating[key]));
  assert.equal(row(snapshot, 'unused').games, 0);
  assert.equal(row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID).isSynthetic, true);
});

test('weekly snapshot identity validates and monthly snapshots are rejected', () => {
  const a = player('a');
  const snapshot = calculateOverallDynamicScoreboard({ players: [a], games: [league(1, '2026-01-05', [a])] });
  assert.equal(snapshot.schemaVersion, OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(OVERALL_DYNAMIC_SNAPSHOT_STORAGE_KEY, 'gameDayBayesianScoreboardSnapshotV3:composite');
  assert.equal(validateOverallDynamicSnapshot(snapshot), true);
  assert.throws(() => validateOverallDynamicSnapshot({ ...snapshot, schemaVersion: 1 }));
  assert.throws(() => validateOverallDynamicSnapshot({ ...snapshot, modelVersion: 'overall-dynamic-v2' }));
  assert.throws(() => validateOverallDynamicSnapshot({
    ...snapshot,
    diagnostics: { ...snapshot.diagnostics, optimizer: { ...snapshot.diagnostics.optimizer, converged: false } },
  }));
  const invalidHistoryGames = {
    ...snapshot,
    history: { ...snapshot.history, a: [{ ...snapshot.history.a[0], games: -1 }] },
  };
  assert.throws(() => validateOverallDynamicSnapshot(invalidHistoryGames), /history game count/);
});
