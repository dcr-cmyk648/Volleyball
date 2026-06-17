// Focused back/explanatory test for balancer-only adjustments.
//
// Compares current full-replay explanatory scoring against scoring that also
// applies Play-page balancing context:
//   - environment silo rating blend
//   - pair adjustment map
//
// Run from eval/:
//   npm run back:balancer

import { loadDatabase } from './database.mjs';
import { attachAccIQDeltas, computeSinglePassAccIQ } from './metrics.mjs';
import {
  buildEnvironmentAdjustedRatingMap,
  buildPairAdjustmentMap,
  getGamesSortedOldestFirst,
  replayRatings,
  scoreVolleyballCandidateSplit,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();
const seasonalTaperDays = Math.round(6 * 30.4375);
const ratingOptions = { seasonalTaperDays };
const volleyballOptions = {};

function isQualityGame(game) {
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

function getTargetSilo(game) {
  const redSize = Array.isArray(game?.redTeam) ? game.redTeam.length : 0;
  const blueSize = Array.isArray(game?.blueTeam) ? game.blueTeam.length : 0;
  const largestSize = Math.max(redSize, blueSize);
  if (largestSize >= 5) return 'big';
  if (largestSize >= 3) return 'small';
  return 'overall';
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function getBrier(score, winner) {
  const actual = winner === 'red' ? 1 : 0;
  return (Number(score.redWinProbability) - actual) ** 2;
}

function fitMarginModel(rows) {
  const usable = rows.filter(row => Number.isFinite(row.strengthDiff) && Number.isFinite(row.actualMargin));
  if (!usable.length) return { baseMargin: 0, slope: 0, sampleSize: 0 };

  const meanX = usable.reduce((sum, row) => sum + row.strengthDiff, 0) / usable.length;
  const meanY = usable.reduce((sum, row) => sum + row.actualMargin, 0) / usable.length;
  let sxy = 0;
  let sxx = 0;
  usable.forEach(row => {
    sxy += (row.strengthDiff - meanX) * (row.actualMargin - meanY);
    sxx += (row.strengthDiff - meanX) ** 2;
  });
  const slope = sxx > 0 ? sxy / sxx : 0;
  return {
    baseMargin: meanY - slope * meanX,
    slope,
    sampleSize: usable.length,
  };
}

function predictMargin(strengthDiff, marginModel) {
  return Math.max(0, marginModel.baseMargin + marginModel.slope * Math.abs(strengthDiff));
}

function getScoreContext({ replay, pairMap, mode, game }) {
  const present = [...game.redTeam, ...game.blueTeam];
  const useSilo = mode.includes('silo');
  const usePair = mode.includes('pair');

  const ratingMap = useSilo
    ? buildEnvironmentAdjustedRatingMap({
      players,
      games,
      baseRatingMap: replay.ratingMap,
      ratingOptions,
      volleyballOptions,
      teamCount: 2,
      playerCount: present.length,
      targetSilo: getTargetSilo(game),
    })
    : replay.ratingMap;

  return {
    ratingMap,
    pairAdjustmentMap: usePair ? pairMap : null,
  };
}

function evaluate(label, mode) {
  const replay = replayRatings({
    players,
    games,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames: true,
    options: ratingOptions,
  });
  const pairMap = buildPairAdjustmentMap({
    players,
    games,
    ratingOptions,
    volleyballOptions,
    seasonal: true,
  });
  const carryScoreMap = replay.carryMap || {};
  const scoredRows = [];
  const qualityGames = getGamesSortedOldestFirst(games).filter(isQualityGame);

  qualityGames.forEach(game => {
    const { ratingMap, pairAdjustmentMap } = getScoreContext({
      replay,
      pairMap,
      mode,
      game,
    });
    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
      pairAdjustmentMap,
    });
    scoredRows.push({
      game,
      score,
      strengthDiff: Math.abs(score.strengthDiff),
      actualMargin: Math.abs(game.scoreRed - game.scoreBlue),
    });
  });

  const marginModel = fitMarginModel(scoredRows);
  let correct = 0;
  let brierSum = 0;
  let maeSum = 0;

  scoredRows.forEach(row => {
    const predictedWinner = row.score.redWinProbability >= 0.5 ? 'red' : 'blue';
    if (predictedWinner === row.game.winner) correct += 1;
    brierSum += getBrier(row.score, row.game.winner);
    maeSum += Math.abs(predictMargin(row.strengthDiff, marginModel) - row.actualMargin);
  });

  const n = scoredRows.length;
  const result = {
    label,
    n,
    accuracy: n ? correct / n : null,
    brier: n ? brierSum / n : null,
    marginMAE: n ? maeSum / n : null,
    baseMargin: marginModel.baseMargin,
    slope: marginModel.slope,
  };
  result.accIQ = computeSinglePassAccIQ(result);
  return result;
}

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(0)}%`;
}

const rows = [
  evaluate('current scoring', ''),
  evaluate('environment silo only', 'silo'),
  evaluate('pair only', 'pair'),
  evaluate('silo + pair', 'silo+pair'),
];
attachAccIQDeltas(rows, row => row.label === 'current scoring');

console.log(`DB: ${sourceLabel}`);
console.log('Back/explanatory scoring comparison over full replay ratings');
console.log('');
console.log([
  'mode'.padEnd(24),
  'n'.padStart(4),
  'acc'.padStart(6),
  'brier'.padStart(7),
  'MAE'.padStart(6),
  'AccIQ'.padStart(7),
  'dIQ'.padStart(7),
  'base'.padStart(7),
  'slope'.padStart(7),
].join(' '));
console.log('-'.repeat(82));
rows.forEach(row => {
  console.log([
    row.label.padEnd(24),
    String(row.n).padStart(4),
    pct(row.accuracy).padStart(6),
    fmt(row.brier, 3).padStart(7),
    fmt(row.marginMAE).padStart(6),
    fmt(row.accIQ).padStart(7),
    fmt(row.accIQDelta).padStart(7),
    fmt(row.baseMargin).padStart(7),
    fmt(row.slope, 3).padStart(7),
  ].join(' '));
});
