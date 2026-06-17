// Targeted diagnostics for team-size effects in the balancer.
//
// This looks at two related questions:
//   1. Do scoring parameters behave differently by base team size?
//   2. When the roster forces size imbalance, which base sizes look risky?
//
// Run from eval/:
//   npm run size:effects

import { loadDatabase } from './database.mjs';
import {
  buildEnvironmentAdjustedRatingMap,
  buildPairAdjustmentMap,
  calibrateMarginModel,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
  getGamesSortedOldestFirst,
  predictExpectedMargin,
  replayRatings,
  scoreVolleyballCandidateSplit,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();
const seasonalTaperDays = Math.round(6 * 30.4375);

const baseOptions = {
  ...DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
};

const parameterVariants = [
  ['current', {}],
  ['global size 1.4', { sizeBonusByBaseSizeEnabled: false, sizeBonusPerExtraPlayer: 1.4 }],
  ['global size 1.8', { sizeBonusByBaseSizeEnabled: false, sizeBonusPerExtraPlayer: 1.8 }],
  ['global size 2.2', { sizeBonusByBaseSizeEnabled: false, sizeBonusPerExtraPlayer: 2.2 }],
  ['global size 2.6', { sizeBonusByBaseSizeEnabled: false, sizeBonusPerExtraPlayer: 2.6 }],
  ['global size 3.0', { sizeBonusByBaseSizeEnabled: false, sizeBonusPerExtraPlayer: 3.0 }],
  ['weakLink off', { weakLinkPenaltyMode: 'off', weakLinkPenaltyScale: 0 }],
  ['weakLink 0.20', { weakLinkPenaltyScale: 0.20 }],
  ['weakLink 0.50', { weakLinkPenaltyScale: 0.50 }],
  ['worst 0.28', { worstPlayerWeight: 0.28, averageWeight: 0.08 }],
  ['worst 0.40', { worstPlayerWeight: 0.40, averageWeight: -0.04 }],
  ['pair off', { pairAdjustmentMode: 'off' }],
  ['silo off', { environmentSiloMode: 'off' }],
];

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(0)}%`;
}

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

function teamKey(team) {
  return team.map(player => String(player.id)).sort().join(',');
}

function getBucketForSizes(a, b) {
  const minSize = Math.min(a, b);
  const maxSize = Math.max(a, b);
  if (minSize >= 5) return `${minSize}v${maxSize} big`;
  if (minSize >= 3) return `${minSize}v${maxSize} small`;
  return `${minSize}v${maxSize}`;
}

function getFamilyForSizes(a, b) {
  return Math.min(a, b) >= 5 ? 'big' : 'small';
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

function getTargetSizes(totalPlayers) {
  return [Math.floor(totalPlayers / 2)];
}

function getTeamSizeFeatures(score) {
  const redSize = Number(score.redEffectiveSize) || 0;
  const blueSize = Number(score.blueEffectiveSize) || 0;
  const minSize = Math.min(redSize, blueSize);
  const sizeDiff = Math.abs(redSize - blueSize);
  const sizeAdjustmentSwing = Math.abs(Number(score.redSizeAdjustment) - Number(score.blueSizeAdjustment));
  return {
    minSize,
    sizeDiff,
    sizeAdjustmentSwing,
    sizeSwingPerSmallerPlayer: minSize > 0 ? sizeAdjustmentSwing / minSize : 0,
  };
}

function scoreSplit({ present, redIndexes, ratingMap, carryScoreMap, marginModel, volleyballOptions, pairAdjustmentMap }) {
  const redIndexSet = new Set(redIndexes);
  const redPlayers = redIndexes.map(index => present[index]);
  const bluePlayers = present
    .filter((_, index) => !redIndexSet.has(index));
  const score = scoreVolleyballCandidateSplit({
    redPlayers,
    bluePlayers,
    ratingMap,
    carryScoreMap,
    volleyballOptions,
    pairAdjustmentMap,
  });
  const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);

  return {
    redPlayers,
    bluePlayers,
    redKey: teamKey(redPlayers),
    blueKey: teamKey(bluePlayers),
    predictedGap,
    fairness: score.fairness,
    redWinProbability: score.redWinProbability,
    strengthDiff: Math.abs(score.strengthDiff),
    highRisk: predictedGap > 8 || Math.max(score.redWinProbability, score.blueWinProbability) > 0.70,
    ...getTeamSizeFeatures(score),
  };
}

function findBestSplit({ present, redSize, ratingMap, carryScoreMap, marginModel, volleyballOptions, pairAdjustmentMap }) {
  let best = null;
  for (const redIndexes of chooseIndexes(present.length, redSize)) {
    const candidate = scoreSplit({
      present,
      redIndexes,
      ratingMap,
      carryScoreMap,
      marginModel,
      volleyballOptions,
      pairAdjustmentMap,
    });
    if (
      !best ||
      candidate.predictedGap < best.predictedGap - 1e-9 ||
      (Math.abs(candidate.predictedGap - best.predictedGap) < 1e-9 && candidate.fairness > best.fairness)
    ) {
      best = candidate;
    }
  }
  return best;
}

function createStats() {
  return {
    n: 0,
    actualMarginSum: 0,
    predictedActualGapSum: 0,
    predictedBestGapSum: 0,
    predictedGapReductionSum: 0,
    predictedBestHighRisk: 0,
    sameAsActual: 0,
    sizeAdjustmentSwingSum: 0,
    sizeSwingPerSmallerPlayerSum: 0,
    actualBlowout8: 0,
    actualWithin5: 0,
  };
}

function addStats(stats, { actualMargin, predictedActualGap, best, sameAsActual }) {
  stats.n += 1;
  stats.actualMarginSum += actualMargin;
  stats.predictedActualGapSum += predictedActualGap;
  stats.predictedBestGapSum += best.predictedGap;
  stats.predictedGapReductionSum += predictedActualGap - best.predictedGap;
  stats.predictedBestHighRisk += best.highRisk ? 1 : 0;
  stats.sameAsActual += sameAsActual ? 1 : 0;
  stats.sizeAdjustmentSwingSum += best.sizeAdjustmentSwing || 0;
  stats.sizeSwingPerSmallerPlayerSum += best.sizeSwingPerSmallerPlayer || 0;
  stats.actualBlowout8 += actualMargin > 8 ? 1 : 0;
  stats.actualWithin5 += actualMargin <= 5 ? 1 : 0;
}

function summarize(stats) {
  if (!stats.n) return null;
  return {
    n: stats.n,
    avgActualMargin: stats.actualMarginSum / stats.n,
    avgPredictedActualGap: stats.predictedActualGapSum / stats.n,
    avgPredictedBestGap: stats.predictedBestGapSum / stats.n,
    avgPredictedGapReduction: stats.predictedGapReductionSum / stats.n,
    predictedBestHighRiskRate: stats.predictedBestHighRisk / stats.n,
    sameAsActualRate: stats.sameAsActual / stats.n,
    avgSizeAdjustmentSwing: stats.sizeAdjustmentSwingSum / stats.n,
    avgSizeSwingPerSmallerPlayer: stats.sizeSwingPerSmallerPlayerSum / stats.n,
    actualBlowout8Rate: stats.actualBlowout8 / stats.n,
    actualWithin5Rate: stats.actualWithin5 / stats.n,
  };
}

function addToMap(map, key, value) {
  if (!map.has(key)) map.set(key, createStats());
  addStats(map.get(key), value);
}

function evaluateVariant(snapshots, label, overrides = {}) {
  const volleyballOptions = {
    ...baseOptions,
    ...overrides,
  };
  const byBucket = new Map();
  const byFamily = new Map();
  const imbalanceStats = new Map();

  for (const snapshot of snapshots) {
    const { game, modelGames } = snapshot;
    const present = [...game.redTeam, ...game.blueTeam];
    const ratingMap = buildEnvironmentAdjustedRatingMap({
      players,
      games: modelGames,
      baseRatingMap: snapshot.replay.ratingMap,
      ratingOptions: snapshot.ratingOptions,
      volleyballOptions,
      teamCount: 2,
      playerCount: present.length,
    });
    const pairAdjustmentMap = buildPairAdjustmentMap({
      players,
      games: modelGames,
      ratingOptions: snapshot.ratingOptions,
      volleyballOptions,
      seasonal: true,
    });
    const carryScoreMap = snapshot.replay.carryMap || {};
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
      pairAdjustmentMap,
    });
    const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
    const predictedActualGap = predictExpectedMargin(actualScore.strengthDiff, marginModel);
    const actualRedKey = teamKey(game.redTeam);
    const actualBlueKey = teamKey(game.blueTeam);
    const targetSizes = getTargetSizes(present.length);

    targetSizes.forEach(redSize => {
      const best = findBestSplit({
        present,
        redSize,
        ratingMap,
        carryScoreMap,
        marginModel,
        volleyballOptions,
        pairAdjustmentMap,
      });
      const sameAsActual =
        (best.redKey === actualRedKey && best.blueKey === actualBlueKey) ||
        (best.redKey === actualBlueKey && best.blueKey === actualRedKey);
      const value = { actualMargin, predictedActualGap, best, sameAsActual };
      const bucket = getBucketForSizes(best.redPlayers.length, best.bluePlayers.length);
      addToMap(byBucket, bucket, value);
      addToMap(byFamily, getFamilyForSizes(best.redPlayers.length, best.bluePlayers.length), value);
      if (best.sizeDiff > 0) addToMap(imbalanceStats, bucket, value);
    });
  }

  return {
    label,
    byBucket,
    byFamily,
    imbalanceStats,
  };
}

function printSummaryTable(title, summaries, limit = 50) {
  console.log(title);
  console.log([
    'variant'.padEnd(16),
    'bucket'.padEnd(12),
    'n'.padStart(4),
    'actMar'.padStart(7),
    'predAct'.padStart(7),
    'predBest'.padStart(8),
    'reduct'.padStart(7),
    'hiRisk'.padStart(7),
    'same'.padStart(6),
    'szSwing'.padStart(8),
    'sz/plyr'.padStart(8),
    'blow8'.padStart(7),
    'within5'.padStart(8),
  ].join(' '));
  console.log('-'.repeat(119));
  summaries.slice(0, limit).forEach(row => {
    console.log([
      row.variant.padEnd(16),
      row.bucket.padEnd(12),
      String(row.summary.n).padStart(4),
      fmt(row.summary.avgActualMargin).padStart(7),
      fmt(row.summary.avgPredictedActualGap).padStart(7),
      fmt(row.summary.avgPredictedBestGap).padStart(8),
      fmt(row.summary.avgPredictedGapReduction).padStart(7),
      pct(row.summary.predictedBestHighRiskRate).padStart(7),
      pct(row.summary.sameAsActualRate).padStart(6),
      fmt(row.summary.avgSizeAdjustmentSwing).padStart(8),
      fmt(row.summary.avgSizeSwingPerSmallerPlayer).padStart(8),
      pct(row.summary.actualBlowout8Rate).padStart(7),
      pct(row.summary.actualWithin5Rate).padStart(8),
    ].join(' '));
  });
  console.log('');
}

const sortedGames = getGamesSortedOldestFirst(games);
const snapshots = [];
const priorGames = [];
const ratingOptions = { seasonalTaperDays };

for (const game of sortedGames) {
  if (isScoredNonLeagueGame(game)) {
    snapshots.push({
      game,
      modelGames: [...priorGames],
      replay: replayRatings({
        players,
        games: priorGames,
        seasonal: true,
        volleyballAdjusted: false,
        includeLeagueGames: true,
        options: ratingOptions,
      }),
      ratingOptions,
    });
  }
  priorGames.push(game);
}

console.log(`DB: ${sourceLabel}`);
console.log(`scoredNonLeague=${snapshots.length}`);
console.log(`Current sizeBonusByBaseSize=${JSON.stringify(baseOptions.sizeBonusByBaseSize)} enabled=${baseOptions.sizeBonusByBaseSizeEnabled}`);
console.log('');

const allResults = parameterVariants.map(([label, overrides]) =>
  evaluateVariant(snapshots, label, overrides)
);

const bucketRows = [];
allResults.forEach(result => {
  result.byBucket.forEach((stats, bucket) => {
    const summary = summarize(stats);
    if (summary) bucketRows.push({ variant: result.label, bucket, summary });
  });
});

const familyRows = [];
allResults.forEach(result => {
  result.byFamily.forEach((stats, bucket) => {
    const summary = summarize(stats);
    if (summary) familyRows.push({ variant: result.label, bucket, summary });
  });
});

const imbalanceRows = [];
allResults.forEach(result => {
  result.imbalanceStats.forEach((stats, bucket) => {
    const summary = summarize(stats);
    if (summary) imbalanceRows.push({ variant: result.label, bucket, summary });
  });
});

printSummaryTable(
  'Current by exact target size',
  bucketRows
    .filter(row => row.variant === 'current')
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
);

printSummaryTable(
  'Current by size family',
  familyRows
    .filter(row => row.variant === 'current')
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
);

printSummaryTable(
  'Natural size-imbalance cases only',
  imbalanceRows
    .filter(row => row.variant === 'current')
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
);

printSummaryTable(
  'Variant comparison by size family',
  familyRows.sort((a, b) =>
    a.bucket.localeCompare(b.bucket) ||
    a.summary.avgPredictedBestGap - b.summary.avgPredictedBestGap
  )
);

printSummaryTable(
  'Size-bonus variants on natural imbalances',
  imbalanceRows
    .filter(row => row.variant === 'current' || row.variant.startsWith('global size '))
    .sort((a, b) =>
      a.bucket.localeCompare(b.bucket) ||
      a.summary.avgPredictedBestGap - b.summary.avgPredictedBestGap
    )
);
