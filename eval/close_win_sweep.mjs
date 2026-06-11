// Eval-only sweep for close two-point win dampening.
//
// In ratings.js this is a dampener, not a bonus: 25-23, 26-24, 27-25, etc.
// reduce rating movement because the teams were probably close.
//
// Run from eval/:
//   npm run closewin

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  getScoreMarginDetails,
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

const dampenerSteps = parseListEnv('CLOSE_WIN_STEPS', [0, 0.03, 0.05, 0.08, 0.10, 0.12, 0.15]);
const dampenerMins = parseListEnv('CLOSE_WIN_MINS', [0.50, 0.60, 0.65, 0.70, 0.80, 0.90, 1.00]);

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

function replayFor(options, priorGames = games) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames: true,
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

function computeForwardQuality(options) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const prior = replayFor(options, priorGames);
      const marginModel = calibrateMarginModel({
        games: priorGames,
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

function computeBackQuality(options) {
  const replay = replayFor(options);
  const marginModel = calibrateMarginModel({
    games,
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

function evaluate(step, min) {
  const options = {
    closeOvertimeDampenerStep: step,
    closeOvertimeDampenerMin: min,
  };
  const forward = computeForwardQuality(options);
  const back = computeBackQuality(options);
  return {
    step,
    min,
    forward,
    back,
    factor2523: getScoreMarginDetails(25, 23, options).closeOvertimeDampener,
    factor2725: getScoreMarginDetails(27, 25, options).closeOvertimeDampener,
    factor3028: getScoreMarginDetails(30, 28, options).closeOvertimeDampener,
    score: forward.brier * 100 + forward.marginMAE * 0.25 + back.brier * 10,
  };
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function printRows(title, rows, limit = 14) {
  console.log(title);
  console.log([
    'step'.padStart(6),
    'min'.padStart(6),
    '25-23'.padStart(6),
    '27-25'.padStart(6),
    '30-28'.padStart(6),
    'fwdAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'fwdMAE'.padStart(7),
    'backAcc'.padStart(8),
    'backBrier'.padStart(9),
    'score'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(104));
  rows.slice(0, limit).forEach(row => {
    console.log([
      fmt(row.step, 2).padStart(6),
      fmt(row.min, 2).padStart(6),
      fmt(row.factor2523, 2).padStart(6),
      fmt(row.factor2725, 2).padStart(6),
      fmt(row.factor3028, 2).padStart(6),
      pct(row.forward.accuracy).padStart(7),
      fmt(row.forward.brier).padStart(9),
      fmt(row.forward.marginMAE).padStart(7),
      pct(row.back.accuracy).padStart(8),
      fmt(row.back.brier).padStart(9),
      fmt(row.score).padStart(7),
    ].join(' '));
  });
  console.log('');
}

const scoredNonLeagueGames = games.filter(isScoredNonLeagueGame);
const closeTwoPointGames = getGamesSortedOldestFirst(games).filter(game => {
  if (!isScoredNonLeagueGame(game)) return false;
  const details = getScoreMarginDetails(game.scoreRed, game.scoreBlue, {});
  return details.isCloseOvertime;
});

console.log(`DB: ${DB_PATH}`);
console.log(`players=${players.length} games=${games.length} scoredNonLeague=${scoredNonLeagueGames.length} closeTwoPointNonLeague=${closeTwoPointGames.length}`);
console.log('Sweeping closeOvertimeDampenerStep and closeOvertimeDampenerMin.');
console.log('');

const rows = [];
for (const step of dampenerSteps) {
  for (const min of dampenerMins) {
    rows.push(evaluate(step, min));
  }
}

const baseline = rows.filter(row =>
  Math.abs(row.step - DEFAULT_RATING_OPTIONS.closeOvertimeDampenerStep) < 1e-9 &&
  Math.abs(row.min - DEFAULT_RATING_OPTIONS.closeOvertimeDampenerMin) < 1e-9
);
const byComposite = [...rows].sort((a, b) => a.score - b.score);
const byForwardBrier = [...rows].sort((a, b) => a.forward.brier - b.forward.brier);
const byForwardMae = [...rows].sort((a, b) => a.forward.marginMAE - b.forward.marginMAE);
const byBackBrier = [...rows].sort((a, b) => a.back.brier - b.back.brier);

printRows('Baseline', baseline, 1);
printRows('Best composite candidates', byComposite, 14);
printRows('Best forward Brier candidates', byForwardBrier, 12);
printRows('Best forward margin-MAE candidates', byForwardMae, 12);
printRows('Best backward Brier candidates', byBackBrier, 12);
