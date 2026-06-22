// Test-only comparison for real forward-play balancer outcomes.
//
// The only true realized counterfactual-free subset is games recorded with
// assignmentSource: "algorithm". This script compares pregame scoring models on
// that same subset and reports how often each model's exhaustive same-size best
// split matches the split that was actually played.
//
// Run from eval/:
//   node --no-deprecation --import ./register.mjs forward_balancer_window_compare.mjs

import { loadDatabase } from './database.mjs';
import {
  buildEnvironmentAdjustedRatingMap,
  buildPairAdjustmentMap,
  calibrateMarginModel,
  getGamesSortedOldestFirst,
  predictExpectedMargin,
  replayRatings,
  scoreVolleyballCandidateSplit,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const seasonRankingLeagueOptions = {
  leagueUpdateMultiplier: 1.5,
  leagueMuUpdateMultiplier: 1,
  leagueSigmaUpdateMultiplier: 0.8,
};

function getGameDateValue(game) {
  if (typeof game?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(game.date)) {
    return game.date;
  }
  const value = game?.createdAt || game?.id || game?.date;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

function getSeasonRankingWindowCutoffDate(priorGames, targetGame) {
  const anchor = getGameDateValue(targetGame) ||
    [...priorGames].map(getGameDateValue).filter(Boolean).sort().at(-1) ||
    new Date().toISOString().slice(0, 10);
  const date = new Date(`${anchor}T00:00:00`);
  date.setMonth(date.getMonth() - 1);
  return date.toISOString().slice(0, 10);
}

function getSeasonRankingWindowGames(priorGames, targetGame) {
  const cutoff = getSeasonRankingWindowCutoffDate(priorGames, targetGame);
  return priorGames.filter(game => {
    const date = getGameDateValue(game);
    return date && date >= cutoff;
  });
}

function getTargetSilo(game) {
  const largest = Math.max(game?.redTeam?.length || 0, game?.blueTeam?.length || 0);
  if (largest >= 5) return 'big';
  if (largest >= 3) return 'small';
  return 'overall';
}

function isScoredAlgorithmGame(game) {
  return (
    game &&
    !game.isLeagueGame &&
    game.assignmentSource === 'algorithm' &&
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

function sameSplit(aRed, aBlue, bRed, bBlue) {
  const aRedKey = teamKey(aRed);
  const aBlueKey = teamKey(aBlue);
  const bRedKey = teamKey(bRed);
  const bBlueKey = teamKey(bBlue);
  return (
    (aRedKey === bRedKey && aBlueKey === bBlueKey) ||
    (aRedKey === bBlueKey && aBlueKey === bRedKey)
  );
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
  pairAdjustmentMap,
  marginModel,
  ratingOptions,
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
      options: ratingOptions,
      volleyballOptions,
      pairAdjustmentMap,
    });
    const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);
    const fairness = 1 - Math.abs(score.redWinProbability - 0.5) * 2;

    if (
      !best ||
      predictedGap < best.predictedGap - 1e-9 ||
      (Math.abs(predictedGap - best.predictedGap) < 1e-9 && fairness > best.fairness)
    ) {
      best = { redPlayers, bluePlayers, score, predictedGap, fairness };
    }
  }

  return best;
}

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    confidenceSum: 0,
    marginErrSum: 0,
    actualMarginSum: 0,
    within5: 0,
    blowouts8: 0,
    expectedGapSum: 0,
    bestGapSum: 0,
    bestMatchesActual: 0,
    assignmentPredictionErrSum: 0,
    assignmentPredictionN: 0,
    priorGameCountSum: 0,
    marginSampleCountSum: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    confidence: stats.n ? stats.confidenceSum / stats.n : null,
    marginMAE: stats.n ? stats.marginErrSum / stats.n : null,
    avgActualMargin: stats.n ? stats.actualMarginSum / stats.n : null,
    within5: stats.n ? stats.within5 / stats.n : null,
    blowouts8: stats.n ? stats.blowouts8 / stats.n : null,
    avgExpectedGap: stats.n ? stats.expectedGapSum / stats.n : null,
    avgBestGap: stats.n ? stats.bestGapSum / stats.n : null,
    bestMatchRate: stats.n ? stats.bestMatchesActual / stats.n : null,
    assignmentPredictionMAE: stats.assignmentPredictionN
      ? stats.assignmentPredictionErrSum / stats.assignmentPredictionN
      : null,
    avgPriorGames: stats.n ? stats.priorGameCountSum / stats.n : null,
    avgMarginSamples: stats.n ? stats.marginSampleCountSum / stats.n : null,
  };
}

function buildContext(variant, priorGames, game) {
  const ratingOptions = {
    seasonalTaperDays,
    ...(variant.ratingOptions || {}),
  };
  const modelGames = variant.getModelGames(priorGames, game);
  const replay = replayRatings({
    players,
    games: modelGames,
    seasonal: true,
    volleyballAdjusted: true,
    volleyballUpdateUsesBalancerContext: true,
    volleyballUpdateContextMode: 'pair',
    includeLeagueGames: variant.includeLeagueGames,
    options: ratingOptions,
    volleyballOptions: variant.volleyballOptions || {},
  });
  const playerCount = (game.redTeam?.length || 0) + (game.blueTeam?.length || 0);
  const adjustedRatingMap = buildEnvironmentAdjustedRatingMap({
    players,
    games: modelGames,
    baseRatingMap: replay.ratingMap,
    ratingOptions,
    volleyballOptions: variant.volleyballOptions || {},
    teamCount: 2,
    playerCount,
    targetSilo: getTargetSilo(game),
  });
  const ratingMap = { ...replay.ratingMap, ...adjustedRatingMap };
  const pairAdjustmentMap = buildPairAdjustmentMap({
    players,
    games: modelGames,
    ratingOptions,
    volleyballOptions: variant.volleyballOptions || {},
    seasonal: true,
  });
  const carryScoreMap = replay.carryMap || {};
  const marginModel = calibrateMarginModel({
    games: modelGames,
    ratingMap,
    carryScoreMap,
    options: ratingOptions,
    volleyballOptions: variant.volleyballOptions || {},
  });

  return {
    modelGames,
    ratingOptions,
    volleyballOptions: variant.volleyballOptions || {},
    ratingMap,
    carryScoreMap,
    pairAdjustmentMap,
    marginModel,
  };
}

function evaluateVariant(variant) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  for (const game of sortedGames) {
    if (isScoredAlgorithmGame(game)) {
      const context = buildContext(variant, priorGames, game);
      if ((context.marginModel?.sampleSize || 0) > 0) {
        const score = scoreVolleyballCandidateSplit({
          redPlayers: game.redTeam,
          bluePlayers: game.blueTeam,
          ratingMap: context.ratingMap,
          carryScoreMap: context.carryScoreMap,
          options: context.ratingOptions,
          volleyballOptions: context.volleyballOptions,
          pairAdjustmentMap: context.pairAdjustmentMap,
        });
        const redProbability = Number(score.redWinProbability);
        const yRed = game.winner === 'red' ? 1 : 0;
        const predictedWinner = redProbability >= 0.5 ? 'red' : 'blue';
        const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
        const expectedGap = predictExpectedMargin(score.strengthDiff, context.marginModel);
        const present = [...game.redTeam, ...game.blueTeam];
        const best = findBestSplit({
          present,
          redSize: game.redTeam.length,
          ratingMap: context.ratingMap,
          carryScoreMap: context.carryScoreMap,
          pairAdjustmentMap: context.pairAdjustmentMap,
          marginModel: context.marginModel,
          ratingOptions: context.ratingOptions,
          volleyballOptions: context.volleyballOptions,
        });

        stats.n += 1;
        if (predictedWinner === game.winner) stats.correct += 1;
        stats.brierSum += (redProbability - yRed) ** 2;
        stats.confidenceSum += Math.max(redProbability, 1 - redProbability);
        stats.marginErrSum += Math.abs(expectedGap - actualMargin);
        stats.actualMarginSum += actualMargin;
        if (actualMargin <= 5) stats.within5 += 1;
        if (actualMargin > 8) stats.blowouts8 += 1;
        stats.expectedGapSum += expectedGap;
        stats.bestGapSum += best.predictedGap;
        if (sameSplit(best.redPlayers, best.bluePlayers, game.redTeam, game.blueTeam)) {
          stats.bestMatchesActual += 1;
        }
        if (Number.isFinite(Number(game.predictedAtAssignment))) {
          stats.assignmentPredictionErrSum += Math.abs(Number(game.predictedAtAssignment) - actualMargin);
          stats.assignmentPredictionN += 1;
        }
        stats.priorGameCountSum += context.modelGames.length;
        stats.marginSampleCountSum += context.marginModel.sampleSize || 0;
      }
    }

    priorGames.push(game);
  }

  return {
    label: variant.label,
    ...summarize(stats),
  };
}

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(1)}%`;
}

function printRows(rows) {
  console.log([
    'model'.padEnd(34),
    'n'.padStart(3),
    'actGap'.padStart(6),
    'W<=5'.padStart(6),
    'BO>8'.padStart(6),
    'expGap'.padStart(7),
    'bestGap'.padStart(7),
    'best=act'.padStart(8),
    'acc'.padStart(7),
    'brier'.padStart(7),
    'mMAE'.padStart(6),
    'assignMAE'.padStart(9),
    'prior'.padStart(6),
  ].join(' '));
  console.log('-'.repeat(126));
  rows.forEach(row => {
    console.log([
      row.label.slice(0, 34).padEnd(34),
      String(row.n).padStart(3),
      fmt(row.avgActualMargin).padStart(6),
      pct(row.within5).padStart(6),
      pct(row.blowouts8).padStart(6),
      fmt(row.avgExpectedGap).padStart(7),
      fmt(row.avgBestGap).padStart(7),
      pct(row.bestMatchRate).padStart(8),
      pct(row.accuracy).padStart(7),
      fmt(row.brier, 3).padStart(7),
      fmt(row.marginMAE).padStart(6),
      fmt(row.assignmentPredictionMAE).padStart(9),
      fmt(row.avgPriorGames, 1).padStart(6),
    ].join(' '));
  });
}

const variants = [
  {
    label: 'current balancer full-history',
    includeLeagueGames: false,
    getModelGames: priorGames => priorGames,
  },
  {
    label: 'season ranking one-month window',
    includeLeagueGames: true,
    ratingOptions: seasonRankingLeagueOptions,
    getModelGames: getSeasonRankingWindowGames,
  },
];

const algorithmTargets = games.filter(isScoredAlgorithmGame);
console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} scoredAlgorithmNonLeague=${algorithmTargets.length}`);
console.log('Subset note: only recorded algorithm-assigned, scored, non-league games are counted.');
console.log('Counterfactual note: bestGap/best=act are replayed same-player exhaustive comparisons; only actGap/W<=5/BO>8 are realized outcomes.');
console.log('');

printRows(variants.map(evaluateVariant));
