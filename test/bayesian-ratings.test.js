import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  BAYESIAN_DEFAULT_SIGMA,
  calculateBayesianScoreboard,
  compareBayesianSnapshotToCurrentData,
  createBayesianUiState,
  createGameFingerprint,
  createGameFingerprintMap,
  saveBayesianSnapshot,
  loadBayesianSnapshot,
} from '../bayesian-ratings.js';

function player(id, name = String(id)) {
  return { id, name };
}

function game(id, redTeam, blueTeam, winner = 'red', scoreRed = 25, scoreBlue = 20) {
  return {
    id,
    createdAt: id,
    redTeam,
    blueTeam,
    winner,
    scoreRed,
    scoreBlue,
    isLeagueGame: false,
    leagueOpponent: null,
  };
}

function leagueGame(id, redTeam, opponentId, winner = 'red', scoreRed = 25, scoreBlue = 20) {
  return {
    id,
    createdAt: id,
    redTeam,
    blueTeam: [],
    winner,
    scoreRed,
    scoreBlue,
    isLeagueGame: true,
    leagueOpponent: { id: opponentId, name: opponentId, size: 6 },
  };
}

function byName(snapshot, name) {
  return snapshot.ratings.find(row => row.name === name);
}

function assertClose(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`);
}

test('no games leaves all registered players at the prior with deterministic ranking', () => {
  const snapshot = calculateBayesianScoreboard({
    players: [player('b', 'Beta'), player('a', 'Alpha')],
    games: [],
  });

  assert.equal(snapshot.gamesConsidered, 0);
  assert.deepEqual(snapshot.ratings.map(row => row.name), ['Alpha', 'Beta']);
  snapshot.ratings.forEach(row => {
    assert.equal(row.mu, 25);
    assert.equal(row.sigma, BAYESIAN_DEFAULT_SIGMA);
    assert.equal(row.ordinal, 0);
    assert.equal(row.games, 0);
    assert.equal(row.wins, 0);
    assert.equal(Number.isFinite(row.mu), true);
  });
});

test('mirrored equal evidence produces equal posterior ratings', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const snapshot = calculateBayesianScoreboard({
    players,
    games: [
      game(1, [players[0]], [players[1]], 'red', 25, 20),
      game(2, [players[1]], [players[0]], 'red', 25, 20),
    ],
  });

  assertClose(byName(snapshot, 'A').mu, byName(snapshot, 'B').mu, 1e-8);
  assertClose(byName(snapshot, 'A').sigma, byName(snapshot, 'B').sigma, 1e-8);
  assertClose(byName(snapshot, 'A').ordinal, byName(snapshot, 'B').ordinal, 1e-8);
});

test('repeatedly stronger side receives higher mu and ordinal', () => {
  const players = [player('strong', 'Strong'), player('weak', 'Weak')];
  const games = Array.from({ length: 8 }, (_, index) =>
    game(index + 1, [players[0]], [players[1]], 'red', 25, 12)
  );
  const snapshot = calculateBayesianScoreboard({ players, games });

  assert.ok(byName(snapshot, 'Strong').mu > byName(snapshot, 'Weak').mu);
  assert.ok(byName(snapshot, 'Strong').ordinal > byName(snapshot, 'Weak').ordinal);
});

test('roster order does not change results or game fingerprints', () => {
  const players = [player('a', 'A'), player('b', 'B'), player('c', 'C'), player('d', 'D')];
  const original = game(1, [players[0], players[1]], [players[2], players[3]], 'red', 25, 19);
  const permuted = game(1, [players[1], players[0]], [players[3], players[2]], 'red', 25, 19);
  const a = calculateBayesianScoreboard({ players, games: [original] });
  const b = calculateBayesianScoreboard({ players, games: [permuted] });

  assert.equal(createGameFingerprint(original), createGameFingerprint(permuted));
  for (const row of a.ratings) {
    const other = b.ratings.find(candidate => candidate.id === row.id);
    assertClose(row.mu, other.mu, 1e-10);
    assertClose(row.sigma, other.sigma, 1e-10);
    assertClose(row.ordinal, other.ordinal, 1e-10);
  }
});

test('same input produces deterministic results', () => {
  const players = [player('a', 'A'), player('b', 'B'), player('c', 'C')];
  const games = [
    game(1, [players[0], players[1]], [players[2]], 'red', 25, 23),
    game(2, [players[2]], [players[0]], 'blue', 19, 25),
  ];
  const first = calculateBayesianScoreboard({ players, games });
  const second = calculateBayesianScoreboard({ players, games });

  for (const row of first.ratings) {
    const other = second.ratings.find(candidate => candidate.id === row.id);
    assertClose(row.mu, other.mu, 1e-12);
    assertClose(row.sigma, other.sigma, 1e-12);
    assertClose(row.ordinal, other.ordinal, 1e-12);
  }
});

test('winner-only games are included and finite', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const snapshot = calculateBayesianScoreboard({
    players,
    games: [game(1, [players[0]], [players[1]], 'red', null, null)],
  });

  assert.equal(snapshot.scoredGames, 0);
  assert.equal(snapshot.winnerOnlyGames, 1);
  snapshot.ratings.forEach(row => {
    assert.equal(Number.isFinite(row.mu), true);
    assert.equal(Number.isFinite(row.sigma), true);
  });
});

test('league opponents are nuisance entities and not rendered as players', () => {
  const players = [player('a', 'A')];
  const snapshot = calculateBayesianScoreboard({
    players,
    games: [
      leagueGame(1, [players[0]], 'league-one', 'red', 25, 20),
      leagueGame(2, [players[0]], 'league-two', 'blue', 20, 25),
    ],
  });

  assert.equal(snapshot.diagnostics.leagueOpponentCount, 2);
  assert.deepEqual(snapshot.ratings.map(row => row.name), ['A']);
});

test('zero-game player remains exactly at the prior', () => {
  const players = [player('a', 'Active'), player('z', 'Zero')];
  const snapshot = calculateBayesianScoreboard({
    players,
    games: [game(1, [players[0]], [players[0]], 'red', 25, 20)],
  });
  const zero = byName(snapshot, 'Zero');

  assert.equal(zero.mu, 25);
  assert.equal(zero.sigma, BAYESIAN_DEFAULT_SIGMA);
  assert.equal(zero.ordinal, 0);
});

test('malformed games are skipped with warnings while valid observations calculate', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const snapshot = calculateBayesianScoreboard({
    players,
    games: [
      { id: 1, redTeam: [], blueTeam: [players[1]], winner: 'red' },
      game(2, [players[0]], [players[1]], 'red', 25, 20),
    ],
  });

  assert.equal(snapshot.skippedGames, 1);
  assert.equal(snapshot.gamesConsidered, 1);
  assert.ok(snapshot.warnings.some(warning => warning.includes('Skipped malformed')));
});

test('posterior covariance produces finite positive sigma without invalid Hessian fallback', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const snapshot = calculateBayesianScoreboard({
    players,
    games: [game(1, [players[0]], [players[1]], 'red', 25, 20)],
  });

  assert.equal(snapshot.diagnostics.posterior.method, 'central-finite-difference-gradient-cholesky');
  snapshot.ratings.forEach(row => {
    assert.equal(Number.isFinite(row.sigma), true);
    assert.ok(row.sigma > 0);
  });
});

test('reference fixture reproduces 2026-06-20 Bayesian ratings', () => {
  const db = JSON.parse(fs.readFileSync('test/fixtures/bayesian-2026-06-20.json', 'utf8'));
  const snapshot = calculateBayesianScoreboard({ players: db.players, games: db.games });
  const expected = {
    MattA: { mu: 29.648, sigma: 2.488, ordinal: 22.185 },
    JoeM: { mu: 29.755, sigma: 2.746, ordinal: 21.516 },
    MelissaR: { mu: 27.037, sigma: 2.360, ordinal: 19.957 },
    JayY: { mu: 27.026, sigma: 2.408, ordinal: 19.803 },
    LukeS: { mu: 30.430, sigma: 3.553, ordinal: 19.770 },
    TylerK: { mu: 25.000, sigma: 25 / 3, ordinal: 0.000 },
  };

  assert.equal(db.players.length, 48);
  assert.equal(db.games.length, 126);
  assert.equal(snapshot.scoredGames, 123);
  assert.equal(snapshot.winnerOnlyGames, 3);
  assert.deepEqual(snapshot.ratings.slice(0, 5).map(row => row.name), ['MattA', 'JoeM', 'MelissaR', 'JayY', 'LukeS']);

  for (const [name, values] of Object.entries(expected)) {
    const row = byName(snapshot, name);
    assertClose(row.mu, values.mu, 0.03);
    assertClose(row.sigma, values.sigma, 0.03);
    assertClose(row.ordinal, values.ordinal, 0.03);
  }
});

test('snapshot comparison reports current games as new with no snapshot', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const games = [game(1, [players[0]], [players[1]])];
  const comparison = compareBayesianSnapshotToCurrentData(null, players, games);
  assert.equal(comparison.addedGameCount, 1);
  assert.equal(comparison.modifiedGameCount, 0);
});

test('matching snapshot reports no additions or modifications', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const games = [game(1, [players[0]], [players[1]])];
  const snapshot = calculateBayesianScoreboard({ players, games });
  const comparison = compareBayesianSnapshotToCurrentData(snapshot, players, games);
  assert.equal(comparison.addedGameCount, 0);
  assert.equal(comparison.modifiedGameCount, 0);
  assert.equal(comparison.deletedGameCount, 0);
  assert.equal(comparison.isStale, false);
});

test('adding two games reports two new games', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const games = [game(1, [players[0]], [players[1]])];
  const snapshot = calculateBayesianScoreboard({ players, games });
  const comparison = compareBayesianSnapshotToCurrentData(snapshot, players, [
    ...games,
    game(2, [players[0]], [players[1]]),
    game(3, [players[1]], [players[0]], 'blue'),
  ]);
  assert.equal(comparison.addedGameCount, 2);
});

test('editing a score reports a modification, not a new identity', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const games = [game(1, [players[0]], [players[1]], 'red', 25, 20)];
  const snapshot = calculateBayesianScoreboard({ players, games });
  const edited = [game(1, [players[0]], [players[1]], 'red', 25, 18)];
  const comparison = compareBayesianSnapshotToCurrentData(snapshot, players, edited);
  assert.equal(comparison.addedGameCount, 0);
  assert.equal(comparison.modifiedGameCount, 1);
});

test('deleting a game reports a deletion', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const games = [game(1, [players[0]], [players[1]]), game(2, [players[1]], [players[0]])];
  const snapshot = calculateBayesianScoreboard({ players, games });
  const comparison = compareBayesianSnapshotToCurrentData(snapshot, players, games.slice(0, 1));
  assert.equal(comparison.deletedGameCount, 1);
});

test('reordering a roster does not report a modification', () => {
  const players = [player('a', 'A'), player('b', 'B'), player('c', 'C'), player('d', 'D')];
  const games = [game(1, [players[0], players[1]], [players[2], players[3]])];
  const snapshot = calculateBayesianScoreboard({ players, games });
  const reordered = [game(1, [players[1], players[0]], [players[3], players[2]])];
  const comparison = compareBayesianSnapshotToCurrentData(snapshot, players, reordered);
  assert.equal(comparison.modifiedGameCount, 0);
});

test('player name-only change does not invalidate the model', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const games = [game(1, [players[0]], [players[1]])];
  const snapshot = calculateBayesianScoreboard({ players, games });
  const renamed = [player('a', 'Renamed'), player('b', 'B')];
  const comparison = compareBayesianSnapshotToCurrentData(snapshot, renamed, games);
  assert.equal(comparison.playerEntityChanged, false);
  assert.equal(comparison.isStale, false);
});

test('adding a new player ID marks the snapshot stale', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const games = [game(1, [players[0]], [players[1]])];
  const snapshot = calculateBayesianScoreboard({ players, games });
  const comparison = compareBayesianSnapshotToCurrentData(snapshot, [...players, player('c', 'C')], games);
  assert.equal(comparison.playerEntityChanged, true);
  assert.equal(comparison.isStale, true);
});

test('UI state button text and stale messages reflect snapshot state without calculating', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const games = [game(1, [players[0]], [players[1]])];
  assert.equal(createBayesianUiState({ players, games }).buttonText, 'Calculate Bayesian ratings — 1 new game');

  const snapshot = calculateBayesianScoreboard({ players, games });
  assert.equal(createBayesianUiState({ players, games, snapshot }).buttonText, 'Recalculate Bayesian ratings — 0 new games');

  const nextGames = [...games, game(2, [players[0]], [players[1]])];
  assert.equal(createBayesianUiState({ players, games: nextGames, snapshot }).buttonText, 'Update Bayesian ratings — 1 new game');

  const edited = [game(1, [players[0]], [players[1]], 'red', 25, 19)];
  const state = createBayesianUiState({ players, games: edited, snapshot });
  assert.match(state.staleMessage, /Game data changed/);
});

test('snapshot persistence helpers use storage without touching canonical data', () => {
  const storage = new Map();
  const adapter = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const players = [player('a', 'A'), player('b', 'B')];
  const snapshot = calculateBayesianScoreboard({ players, games: [game(1, [players[0]], [players[1]])] });
  saveBayesianSnapshot(adapter, snapshot);
  assert.equal(loadBayesianSnapshot(adapter).ratings.length, 2);
});

test('game fingerprint map uses stable identities', () => {
  const players = [player('a', 'A'), player('b', 'B')];
  const map = createGameFingerprintMap([game(42, [players[0]], [players[1]])]);
  assert.deepEqual(Object.keys(map), ['id:42']);
});
