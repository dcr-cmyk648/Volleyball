// Exploratory sweep for identifying player volatility and whether it predicts
// future margin/blowout risk. This is eval-only; it does not change ratings.

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const MIN_VOL_GAMES = Number(process.env.VOL_MIN_GAMES || 6);
const CONFIDENCE_GAMES = Number(process.env.VOL_CONFIDENCE_GAMES || 16);
const MAX_ROWS = Number(process.env.VOL_ROWS || 15);

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
  return values.length > 0
    ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
    : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / (values.length - 1));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function robustNormalize(value, q25, q75) {
  const denom = Math.max(1e-9, q75 - q25);
  return clamp((Number(value) - q25) / denom, 0, 2);
}

function teamKey(team) {
  return (Array.isArray(team) ? team : []).map(player => String(player.id)).sort().join(',');
}

function getNameMap(playersList) {
  return new Map((Array.isArray(playersList) ? playersList : []).map(player => [
    String(player.id),
    player.name || String(player.id),
  ]));
}

function createPlayerRows(history, { includeLeague = true } = {}) {
  const rows = new Map();

  const rowFor = id => {
    const key = String(id);
    if (!rows.has(key)) {
      rows.set(key, {
        id: key,
        games: 0,
        residuals: [],
        absResiduals: [],
        deltas: [],
        absDeltas: [],
        goodTail: 0,
        badTail: 0,
      });
    }
    return rows.get(key);
  };

  (Array.isArray(history) ? history : []).forEach(entry => {
    const game = entry.game || {};
    if (!includeLeague && game.isLeagueGame) return;

    const winner = game.winner === 'blue' ? 'blue' : 'red';
    const redProbability = Number(entry.volleyballWinnerProbability ?? entry.openSkillWinnerProbability ?? 0.5);
    const redProb = Number.isFinite(redProbability) ? redProbability : 0.5;

    ['red', 'blue'].forEach(side => {
      if (game.isLeagueGame && side === 'blue') return;

      const before = Array.isArray(entry.before?.[side]) ? entry.before[side] : [];
      const after = Array.isArray(entry.after?.[side]) ? entry.after[side] : [];
      const probability = side === 'red' ? redProb : 1 - redProb;
      const actual = winner === side ? 1 : 0;
      const residual = actual - probability;

      before.forEach((player, index) => {
        const id = String(player.id);
        if (id.startsWith('league_team_')) return;

        const afterPlayer = after[index];
        const beforeRating = Number(player.rating);
        const afterRating = Number(afterPlayer?.rating);
        const delta = Number.isFinite(beforeRating) && Number.isFinite(afterRating)
          ? afterRating - beforeRating
          : null;
        const row = rowFor(id);

        row.games += 1;
        row.residuals.push(residual);
        row.absResiduals.push(Math.abs(residual));
        if (Number.isFinite(delta)) {
          row.deltas.push(delta);
          row.absDeltas.push(Math.abs(delta));
        }
        if (residual >= 0.35) row.goodTail += 1;
        if (residual <= -0.35) row.badTail += 1;
      });
    });
  });

  const rawRows = [...rows.values()].map(row => {
    const gamesPlayed = row.games;
    const goodRate = gamesPlayed > 0 ? row.goodTail / gamesPlayed : 0;
    const badRate = gamesPlayed > 0 ? row.badTail / gamesPlayed : 0;
    return {
      id: row.id,
      games: gamesPlayed,
      outcomeStd: stddev(row.residuals),
      avgAbsOutcome: mean(row.absResiduals),
      deltaStd: stddev(row.deltas),
      avgAbsDelta: mean(row.absDeltas),
      twoSidedTail: Math.min(goodRate, badRate),
      downsideTail: badRate,
      upsideTail: goodRate,
      confidence: gamesPlayed >= MIN_VOL_GAMES
        ? clamp((gamesPlayed - MIN_VOL_GAMES + 1) / Math.max(1, CONFIDENCE_GAMES - MIN_VOL_GAMES + 1), 0, 1)
        : 0,
    };
  });

  const q = field => ({
    q25: quantile(rawRows.map(row => row[field]), 0.25),
    q75: quantile(rawRows.map(row => row[field]), 0.75),
  });
  const qs = {
    outcomeStd: q('outcomeStd'),
    avgAbsOutcome: q('avgAbsOutcome'),
    deltaStd: q('deltaStd'),
    avgAbsDelta: q('avgAbsDelta'),
    twoSidedTail: q('twoSidedTail'),
    downsideTail: q('downsideTail'),
  };

  const map = new Map();
  rawRows.forEach(row => {
    const normalized = {
      ...row,
      nOutcomeStd: robustNormalize(row.outcomeStd, qs.outcomeStd.q25, qs.outcomeStd.q75),
      nAvgAbsOutcome: robustNormalize(row.avgAbsOutcome, qs.avgAbsOutcome.q25, qs.avgAbsOutcome.q75),
      nDeltaStd: robustNormalize(row.deltaStd, qs.deltaStd.q25, qs.deltaStd.q75),
      nAvgAbsDelta: robustNormalize(row.avgAbsDelta, qs.avgAbsDelta.q25, qs.avgAbsDelta.q75),
      nTwoSidedTail: robustNormalize(row.twoSidedTail, qs.twoSidedTail.q25, qs.twoSidedTail.q75),
      nDownsideTail: robustNormalize(row.downsideTail, qs.downsideTail.q25, qs.downsideTail.q75),
    };
    map.set(row.id, normalized);
  });

  return map;
}

const formulas = [
  {
    label: 'outcomeStd',
    score: row => row.nOutcomeStd,
  },
  {
    label: 'absOutcome',
    score: row => row.nAvgAbsOutcome,
  },
  {
    label: 'ratingDeltaStd',
    score: row => row.nDeltaStd,
  },
  {
    label: 'absRatingDelta',
    score: row => row.nAvgAbsDelta,
  },
  {
    label: 'tailBalance',
    score: row => row.nTwoSidedTail,
  },
  {
    label: 'outcome+delta',
    score: row => 0.65 * row.nOutcomeStd + 0.35 * row.nDeltaStd,
  },
  {
    label: 'outcome+tail',
    score: row => 0.70 * row.nOutcomeStd + 0.30 * row.nTwoSidedTail,
  },
  {
    label: 'delta+tail',
    score: row => 0.65 * row.nDeltaStd + 0.35 * row.nTwoSidedTail,
  },
  {
    label: 'balancedComposite',
    score: row => 0.45 * row.nOutcomeStd + 0.25 * row.nDeltaStd + 0.20 * row.nAvgAbsOutcome + 0.10 * row.nTwoSidedTail,
  },
  {
    label: 'downsideComposite',
    score: row => 0.45 * row.nOutcomeStd + 0.25 * row.nDownsideTail + 0.20 * row.nDeltaStd + 0.10 * row.nAvgAbsDelta,
  },
];

const aggregators = [
  {
    label: 'totalAvg',
    feature: (red, blue) => mean([...red, ...blue]),
  },
  {
    label: 'teamGap',
    feature: (red, blue) => Math.abs(mean(red) - mean(blue)),
  },
  {
    label: 'maxTeam',
    feature: (red, blue) => Math.max(mean(red), mean(blue)),
  },
  {
    label: 'stackTop2',
    feature: (red, blue) => Math.max(topNMean(red, 2), topNMean(blue, 2)),
  },
  {
    label: 'newInteraction',
    feature: (red, blue, redRows, blueRows) =>
      mean(red) * provisionalCount(redRows) + mean(blue) * provisionalCount(blueRows),
  },
];

const coefficients = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8];

function topNMean(values, n) {
  const sorted = [...values].sort((a, b) => b - a);
  return mean(sorted.slice(0, Math.min(n, sorted.length)));
}

function provisionalCount(rows) {
  return rows.filter(row => (row?.games || 0) < 8).length;
}

function getPlayerVolatility(row, formula) {
  if (!row || row.confidence <= 0) return 0;
  return row.confidence * formula.score(row);
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let numerator = 0;
  let xSum = 0;
  let ySum = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    numerator += dx * dy;
    xSum += dx * dx;
    ySum += dy * dy;
  }
  const denom = Math.sqrt(xSum * ySum);
  return denom > 0 ? numerator / denom : 0;
}

function createStats() {
  return {
    n: 0,
    baseAbsError: 0,
    adjustedAbsError: 0,
    baseBlowoutBrier: 0,
    adjustedBlowoutBrier: 0,
    actualBlowouts: 0,
    features: [],
    residuals: [],
    actualMargins: [],
  };
}

function addGame(stats, { actualMargin, basePredictedMargin, adjustedPredictedMargin, feature }) {
  const residual = actualMargin - basePredictedMargin;
  const actualBlowout = actualMargin > 8 ? 1 : 0;
  const baseBlowoutProbability = clamp((basePredictedMargin - 4) / 8, 0.02, 0.98);
  const adjustedBlowoutProbability = clamp((adjustedPredictedMargin - 4) / 8, 0.02, 0.98);

  stats.n += 1;
  stats.baseAbsError += Math.abs(actualMargin - basePredictedMargin);
  stats.adjustedAbsError += Math.abs(actualMargin - adjustedPredictedMargin);
  stats.baseBlowoutBrier += Math.pow(actualBlowout - baseBlowoutProbability, 2);
  stats.adjustedBlowoutBrier += Math.pow(actualBlowout - adjustedBlowoutProbability, 2);
  stats.actualBlowouts += actualBlowout;
  stats.features.push(feature);
  stats.residuals.push(residual);
  stats.actualMargins.push(actualMargin);
}

function summarize(stats) {
  return {
    n: stats.n,
    baseMAE: stats.n ? stats.baseAbsError / stats.n : null,
    adjustedMAE: stats.n ? stats.adjustedAbsError / stats.n : null,
    maeDelta: stats.n ? (stats.baseAbsError - stats.adjustedAbsError) / stats.n : null,
    baseBlowoutBrier: stats.n ? stats.baseBlowoutBrier / stats.n : null,
    adjustedBlowoutBrier: stats.n ? stats.adjustedBlowoutBrier / stats.n : null,
    brierDelta: stats.n ? (stats.baseBlowoutBrier - stats.adjustedBlowoutBrier) / stats.n : null,
    blowoutRate: stats.n ? stats.actualBlowouts / stats.n : null,
    residualCorrelation: pearson(stats.features, stats.residuals),
    marginCorrelation: pearson(stats.features, stats.actualMargins),
  };
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

function buildSnapshots() {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const snapshots = [];

  for (const game of sortedGames) {
    if (!isScoredNonLeagueGame(game)) {
      priorGames.push(game);
      continue;
    }

    const replay = replayFor(priorGames);
    const marginModel = calibrateMarginModel({
      games: priorGames,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
      options: { seasonalTaperDays },
    });

    if (!marginModel?.sampleSize) {
      priorGames.push(game);
      continue;
    }

    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
    });
    const basePredictedMargin = predictExpectedMargin(score.strengthDiff, marginModel);
    const volatilityWithLeague = createPlayerRows(replay.history, { includeLeague: true });
    const volatilityNonLeague = createPlayerRows(replay.history, { includeLeague: false });
    const actualMargin = Math.abs(Number(game.scoreRed) - Number(game.scoreBlue));

    snapshots.push({
      game,
      actualMargin,
      basePredictedMargin,
      volatilityMaps: {
        true: volatilityWithLeague,
        false: volatilityNonLeague,
      },
    });
    priorGames.push(game);
  }

  return snapshots;
}

function evaluateCandidate({ snapshots, formula, aggregator, coefficient, includeLeagueVolatility }) {
  const stats = createStats();

  for (const snapshot of snapshots) {
    const { game, actualMargin, basePredictedMargin } = snapshot;
    const volatilityMap = snapshot.volatilityMaps[String(includeLeagueVolatility)];
    const redRows = game.redTeam.map(player => volatilityMap.get(String(player.id)));
    const blueRows = game.blueTeam.map(player => volatilityMap.get(String(player.id)));
    const redScores = redRows.map(row => getPlayerVolatility(row, formula));
    const blueScores = blueRows.map(row => getPlayerVolatility(row, formula));
    const feature = aggregator.feature(redScores, blueScores, redRows, blueRows);
    const adjustedPredictedMargin = basePredictedMargin + coefficient * feature;

    addGame(stats, {
      actualMargin,
      basePredictedMargin,
      adjustedPredictedMargin,
      feature,
    });
  }

  return {
    formula: formula.label,
    aggregator: aggregator.label,
    coefficient,
    includeLeagueVolatility,
    ...summarize(stats),
  };
}

function formatNumber(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
}

function printRows(title, rows) {
  console.log(`\n${title}`);
  console.log([
    'formula'.padEnd(19),
    'agg'.padEnd(15),
    'lg'.padStart(3),
    'coef'.padStart(5),
    'n'.padStart(4),
    'MAE'.padStart(7),
    'dMAE'.padStart(8),
    'brier'.padStart(8),
    'dBrier'.padStart(8),
    'corrR'.padStart(7),
    'corrM'.padStart(7),
  ].join('  '));

  rows.forEach(row => {
    console.log([
      row.formula.slice(0, 19).padEnd(19),
      row.aggregator.slice(0, 15).padEnd(15),
      (row.includeLeagueVolatility ? 'Y' : 'N').padStart(3),
      formatNumber(row.coefficient, 1).padStart(5),
      String(row.n).padStart(4),
      formatNumber(row.adjustedMAE, 3).padStart(7),
      formatNumber(row.maeDelta, 3).padStart(8),
      formatNumber(row.adjustedBlowoutBrier, 3).padStart(8),
      formatNumber(row.brierDelta, 3).padStart(8),
      formatNumber(row.residualCorrelation, 3).padStart(7),
      formatNumber(row.marginCorrelation, 3).padStart(7),
    ].join('  '));
  });
}

const rows = [];
const snapshots = buildSnapshots();

for (const includeLeagueVolatility of [true, false]) {
  for (const formula of formulas) {
    for (const aggregator of aggregators) {
      for (const coefficient of coefficients) {
        rows.push(evaluateCandidate({
          snapshots,
          formula,
          aggregator,
          coefficient,
          includeLeagueVolatility,
        }));
      }
    }
  }
}

const baseline = rows.find(row =>
  row.formula === formulas[0].label &&
  row.aggregator === aggregators[0].label &&
  row.coefficient === 0 &&
  row.includeLeagueVolatility === true
);

console.log(`Volatility sweep over ${sourceLabel}`);
console.log(`minVolGames=${MIN_VOL_GAMES} confidenceGames=${CONFIDENCE_GAMES}`);
console.log(`Baseline: n=${baseline?.n || 0} marginMAE=${formatNumber(baseline?.baseMAE, 3)} blowoutBrier=${formatNumber(baseline?.baseBlowoutBrier, 3)}`);
console.log('dMAE/dBrier are improvements over the base predicted margin/blowout risk.');

const bestByMae = rows
  .filter(row => row.coefficient > 0)
  .sort((a, b) => (Number(b.maeDelta) || -Infinity) - (Number(a.maeDelta) || -Infinity))
  .slice(0, MAX_ROWS);
const bestByBrier = rows
  .filter(row => row.coefficient > 0)
  .sort((a, b) => (Number(b.brierDelta) || -Infinity) - (Number(a.brierDelta) || -Infinity))
  .slice(0, MAX_ROWS);
const bestCorrelations = rows
  .filter(row => row.coefficient === 1)
  .sort((a, b) => Math.abs(Number(b.residualCorrelation) || 0) - Math.abs(Number(a.residualCorrelation) || 0))
  .slice(0, MAX_ROWS);

printRows('Best margin-MAE improvements', bestByMae);
printRows('Best blowout-risk Brier improvements', bestByBrier);
printRows('Strongest residual correlations at coefficient 1.0', bestCorrelations);

const nameById = getNameMap(players);
const finalReplay = replayFor(games);
const finalMap = createPlayerRows(finalReplay.history, { includeLeague: true });
const finalFormula = formulas.find(formula => formula.label === 'balancedComposite');
const playerRows = [...finalMap.values()]
  .filter(row => row.games >= MIN_VOL_GAMES)
  .map(row => ({
    name: nameById.get(row.id) || row.id,
    games: row.games,
    score: getPlayerVolatility(row, finalFormula),
    outcomeStd: row.outcomeStd,
    deltaStd: row.deltaStd,
    twoSidedTail: row.twoSidedTail,
  }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 10);

console.log('\nCurrent top players by balancedComposite volatility');
console.log('player'.padEnd(18), 'games'.padStart(5), 'score'.padStart(7), 'outStd'.padStart(7), 'dStd'.padStart(7), 'tail'.padStart(7));
playerRows.forEach(row => {
  console.log([
    row.name.slice(0, 18).padEnd(18),
    String(row.games).padStart(5),
    formatNumber(row.score, 3).padStart(7),
    formatNumber(row.outcomeStd, 3).padStart(7),
    formatNumber(row.deltaStd, 3).padStart(7),
    formatNumber(row.twoSidedTail, 3).padStart(7),
  ].join('  '));
});
