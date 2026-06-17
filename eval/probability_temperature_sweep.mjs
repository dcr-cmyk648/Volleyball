// Eval-only sweep for probabilityTemperature.
//
// This parameter calibrates displayed/predicted win probabilities. Rating
// updates intentionally use probabilityTemperature=1 internally, so this sweep
// focuses on probability calibration, not rating movement.
//
// Run from eval/:
//   npm run probtemp
// Or target values:
//   PROBABILITY_TEMPERATURES=0.6,0.7,0.8 npm run probtemp

import { loadDatabase } from './database.mjs';
import { attachAccIQDeltas, compareAccIQDesc, computeAccIQ } from './metrics.mjs';
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
const EPS = 1e-9;

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value > 0);

  return values.length > 0 ? values : fallback;
}

const temperatures = parseListEnv(
  'PROBABILITY_TEMPERATURES',
  [0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 1.00, 1.10, 1.20, 1.35, 1.50]
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
      predictedGap < best.predictedGap - EPS ||
      (Math.abs(predictedGap - best.predictedGap) < EPS && fairness > best.fairness)
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
    logLossSum: 0,
    confidenceSum: 0,
    actualMarginErrSum: 0,
    predictedActualGapSum: 0,
    predictedBestGapSum: 0,
    predictedGapReductionSum: 0,
    selectedLowRisk: 0,
    selectedHighRisk: 0,
    sameAsActualCount: 0,
  };
}

function addGameStats(stats, probabilityRed, winner, predictedGap, actualMargin, best = null, actualTeamKeys = null) {
  const yRed = winner === 'red' ? 1 : 0;
  const clamped = Math.min(0.999, Math.max(0.001, probabilityRed));
  const predictedWinner = probabilityRed >= 0.5 ? 'red' : 'blue';

  stats.n += 1;
  stats.correct += predictedWinner === winner ? 1 : 0;
  stats.brierSum += (probabilityRed - yRed) ** 2;
  stats.logLossSum += -(yRed * Math.log(clamped) + (1 - yRed) * Math.log(1 - clamped));
  stats.confidenceSum += Math.max(probabilityRed, 1 - probabilityRed);
  stats.actualMarginErrSum += Math.abs(predictedGap - actualMargin);
  stats.predictedActualGapSum += predictedGap;

  if (best && actualTeamKeys) {
    stats.predictedBestGapSum += best.predictedGap;
    stats.predictedGapReductionSum += predictedGap - best.predictedGap;
    stats.selectedLowRisk += best.predictedGap <= 5 ? 1 : 0;
    stats.selectedHighRisk += best.predictedGap > 8 ? 1 : 0;
    const sameAsActual =
      (best.redKey === actualTeamKeys.red && best.blueKey === actualTeamKeys.blue) ||
      (best.redKey === actualTeamKeys.blue && best.blueKey === actualTeamKeys.red);
    stats.sameAsActualCount += sameAsActual ? 1 : 0;
  }
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.correct / stats.n,
    brier: stats.brierSum / stats.n,
    logLoss: stats.logLossSum / stats.n,
    avgConfidence: stats.confidenceSum / stats.n,
    marginMAE: stats.actualMarginErrSum / stats.n,
    avgPredictedActualGap: stats.predictedActualGapSum / stats.n,
    avgPredictedBestGap: stats.predictedBestGapSum ? stats.predictedBestGapSum / stats.n : null,
    avgPredictedGapReduction: stats.predictedGapReductionSum ? stats.predictedGapReductionSum / stats.n : null,
    selectedLowRiskRate: stats.selectedLowRisk ? stats.selectedLowRisk / stats.n : null,
    selectedHighRiskRate: stats.selectedHighRisk ? stats.selectedHighRisk / stats.n : null,
    sameAsActualRate: stats.sameAsActualCount ? stats.sameAsActualCount / stats.n : null,
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

const finalReplay = replayFor(sortedGames);

function evaluateForward(probabilityTemperature) {
  const volleyballOptions = { probabilityTemperature };
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

    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
    });
    const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);
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

    addGameStats(
      stats,
      score.redWinProbability,
      game.winner,
      predictedGap,
      actualMargin,
      best,
      { red: teamKey(game.redTeam), blue: teamKey(game.blueTeam) }
    );
  }

  return summarize(stats);
}

function evaluateBack(probabilityTemperature) {
  const volleyballOptions = { probabilityTemperature };
  const stats = createStats();
  const marginModel = calibrateMarginModel({
    games,
    ratingMap: finalReplay.ratingMap,
    carryScoreMap: finalReplay.carryMap || {},
    volleyballOptions,
  });

  for (const game of scoredGames) {
    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: finalReplay.ratingMap,
      carryScoreMap: finalReplay.carryMap || {},
      volleyballOptions,
    });
    const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);
    const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
    addGameStats(stats, score.redWinProbability, game.winner, predictedGap, actualMargin);
  }

  return summarize(stats);
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function printRows(title, rows, limit = 16) {
  console.log(title);
  console.log([
    'temp'.padStart(6),
    'fAcc'.padStart(6),
    'fBrier'.padStart(8),
    'fLog'.padStart(7),
    'fConf'.padStart(7),
    'fBest'.padStart(7),
    'bAcc'.padStart(6),
    'bBrier'.padStart(8),
    'bLog'.padStart(7),
    'AccIQ'.padStart(7),
    'dIQ'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(96));
  rows.slice(0, limit).forEach(row => {
    console.log([
      fmt(row.temperature, 2).padStart(6),
      pct(row.forward.accuracy).padStart(6),
      fmt(row.forward.brier).padStart(8),
      fmt(row.forward.logLoss).padStart(7),
      fmt(row.forward.avgConfidence).padStart(7),
      fmt(row.forward.avgPredictedBestGap, 2).padStart(7),
      pct(row.back.accuracy).padStart(6),
      fmt(row.back.brier).padStart(8),
      fmt(row.back.logLoss).padStart(7),
      fmt(row.accIQ, 2).padStart(7),
      fmt(row.accIQDelta, 2).padStart(7),
    ].join(' '));
  });
  console.log('');
}

console.log(`DB: ${sourceLabel}`);
console.log(`scoredNonLeague=${scoredGames.length} evaluated=${priorSnapshots.length}`);
console.log('Sweeping probabilityTemperature with current production rating + balancer defaults.');
console.log('');

const rows = temperatures.map(temperature => {
  const row = {
    temperature,
    forward: evaluateForward(temperature),
    back: evaluateBack(temperature),
  };
  row.accIQ = computeAccIQ({ forward: row.forward, back: row.back });
  return row;
});

const baseline = rows.filter(row =>
  Math.abs(row.temperature - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.probabilityTemperature) < EPS
);
attachAccIQDeltas(rows, row =>
  Math.abs(row.temperature - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.probabilityTemperature) < EPS
);
const byAccIQ = [...rows].sort(compareAccIQDesc);
const byForwardBrier = [...rows].sort((a, b) =>
  a.forward.brier - b.forward.brier ||
  a.forward.logLoss - b.forward.logLoss
);
const byForwardLogLoss = [...rows].sort((a, b) =>
  a.forward.logLoss - b.forward.logLoss ||
  a.forward.brier - b.forward.brier
);
const byBackBrier = [...rows].sort((a, b) =>
  a.back.brier - b.back.brier ||
  a.back.logLoss - b.back.logLoss
);

printRows('Baseline', baseline, 1);
printRows('Best AccIQ candidates', byAccIQ, 16);
printRows('Best forward Brier candidates', byForwardBrier, 16);
printRows('Best forward log-loss candidates', byForwardLogLoss, 16);
printRows('Best backward Brier candidates', byBackBrier, 16);
