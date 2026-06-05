// Walk-forward benchmark for pair interaction features.
//
// Tests whether same-team pair synergy and ordered opponent effects improve
// prediction quality beyond the current volleyball model.
//
// Run: node --import ./register.mjs pair_interactions.mjs

import { readFileSync } from 'node:fs';
import {
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
} from '../ratings.js';

const DB_PATH = process.env.VBALL_DB || 'C:/Users/rowla/Documents/Volleyball/default_database';
const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
const players = db.players || [];
const games = db.games || [];

const SEASON_MONTHS = 6;
const seasonalTaperDays = Math.round(SEASON_MONTHS * 30.4375);

const MIN_OVERLAPS = parseNumberList(process.env.VBALL_PAIR_MIN, [1, 2, 3, 4, 5]);
const SHRINKAGES = parseNumberList(process.env.VBALL_PAIR_SHRINK, [0, 1, 3, 5, 10, 20]);
const EFFECT_SCALES = parseNumberList(process.env.VBALL_PAIR_SCALE, [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 4]);
const MODES = ['same', 'opponent', 'combined'];
const TOP_ROWS = Number(process.env.VBALL_PAIR_TOP || 12);
const DETAIL_MIN_OVERLAP = Number(process.env.VBALL_PAIR_DETAIL_MIN || 3);

const probabilityScale = DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.probabilityScale;
const minWinProbability = DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.minWinProbability;
const maxWinProbability = DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.maxWinProbability;

const replay = replayRatings({
  players,
  games,
  seasonal: true,
  volleyballAdjusted: true,
  includeLeagueGames: true,
  options: { seasonalTaperDays },
});

const ratingMap = replay.ratingMap;
const carryMap = replay.carryMap || {};
const marginModel = calibrateMarginModel({ games, ratingMap, carryScoreMap: carryMap });
const playerNames = new Map(players.map(player => [String(player.id), player.name || String(player.id)]));

function parseNumberList(raw, fallback) {
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
  return values.length ? values : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function logLoss(probability, outcome) {
  const p = clamp(probability, 1e-6, 1 - 1e-6);
  return outcome === 1 ? -Math.log(p) : -Math.log(1 - p);
}

function probabilityFromStrengthDiff(strengthDiff) {
  return clamp(
    sigmoid(strengthDiff / probabilityScale),
    minWinProbability,
    maxWinProbability
  );
}

function pairKey(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function orderedKey(playerId, opponentId) {
  return `${String(playerId)}>${String(opponentId)}`;
}

function splitPairKey(key) {
  return key.split('|');
}

function splitOrderedKey(key) {
  return key.split('>');
}

function getSameTeamPairKeys(team) {
  const ids = team.map(player => String(player.id));
  const keys = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      keys.push(pairKey(ids[i], ids[j]));
    }
  }
  return keys;
}

function getOrderedOpponentKeys(team, opponents) {
  const keys = [];
  team.forEach(player => {
    opponents.forEach(opponent => {
      keys.push(orderedKey(player.id, opponent.id));
    });
  });
  return keys;
}

function addObservation(map, key, value) {
  const current = map.get(key) || { total: 0, count: 0 };
  current.total += value;
  current.count += 1;
  map.set(key, current);
}

function getEffect(map, key, minOverlap, shrinkage) {
  const stat = map.get(key);
  if (!stat || stat.count < minOverlap) return null;
  return stat.total / (stat.count + shrinkage);
}

function summarizeKeys(map, keys, minOverlap, shrinkage) {
  let total = 0;
  let usable = 0;
  let countTotal = 0;

  keys.forEach(key => {
    const stat = map.get(key);
    const effect = getEffect(map, key, minOverlap, shrinkage);
    if (effect === null) return;
    total += effect;
    usable += 1;
    countTotal += stat.count;
  });

  return {
    mean: usable ? total / usable : 0,
    usable,
    avgOverlap: usable ? countTotal / usable : 0,
  };
}

function getInteractionFeature({ maps, red, blue, mode, minOverlap, shrinkage }) {
  const sameRed = summarizeKeys(maps.same, getSameTeamPairKeys(red), minOverlap, shrinkage);
  const sameBlue = summarizeKeys(maps.same, getSameTeamPairKeys(blue), minOverlap, shrinkage);
  const oppRed = summarizeKeys(maps.opponent, getOrderedOpponentKeys(red, blue), minOverlap, shrinkage);
  const oppBlue = summarizeKeys(maps.opponent, getOrderedOpponentKeys(blue, red), minOverlap, shrinkage);

  const sameFeature = sameRed.mean - sameBlue.mean;
  const opponentFeature = oppRed.mean - oppBlue.mean;
  const feature =
    mode === 'same' ? sameFeature :
    mode === 'opponent' ? opponentFeature :
    sameFeature + opponentFeature;

  const usable =
    mode === 'same' ? sameRed.usable + sameBlue.usable :
    mode === 'opponent' ? oppRed.usable + oppBlue.usable :
    sameRed.usable + sameBlue.usable + oppRed.usable + oppBlue.usable;

  const overlapSum =
    mode === 'same'
      ? sameRed.avgOverlap * sameRed.usable + sameBlue.avgOverlap * sameBlue.usable
      : mode === 'opponent'
        ? oppRed.avgOverlap * oppRed.usable + oppBlue.avgOverlap * oppBlue.usable
        : sameRed.avgOverlap * sameRed.usable +
          sameBlue.avgOverlap * sameBlue.usable +
          oppRed.avgOverlap * oppRed.usable +
          oppBlue.avgOverlap * oppBlue.usable;

  return { feature, usable, overlapSum };
}

function updateInteractionMaps(maps, red, blue, residual) {
  getSameTeamPairKeys(red).forEach(key => addObservation(maps.same, key, residual));
  getSameTeamPairKeys(blue).forEach(key => addObservation(maps.same, key, -residual));
  getOrderedOpponentKeys(red, blue).forEach(key => addObservation(maps.opponent, key, residual));
  getOrderedOpponentKeys(blue, red).forEach(key => addObservation(maps.opponent, key, -residual));
}

function isAnalyzable(game) {
  return Boolean(
    game &&
    !game.isLeagueGame &&
    Array.isArray(game.redTeam) &&
    game.redTeam.length > 0 &&
    Array.isArray(game.blueTeam) &&
    game.blueTeam.length > 0 &&
    (game.winner === 'red' || game.winner === 'blue')
  );
}

function makeResult(config) {
  return {
    ...config,
    games: 0,
    scored: 0,
    correct: 0,
    brier: 0,
    logLoss: 0,
    marginError: 0,
    within5: 0,
    blowouts8: 0,
    actualDiff: 0,
    featureGames: 0,
    absFeature: 0,
    usableLinks: 0,
    overlapSum: 0,
  };
}

function addPrediction(result, game, probability, strengthDiff, featureDetails) {
  const outcome = game.winner === 'red' ? 1 : 0;
  const predictedWinner = probability >= 0.5 ? 'red' : 'blue';
  const hasScores = typeof game.scoreRed === 'number' && typeof game.scoreBlue === 'number';

  result.games += 1;
  if (predictedWinner === game.winner) result.correct += 1;
  result.brier += (probability - outcome) ** 2;
  result.logLoss += logLoss(probability, outcome);

  if (hasScores) {
    const margin = Math.abs(game.scoreRed - game.scoreBlue);
    result.scored += 1;
    result.actualDiff += margin;
    if (margin <= 5) result.within5 += 1;
    if (margin > 8) result.blowouts8 += 1;
    result.marginError += Math.abs(predictExpectedMargin(strengthDiff, marginModel) - margin);
  }

  if (featureDetails && featureDetails.usable > 0) {
    result.featureGames += 1;
    result.absFeature += Math.abs(featureDetails.feature);
    result.usableLinks += featureDetails.usable;
    result.overlapSum += featureDetails.overlapSum;
  }
}

function finalize(result, baseline = null) {
  const acc = result.games ? result.correct / result.games : NaN;
  const brier = result.games ? result.brier / result.games : NaN;
  const ll = result.games ? result.logLoss / result.games : NaN;
  const mae = result.scored ? result.marginError / result.scored : NaN;
  const within5 = result.scored ? result.within5 / result.scored : NaN;
  const blowoutRate = result.scored ? result.blowouts8 / result.scored : NaN;
  const avgDiff = result.scored ? result.actualDiff / result.scored : NaN;
  const featureCoverage = result.games ? result.featureGames / result.games : 0;
  const avgAbsFeature = result.featureGames ? result.absFeature / result.featureGames : 0;
  const avgUsableLinks = result.featureGames ? result.usableLinks / result.featureGames : 0;
  const avgOverlap = result.usableLinks ? result.overlapSum / result.usableLinks : 0;

  return {
    ...result,
    acc,
    brier,
    logLossAvg: ll,
    mae,
    within5,
    blowoutRate,
    avgDiff,
    featureCoverage,
    avgAbsFeature,
    avgUsableLinks,
    avgOverlap,
    deltaBrier: baseline ? brier - baseline.brier : 0,
    deltaMae: baseline ? mae - baseline.mae : 0,
    deltaAcc: baseline ? acc - baseline.acc : 0,
  };
}

function summarizeMapByOverlap(map) {
  const counts = [...map.values()].map(value => value.count);
  const thresholds = [1, 2, 3, 4, 5, 8, 10];
  return thresholds.map(threshold => ({
    threshold,
    count: counts.filter(value => value >= threshold).length,
  }));
}

function formatPercent(value, digits = 0) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : 'n/a';
}

function fmt(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function formatDelta(value, digits = 4) {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

function nameFor(id) {
  return playerNames.get(String(id)) || String(id);
}

function describeSamePair(key) {
  const [a, b] = splitPairKey(key);
  return `${nameFor(a)} + ${nameFor(b)}`;
}

function describeOpponentPair(key) {
  const [a, b] = splitOrderedKey(key);
  return `${nameFor(a)} vs ${nameFor(b)}`;
}

function topEffects(map, minOverlap, limit, describe) {
  return [...map.entries()]
    .filter(([, stat]) => stat.count >= minOverlap)
    .map(([key, stat]) => ({
      label: describe(key),
      count: stat.count,
      effect: stat.total / stat.count,
    }))
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
    .slice(0, limit);
}

const configs = [
  { label: 'baseline', mode: 'none', minOverlap: 0, shrinkage: 0, scale: 0 },
];

MODES.forEach(mode => {
  MIN_OVERLAPS.forEach(minOverlap => {
    SHRINKAGES.forEach(shrinkage => {
      EFFECT_SCALES.forEach(scale => {
        configs.push({
          label: `${mode} min=${minOverlap} shrink=${shrinkage} scale=${scale}`,
          mode,
          minOverlap,
          shrinkage,
          scale,
        });
      });
    });
  });
});

const results = configs.map(makeResult);
const maps = {
  same: new Map(),
  opponent: new Map(),
};

for (const game of getGamesSortedOldestFirst(games)) {
  if (!isAnalyzable(game)) continue;

  const red = game.redTeam;
  const blue = game.blueTeam;
  const baseScore = scoreVolleyballCandidateSplit({
    redPlayers: red,
    bluePlayers: blue,
    ratingMap,
    carryScoreMap: carryMap,
  });
  const baselineProbability = baseScore.redWinProbability;

  results.forEach(result => {
    if (result.mode === 'none') {
      addPrediction(result, game, baselineProbability, baseScore.strengthDiff, null);
      return;
    }

    const featureDetails = getInteractionFeature({
      maps,
      red,
      blue,
      mode: result.mode,
      minOverlap: result.minOverlap,
      shrinkage: result.shrinkage,
    });
    const adjustment = probabilityScale * 4 * result.scale * featureDetails.feature;
    const adjustedStrengthDiff = baseScore.strengthDiff + adjustment;
    const adjustedProbability = probabilityFromStrengthDiff(adjustedStrengthDiff);
    addPrediction(result, game, adjustedProbability, adjustedStrengthDiff, featureDetails);
  });

  const outcome = game.winner === 'red' ? 1 : 0;
  const residual = outcome - baselineProbability;
  updateInteractionMaps(maps, red, blue, residual);
}

const baseline = finalize(results[0]);
const finalized = results.map(result => finalize(result, baseline));
const interactionRows = finalized.slice(1);

console.log('\nPair interaction benchmark');
console.log(`DB: ${DB_PATH}`);
console.log(`Games analyzed: ${baseline.games} (${baseline.scored} scored)`);
console.log(`Baseline: acc=${formatPercent(baseline.acc)} brier=${fmt(baseline.brier)} logloss=${fmt(baseline.logLossAvg)} MAE=${fmt(baseline.mae, 2)} within5=${formatPercent(baseline.within5)} blowouts>8=${baseline.blowouts8}`);
console.log(`Margin model: base=${fmt(marginModel.baseMargin, 2)} slope=${fmt(marginModel.slope, 3)} sample=${marginModel.sampleSize}`);

console.log('\nObserved interaction overlap after walk-forward pass');
console.log('threshold'.padEnd(12), 'same-team pairs'.padStart(16), 'ordered opp pairs'.padStart(18));
const sameOverlap = summarizeMapByOverlap(maps.same);
const oppOverlap = summarizeMapByOverlap(maps.opponent);
sameOverlap.forEach((row, index) => {
  console.log(
    `>=${row.threshold}`.padEnd(12),
    String(row.count).padStart(16),
    String(oppOverlap[index].count).padStart(18)
  );
});

const bestOverall = [...interactionRows]
  .sort((a, b) =>
    a.brier - b.brier ||
    a.mae - b.mae ||
    b.acc - a.acc
  )
  .slice(0, TOP_ROWS);

console.log(`\nTop ${bestOverall.length} interaction configs (lower brier is better)`);
console.log('config'.padEnd(42), 'acc '.padStart(6), 'brier'.padStart(8), 'dBrier'.padStart(9), 'MAE'.padStart(7), 'dMAE'.padStart(8), 'cover'.padStart(8), 'avg|f|'.padStart(8), 'avgN'.padStart(7));
console.log('-'.repeat(96));
bestOverall.forEach(row => {
  console.log(
    row.label.padEnd(42),
    formatPercent(row.acc).padStart(6),
    fmt(row.brier, 4).padStart(8),
    formatDelta(row.deltaBrier, 4).padStart(9),
    fmt(row.mae, 2).padStart(7),
    formatDelta(row.deltaMae, 3).padStart(8),
    formatPercent(row.featureCoverage).padStart(8),
    fmt(row.avgAbsFeature, 3).padStart(8),
    fmt(row.avgOverlap, 1).padStart(7)
  );
});

console.log('\nBest config by mode and minimum overlap');
console.log('mode'.padEnd(10), 'min'.padStart(4), 'shrink'.padStart(8), 'scale'.padStart(7), 'acc'.padStart(6), 'brier'.padStart(8), 'dBrier'.padStart(9), 'MAE'.padStart(7), 'cover'.padStart(8));
console.log('-'.repeat(78));
MODES.forEach(mode => {
  MIN_OVERLAPS.forEach(minOverlap => {
    const best = interactionRows
      .filter(row => row.mode === mode && row.minOverlap === minOverlap)
      .sort((a, b) =>
        a.brier - b.brier ||
        a.mae - b.mae ||
        b.acc - a.acc
      )[0];
    if (!best) return;
    console.log(
      mode.padEnd(10),
      String(minOverlap).padStart(4),
      String(best.shrinkage).padStart(8),
      String(best.scale).padStart(7),
      formatPercent(best.acc).padStart(6),
      fmt(best.brier, 4).padStart(8),
      formatDelta(best.deltaBrier, 4).padStart(9),
      fmt(best.mae, 2).padStart(7),
      formatPercent(best.featureCoverage).padStart(8)
    );
  });
});

console.log(`\nLargest observed effects with >=${DETAIL_MIN_OVERLAP} prior overlaps at final state`);
console.log('same-team pair'.padEnd(34), 'games'.padStart(6), 'effect'.padStart(8));
topEffects(maps.same, DETAIL_MIN_OVERLAP, 8, describeSamePair).forEach(row => {
  console.log(row.label.slice(0, 34).padEnd(34), String(row.count).padStart(6), fmt(row.effect, 3).padStart(8));
});
console.log('\nordered opponent pair'.padEnd(34), 'games'.padStart(6), 'effect'.padStart(8));
topEffects(maps.opponent, DETAIL_MIN_OVERLAP, 8, describeOpponentPair).forEach(row => {
  console.log(row.label.slice(0, 34).padEnd(34), String(row.count).padStart(6), fmt(row.effect, 3).padStart(8));
});

console.log('\nNotes:');
console.log('- Pair effects are learned walk-forward from earlier games only; current-game outcomes are not used.');
console.log('- Ratings, carry, and the margin model intentionally match the existing QC style: final replay maps are reused retroactively.');
console.log('- Effects are residuals versus the current model: actual red win outcome minus predicted red win probability.');
console.log('- within5, average point diff, and blowout count are actual-score controls, so they do not change unless future team assignments change.');
