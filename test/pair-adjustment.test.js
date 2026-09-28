import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../ratings.js', import.meta.url), 'utf8')
  .replace('https://esm.sh/openskill@4.1.1', new URL('../eval/node_modules/openskill/dist/index.js', import.meta.url).href);
const ratings = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const red = ['a', 'b', 'c'].map(id => ({ id, name: id }));
const blue = ['d', 'e', 'f'].map(id => ({ id, name: id }));
const score = (pairs, volleyballOptions = {}) => ratings.scoreVolleyballCandidateSplit({
  redPlayers: red, bluePlayers: blue, ratingMap: {}, pairAdjustmentMap: new Map(pairs), volleyballOptions,
});
const legacy = { pairAdjustmentMinGames: 8, pairAdjustmentScale: 1, pairAdjustmentTeamCap: 0.75 };

test('pair adjustment starts after ten previous shared games and scales threefold', () => {
  assert.equal(score([['a|b', { count: 9, total: 1.8 }]]).redPairAdjustment, 0);
  const pairs = [['a|b', { count: 10, total: 2 }], ['d|e', { count: 10, total: -2 }]];
  const actual = score(pairs);
  const reference = score(pairs, { ...legacy, pairAdjustmentMinGames: 10 });
  assert.ok(Math.abs(actual.redPairAdjustment - 3 * reference.redPairAdjustment) < 1e-12);
  assert.ok(Math.abs(actual.bluePairAdjustment - 3 * reference.bluePairAdjustment) < 1e-12);
});

test('team caps apply in both directions and low residuals remain filtered', () => {
  const pairs = ['a|b', 'a|c', 'b|c'].map(key => [key, { count: 20, total: 16 }]);
  pairs.push(...['d|e', 'd|f', 'e|f'].map(key => [key, { count: 20, total: -16 }]));
  const actual = score(pairs);
  assert.equal(actual.redPairAdjustment, 2.25);
  assert.equal(actual.bluePairAdjustment, -2.25);
  assert.equal(score([['a|b', { count: 100, total: 9 }]]).redPairAdjustment, 0);
  assert.equal(score(pairs, { pairAdjustmentScale: 0 }).redPairAdjustment, 0);
  assert.equal(score(pairs, { pairAdjustmentMode: 'off' }).redPairAdjustment, 0);
});

test('balancer rollout preserves rating replay and player timelines', () => {
  const players = [...red, ...blue];
  const games = Array.from({ length: 24 }, (_, index) => ({
    id: index + 1, createdAt: index + 1, date: `2026-09-${String(1 + Math.floor(index / 3)).padStart(2, '0')}`,
    redTeam: red, blueTeam: blue, winner: index % 4 ? 'red' : 'blue',
    scoreRed: index % 4 ? 25 : 17, scoreBlue: index % 4 ? 17 : 25,
  }));
  const args = { players, games, seasonal: true, volleyballAdjusted: true, includeLeagueGames: true };
  const baseline = ratings.replayRatings({ ...args, volleyballOptions: legacy });
  assert.deepEqual(ratings.replayRatings(args), baseline);
  assert.deepEqual(ratings.replayRatings({ ...args, volleyballOptions: {} }), baseline);
  for (const player of players) {
    assert.deepEqual(ratings.getPlayerRatingTimeline({ ...args, playerId: player.id }),
      ratings.getPlayerRatingTimeline({ ...args, playerId: player.id, volleyballOptions: legacy }));
  }
});
