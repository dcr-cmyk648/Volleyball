// Eval-only sweep for synthetic league-opponent rating behavior.
//
// This does not change recorded league-game metadata. It only varies how the
// model maps those league games onto synthetic opponent identities and how fast
// those synthetic opponents react to results.
//
// Run from eval/:
//   npm run league:team

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  DEFAULT_RATING_OPTIONS,
} from '../ratings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.VBALL_DB || resolve(__dirname, '../default_database');
const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
const players = db.players || [];
const games = db.games || [];

const seasonalTaperDays = Math.round(6 * 30.4375);

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value >= 0);

  return values.length > 0 ? values : fallback;
}

function parseModesEnv(fallback) {
  const raw = process.env.LEAGUE_TEAM_MODES;
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value === 'context' || value === 'pooled');

  return values.length > 0 ? values : fallback;
}

function isQualityGame(game) {
  return (
    game &&
    !game.isLeagueGame &&
    Array.isArray(game.redTeam) &&
    game.redTeam.length > 0 &&
    Array.isArray(game.blueTeam) &&
    game.blueTeam.length > 0 &&
    (game.winner === 'red' || game.winner === 'blue')
  );
}

function isScoredNonLeagueGame(game) {
  return (
    isQualityGame(game) &&
    typeof game.scoreRed === 'number' &&
    typeof game.scoreBlue === 'number'
  );
}

function replayFor(options, priorGames = games, includeLeagueGames = true) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames,
    options: {
      seasonalTaperDays,
      ...options,
    },
  });
}

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    scored: 0,
    marginErrSum: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    marginMAE: stats.scored ? stats.marginErrSum / stats.scored : null,
  };
}

function recordPrediction(stats, game, score, marginModel) {
  const predictedWinner = score.redWinProbability >= 0.5 ? 'red' : 'blue';
  const yRed = game.winner === 'red' ? 1 : 0;

  stats.n += 1;
  if (predictedWinner === game.winner) stats.correct += 1;
  stats.brierSum += (score.redWinProbability - yRed) ** 2;

  if (
    typeof game.scoreRed === 'number' &&
    typeof game.scoreBlue === 'number' &&
    marginModel?.sampleSize > 0
  ) {
    const gap = Math.abs(game.scoreRed - game.scoreBlue);
    const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);
    stats.scored += 1;
    stats.marginErrSum += Math.abs(predictedGap - gap);
  }
}

function computeForwardQuality(options, includeLeagueGames = true) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const prior = replayFor(options, priorGames, includeLeagueGames);
      const modelGames = includeLeagueGames
        ? priorGames
        : priorGames.filter(priorGame => !priorGame?.isLeagueGame);
      const marginModel = calibrateMarginModel({
        games: modelGames,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options,
      });
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options,
      });
      recordPrediction(stats, game, score, marginModel);
    }

    priorGames.push(game);
  });

  return summarize(stats);
}

function computeBackQuality(options, includeLeagueGames = true) {
  const replay = replayFor(options, games, includeLeagueGames);
  const modelGames = includeLeagueGames ? games : games.filter(game => !game?.isLeagueGame);
  const marginModel = calibrateMarginModel({
    games: modelGames,
    ratingMap: replay.ratingMap,
    carryScoreMap: replay.carryMap || {},
    options,
  });
  const stats = createStats();

  getGamesSortedOldestFirst(games).forEach(game => {
    if (!isQualityGame(game)) return;
    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
      options,
    });
    recordPrediction(stats, game, score, marginModel);
  });

  return summarize(stats);
}

function evaluate(label, options = {}, includeLeagueGames = true) {
  const forward = computeForwardQuality(options, includeLeagueGames);
  const back = computeBackQuality(options, includeLeagueGames);

  return {
    label,
    options,
    includeLeagueGames,
    forward,
    back,
    score: forward.brier * 100 + forward.marginMAE * 0.25 + back.brier * 10,
  };
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function printRows(title, rows, limit = rows.length) {
  console.log(title);
  console.log([
    'label'.padEnd(32),
    'fwdAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'fwdMAE'.padStart(7),
    'backAcc'.padStart(8),
    'backBrier'.padStart(9),
    'backMAE'.padStart(7),
    'score'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(96));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, 32).padEnd(32),
      pct(row.forward.accuracy).padStart(7),
      fmt(row.forward.brier).padStart(9),
      fmt(row.forward.marginMAE).padStart(7),
      pct(row.back.accuracy).padStart(8),
      fmt(row.back.brier).padStart(9),
      fmt(row.back.marginMAE).padStart(7),
      fmt(row.score).padStart(7),
    ].join(' '));
  });
  console.log('');
}

const leagueGames = games.filter(game => game?.isLeagueGame);
const scoredNonLeagueGames = games.filter(isScoredNonLeagueGame);

console.log(`DB: ${DB_PATH}`);
console.log(`players=${players.length} games=${games.length} leagueGames=${leagueGames.length} scoredNonLeague=${scoredNonLeagueGames.length}`);
console.log('Sweeping leagueTeamRatingMode and leagueOpponentUpdateMultiplier.');
console.log('');

const rows = [
  evaluate('exclude league games', {}, false),
  evaluate('current default', {}, true),
];

const modes = parseModesEnv(['context', 'pooled']);
const multipliers = parseListEnv(
  'LEAGUE_OPPONENT_MULTIPLIERS',
  [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]
);

for (const mode of modes) {
  for (const multiplier of multipliers) {
    rows.push(evaluate(`${mode} opp x${multiplier.toFixed(2)}`, {
      leagueTeamRatingMode: mode,
      leagueOpponentUpdateMultiplier: multiplier,
      leagueUpdateMultiplier: DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier,
    }));
  }
}

const uniqueRows = [];
const seen = new Set();
rows.forEach(row => {
  const key = `${row.includeLeagueGames}:${JSON.stringify(row.options)}`;
  if (seen.has(key)) return;
  seen.add(key);
  uniqueRows.push(row);
});

const byComposite = [...uniqueRows].sort((a, b) => a.score - b.score);
const byForwardBrier = [...uniqueRows].sort((a, b) => a.forward.brier - b.forward.brier);
const byForwardMae = [...uniqueRows].sort((a, b) => a.forward.marginMAE - b.forward.marginMAE);
const baselines = uniqueRows.filter(row =>
  row.label === 'exclude league games' ||
  row.label === 'current default'
);

printRows('Baselines', baselines);
printRows('Best composite candidates', byComposite, 14);
printRows('Best forward Brier candidates', byForwardBrier, 12);
printRows('Best forward margin-MAE candidates', byForwardMae, 12);
