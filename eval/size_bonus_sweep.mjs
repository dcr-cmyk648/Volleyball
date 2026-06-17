// Sweep base-size-specific size bonuses for naturally imbalanced 2-team rosters.
//
// Production now uses base-size-specific size bonuses. This harness disables the
// production size bonus, then applies a harness-only size adjustment based on the
// smaller raw team size:
//   3v4 -> size3 bonus, 4v5 -> size4 bonus, 5v6 -> size5 bonus, 6v7+ -> size6 bonus.
//
// Run from eval/:
//   npm run size:bonus

import { loadDatabase } from './database.mjs';
import {
  buildEnvironmentAdjustedRatingMap,
  buildPairAdjustmentMap,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
  getGamesSortedOldestFirst,
  replayRatings,
  scoreVolleyballCandidateSplit,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();
const seasonalTaperDays = Math.round(6 * 30.4375);
const baseOptions = {
  ...DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
  sizeBonusPerExtraPlayer: 0,
  sizeBonusByBaseSizeEnabled: false,
};

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
  return values.length ? values : fallback;
}

const size3Bonuses = parseListEnv('SIZE3_BONUSES', [1.4, 1.8, 2.2, 2.6, 3.0]);
const size4Bonuses = parseListEnv('SIZE4_BONUSES', [1.4, 1.8, 2.2, 2.6, 3.0]);
const size5Bonuses = parseListEnv('SIZE5_BONUSES', [1.4, 1.8, 2.2, 2.6, 3.0]);
const size6Bonuses = parseListEnv('SIZE6_BONUSES', [0.0, 1.4, 2.2, 3.0]);

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(0)}%`;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
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

function getSizeBucket(redSize, blueSize) {
  return Math.min(redSize, blueSize);
}

function getBucketLabel(redSize, blueSize) {
  const min = Math.min(redSize, blueSize);
  const max = Math.max(redSize, blueSize);
  return `${min}v${max}`;
}

function getSizeBonus(redSize, blueSize, config) {
  const bucket = getSizeBucket(redSize, blueSize);
  if (bucket <= 3) return config.size3;
  if (bucket === 4) return config.size4;
  if (bucket === 5) return config.size5;
  return config.size6;
}

function applyDynamicSizeBonus(score, redPlayers, bluePlayers, config, volleyballOptions) {
  const redSize = redPlayers.length;
  const blueSize = bluePlayers.length;
  const sizeDiff = redSize - blueSize;
  const sizeBonus = getSizeBonus(redSize, blueSize, config);
  const sizeSwing = sizeDiff * sizeBonus * 2;
  const strengthDiff = score.strengthDiff + sizeSwing;
  const probabilityScale = Math.max(0.01, Number(volleyballOptions.probabilityScale) || 4.2);
  const probabilityTemperature = Math.max(0.01, Number(volleyballOptions.probabilityTemperature) || 1.5);
  const redWinProbability = Math.max(
    Number(volleyballOptions.minWinProbability) || 0.05,
    Math.min(
      Number(volleyballOptions.maxWinProbability) || 0.95,
      sigmoid((strengthDiff / probabilityScale) / probabilityTemperature)
    )
  );

  return {
    ...score,
    redWinProbability,
    blueWinProbability: 1 - redWinProbability,
    fairness: 1 - Math.abs(redWinProbability - 0.5) * 2,
    strengthDiff,
    dynamicSizeBonus: sizeBonus,
    dynamicSizeSwing: Math.abs(sizeSwing),
  };
}

function getMarginModel(modelGames, ratingMap, carryScoreMap, pairAdjustmentMap, config, volleyballOptions) {
  const xs = [];
  const ys = [];

  modelGames.forEach(game => {
    if (!isScoredNonLeagueGame(game)) return;
    const baseScore = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
      pairAdjustmentMap,
    });
    const score = applyDynamicSizeBonus(baseScore, game.redTeam, game.blueTeam, config, volleyballOptions);
    xs.push(Math.abs(score.strengthDiff));
    ys.push(Math.abs(game.scoreRed - game.scoreBlue));
  });

  const sampleSize = xs.length;
  if (!sampleSize) return { baseMargin: 0, slope: 0, sampleSize: 0 };

  const meanX = xs.reduce((sum, value) => sum + value, 0) / sampleSize;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / sampleSize;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return {
    baseMargin: meanY - slope * meanX,
    slope,
    sampleSize,
  };
}

function predictExpectedMargin(strengthDiff, marginModel) {
  if (!marginModel) return 0;
  return Math.max(0, marginModel.baseMargin + marginModel.slope * Math.abs(strengthDiff));
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

function scoreSplit({ present, redIndexes, ratingMap, carryScoreMap, pairAdjustmentMap, marginModel, config, volleyballOptions }) {
  const redIndexSet = new Set(redIndexes);
  const redPlayers = redIndexes.map(index => present[index]);
  const bluePlayers = present.filter((_, index) => !redIndexSet.has(index));
  const baseScore = scoreVolleyballCandidateSplit({
    redPlayers,
    bluePlayers,
    ratingMap,
    carryScoreMap,
    volleyballOptions,
    pairAdjustmentMap,
  });
  const score = applyDynamicSizeBonus(baseScore, redPlayers, bluePlayers, config, volleyballOptions);
  const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);

  return {
    redPlayers,
    bluePlayers,
    redKey: teamKey(redPlayers),
    blueKey: teamKey(bluePlayers),
    bucket: getBucketLabel(redPlayers.length, bluePlayers.length),
    predictedGap,
    fairness: score.fairness,
    dynamicSizeBonus: score.dynamicSizeBonus,
    dynamicSizeSwing: score.dynamicSizeSwing,
    highRisk: predictedGap > 8 || Math.max(score.redWinProbability, score.blueWinProbability) > 0.70,
  };
}

function findBestSplit({ present, redSize, ratingMap, carryScoreMap, pairAdjustmentMap, marginModel, config, volleyballOptions }) {
  let best = null;
  for (const redIndexes of chooseIndexes(present.length, redSize)) {
    const candidate = scoreSplit({
      present,
      redIndexes,
      ratingMap,
      carryScoreMap,
      pairAdjustmentMap,
      marginModel,
      config,
      volleyballOptions,
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
    actualMarginErrSum: 0,
    predictedActualGapSum: 0,
    predictedBestGapSum: 0,
    predictedReductionSum: 0,
    highRiskSum: 0,
    sameAsActualSum: 0,
    sizeSwingSum: 0,
  };
}

function addStats(stats, value) {
  stats.n += 1;
  stats.actualMarginSum += value.actualMargin;
  stats.actualMarginErrSum += Math.abs(value.predictedActualGap - value.actualMargin);
  stats.predictedActualGapSum += value.predictedActualGap;
  stats.predictedBestGapSum += value.best.predictedGap;
  stats.predictedReductionSum += value.predictedActualGap - value.best.predictedGap;
  stats.highRiskSum += value.best.highRisk ? 1 : 0;
  stats.sameAsActualSum += value.sameAsActual ? 1 : 0;
  stats.sizeSwingSum += value.best.dynamicSizeSwing || 0;
}

function summarize(stats) {
  if (!stats.n) return null;
  return {
    n: stats.n,
    actualMargin: stats.actualMarginSum / stats.n,
    actualMAE: stats.actualMarginErrSum / stats.n,
    predictedActualGap: stats.predictedActualGapSum / stats.n,
    predictedBestGap: stats.predictedBestGapSum / stats.n,
    predictedReduction: stats.predictedReductionSum / stats.n,
    highRiskRate: stats.highRiskSum / stats.n,
    sameAsActualRate: stats.sameAsActualSum / stats.n,
    sizeSwing: stats.sizeSwingSum / stats.n,
  };
}

function getComposite(summary) {
  // Lower is better. This prioritizes predicted closeness, but keeps actual
  // split calibration in the score so huge size bonuses cannot win by illusion.
  return summary.predictedBestGap * 10 + summary.actualMAE - summary.predictedReduction * 0.4;
}

function evaluateConfig(snapshots, config) {
  const byBucket = new Map();
  const all = createStats();

  for (const snapshot of snapshots) {
    const { game, context } = snapshot;
    const present = [...game.redTeam, ...game.blueTeam];
    if (present.length % 2 === 0) continue;

    const marginModel = getMarginModel(
      context.modelGames,
      context.ratingMap,
      context.carryScoreMap,
      context.pairAdjustmentMap,
      config,
      context.volleyballOptions
    );
    if (!marginModel.sampleSize) continue;

    const actualBaseScore = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: context.ratingMap,
      carryScoreMap: context.carryScoreMap,
      volleyballOptions: context.volleyballOptions,
      pairAdjustmentMap: context.pairAdjustmentMap,
    });
    const actualScore = applyDynamicSizeBonus(
      actualBaseScore,
      game.redTeam,
      game.blueTeam,
      config,
      context.volleyballOptions
    );
    const predictedActualGap = predictExpectedMargin(actualScore.strengthDiff, marginModel);
    const best = findBestSplit({
      present,
      redSize: Math.floor(present.length / 2),
      ratingMap: context.ratingMap,
      carryScoreMap: context.carryScoreMap,
      pairAdjustmentMap: context.pairAdjustmentMap,
      marginModel,
      config,
      volleyballOptions: context.volleyballOptions,
    });
    const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
    const actualRedKey = teamKey(game.redTeam);
    const actualBlueKey = teamKey(game.blueTeam);
    const sameAsActual =
      (best.redKey === actualRedKey && best.blueKey === actualBlueKey) ||
      (best.redKey === actualBlueKey && best.blueKey === actualRedKey);
    const value = { actualMargin, predictedActualGap, best, sameAsActual };
    addStats(all, value);
    if (!byBucket.has(best.bucket)) byBucket.set(best.bucket, createStats());
    addStats(byBucket.get(best.bucket), value);
  }

  const summary = summarize(all);
  return {
    ...config,
    summary,
    score: summary ? getComposite(summary) : Infinity,
    byBucket,
  };
}

function printRows(title, rows, limit = 20) {
  console.log(title);
  console.log([
    's3'.padStart(5),
    's4'.padStart(5),
    's5'.padStart(5),
    's6'.padStart(5),
    'n'.padStart(4),
    'act'.padStart(6),
    'mae'.padStart(6),
    'predA'.padStart(7),
    'predB'.padStart(7),
    'red'.padStart(6),
    'hi'.padStart(5),
    'same'.padStart(6),
    'swing'.padStart(7),
    'score'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(92));
  rows.slice(0, limit).forEach(row => {
    const s = row.summary;
    console.log([
      fmt(row.size3, 1).padStart(5),
      fmt(row.size4, 1).padStart(5),
      fmt(row.size5, 1).padStart(5),
      fmt(row.size6, 1).padStart(5),
      String(s.n).padStart(4),
      fmt(s.actualMargin).padStart(6),
      fmt(s.actualMAE).padStart(6),
      fmt(s.predictedActualGap).padStart(7),
      fmt(s.predictedBestGap).padStart(7),
      fmt(s.predictedReduction).padStart(6),
      pct(s.highRiskRate).padStart(5),
      pct(s.sameAsActualRate).padStart(6),
      fmt(s.sizeSwing).padStart(7),
      fmt(row.score).padStart(7),
    ].join(' '));
  });
  console.log('');
}

function printBucketRows(title, rows, limit = 30) {
  console.log(title);
  console.log([
    'bucket'.padEnd(7),
    's3'.padStart(5),
    's4'.padStart(5),
    's5'.padStart(5),
    's6'.padStart(5),
    'n'.padStart(4),
    'act'.padStart(6),
    'mae'.padStart(6),
    'predB'.padStart(7),
    'red'.padStart(6),
    'hi'.padStart(5),
    'swing'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(82));
  rows.slice(0, limit).forEach(row => {
    const s = row.summary;
    console.log([
      row.bucket.padEnd(7),
      fmt(row.size3, 1).padStart(5),
      fmt(row.size4, 1).padStart(5),
      fmt(row.size5, 1).padStart(5),
      fmt(row.size6, 1).padStart(5),
      String(s.n).padStart(4),
      fmt(s.actualMargin).padStart(6),
      fmt(s.actualMAE).padStart(6),
      fmt(s.predictedBestGap).padStart(7),
      fmt(s.predictedReduction).padStart(6),
      pct(s.highRiskRate).padStart(5),
      fmt(s.sizeSwing).padStart(7),
    ].join(' '));
  });
  console.log('');
}

const ratingOptions = { seasonalTaperDays };
const sortedGames = getGamesSortedOldestFirst(games);
const snapshots = [];
const priorGames = [];

for (const game of sortedGames) {
  if (isScoredNonLeagueGame(game)) {
    const replay = replayRatings({
      players,
      games: priorGames,
      seasonal: true,
      volleyballAdjusted: false,
      includeLeagueGames: true,
      options: ratingOptions,
    });
    const present = [...game.redTeam, ...game.blueTeam];
    const ratingMap = buildEnvironmentAdjustedRatingMap({
      players,
      games: priorGames,
      baseRatingMap: replay.ratingMap,
      ratingOptions,
      volleyballOptions: baseOptions,
      teamCount: 2,
      playerCount: present.length,
    });
    const pairAdjustmentMap = buildPairAdjustmentMap({
      players,
      games: priorGames,
      ratingOptions,
      volleyballOptions: baseOptions,
      seasonal: true,
    });
    snapshots.push({
      game,
      context: {
        modelGames: [...priorGames],
        ratingMap,
        carryScoreMap: replay.carryMap || {},
        pairAdjustmentMap,
        volleyballOptions: baseOptions,
      },
    });
  }
  priorGames.push(game);
}

console.log(`DB: ${sourceLabel}`);
console.log(`scoredNonLeague=${snapshots.length}`);
console.log(`odd-roster imbalanced snapshots=${snapshots.filter(s => (s.game.redTeam.length + s.game.blueTeam.length) % 2 === 1).length}`);
console.log(`size3=${size3Bonuses.join(',')} size4=${size4Bonuses.join(',')} size5=${size5Bonuses.join(',')} size6=${size6Bonuses.join(',')}`);
console.log('');

const rows = [];
let completed = 0;
const total = size3Bonuses.length * size4Bonuses.length * size5Bonuses.length * size6Bonuses.length;
const started = Date.now();

for (const size3 of size3Bonuses) {
  for (const size4 of size4Bonuses) {
    for (const size5 of size5Bonuses) {
      for (const size6 of size6Bonuses) {
        rows.push(evaluateConfig(snapshots, { size3, size4, size5, size6 }));
        completed += 1;
      }
    }
  }
  console.error(`completed ${completed}/${total} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

const byScore = [...rows].sort((a, b) => a.score - b.score);
const baseline = rows.filter(row =>
  Math.abs(row.size3 - 2.2) < 1e-9 &&
  Math.abs(row.size4 - 1.4) < 1e-9 &&
  Math.abs(row.size5 - 2.6) < 1e-9 &&
  Math.abs(row.size6 - 0.0) < 1e-9
);
const productionLike = rows.filter(row =>
  Math.abs(row.size3 - 2.2) < 1e-9 &&
  Math.abs(row.size4 - 1.4) < 1e-9 &&
  Math.abs(row.size5 - 2.6) < 1e-9 &&
  Math.abs(row.size6 - 2.2) < 1e-9
);

printRows('Baseline current-cap equivalent', baseline, 1);
printRows('Production-like uncapped 6v7+', productionLike, 1);
printRows('Best base-size-specific size bonuses', byScore, 20);

const bucketRows = [];
byScore.slice(0, 8).forEach(row => {
  row.byBucket.forEach((stats, bucket) => {
    const summary = summarize(stats);
    if (summary) bucketRows.push({ ...row, bucket, summary });
  });
});

printBucketRows(
  'Bucket details for top candidates',
  bucketRows.sort((a, b) =>
    a.bucket.localeCompare(b.bucket) ||
    a.score - b.score
  ),
  40
);
