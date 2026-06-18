// Eval-only sweep: use prior-game player volatility as a soft team-selection
// penalty, then compare selected-team BalanceIQ tradeoffs.

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
} from '../ratings.js';
import {
  attachBalanceIQDeltas,
  compareBalanceIQDesc,
  computeBalanceIQ,
} from './metrics.mjs';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const MIN_VOL_GAMES = Number(process.env.VOL_MIN_GAMES || 6);
const CONFIDENCE_GAMES = Number(process.env.VOL_CONFIDENCE_GAMES || 16);
const weights = parseListEnv('VOL_WEIGHTS', [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2]);
const includeLeagueOptions = String(process.env.VOL_INCLUDE_LEAGUE || 'true,false')
  .split(',')
  .map(value => /^(1|true|yes)$/i.test(value.trim()));

const formulas = [
  {
    label: 'balancedComposite',
    score: row => 0.45 * row.nOutcomeStd + 0.25 * row.nDeltaStd + 0.20 * row.nAvgAbsOutcome + 0.10 * row.nTwoSidedTail,
  },
  {
    label: 'downsideComposite',
    score: row => 0.45 * row.nDownsideTail + 0.35 * row.nDownsideMean + 0.20 * row.nDownsideSeverity,
  },
  {
    label: 'downsideTail',
    score: row => row.nDownsideTail,
  },
];

const penalties = [
  {
    label: 'teamGap',
    value: (red, blue) => Math.abs(mean(red) - mean(blue)),
  },
  {
    label: 'stackTop2',
    value: (red, blue) => Math.max(topNMean(red, 2), topNMean(blue, 2)),
  },
  {
    label: 'gap+stack',
    value: (red, blue) => Math.abs(mean(red) - mean(blue)) + 0.5 * Math.max(topNMean(red, 2), topNMean(blue, 2)),
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
  return clamp((Number(value) - q25) / Math.max(1e-9, q75 - q25), 0, 2);
}

function topNMean(values, n) {
  return mean([...values].sort((a, b) => b - a).slice(0, Math.min(n, values.length)));
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

function createPlayerRows(history, { includeLeague }) {
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

  (history || []).forEach(entry => {
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
      const residual = (winner === side ? 1 : 0) - probability;

      before.forEach((player, index) => {
        const id = String(player.id);
        if (id.startsWith('league_team_')) return;
        const beforeRating = Number(player.rating);
        const afterRating = Number(after[index]?.rating);
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
    const goodRate = row.games ? row.goodTail / row.games : 0;
    const badRate = row.games ? row.badTail / row.games : 0;
    return {
      id: row.id,
      games: row.games,
      outcomeStd: stddev(row.residuals),
      avgAbsOutcome: mean(row.absResiduals),
      deltaStd: stddev(row.deltas),
      avgAbsDelta: mean(row.absDeltas),
      downsideMean: mean(row.absResiduals.filter((_, index) => row.residuals[index] < 0)),
      downsideSeverity: mean(row.absResiduals.filter((_, index) => row.residuals[index] <= -0.35)),
      twoSidedTail: Math.min(goodRate, badRate),
      downsideTail: badRate,
      confidence: row.games >= MIN_VOL_GAMES
        ? clamp((row.games - MIN_VOL_GAMES + 1) / Math.max(1, CONFIDENCE_GAMES - MIN_VOL_GAMES + 1), 0, 1)
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
    downsideMean: q('downsideMean'),
    downsideSeverity: q('downsideSeverity'),
    twoSidedTail: q('twoSidedTail'),
    downsideTail: q('downsideTail'),
  };

  return new Map(rawRows.map(row => [row.id, {
    ...row,
    nOutcomeStd: robustNormalize(row.outcomeStd, qs.outcomeStd.q25, qs.outcomeStd.q75),
    nAvgAbsOutcome: robustNormalize(row.avgAbsOutcome, qs.avgAbsOutcome.q25, qs.avgAbsOutcome.q75),
    nDeltaStd: robustNormalize(row.deltaStd, qs.deltaStd.q25, qs.deltaStd.q75),
    nAvgAbsDelta: robustNormalize(row.avgAbsDelta, qs.avgAbsDelta.q25, qs.avgAbsDelta.q75),
    nDownsideMean: robustNormalize(row.downsideMean, qs.downsideMean.q25, qs.downsideMean.q75),
    nDownsideSeverity: robustNormalize(row.downsideSeverity, qs.downsideSeverity.q25, qs.downsideSeverity.q75),
    nTwoSidedTail: robustNormalize(row.twoSidedTail, qs.twoSidedTail.q25, qs.twoSidedTail.q75),
    nDownsideTail: robustNormalize(row.downsideTail, qs.downsideTail.q25, qs.downsideTail.q75),
  }]));
}

function getPlayerVolatility(row, formula) {
  if (!row || row.confidence <= 0) return 0;
  return row.confidence * formula.score(row);
}

function findBestSplit({ present, redSize, ratingMap, carryScoreMap, marginModel, volatilityMap, formula, penalty, weight }) {
  const allIndexes = new Set(present.map((_, index) => index));
  let best = null;

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
    const redVol = redPlayers.map(player => getPlayerVolatility(volatilityMap.get(String(player.id)), formula));
    const blueVol = bluePlayers.map(player => getPlayerVolatility(volatilityMap.get(String(player.id)), formula));
    const volatilityPenalty = penalty.value(redVol, blueVol);
    const objective = predictedGap + weight * volatilityPenalty;
    const fairness = 1 - Math.abs(score.redWinProbability - 0.5) * 2;

    if (
      !best ||
      objective < best.objective - 1e-9 ||
      (Math.abs(objective - best.objective) < 1e-9 && predictedGap < best.predictedGap - 1e-9) ||
      (Math.abs(objective - best.objective) < 1e-9 && Math.abs(predictedGap - best.predictedGap) < 1e-9 && fairness > best.fairness)
    ) {
      best = {
        redKey: teamKey(redPlayers),
        blueKey: teamKey(bluePlayers),
        predictedGap,
        objective,
        volatilityPenalty,
        fairness,
      };
    }
  }

  return best;
}

function buildSplitCandidates({ present, redSize, ratingMap, carryScoreMap, marginModel, volatilityMap, formula, penalty }) {
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
    const redVol = redPlayers.map(player => getPlayerVolatility(volatilityMap.get(String(player.id)), formula));
    const blueVol = bluePlayers.map(player => getPlayerVolatility(volatilityMap.get(String(player.id)), formula));
    candidates.push({
      redKey: teamKey(redPlayers),
      blueKey: teamKey(bluePlayers),
      predictedGap,
      volatilityPenalty: penalty.value(redVol, blueVol),
      fairness: 1 - Math.abs(score.redWinProbability - 0.5) * 2,
    });
  }

  return candidates;
}

function selectBestCandidate(candidates, weight) {
  let best = null;
  candidates.forEach(candidate => {
    const objective = candidate.predictedGap + weight * candidate.volatilityPenalty;
    if (
      !best ||
      objective < best.objective - 1e-9 ||
      (Math.abs(objective - best.objective) < 1e-9 && candidate.predictedGap < best.predictedGap - 1e-9) ||
      (Math.abs(objective - best.objective) < 1e-9 && Math.abs(candidate.predictedGap - best.predictedGap) < 1e-9 && candidate.fairness > best.fairness)
    ) {
      best = {
        ...candidate,
        objective,
      };
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
    selectedVolatilityPenaltySum: 0,
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
    avgSelectedVolatilityPenalty: stats.selectedVolatilityPenaltySum / stats.n,
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
          volatilityMaps: {
            true: createPlayerRows(prior.history, { includeLeague: true }),
            false: createPlayerRows(prior.history, { includeLeague: false }),
          },
        });
      }
    }
    priorGames.push(game);
  }

  return snapshots;
}

function evaluate({ snapshots, formula, penalty, weight, includeLeagueVolatility }) {
  const stats = createStats();

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
    const present = [...game.redTeam, ...game.blueTeam];
    const best = findBestSplit({
      present,
      redSize: game.redTeam.length,
      ratingMap,
      carryScoreMap,
      marginModel,
      volatilityMap: snapshot.volatilityMaps[String(includeLeagueVolatility)],
      formula,
      penalty,
      weight,
    });

    const actualRedKey = teamKey(game.redTeam);
    const actualBlueKey = teamKey(game.blueTeam);
    const sameAsActual =
      (best.redKey === actualRedKey && best.blueKey === actualBlueKey) ||
      (best.redKey === actualBlueKey && best.blueKey === actualRedKey);

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
    stats.selectedVolatilityPenaltySum += best.volatilityPenalty;
  });

  const summary = summarize(stats);
  return {
    formula: formula.label,
    penalty: penalty.label,
    weight,
    includeLeagueVolatility,
    ...summary,
    balanceIQ: computeBalanceIQ(summary),
  };
}

function evaluateGroup({ snapshots, formula, penalty, includeLeagueVolatility, groupWeights }) {
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
      volatilityMap: snapshot.volatilityMaps[String(includeLeagueVolatility)],
      formula,
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
      stats.selectedVolatilityPenaltySum += best.volatilityPenalty;
    });
  });

  return groupWeights.map(weight => {
    const summary = summarize(statsByWeight.get(weight));
    return {
      formula: formula.label,
      penalty: penalty.label,
      weight,
      includeLeagueVolatility,
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
    'formula'.padEnd(18),
    'penalty'.padEnd(11),
    'lg'.padStart(3),
    'wt'.padStart(5),
    'BalIQ'.padStart(6),
    'dBal'.padStart(6),
    'predBest'.padStart(8),
    'selLow'.padStart(6),
    'selHigh'.padStart(7),
    'vol'.padStart(6),
    'same'.padStart(5),
  ].join(' '));
  console.log('-'.repeat(96));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.formula.slice(0, 18).padEnd(18),
      row.penalty.slice(0, 11).padEnd(11),
      (row.includeLeagueVolatility ? 'Y' : 'N').padStart(3),
      fmt(row.weight, 2).padStart(5),
      fmt(row.balanceIQ).padStart(6),
      fmt(row.balanceIQDelta).padStart(6),
      fmt(row.avgPredictedBestGap).padStart(8),
      pct(row.selectedLowRiskRate).padStart(6),
      pct(row.selectedHighRiskRate).padStart(7),
      fmt(row.avgSelectedVolatilityPenalty).padStart(6),
      pct(row.sameAsActualRate).padStart(5),
    ].join(' '));
  });
}

console.log(`DB: ${sourceLabel}`);
console.log(`minVolGames=${MIN_VOL_GAMES} confidenceGames=${CONFIDENCE_GAMES}`);
console.log(`weights=${weights.join(',')}`);

const snapshots = buildSnapshots();
const rows = [];

for (const includeLeagueVolatility of includeLeagueOptions) {
  for (const formula of formulas) {
    for (const penalty of penalties) {
      rows.push(...evaluateGroup({
        snapshots,
        formula,
        penalty,
        includeLeagueVolatility,
        groupWeights: weights,
      }));
    }
  }
}

attachBalanceIQDeltas(rows, row =>
  row.formula === formulas[0].label &&
  row.penalty === penalties[0].label &&
  row.weight === 0 &&
  row.includeLeagueVolatility === includeLeagueOptions[0]
);

const baseline = rows.find(row =>
  row.formula === formulas[0].label &&
  row.penalty === penalties[0].label &&
  row.weight === 0 &&
  row.includeLeagueVolatility === includeLeagueOptions[0]
);

console.log(`Baseline: n=${baseline?.n || 0} BalanceIQ=${fmt(baseline?.balanceIQ)} predBest=${fmt(baseline?.avgPredictedBestGap)} selLow=${pct(baseline?.selectedLowRiskRate)} selHigh=${pct(baseline?.selectedHighRiskRate)} vol=${fmt(baseline?.avgSelectedVolatilityPenalty)}`);

const byBalance = [...rows].sort(compareBalanceIQDesc);
const byVol = [...rows].sort((a, b) =>
  a.avgSelectedVolatilityPenalty - b.avgSelectedVolatilityPenalty ||
  Number(b.balanceIQ) - Number(a.balanceIQ)
);
const nonZero = rows.filter(row => row.weight > 0);
const bestNonZero = [...nonZero].sort(compareBalanceIQDesc);

printRows('Baseline', [baseline], 1);
printRows('Best BalanceIQ candidates', byBalance, 18);
printRows('Best nonzero volatility penalties', bestNonZero, 18);
printRows('Lowest selected volatility risk', byVol, 14);
