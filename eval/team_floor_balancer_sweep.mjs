// Eval-only sweep: penalize candidate splits that stack low-floor / weak-link
// players on one team, then compare selected-team BalanceIQ tradeoffs.

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  getRawOrdinal,
  makeInitialRating,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
} from '../ratings.js';
import {
  attachBalanceIQDeltas,
  compareBalanceIQDesc,
  computeBalanceIQ,
} from './metrics.mjs';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const weights = parseListEnv('FLOOR_WEIGHTS', [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2]);
const thresholds = parseListEnv('FLOOR_THRESHOLDS', [0, 2, 4]);

const floorModes = [
  { label: 'bottom2Avg', size: 2, type: 'avg' },
  { label: 'bottom3Avg', size: 3, type: 'avg' },
  { label: 'bottom2Load', size: 2, type: 'load' },
  { label: 'bottom3Load', size: 3, type: 'load' },
  { label: 'secondWorst', size: 2, type: 'secondWorst' },
];

const penalties = [
  {
    label: 'teamGap',
    value: (red, blue) => Math.abs(red - blue),
  },
  {
    label: 'maxTeam',
    value: (red, blue) => Math.max(red, blue),
  },
  {
    label: 'gap+max',
    value: (red, blue) => Math.abs(red - blue) + 0.5 * Math.max(red, blue),
  },
];

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : fallback;
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

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
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

function replayFor(priorGames) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: true,
    volleyballUpdateUsesBalancerContext: true,
    volleyballUpdateContextMode: 'pair',
    includeLeagueGames: true,
    options: {
      seasonalTaperDays,
      leagueDisplayEstimateEnabled: true,
    },
  });
}

function getPlayerRaw(player, ratingMap) {
  const skill = ratingMap?.[player.id] || makeInitialRating({ seasonalTaperDays });
  return getRawOrdinal(skill, { seasonalTaperDays });
}

function getTeamFloorRisk(team, ratingMap, mode, threshold) {
  const ratings = team
    .map(player => getPlayerRaw(player, ratingMap))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!ratings.length) return 0;

  const bottom = ratings.slice(0, Math.min(mode.size, ratings.length));

  if (mode.type === 'avg') {
    return -mean(bottom);
  }

  if (mode.type === 'load') {
    return bottom.reduce((sum, rating) => sum + Math.max(0, threshold - rating), 0);
  }

  if (mode.type === 'secondWorst') {
    return -(ratings[1] ?? ratings[0]);
  }

  return 0;
}

function buildSplitCandidates({ present, redSize, ratingMap, carryScoreMap, marginModel, mode, threshold, penalty }) {
  const allIndexes = new Set(present.map((_, index) => index));
  const candidates = [];

  for (const redIndexes of chooseIndexes(present.length, redSize)) {
    const redIndexSet = new Set(redIndexes);
    const redPlayers = redIndexes.map(index => present[index]);
    const bluePlayers = [...allIndexes].filter(index => !redIndexSet.has(index)).map(index => present[index]);
    const score = scoreVolleyballCandidateSplit({
      redPlayers,
      bluePlayers,
      ratingMap,
      carryScoreMap,
      volleyballOptions: DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
    });
    const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);
    const redRisk = getTeamFloorRisk(redPlayers, ratingMap, mode, threshold);
    const blueRisk = getTeamFloorRisk(bluePlayers, ratingMap, mode, threshold);
    candidates.push({
      redKey: teamKey(redPlayers),
      blueKey: teamKey(bluePlayers),
      predictedGap,
      floorPenalty: penalty.value(redRisk, blueRisk),
      fairness: 1 - Math.abs(score.redWinProbability - 0.5) * 2,
    });
  }

  return candidates;
}

function selectBestCandidate(candidates, weight) {
  let best = null;
  candidates.forEach(candidate => {
    const objective = candidate.predictedGap + weight * candidate.floorPenalty;
    if (
      !best ||
      objective < best.objective - 1e-9 ||
      (Math.abs(objective - best.objective) < 1e-9 && candidate.predictedGap < best.predictedGap - 1e-9) ||
      (Math.abs(objective - best.objective) < 1e-9 && Math.abs(candidate.predictedGap - best.predictedGap) < 1e-9 && candidate.fairness > best.fairness)
    ) {
      best = { ...candidate, objective };
    }
  });
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
    selectedFloorPenaltySum: 0,
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
    avgSelectedFloorPenalty: stats.selectedFloorPenaltySum / stats.n,
  };
}

function buildSnapshots() {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const snapshots = [];

  for (const game of sortedGames) {
    if (isScoredNonLeagueGame(game)) {
      const prior = replayFor(priorGames);
      const marginModel = calibrateMarginModel({
        games: priorGames,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options: { seasonalTaperDays },
        volleyballOptions: DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
      });
      if (marginModel?.sampleSize) {
        snapshots.push({
          game,
          ratingMap: prior.ratingMap,
          carryScoreMap: prior.carryMap || {},
          marginModel,
        });
      }
    }
    priorGames.push(game);
  }

  return snapshots;
}

function evaluateGroup({ snapshots, mode, threshold, penalty, groupWeights }) {
  const statsByWeight = new Map(groupWeights.map(weight => [weight, createStats()]));

  snapshots.forEach(snapshot => {
    const { game, ratingMap, carryScoreMap, marginModel } = snapshot;
    const actualScore = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap,
      carryScoreMap,
      volleyballOptions: DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
    });
    const predictedActualGap = predictExpectedMargin(actualScore.strengthDiff, marginModel);
    const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
    const actualRedKey = teamKey(game.redTeam);
    const actualBlueKey = teamKey(game.blueTeam);
    const candidates = buildSplitCandidates({
      present: [...game.redTeam, ...game.blueTeam],
      redSize: game.redTeam.length,
      ratingMap,
      carryScoreMap,
      marginModel,
      mode,
      threshold,
      penalty,
    });

    groupWeights.forEach(weight => {
      const best = selectBestCandidate(candidates, weight);
      const sameAsActual =
        (best.redKey === actualRedKey && best.blueKey === actualBlueKey) ||
        (best.redKey === actualBlueKey && best.blueKey === actualRedKey);
      const stats = statsByWeight.get(weight);

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
      stats.selectedFloorPenaltySum += best.floorPenalty;
    });
  });

  return groupWeights.map(weight => {
    const summary = summarize(statsByWeight.get(weight));
    return {
      mode: mode.label,
      threshold,
      penalty: penalty.label,
      weight,
      ...summary,
      balanceIQ: computeBalanceIQ(summary),
    };
  });
}

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(0)}%`;
}

function printRows(title, rows, limit = 18) {
  console.log(`\n${title}`);
  console.log([
    'mode'.padEnd(11),
    'thr'.padStart(5),
    'penalty'.padEnd(8),
    'wt'.padStart(5),
    'BalIQ'.padStart(6),
    'dBal'.padStart(6),
    'predBest'.padStart(8),
    'selLow'.padStart(6),
    'selHigh'.padStart(7),
    'floor'.padStart(7),
    'same'.padStart(5),
  ].join(' '));
  console.log('-'.repeat(88));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.mode.slice(0, 11).padEnd(11),
      fmt(row.threshold, 1).padStart(5),
      row.penalty.slice(0, 8).padEnd(8),
      fmt(row.weight, 2).padStart(5),
      fmt(row.balanceIQ).padStart(6),
      fmt(row.balanceIQDelta).padStart(6),
      fmt(row.avgPredictedBestGap).padStart(8),
      pct(row.selectedLowRiskRate).padStart(6),
      pct(row.selectedHighRiskRate).padStart(7),
      fmt(row.avgSelectedFloorPenalty).padStart(7),
      pct(row.sameAsActualRate).padStart(5),
    ].join(' '));
  });
}

console.log(`DB: ${sourceLabel}`);
console.log(`weights=${weights.join(',')}`);
console.log(`thresholds=${thresholds.join(',')}`);

const snapshots = buildSnapshots();
const rows = [];

for (const mode of floorModes) {
  const modeThresholds = mode.type === 'load' ? thresholds : [0];
  for (const threshold of modeThresholds) {
    for (const penalty of penalties) {
      rows.push(...evaluateGroup({
        snapshots,
        mode,
        threshold,
        penalty,
        groupWeights: weights,
      }));
    }
  }
}

attachBalanceIQDeltas(rows, row =>
  row.mode === floorModes[0].label &&
  row.threshold === 0 &&
  row.penalty === penalties[0].label &&
  row.weight === 0
);

const baseline = rows.find(row =>
  row.mode === floorModes[0].label &&
  row.threshold === 0 &&
  row.penalty === penalties[0].label &&
  row.weight === 0
);
const byBalance = [...rows].sort(compareBalanceIQDesc);
const bestNonZero = rows.filter(row => row.weight > 0).sort(compareBalanceIQDesc);
const byFloorRisk = [...rows].sort((a, b) =>
  a.avgSelectedFloorPenalty - b.avgSelectedFloorPenalty ||
  Number(b.balanceIQ) - Number(a.balanceIQ)
);

console.log(`Baseline: n=${baseline?.n || 0} BalanceIQ=${fmt(baseline?.balanceIQ)} predBest=${fmt(baseline?.avgPredictedBestGap)} selLow=${pct(baseline?.selectedLowRiskRate)} selHigh=${pct(baseline?.selectedHighRiskRate)} floor=${fmt(baseline?.avgSelectedFloorPenalty)}`);

printRows('Baseline', [baseline], 1);
printRows('Best BalanceIQ candidates', byBalance, 20);
printRows('Best nonzero floor penalties', bestNonZero, 20);
printRows('Lowest selected floor risk', byFloorRisk, 14);
