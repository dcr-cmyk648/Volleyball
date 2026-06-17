// Eval-only sweep for volleyball probabilityScale using current production
// rating and balancing defaults.
//
// Run from eval/:
//   npm run probscale
// Or target values:
//   PROBABILITY_SCALES=3.2,3.4,3.6 npm run probscale

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
} from '../ratings.js';

const { db, players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value > 0);

  return values.length > 0 ? values : fallback;
}

const probabilityScales = parseListEnv(
  'PROBABILITY_SCALES',
  [2.8, 3.0, 3.2, 3.4, 3.6, 3.8, 4.0, 4.2, 4.4, 4.6, 4.8, 5.0, 5.2]
);

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
    correct: 0,
    brierSum: 0,
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
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
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

const backReplay = replayFor(games);
const backMarginModel = calibrateMarginModel({
  games,
  ratingMap: backReplay.ratingMap,
  carryScoreMap: backReplay.carryMap || {},
});

function recordPrediction(stats, game, score) {
  const predictedWinner = score.redWinProbability >= 0.5 ? 'red' : 'blue';
  const actualRed = game.winner === 'red' ? 1 : 0;
  if (predictedWinner === game.winner) stats.correct += 1;
  stats.brierSum += (score.redWinProbability - actualRed) ** 2;
}

function evaluateBack(probabilityScale) {
  const volleyballOptions = { probabilityScale };
  const stats = createStats();

  for (const game of scoredGames) {
    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: backReplay.ratingMap,
      carryScoreMap: backReplay.carryMap || {},
      volleyballOptions,
    });
    const predictedActualGap = predictExpectedMargin(score.strengthDiff, backMarginModel);
    const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);

    stats.n += 1;
    recordPrediction(stats, game, score);
    stats.actualMarginSum += actualMargin;
    stats.actualWithin5 += actualMargin <= 5 ? 1 : 0;
    stats.actualBlowouts8 += actualMargin > 8 ? 1 : 0;
    stats.predictedActualGapSum += predictedActualGap;
    stats.actualMarginErrSum += Math.abs(predictedActualGap - actualMargin);
  }

  return summarize(stats);
}

function evaluate(probabilityScale) {
  const volleyballOptions = { probabilityScale };
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
    recordPrediction(stats, game, actualScore);
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
    probabilityScale,
    back: evaluateBack(probabilityScale),
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
    'prob'.padStart(6),
    'fAcc'.padStart(6),
    'fBrier'.padStart(8),
    'bAcc'.padStart(6),
    'bBrier'.padStart(8),
    'actMAE'.padStart(6),
    'predAct'.padStart(7),
    'predBest'.padStart(8),
    'reduct'.padStart(6),
    'selLow'.padStart(6),
    'selHigh'.padStart(7),
    'same'.padStart(5),
    'score'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(102));
  rows.slice(0, limit).forEach(row => {
    console.log([
      fmt(row.probabilityScale).padStart(6),
      pct(row.accuracy).padStart(6),
      fmt(row.brier, 3).padStart(8),
      pct(row.back?.accuracy ?? null).padStart(6),
      fmt(row.back?.brier ?? null, 3).padStart(8),
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

console.log(`DB: ${sourceLabel}`);
console.log(`scoredNonLeague=${scoredGames.length} evaluated=${priorSnapshots.length}`);
console.log('Sweeping probabilityScale with current production rating + balancer defaults.');
console.log('');

const rows = probabilityScales.map(probabilityScale => {
  const row = evaluate(probabilityScale);
  row.score = composite(row);
  return row;
});

const baseline = rows.filter(row =>
  Math.abs(row.probabilityScale - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.probabilityScale) < 1e-9
);
const byComposite = [...rows].sort((a, b) => a.score - b.score);
const byBestGap = [...rows].sort((a, b) =>
  a.avgPredictedBestGap - b.avgPredictedBestGap ||
  a.actualMarginMAE - b.actualMarginMAE
);
const byCalibration = [...rows].sort((a, b) =>
  a.actualMarginMAE - b.actualMarginMAE ||
  a.avgPredictedBestGap - b.avgPredictedBestGap
);

printRows('Baseline', baseline, 1);
printRows('Best composite candidates', byComposite, 16);
printRows('Best predicted balancing closeness', byBestGap, 16);
printRows('Best actual-split calibration', byCalibration, 16);
