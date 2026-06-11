// Eval-only grid search for weak-link and team-size balancing parameters.
//
// This uses the current production rating replay settings, then exhaustively
// searches same-size candidate splits for each historical scored non-league
// game. Counterfactual actual scores are unknowable, so selected-split metrics
// are predicted opportunity/calibration, not proven alternate outcomes.
//
// Run from eval/:
//   npm run balancer:grid

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

const seasonalTaperDays = Math.round(6 * 30.4375);

const BASE = {
  topPlayerWeight: 0.30,
  secondPlayerWeight: 0.24,
  depthWeight: 0.10,
};

function makeOptions(worstPlayerWeight, sizeBonusPerExtraPlayer) {
  return {
    ...BASE,
    averageWeight: 1 - BASE.topPlayerWeight - BASE.secondPlayerWeight - BASE.depthWeight - worstPlayerWeight,
    worstPlayerWeight,
    sizeBonusPerExtraPlayer,
  };
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
  const n = present.length;
  const allIndexes = new Set(present.map((_, index) => index));
  let best = null;

  for (const redIndexes of chooseIndexes(n, redSize)) {
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
    actualWithin3: 0,
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
    actualWithin3: stats.actualWithin3 / stats.n,
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

function evaluate(worstPlayerWeight, sizeBonusPerExtraPlayer) {
  const volleyballOptions = makeOptions(worstPlayerWeight, sizeBonusPerExtraPlayer);
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
    stats.actualWithin3 += actualMargin <= 3 ? 1 : 0;
    stats.actualWithin5 += actualMargin <= 5 ? 1 : 0;
    stats.actualBlowouts8 += actualMargin > 8 ? 1 : 0;
    stats.predictedActualGapSum += predictedActualGap;
    stats.predictedBestGapSum += best.predictedGap;
    stats.predictedGapReductionSum += predictedActualGap - best.predictedGap;
    stats.actualMarginErrSum += Math.abs(predictedActualGap - actualMargin);
    if (best.predictedGap <= 5) stats.selectedLowRisk += 1;
    if (best.predictedGap > 8) stats.selectedHighRisk += 1;
    if (sameAsActual) stats.sameAsActualCount += 1;
  }

  return {
    worstPlayerWeight,
    averageWeight: volleyballOptions.averageWeight,
    sizeBonusPerExtraPlayer,
    ...summarize(stats),
  };
}

function composite(row) {
  // Lower is better. Main target is best predicted closeness; actual-split
  // margin calibration breaks ties, then reduction opportunity.
  return row.avgPredictedBestGap * 10 + row.actualMarginMAE - row.avgPredictedGapReduction * 0.5;
}

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function printRows(title, rows, limit = 16) {
  console.log(title);
  console.log([
    'worst'.padStart(6),
    'avgW'.padStart(6),
    'size'.padStart(6),
    'actMAE'.padStart(6),
    'predAct'.padStart(7),
    'predBest'.padStart(8),
    'reduct'.padStart(6),
    'selLow'.padStart(6),
    'selHigh'.padStart(7),
    'same'.padStart(5),
    'score'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(88));
  rows.slice(0, limit).forEach(row => {
    console.log([
      fmt(row.worstPlayerWeight).padStart(6),
      fmt(row.averageWeight).padStart(6),
      fmt(row.sizeBonusPerExtraPlayer).padStart(6),
      fmt(row.actualMarginMAE).padStart(6),
      fmt(row.avgPredictedActualGap).padStart(7),
      fmt(row.avgPredictedBestGap).padStart(8),
      fmt(row.avgPredictedGapReduction).padStart(6),
      pct(row.selectedLowRiskRate).padStart(6),
      pct(row.selectedHighRiskRate).padStart(7),
      pct(row.sameAsActualRate).padStart(5),
      fmt(row.score).padStart(7),
    ].join(' '));
  });
  console.log('');
}

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value));

  return values.length > 0 ? values : fallback;
}

const worstWeights = parseListEnv('WORST_WEIGHTS', [0.00, 0.04, 0.08, 0.12, 0.16, 0.20, 0.24]);
const sizeWeights = parseListEnv('SIZE_WEIGHTS', [0.40, 0.55, 0.70, 0.85, 1.00, 1.15, 1.30]);

console.log(`DB: ${DB_PATH}`);
console.log(`scoredNonLeague=${scoredGames.length} evaluated=${priorSnapshots.length}`);
console.log('Grid keeps top=.30, second=.24, depth=.10, and shifts weight between average and worst.');
console.log('');

const rows = [];
let completed = 0;
const started = Date.now();

for (const worst of worstWeights) {
  for (const size of sizeWeights) {
    const row = evaluate(worst, size);
    row.score = composite(row);
    rows.push(row);
    completed += 1;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`completed ${completed}/${worstWeights.length * sizeWeights.length} in ${elapsed}s`);
}

const baseline = rows.filter(row =>
  Math.abs(row.worstPlayerWeight - 0.08) < 1e-9 &&
  Math.abs(row.sizeBonusPerExtraPlayer - 0.70) < 1e-9
);
const byComposite = [...rows].sort((a, b) => a.score - b.score);
const byBestGap = [...rows].sort((a, b) =>
  a.avgPredictedBestGap - b.avgPredictedBestGap ||
  a.actualMarginMAE - b.actualMarginMAE
);
const byReduction = [...rows].sort((a, b) =>
  b.avgPredictedGapReduction - a.avgPredictedGapReduction ||
  a.avgPredictedBestGap - b.avgPredictedBestGap
);
const byCalibration = [...rows].sort((a, b) =>
  a.actualMarginMAE - b.actualMarginMAE ||
  a.avgPredictedBestGap - b.avgPredictedBestGap
);

printRows('Baseline', baseline, 1);
printRows('Best composite candidates', byComposite, 16);
printRows('Best predicted balancing closeness', byBestGap, 16);
printRows('Largest predicted improvement over actual splits', byReduction, 16);
printRows('Best actual-split calibration', byCalibration, 16);
