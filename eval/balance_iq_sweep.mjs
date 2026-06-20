// Focused BalanceIQ sweep for rating/update settings that affect team assignment.
//
// Run from eval/:
//   npm run balance:iq
// Or target values:
//   LEAGUE_MULTIPLIERS=1.5,1.75,2 CARRY_SCALES=8,10,12 CARRY_CONFIDENCE_GAMES=8,10 npm run balance:iq

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  DEFAULT_RATING_OPTIONS,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
} from '../ratings.js';
import {
  attachBalanceIQDeltas,
  compareBalanceIQDesc,
  computeBalanceIQ,
} from './metrics.mjs';

const { players, games, sourceLabel } = await loadDatabase();

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

function withRequiredValue(values, required) {
  return [...new Set([...values, required])].sort((a, b) => a - b);
}

const leagueMultipliers = withRequiredValue(
  parseListEnv('LEAGUE_MULTIPLIERS', [0.5, 1.5, 1.75, 2, 2.25, 2.5]),
  DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier
);
const carryScales = withRequiredValue(
  parseListEnv('CARRY_SCALES', [0, 8, 10, 12, 14, 16]),
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryScale
);
const carryConfidenceGames = withRequiredValue(
  parseListEnv('CARRY_CONFIDENCE_GAMES', [8, 10, 12, 15]),
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryConfidenceGames
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

function replayFor({ priorGames, leagueUpdateMultiplier }) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames: false,
    options: {
      seasonalTaperDays,
      leagueUpdateMultiplier,
    },
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

function buildSnapshots(leagueUpdateMultiplier) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const snapshots = [];
  const priorGames = [];

  for (const game of sortedGames) {
    if (isScoredNonLeagueGame(game)) {
      const prior = replayFor({ priorGames, leagueUpdateMultiplier });
      snapshots.push({
        game,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        modelGames: [...priorGames],
      });
    }
    priorGames.push(game);
  }

  return snapshots;
}

function evaluate({ leagueUpdateMultiplier, carryScale, confidenceGames, snapshots }) {
  const ratingOptions = { leagueUpdateMultiplier };
  const volleyballOptions = {
    carryScale,
    carryConfidenceGames: confidenceGames,
  };
  const stats = createStats();

  for (const snapshot of snapshots) {
    const { game, ratingMap, carryScoreMap, modelGames } = snapshot;
    const marginModel = calibrateMarginModel({
      games: modelGames,
      ratingMap,
      carryScoreMap,
      options: ratingOptions,
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

  const summary = summarize(stats);
  return {
    leagueUpdateMultiplier,
    carryScale,
    carryConfidenceGames: confidenceGames,
    ...summary,
    balanceIQ: computeBalanceIQ(summary),
  };
}

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(0)}%`;
}

function printRows(title, rows, limit = 18) {
  console.log(title);
  console.log([
    'lg'.padStart(5),
    'carry'.padStart(6),
    'conf'.padStart(5),
    'BalIQ'.padStart(6),
    'dBal'.padStart(6),
    'actMAE'.padStart(6),
    'predAct'.padStart(7),
    'predBest'.padStart(8),
    'reduct'.padStart(6),
    'selLow'.padStart(6),
    'selHigh'.padStart(7),
    'same'.padStart(5),
  ].join(' '));
  console.log('-'.repeat(89));
  rows.slice(0, limit).forEach(row => {
    console.log([
      fmt(row.leagueUpdateMultiplier).padStart(5),
      fmt(row.carryScale).padStart(6),
      fmt(row.carryConfidenceGames, 0).padStart(5),
      fmt(row.balanceIQ).padStart(6),
      fmt(row.balanceIQDelta).padStart(6),
      fmt(row.actualMarginMAE).padStart(6),
      fmt(row.avgPredictedActualGap).padStart(7),
      fmt(row.avgPredictedBestGap).padStart(8),
      fmt(row.avgPredictedGapReduction).padStart(6),
      pct(row.selectedLowRiskRate).padStart(6),
      pct(row.selectedHighRiskRate).padStart(7),
      pct(row.sameAsActualRate).padStart(5),
    ].join(' '));
  });
  console.log('');
}

console.log(`DB: ${sourceLabel}`);
console.log(`leagueMultipliers=${leagueMultipliers.join(',')}`);
console.log(`carryScales=${carryScales.join(',')}`);
console.log(`carryConfidenceGames=${carryConfidenceGames.join(',')}`);
console.log('Metric notes: BalanceIQ is primary. AccIQ/release checks still guard rating drift before shipping.');
console.log('');

const snapshotsByLeague = new Map();
const rows = [];
let completed = 0;
const started = Date.now();

for (const leagueUpdateMultiplier of leagueMultipliers) {
  const snapshots = buildSnapshots(leagueUpdateMultiplier);
  snapshotsByLeague.set(leagueUpdateMultiplier, snapshots);

  for (const carryScale of carryScales) {
    for (const confidenceGames of carryConfidenceGames) {
      rows.push(evaluate({
        leagueUpdateMultiplier,
        carryScale,
        confidenceGames,
        snapshots,
      }));
      completed += 1;
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`completed ${completed}/${leagueMultipliers.length * carryScales.length * carryConfidenceGames.length} in ${elapsed}s`);
}

attachBalanceIQDeltas(rows, row =>
  Math.abs(row.leagueUpdateMultiplier - DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier) < 1e-9 &&
  Math.abs(row.carryScale - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryScale) < 1e-9 &&
  Math.abs(row.carryConfidenceGames - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryConfidenceGames) < 1e-9
);

const baseline = rows.filter(row =>
  Math.abs(row.leagueUpdateMultiplier - DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier) < 1e-9 &&
  Math.abs(row.carryScale - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryScale) < 1e-9 &&
  Math.abs(row.carryConfidenceGames - DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryConfidenceGames) < 1e-9
);
const byBalanceIQ = [...rows].sort(compareBalanceIQDesc);
const byPredictedGap = [...rows].sort((a, b) =>
  a.avgPredictedBestGap - b.avgPredictedBestGap ||
  Number(b.balanceIQ) - Number(a.balanceIQ)
);
const byCalibration = [...rows].sort((a, b) =>
  a.actualMarginMAE - b.actualMarginMAE ||
  Number(b.balanceIQ) - Number(a.balanceIQ)
);

printRows('Baseline', baseline, 1);
printRows('Best BalanceIQ candidates', byBalanceIQ, 20);
printRows('Best predicted balancing closeness', byPredictedGap, 14);
printRows('Best actual-split calibration', byCalibration, 14);
