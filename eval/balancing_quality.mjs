// Eval-only harness for separating rating replay quality from team-balancing quality.
//
// For each historical scored non-league game:
//   1. Replay ratings using only prior games under a rating config.
//   2. Score the actual historical split under a balancer config.
//   3. Exhaustively search same-size candidate splits from the same present players.
//   4. Report actual-split calibration and the predicted closeness available
//      to the balancer. Counterfactual actual scores are unknowable, so the
//      "best split" metrics are predicted opportunity, not proof of outcome.
//
// Run from eval/:
//   npm run balance

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
} from '../ratings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.VBALL_DB || resolve(__dirname, '../default_database');
const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
const players = db.players || [];
const games = db.games || [];

const SEASON_MONTHS = 6;
const seasonalTaperDays = Math.round(SEASON_MONTHS * 30.4375);

const ratingConfigs = [
  ['rating: current league x2.3', {}, true],
  ['rating: exclude league', {}, false],
  ['rating: league x1', { leagueUpdateMultiplier: 1.0 }, true],
  ['rating: league x2', { leagueUpdateMultiplier: 2.0 }, true],
  ['rating: league x2.5', { leagueUpdateMultiplier: 2.5 }, true],
];

const w = (top, second, average, depth, worst, extra = {}) => ({
  topPlayerWeight: top,
  secondPlayerWeight: second,
  averageWeight: average,
  depthWeight: depth,
  worstPlayerWeight: worst,
  ...extra,
});

const balancingConfigs = [
  ['balancer: current', {}],
  ['balancer: top-heavy', w(0.45, 0.20, 0.17, 0.12, 0.06)],
  ['balancer: flat-ish', w(0.25, 0.22, 0.33, 0.12, 0.08)],
  ['balancer: weak-link+', w(0.27, 0.22, 0.28, 0.10, 0.13)],
  ['balancer: weak-link++', w(0.24, 0.20, 0.28, 0.10, 0.18)],
  ['balancer: weak-link-', w(0.33, 0.25, 0.28, 0.10, 0.04)],
  ['balancer: no carry', { carryScale: 0 }],
  ['balancer: carry 12', { carryScale: 12 }],
  ['balancer: size 0.4', { sizeBonusPerExtraPlayer: 0.4 }],
  ['balancer: size 1.0', { sizeBonusPerExtraPlayer: 1.0 }],
  ['balancer: probScale 3.8', { probabilityScale: 3.8 }],
  ['balancer: probScale 5.2', { probabilityScale: 5.2 }],
];

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

function replayFor(ratingOptions, priorGames, includeLeagueGames) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames,
    options: {
      seasonalTaperDays,
      ...ratingOptions,
    },
  });
}

function createStats() {
  return {
    n: 0,
    actualMarginSum: 0,
    actualWithin3: 0,
    actualWithin5: 0,
    actualBlowouts8: 0,
    predictedActualGapSum: 0,
    predictedBestGapSum: 0,
    predictedGapReductionSum: 0,
    actualMarginErrSum: 0,
    actualHighRisk: 0,
    actualHighRiskBlowouts: 0,
    actualLowRisk: 0,
    actualLowRiskWithin5: 0,
    selectedHighRisk: 0,
    selectedLowRisk: 0,
    sameAsActualCount: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    avgActualMargin: stats.actualMarginSum / stats.n,
    actualWithin3: stats.actualWithin3 / stats.n,
    actualWithin5: stats.actualWithin5 / stats.n,
    actualBlowoutRate: stats.actualBlowouts8 / stats.n,
    avgPredictedActualGap: stats.predictedActualGapSum / stats.n,
    avgPredictedBestGap: stats.predictedBestGapSum / stats.n,
    avgPredictedGapReduction: stats.predictedGapReductionSum / stats.n,
    actualMarginMAE: stats.actualMarginErrSum / stats.n,
    highRiskBlowoutRate: stats.actualHighRisk
      ? stats.actualHighRiskBlowouts / stats.actualHighRisk
      : null,
    lowRiskWithin5Rate: stats.actualLowRisk
      ? stats.actualLowRiskWithin5 / stats.actualLowRisk
      : null,
    actualHighRiskRate: stats.actualHighRisk / stats.n,
    selectedHighRiskRate: stats.selectedHighRisk / stats.n,
    selectedLowRiskRate: stats.selectedLowRisk / stats.n,
    sameAsActualRate: stats.sameAsActualCount / stats.n,
  };
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
  const actualTotal = present.length;
  let best = null;
  const allIndexes = new Set(present.map((_, index) => index));

  for (const redIndexes of chooseIndexes(actualTotal, redSize)) {
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
        redPlayers,
        bluePlayers,
        redKey: teamKey(redPlayers),
        blueKey: teamKey(bluePlayers),
        predictedGap,
        fairness,
        score,
      };
    }
  }

  return best;
}

function evaluatePair({
  ratingLabel,
  ratingOptions,
  includeLeagueGames,
  balancingLabel,
  volleyballOptions,
}) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (!isScoredNonLeagueGame(game)) {
      priorGames.push(game);
      return;
    }

    const prior = replayFor(ratingOptions, priorGames, includeLeagueGames);
    const modelGames = includeLeagueGames
      ? priorGames
      : priorGames.filter(priorGame => !priorGame?.isLeagueGame);
    const marginModel = calibrateMarginModel({
      games: modelGames,
      ratingMap: prior.ratingMap,
      carryScoreMap: prior.carryMap || {},
      options: ratingOptions,
      volleyballOptions,
    });

    if (!marginModel?.sampleSize) {
      priorGames.push(game);
      return;
    }

    const actualScore = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: prior.ratingMap,
      carryScoreMap: prior.carryMap || {},
      volleyballOptions,
    });
    const predictedActualGap = predictExpectedMargin(actualScore.strengthDiff, marginModel);
    const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
    const present = [...game.redTeam, ...game.blueTeam];
    const best = findBestSplit({
      present,
      redSize: game.redTeam.length,
      ratingMap: prior.ratingMap,
      carryScoreMap: prior.carryMap || {},
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
    stats.actualWithin3 += actualMargin <= 3 ? 1 : 0;
    stats.actualWithin5 += actualMargin <= 5 ? 1 : 0;
    stats.actualBlowouts8 += actualMargin > 8 ? 1 : 0;
    stats.predictedActualGapSum += predictedActualGap;
    stats.predictedBestGapSum += best.predictedGap;
    stats.predictedGapReductionSum += predictedActualGap - best.predictedGap;
    stats.actualMarginErrSum += Math.abs(predictedActualGap - actualMargin);

    if (predictedActualGap > 8) {
      stats.actualHighRisk += 1;
      if (actualMargin > 8) stats.actualHighRiskBlowouts += 1;
    }

    if (predictedActualGap <= 5) {
      stats.actualLowRisk += 1;
      if (actualMargin <= 5) stats.actualLowRiskWithin5 += 1;
    }

    if (best.predictedGap > 8) stats.selectedHighRisk += 1;
    if (best.predictedGap <= 5) stats.selectedLowRisk += 1;
    if (sameAsActual) stats.sameAsActualCount += 1;

    priorGames.push(game);
  });

  return {
    ratingLabel,
    balancingLabel,
    ...summarize(stats),
  };
}

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function printRows(title, rows, limit = 12) {
  console.log(title);
  console.log([
    'rating'.padEnd(24),
    'balancer'.padEnd(22),
    'actMAE'.padStart(6),
    'predAct'.padStart(7),
    'predBest'.padStart(8),
    'reduct'.padStart(6),
    'selLow'.padStart(6),
    'selHigh'.padStart(7),
    'same'.padStart(5),
    'hi->BO'.padStart(7),
    'lo->W5'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(106));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.ratingLabel.slice(0, 24).padEnd(24),
      row.balancingLabel.slice(0, 22).padEnd(22),
      fmt(row.actualMarginMAE).padStart(6),
      fmt(row.avgPredictedActualGap).padStart(7),
      fmt(row.avgPredictedBestGap).padStart(8),
      fmt(row.avgPredictedGapReduction).padStart(6),
      pct(row.selectedLowRiskRate).padStart(6),
      pct(row.selectedHighRiskRate).padStart(7),
      pct(row.sameAsActualRate).padStart(5),
      pct(row.highRiskBlowoutRate).padStart(7),
      pct(row.lowRiskWithin5Rate).padStart(7),
    ].join(' '));
  });
  console.log('');
}

console.log(`DB: ${DB_PATH}`);
console.log(`players=${players.length} games=${games.length} scoredNonLeague=${games.filter(isScoredNonLeagueGame).length}`);
console.log('');
console.log('Metric notes: actMAE is actual split predicted-margin MAE. predBest is the best predicted gap among same-size splits.');
console.log('selLow/selHigh are rates for the best predicted split. hi->BO and lo->W5 are calibration checks on actual historical splits.');
console.log('');

const rows = [];
for (const [ratingLabel, ratingOptions, includeLeagueGames] of ratingConfigs) {
  for (const [balancingLabel, volleyballOptions] of balancingConfigs) {
    rows.push(evaluatePair({
      ratingLabel,
      ratingOptions,
      includeLeagueGames,
      balancingLabel,
      volleyballOptions,
    }));
  }
}

const byBestGap = [...rows].sort((a, b) =>
  a.avgPredictedBestGap - b.avgPredictedBestGap ||
  a.actualMarginMAE - b.actualMarginMAE
);
const byActualMae = [...rows].sort((a, b) =>
  a.actualMarginMAE - b.actualMarginMAE ||
  a.avgPredictedBestGap - b.avgPredictedBestGap
);
const byReduction = [...rows].sort((a, b) =>
  b.avgPredictedGapReduction - a.avgPredictedGapReduction ||
  a.avgPredictedBestGap - b.avgPredictedBestGap
);
const baselines = rows.filter(row =>
  row.ratingLabel === 'rating: current league x2.3' &&
  row.balancingLabel === 'balancer: current'
);

printRows('Baseline', baselines, 1);
printRows('Best predicted balancing closeness', byBestGap, 14);
printRows('Best actual-split calibration', byActualMae, 14);
printRows('Largest predicted improvement over actual splits', byReduction, 14);
