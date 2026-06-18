// Eval-only sweep: use prior teammate-pair downside risk as a soft
// team-selection penalty, then compare selected-team BalanceIQ tradeoffs.

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
const MIN_PAIR_GAMES = Number(process.env.PAIR_MIN_GAMES || 4);
const PAIR_CONFIDENCE_GAMES = Number(process.env.PAIR_CONFIDENCE_GAMES || 10);
const weights = parseListEnv('PAIR_WEIGHTS', [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2]);
const includeLeagueOptions = String(process.env.PAIR_INCLUDE_LEAGUE || 'true,false')
  .split(',')
  .map(value => /^(1|true|yes)$/i.test(value.trim()));

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
    label: 'totalRisk',
    value: (red, blue) => red + blue,
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

function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
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

function createPairRiskMap(history, { includeLeague }) {
  const pairs = new Map();
  const rowFor = key => {
    if (!pairs.has(key)) {
      pairs.set(key, {
        key,
        games: 0,
        downsideResiduals: [],
        badTail: 0,
      });
    }
    return pairs.get(key);
  };

  (history || []).forEach(entry => {
    const game = entry.game || {};
    if (!includeLeague && game.isLeagueGame) return;
    const winner = game.winner === 'blue' ? 'blue' : 'red';
    const redProbability = Number(entry.volleyballWinnerProbability ?? entry.openSkillWinnerProbability ?? 0.5);
    const redProb = Number.isFinite(redProbability) ? redProbability : 0.5;

    ['red', 'blue'].forEach(side => {
      if (game.isLeagueGame && side === 'blue') return;
      const entries = Array.isArray(entry.before?.[side]) ? entry.before[side] : [];
      const ids = entries
        .map(player => String(player.id))
        .filter(id => !id.startsWith('league_team_'));
      if (ids.length < 2) return;

      const probability = side === 'red' ? redProb : 1 - redProb;
      const residual = (winner === side ? 1 : 0) - probability;
      const downside = residual < 0 ? -residual : 0;

      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const row = rowFor(pairKey(ids[i], ids[j]));
          row.games += 1;
          if (downside > 0) row.downsideResiduals.push(downside);
          if (residual <= -0.35) row.badTail += 1;
        }
      }
    });
  });

  const rawRows = [...pairs.values()].map(row => ({
    key: row.key,
    games: row.games,
    badRate: row.games ? row.badTail / row.games : 0,
    downsideMean: mean(row.downsideResiduals),
    downsideSeverity: mean(row.downsideResiduals.filter(value => value >= 0.35)),
    confidence: row.games >= MIN_PAIR_GAMES
      ? clamp((row.games - MIN_PAIR_GAMES + 1) / Math.max(1, PAIR_CONFIDENCE_GAMES - MIN_PAIR_GAMES + 1), 0, 1)
      : 0,
  }));

  const q = field => ({
    q25: quantile(rawRows.map(row => row[field]), 0.25),
    q75: quantile(rawRows.map(row => row[field]), 0.75),
  });
  const qs = {
    badRate: q('badRate'),
    downsideMean: q('downsideMean'),
    downsideSeverity: q('downsideSeverity'),
  };

  return new Map(rawRows.map(row => {
    const score = row.confidence * (
      0.45 * robustNormalize(row.badRate, qs.badRate.q25, qs.badRate.q75) +
      0.35 * robustNormalize(row.downsideMean, qs.downsideMean.q25, qs.downsideMean.q75) +
      0.20 * robustNormalize(row.downsideSeverity, qs.downsideSeverity.q25, qs.downsideSeverity.q75)
    );
    return [row.key, { ...row, score }];
  }));
}

function getTeamPairRisk(team, pairRiskMap) {
  let risk = 0;
  for (let i = 0; i < team.length; i += 1) {
    for (let j = i + 1; j < team.length; j += 1) {
      risk += Number(pairRiskMap.get(pairKey(team[i].id, team[j].id))?.score) || 0;
    }
  }
  return risk;
}

function buildSplitCandidates({ present, redSize, ratingMap, carryScoreMap, marginModel, pairRiskMap, penalty }) {
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
    const redRisk = getTeamPairRisk(redPlayers, pairRiskMap);
    const blueRisk = getTeamPairRisk(bluePlayers, pairRiskMap);
    candidates.push({
      redKey: teamKey(redPlayers),
      blueKey: teamKey(bluePlayers),
      predictedGap,
      pairRiskPenalty: penalty.value(redRisk, blueRisk),
      fairness: 1 - Math.abs(score.redWinProbability - 0.5) * 2,
    });
  }

  return candidates;
}

function selectBestCandidate(candidates, weight) {
  let best = null;
  candidates.forEach(candidate => {
    const objective = candidate.predictedGap + weight * candidate.pairRiskPenalty;
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
    selectedPairRiskPenaltySum: 0,
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
    avgSelectedPairRiskPenalty: stats.selectedPairRiskPenaltySum / stats.n,
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
          pairRiskMaps: {
            true: createPairRiskMap(prior.history, { includeLeague: true }),
            false: createPairRiskMap(prior.history, { includeLeague: false }),
          },
        });
      }
    }
    priorGames.push(game);
  }

  return snapshots;
}

function evaluateGroup({ snapshots, penalty, includeLeague, groupWeights }) {
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
      pairRiskMap: snapshot.pairRiskMaps[String(includeLeague)],
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
      stats.selectedPairRiskPenaltySum += best.pairRiskPenalty;
    });
  });

  return groupWeights.map(weight => {
    const summary = summarize(statsByWeight.get(weight));
    return {
      penalty: penalty.label,
      includeLeague,
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
    'penalty'.padEnd(10),
    'lg'.padStart(3),
    'wt'.padStart(5),
    'BalIQ'.padStart(6),
    'dBal'.padStart(6),
    'predBest'.padStart(8),
    'selLow'.padStart(6),
    'selHigh'.padStart(7),
    'pair'.padStart(7),
    'same'.padStart(5),
  ].join(' '));
  console.log('-'.repeat(76));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.penalty.slice(0, 10).padEnd(10),
      (row.includeLeague ? 'Y' : 'N').padStart(3),
      fmt(row.weight, 2).padStart(5),
      fmt(row.balanceIQ).padStart(6),
      fmt(row.balanceIQDelta).padStart(6),
      fmt(row.avgPredictedBestGap).padStart(8),
      pct(row.selectedLowRiskRate).padStart(6),
      pct(row.selectedHighRiskRate).padStart(7),
      fmt(row.avgSelectedPairRiskPenalty).padStart(7),
      pct(row.sameAsActualRate).padStart(5),
    ].join(' '));
  });
}

console.log(`DB: ${sourceLabel}`);
console.log(`minPairGames=${MIN_PAIR_GAMES} confidenceGames=${PAIR_CONFIDENCE_GAMES}`);
console.log(`weights=${weights.join(',')}`);

const snapshots = buildSnapshots();
const rows = [];

for (const includeLeague of includeLeagueOptions) {
  for (const penalty of penalties) {
    rows.push(...evaluateGroup({
      snapshots,
      penalty,
      includeLeague,
      groupWeights: weights,
    }));
  }
}

attachBalanceIQDeltas(rows, row =>
  row.penalty === penalties[0].label &&
  row.weight === 0 &&
  row.includeLeague === includeLeagueOptions[0]
);

const baseline = rows.find(row =>
  row.penalty === penalties[0].label &&
  row.weight === 0 &&
  row.includeLeague === includeLeagueOptions[0]
);
const byBalance = [...rows].sort(compareBalanceIQDesc);
const bestNonZero = rows.filter(row => row.weight > 0).sort(compareBalanceIQDesc);
const byPairRisk = [...rows].sort((a, b) =>
  a.avgSelectedPairRiskPenalty - b.avgSelectedPairRiskPenalty ||
  Number(b.balanceIQ) - Number(a.balanceIQ)
);

console.log(`Baseline: n=${baseline?.n || 0} BalanceIQ=${fmt(baseline?.balanceIQ)} predBest=${fmt(baseline?.avgPredictedBestGap)} selLow=${pct(baseline?.selectedLowRiskRate)} selHigh=${pct(baseline?.selectedHighRiskRate)} pair=${fmt(baseline?.avgSelectedPairRiskPenalty)}`);

printRows('Baseline', [baseline], 1);
printRows('Best BalanceIQ candidates', byBalance, 18);
printRows('Best nonzero pair-risk penalties', bestNonZero, 18);
printRows('Lowest selected pair risk', byPairRisk, 14);
