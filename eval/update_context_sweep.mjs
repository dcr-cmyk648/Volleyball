// Test whether rating updates should use balancer-context pregame expectations.
//
// The replay option tested here changes only the surprise/update multiplier:
// ratings are still updated in the base rating map, but the "how surprising was
// this result?" probability can be computed from environment-silo and pair
// adjusted team strengths.
//
// Run from eval/:
//   npm run update:context

import { loadDatabase } from './database.mjs';
import { computeSinglePassAccIQ } from './metrics.mjs';
import {
  buildEnvironmentAdjustedRatingMap,
  buildPairAdjustmentMap,
  calibrateMarginModel,
  getGamesSortedOldestFirst,
  replayRatings,
  scoreVolleyballCandidateSplit,
  predictExpectedMargin,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();
const seasonalTaperDays = Math.round(6 * 30.4375);
const ratingOptions = { seasonalTaperDays };

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

function isScored(game) {
  return typeof game?.scoreRed === 'number' && typeof game?.scoreBlue === 'number';
}

function getTargetSilo(game) {
  const largest = Math.max(game.redTeam?.length || 0, game.blueTeam?.length || 0);
  if (largest >= 5) return 'big';
  if (largest >= 3) return 'small';
  return 'overall';
}

function getScoringRatingMap({ replay, modelGames, game, useBalancerScoring, volleyballOptions }) {
  if (!useBalancerScoring) return replay.ratingMap;
  const adjustedMap = buildEnvironmentAdjustedRatingMap({
    players,
    games: modelGames,
    baseRatingMap: replay.ratingMap,
    ratingOptions,
    volleyballOptions,
    teamCount: 2,
    playerCount: game.redTeam.length + game.blueTeam.length,
    targetSilo: getTargetSilo(game),
  });
  return {
    ...replay.ratingMap,
    ...adjustedMap,
  };
}

function getScoringPairMap({ modelGames, useBalancerScoring, volleyballOptions }) {
  if (!useBalancerScoring) return null;
  return buildPairAdjustmentMap({
    players,
    games: modelGames,
    ratingOptions,
    volleyballOptions,
    seasonal: true,
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

function record(stats, game, score, marginModel) {
  stats.n += 1;
  if ((score.redWinProbability >= 0.5 ? 'red' : 'blue') === game.winner) {
    stats.correct += 1;
  }
  stats.brierSum += (score.redWinProbability - (game.winner === 'red' ? 1 : 0)) ** 2;
  if (isScored(game) && marginModel?.sampleSize > 0) {
    stats.scored += 1;
    stats.marginErrSum += Math.abs(
      predictExpectedMargin(score.strengthDiff, marginModel) -
      Math.abs(game.scoreRed - game.scoreBlue)
    );
  }
}

function replayFor(modelGames, {
  updateUsesBalancerContext,
  updateContextMode = 'pair',
  volleyballOptions,
}) {
  return replayRatings({
    players,
    games: modelGames,
    seasonal: true,
    volleyballAdjusted: true,
    volleyballUpdateUsesBalancerContext: updateUsesBalancerContext,
    volleyballUpdateContextMode: updateContextMode,
    includeLeagueGames: true,
    options: ratingOptions,
    volleyballOptions,
  });
}

function scoreGame({ replay, modelGames, game, useBalancerScoring, volleyballOptions }) {
  return scoreVolleyballCandidateSplit({
    redPlayers: game.redTeam,
    bluePlayers: game.blueTeam,
    ratingMap: getScoringRatingMap({ replay, modelGames, game, useBalancerScoring, volleyballOptions }),
    carryScoreMap: replay.carryMap || {},
    volleyballOptions,
    pairAdjustmentMap: getScoringPairMap({ modelGames, useBalancerScoring, volleyballOptions }),
  });
}

function computeMarginModel({ replay, modelGames, useBalancerScoring, volleyballOptions }) {
  if (!useBalancerScoring) {
    return calibrateMarginModel({
      games: modelGames,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
      volleyballOptions,
    });
  }

  const xs = [];
  const ys = [];
  getGamesSortedOldestFirst(modelGames).forEach(game => {
    if (!isQualityGame(game) || !isScored(game)) return;
    const score = scoreGame({ replay, modelGames, game, useBalancerScoring, volleyballOptions });
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

function computeBack({ updateUsesBalancerContext, updateContextMode, useBalancerScoring, volleyballOptions }) {
  const replay = replayFor(games, { updateUsesBalancerContext, updateContextMode, volleyballOptions });
  const marginModel = computeMarginModel({
    replay,
    modelGames: games,
    useBalancerScoring,
    volleyballOptions,
  });
  const stats = createStats();

  getGamesSortedOldestFirst(games).forEach(game => {
    if (!isQualityGame(game)) return;
    const score = scoreGame({
      replay,
      modelGames: games,
      game,
      useBalancerScoring,
      volleyballOptions,
    });
    record(stats, game, score, marginModel);
  });

  return summarize(stats);
}

function evaluate(label, {
  updateUsesBalancerContext = false,
  updateContextMode = 'pair',
  useBalancerScoring = false,
  volleyballOptions = {},
} = {}) {
  const back = computeBack({
    updateUsesBalancerContext,
    updateContextMode,
    useBalancerScoring,
    volleyballOptions,
  });
  return {
    label,
    back,
    accIQ: computeSinglePassAccIQ(back),
  };
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

const rows = [
  evaluate('current updates / plain scoring'),
  evaluate('pair updates / plain scoring', {
    updateUsesBalancerContext: true,
    updateContextMode: 'pair',
  }),
  evaluate('current updates / balancer scoring', {
    useBalancerScoring: true,
  }),
  evaluate('full updates / balancer scoring', {
    updateUsesBalancerContext: true,
    updateContextMode: 'full',
    useBalancerScoring: true,
  }),
  evaluate('silo-only updates / balancer scoring', {
    updateUsesBalancerContext: true,
    updateContextMode: 'silo',
    useBalancerScoring: true,
    volleyballOptions: { pairAdjustmentMode: 'off' },
  }),
  evaluate('pair-only updates / balancer scoring', {
    updateUsesBalancerContext: true,
    updateContextMode: 'pair',
    useBalancerScoring: true,
    volleyballOptions: { environmentSiloMode: 'off' },
  }),
];

const baseline = rows[0].accIQ;

console.log(`DB: ${sourceLabel}`);
console.log('Rating update context sweep');
console.log('');
console.log([
  'mode'.padEnd(40),
  'acc'.padStart(6),
  'brier'.padStart(8),
  'MAE'.padStart(6),
  'AccIQ'.padStart(7),
  'dIQ'.padStart(7),
].join(' '));
console.log('-'.repeat(78));
rows.forEach(row => {
  console.log([
    row.label.padEnd(40),
    pct(row.back.accuracy).padStart(6),
    fmt(row.back.brier).padStart(8),
    fmt(row.back.marginMAE).padStart(6),
    fmt(row.accIQ, 2).padStart(7),
    fmt(row.accIQ - baseline, 2).padStart(7),
  ].join(' '));
});
