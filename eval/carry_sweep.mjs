// Eval-only sweep for carryScale and carryConfidenceGames using current
// production rating and balancing defaults.
//
// Run from eval/:
//   npm run carry
// Or target values:
//   CARRY_SCALES=0,4,8,12 CARRY_CONFIDENCE_GAMES=10,15,20 npm run carry

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
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

const carryScales = parseListEnv('CARRY_SCALES', [0, 2, 4, 6, 8, 10, 12, 14, 16]);
const carryConfidenceGames = parseListEnv('CARRY_CONFIDENCE_GAMES', [6, 10, 15, 20, 25, 35]);

function isScoredNonLeagueGame(game) {
  return (
    game &&
    !game.isLeagueGame &&
    Array.isArray(game.redTeam) &&
    game.redTeam.length > 0 &&
    Array.isArray(game.blueTeam) &&
    game.blueTeam.length > 0 &&
    typeof game.scoreRed === 'number' &&
    typeof game.scoreBlue === 'number' &&
    (game.winner === 'red' || game.winner === 'blue')
  );
}

function replayFor(priorGames) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames: true,
    options: { seasonalTaperDays },
  });
}

function teamKey(team) {
  return team.map(player => String(player.id)).sort().join(',');
}

function* chooseIndexes(n, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix;
    return;
  }

  const remaining = k - prefix.length;
  for (let i = start; i <= n - remaining; i += 1) {
    yield* chooseIndexes(n, k, i + 1, [...prefix, i]);
  }
}

function findBestSplit({
  present,
  redSize,
  ratingMap,
  carryScoreMap,
  marginModel,
  volleyballOptions,
}) {
  const allIndexes = new Set(present.map((_, index) => index));
  let best = null;

  for (const redIndexes of chooseIndexes(present.length, redSize)) {
    const redIndexSet = new Set(redIndexes);
    const redPlayers = redIndexes.map(index => present[index]);
    const bluePlayers = [...allIndexes]
      .filter(index => !redIndexSet.has(index))
      .map(index => present[index]);

    const score = scoreVolleyballCandidateSplit({
      redPlayers,
      bluePlayers,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
    });
    const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);
    const fairness = 1 - Math.abs(score.redWinProbability - 0.5) * 2;

    if (
      !best ||
      predictedGap < best.predictedGap - 1e-9 ||
      (Math.abs(predictedGap - best.predictedGap) < 1e-9 && fairness > best.fairness)
    ) {
      best = {
        redKey: teamKey(redPlayers),
        blueKey: teamKey(bluePlayers),
        predictedGap,
        fairness,
      };
    }
  }

  return best;
}

function createStats() {
  return {
    n: 0,
    actualMarginSum: 0,
    actualWithin5: 0,
    actualBlowouts8: 0,
    predictedActualGapSum: 0,
    predictedBestGapSum: 0,
    predictedGapReductionSum: 0,
    actualMarginErrSum: 0,
    selectedLowRisk: 0,
    selectedHighRisk: 0,
    sameAsActualCount: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    avgActualMargin: stats.actualMarginSum / stats.n,
    actualWithin5: stats.actualWithin5 / stats.n,
    actualBlowoutRate: stats.actualBlowouts8 / stats.n,
    avgPredictedActualGap: stats.predictedActualGapSum / stats.n,
    avgPredictedBestGap: stats.predictedBestGapSum / stats.n,
    avgPredictedGapReduction: stats.predictedGapReductionSum / stats.n,
    actualMarginMAE: stats.actualMarginErrSum / stats.n,
    selectedLowRiskRate: stats.selectedLowRisk / stats.n,
    selectedHighRiskRate: stats.selectedHighRisk / stats.n,
    sameAsActualRate: stats.sameAsActualCount / stats.n,
  };
}

const sortedGames = getGamesSortedOldestFirst(games);
const scoredGames = sortedGames.filter(isScoredNonLeagueGame);
const priorSnapshots = [];
const priorGames = [];

for (const game of sortedGames) {
  if (isScoredNonLeagueGame(game)) {
    const prior = replayFor(priorGames);
    priorSnapshots.push({
      game,
      ratingMap: prior.ratingMap,
      carryScoreMap: prior.carryMap || {},
      modelGames: [...priorGames],
    });
  }
  priorGames.push(game);
}

function evaluate(carryScale, carryConfidenceGamesValue) {
  const volleyballOptions = {
    carryScale,
    carryConfidenceGames: carryConfidenceGamesValue,
  };
  const stats = createStats();

  for (const snapshot of priorSnapshots) {
    const { game, ratingMap, carryScoreMap, modelGames } = snapshot;
    const marginModel = calibrateMarginModel({
      games: modelGames,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
    });

    if (!marginModel?.sampleSize) continue;

    const actualScore = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
    });
    const predictedActualGap = predictExpectedMargin(actualScore.strengthDiff, marginModel);
    const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
    const present = [...game.redTeam, ...game.blueTeam];
    const best = findBestSplit({
      present,
      redSize: game.redTeam.length,
      ratingMap,
      carryScoreMap,
      marginModel,
      volleyballOptions,
    });

    const actualRedKey = teamKey(game.redTeam);
    const actualBlueKey = teamKey(game.blueTeam);
    const sameAsActual =
      (best.redKey === actualRedKey && best.blueKey === actualBlueKey) ||
      (best.redKey === actualBlueKey && best.blueKey === actualRedKey);

    stats.n += 1;
    stats.actualMarginSum += actualMargin;
    stats.actualWithin5 += actualMargin <= 5 ? 1 : 0;
    stats.actualBlowouts8 += actualMargin > 8 ? 1 : 0;
    stats.predictedActualGapSum += predictedActualGap;
    stats.predictedBestGapSum += best.predictedGap;
    stats.predictedGapReductionSum += predictedActualGap - best.predictedGap;
    stats.actualMarginErrSum += Math.abs(predictedActualGap - actualMargin);
    stats.selectedLowRisk += best.predictedGap <= 5 ? 1 : 0;
    stats.selectedHighRisk += best.predictedGap > 8 ? 1 : 0;
    stats.sameAsActualCount += sameAsActual ? 1 : 0;
  }

  return {
    carryScale,
    carryConfidenceGames: carryConfidenceGamesValue,
    ...summarize(stats),
  };
}

function composite(row) {
  return row.avgPredictedBestGap * 10 + row.actualMarginMAE - row.avgPredictedGapReduction * 0.5;
}

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function printRows(title, rows, limit = 16) {
  console.log(title);
  console.log([
    'scale'.padStart(6),
    'conf'.padStart(6),
    'actMAE'.padStart(6),
    'predAct'.padStart(7),
    'predBest'.padStart(8),
    'reduct'.padStart(6),
    'selLow'.padStart(6),
    'selHigh'.padStart(7),
    'same'.padStart(5),
    'score'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(80));
  rows.slice(0, limit).forEach(row => {
    console.log([
      fmt(row.carryScale).padStart(6),
      fmt(row.carryConfidenceGames, 0).padStart(6),
      fmt(row.actualMarginMAE).padStart(6),
      fmt(row.avgPredictedActualGap).padStart(7),
      fmt(row.avgPredictedBestGap).padStart(8),
      fmt(row.avgPredictedGapReduction).padStart(6),
      pct(row.selectedLowRiskRate).padStart(6),
      pct(row.selectedHighRiskRate).padStart(7),
      pct(row.sameAsActualRate).padStart(5),
      fmt(row.score).padStart(7),
    ].join(' '));
  });
  console.log('');
}

console.log(`DB: ${DB_PATH}`);
console.log(`scoredNonLeague=${scoredGames.length} evaluated=${priorSnapshots.length}`);
console.log('Sweeping carryScale and carryConfidenceGames with current production rating + balancer defaults.');
console.log('');

const rows = [];
let completed = 0;
const started = Date.now();

for (const carryScale of carryScales) {
  for (const confidenceGames of carryConfidenceGames) {
    const row = evaluate(carryScale, confidenceGames);
    row.score = composite(row);
    rows.push(row);
    completed += 1;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`completed ${completed}/${carryScales.length * carryConfidenceGames.length} in ${elapsed}s`);
}

const baseline = rows.filter(row =>
  Math.abs(row.carryScale - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryScale) < 1e-9 &&
  Math.abs(row.carryConfidenceGames - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryConfidenceGames) < 1e-9
);
const byComposite = [...rows].sort((a, b) => a.score - b.score);
const byBestGap = [...rows].sort((a, b) =>
  a.avgPredictedBestGap - b.avgPredictedBestGap ||
  a.actualMarginMAE - b.actualMarginMAE
);
const byReduction = [...rows].sort((a, b) =>
  b.avgPredictedGapReduction - a.avgPredictedGapReduction ||
  a.avgPredictedBestGap - b.avgPredictedBestGap
);
const byCalibration = [...rows].sort((a, b) =>
  a.actualMarginMAE - b.actualMarginMAE ||
  a.avgPredictedBestGap - b.avgPredictedBestGap
);

printRows('Baseline', baseline, 1);
printRows('Best composite candidates', byComposite, 16);
printRows('Best predicted balancing closeness', byBestGap, 16);
printRows('Largest predicted improvement over actual splits', byReduction, 16);
printRows('Best actual-split calibration', byCalibration, 16);
