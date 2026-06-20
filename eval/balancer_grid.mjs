// Eval-only grid search for weak-link and team-size balancing parameters.
//
// This uses the current production rating replay settings, then exhaustively
// searches same-size candidate splits for each historical scored non-league
// game. Counterfactual actual scores are unknowable, so selected-split metrics
// are predicted opportunity/calibration, not proven alternate outcomes.
//
// Run from eval/:
//   npm run balancer:grid

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  makeInitialRating,
  getRawOrdinal,
} from '../ratings.js';

const { db, players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);

const BASE = {
  topPlayerWeight: 0.30,
  secondPlayerWeight: 0.24,
  depthWeight: 0.10,
};

function makeOptions(worstPlayerWeight, sizeBonusPerExtraPlayer, weakLinkOptions = { mode: 'off' }) {
  return {
    ...BASE,
    averageWeight: 1 - BASE.topPlayerWeight - BASE.secondPlayerWeight - BASE.depthWeight - worstPlayerWeight,
    worstPlayerWeight,
    sizeBonusPerExtraPlayer,
    sizeBonusByBaseSizeEnabled: false,
    weakLinkPenaltyMode: weakLinkOptions?.mode || 'off',
    weakLinkPenaltyScale: Number(weakLinkOptions?.scale) || 0,
    weakLinkPenaltyThreshold: Number(weakLinkOptions?.threshold) || 0,
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

function getSideSize(game, side) {
  const team = Array.isArray(game?.[`${side}Team`]) ? game[`${side}Team`] : [];
  return team.length;
}

function isSmallTeamSize(size) {
  return size === 3 || size === 4;
}

function isBigTeamSize(size) {
  return size >= 5;
}

function getGameSilo(game) {
  const redSize = getSideSize(game, 'red');
  const blueSize = game?.isLeagueGame ? 0 : getSideSize(game, 'blue');
  if (game?.isLeagueGame || isBigTeamSize(redSize) || isBigTeamSize(blueSize)) return 'big';
  if (isSmallTeamSize(redSize) || isSmallTeamSize(blueSize)) return 'small';
  return 'overall';
}

function isSiloGame(game, silo) {
  return getGameSilo(game) === silo;
}

function addCount(counts, player) {
  if (!player?.id) return;
  const id = String(player.id);
  counts[id] = (counts[id] || 0) + 1;
}

function getSiloCounts(priorGames, silo) {
  const counts = {};
  priorGames.forEach(game => {
    if (!isSiloGame(game, silo)) return;
    if (Array.isArray(game.redTeam)) game.redTeam.forEach(player => addCount(counts, player));
    if (!game.isLeagueGame && Array.isArray(game.blueTeam)) {
      game.blueTeam.forEach(player => addCount(counts, player));
    }
  });
  return counts;
}

function replayFor(priorGames) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames: false,
    options: { seasonalTaperDays },
  });
}

function cloneSkill(skill) {
  return skill ? { mu: Number(skill.mu), sigma: Number(skill.sigma) } : null;
}

function skillFromRawOrdinal(rawOrdinal, sigma) {
  const safeSigma = Number.isFinite(Number(sigma)) ? Number(sigma) : Number(makeInitialRating().sigma);
  return {
    mu: Number(rawOrdinal) + 3 * safeSigma,
    sigma: safeSigma,
  };
}

function getBlendedSiloSkill({ overallSkill, siloSkill, siloGames, siloOptions }) {
  if (!overallSkill) return cloneSkill(siloSkill) || makeInitialRating();
  if (!siloSkill) return cloneSkill(overallSkill);

  const overallRaw = getRawOrdinal(overallSkill);
  const siloRaw = getRawOrdinal(siloSkill);
  const delta = siloRaw - overallRaw;
  const minDelta = Math.max(0, Number(siloOptions?.minDelta) || 0);
  if (Math.abs(delta) < minDelta) return cloneSkill(overallSkill);

  const confidenceGames = Math.max(0.01, Number(siloOptions?.confidenceGames) || 12);
  const maxBlend = Math.max(0, Math.min(1, Number(siloOptions?.maxBlend) || 0));
  const adjustmentCap = Math.max(0, Number(siloOptions?.adjustmentCap) || Infinity);
  const blend = Math.min(maxBlend, siloGames / (siloGames + confidenceGames));
  const adjustment = Math.max(-adjustmentCap, Math.min(adjustmentCap, delta * blend));
  return skillFromRawOrdinal(overallRaw + adjustment, overallSkill.sigma);
}

function createHybridRatingMap({
  present,
  targetSilo,
  overallRatingMap,
  siloRatingMap,
  siloCounts,
  siloOptions,
}) {
  const mode = siloOptions?.mode || 'off';
  const minSiloGames = Math.max(0, Number(siloOptions?.minGames) || 0);
  const ratingMap = {};
  present.forEach(player => {
    if (!player?.id) return;
    const id = String(player.id);
    const siloGames = siloCounts[id] || 0;
    const hasSiloSample = targetSilo !== 'overall' && siloGames >= minSiloGames;
    let skill = overallRatingMap[id];
    if (hasSiloSample && mode === 'hard') {
      skill = siloRatingMap[id] || overallRatingMap[id];
    } else if (hasSiloSample && mode === 'blend') {
      skill = getBlendedSiloSkill({
        overallSkill: overallRatingMap[id],
        siloSkill: siloRatingMap[id],
        siloGames,
        siloOptions,
      });
    }
    ratingMap[id] = cloneSkill(skill) || makeInitialRating();
  });
  return ratingMap;
}

function teamKey(team) {
  return team.map(player => String(player.id)).sort().join(',');
}

function pairKey(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
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

function clonePairMap(pairMap) {
  const cloned = new Map();
  pairMap.forEach((value, key) => {
    cloned.set(key, { total: value.total, count: value.count });
  });
  return cloned;
}

function addPairObservation(pairMap, key, value) {
  const current = pairMap.get(key) || { total: 0, count: 0 };
  current.total += value;
  current.count += 1;
  pairMap.set(key, current);
}

function updatePairMap(pairMap, redTeam, blueTeam, residual) {
  getSameTeamPairKeys(redTeam).forEach(key => addPairObservation(pairMap, key, residual));
  getSameTeamPairKeys(blueTeam).forEach(key => addPairObservation(pairMap, key, -residual));
}

function getPairTeamAdjustment(team, pairMap, pairOptions) {
  if (!pairOptions || pairOptions.mode === 'off') {
    return { adjustment: 0, usablePairs: 0 };
  }

  const minGames = Math.max(0, Number(pairOptions.minGames) || 0);
  const confidenceGames = Math.max(0.01, Number(pairOptions.confidenceGames) || 8);
  const maxBlend = Math.max(0, Math.min(1, Number(pairOptions.maxBlend) || 0));
  const perPairCap = Math.max(0, Number(pairOptions.perPairCap) || 0);
  const teamCap = Math.max(0, Number(pairOptions.teamCap) || Infinity);
  const minDelta = Math.max(0, Number(pairOptions.minDelta) || 0);

  let total = 0;
  let usablePairs = 0;
  getSameTeamPairKeys(team).forEach(key => {
    const stat = pairMap.get(key);
    if (!stat || stat.count < minGames) return;

    const raw = stat.total / stat.count;
    if (Math.abs(raw) < minDelta) return;

    const blend = Math.min(maxBlend, stat.count / (stat.count + confidenceGames));
    const pairAdjustment = Math.max(-perPairCap, Math.min(perPairCap, raw * blend));
    total += pairAdjustment;
    usablePairs += 1;
  });

  return {
    adjustment: Math.max(-teamCap, Math.min(teamCap, total)),
    usablePairs,
  };
}

function applyPairAdjustment(score, redPlayers, bluePlayers, pairMap, pairOptions, volleyballOptions) {
  if (!pairOptions || pairOptions.mode === 'off') return score;

  const red = getPairTeamAdjustment(redPlayers, pairMap, pairOptions);
  const blue = getPairTeamAdjustment(bluePlayers, pairMap, pairOptions);
  const strengthDiff = score.strengthDiff + red.adjustment - blue.adjustment;
  const probabilityScale = Math.max(0.01, Number(volleyballOptions?.probabilityScale) || 4.2);
  const probabilityTemperature = Math.max(0.01, Number(volleyballOptions?.probabilityTemperature) || 1.5);
  const redWinProbability = Math.max(
    0.05,
    Math.min(0.95, 1 / (1 + Math.exp(-((strengthDiff / probabilityScale) / probabilityTemperature))))
  );

  return {
    ...score,
    redPairAdjustment: red.adjustment,
    bluePairAdjustment: blue.adjustment,
    pairUsableLinks: red.usablePairs + blue.usablePairs,
    redWinProbability,
    blueWinProbability: 1 - redWinProbability,
    fairness: 1 - Math.abs(redWinProbability - 0.5) * 2,
    strengthDiff,
  };
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
  pairMap,
  pairOptions,
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

    const baseScore = scoreVolleyballCandidateSplit({
      redPlayers,
      bluePlayers,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
    });
    const score = applyPairAdjustment(baseScore, redPlayers, bluePlayers, pairMap, pairOptions, volleyballOptions);
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
    pairFeatureGames: 0,
    pairUsableLinks: 0,
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
    pairFeatureRate: stats.n ? stats.pairFeatureGames / stats.n : 0,
    avgPairUsableLinks: stats.pairFeatureGames ? stats.pairUsableLinks / stats.pairFeatureGames : 0,
  };
}

const sortedGames = getGamesSortedOldestFirst(games);
const scoredGames = sortedGames.filter(isScoredNonLeagueGame);
const priorSnapshots = [];
const priorGames = [];
const pairMap = new Map();

for (const game of sortedGames) {
  if (isScoredNonLeagueGame(game)) {
    const prior = replayFor(priorGames);
    const smallPriorGames = priorGames.filter(priorGame => isSiloGame(priorGame, 'small'));
    const bigPriorGames = priorGames.filter(priorGame => isSiloGame(priorGame, 'big'));
    const smallPrior = replayFor(smallPriorGames);
    const bigPrior = replayFor(bigPriorGames);
    priorSnapshots.push({
      game,
      ratingMap: prior.ratingMap,
      carryScoreMap: prior.carryMap || {},
      siloRatingMaps: {
        small: smallPrior.ratingMap,
        big: bigPrior.ratingMap,
      },
      siloCarryMaps: {
        small: smallPrior.carryMap || {},
        big: bigPrior.carryMap || {},
      },
      siloCounts: {
        small: getSiloCounts(priorGames, 'small'),
        big: getSiloCounts(priorGames, 'big'),
      },
      pairMap: clonePairMap(pairMap),
      modelGames: [...priorGames],
    });

    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: prior.ratingMap,
      carryScoreMap: prior.carryMap || {},
      volleyballOptions: makeOptions(0.34, 2.2, { mode: 'avgGap', scale: 0.35, threshold: 2 }),
    });
    const residual = (game.winner === 'red' ? 1 : 0) - score.redWinProbability;
    updatePairMap(pairMap, game.redTeam, game.blueTeam, residual);
  }
  priorGames.push(game);
}

function getSnapshotRatingContext(snapshot, siloOptions) {
  const mode = siloOptions?.mode || 'off';
  if (mode === 'off') {
    return {
      ratingMap: snapshot.ratingMap,
      carryScoreMap: snapshot.carryScoreMap,
      targetSilo: 'overall',
      siloFallbackPlayers: 0,
      siloRatedPlayers: 0,
    };
  }

  const targetSilo = getGameSilo(snapshot.game);
  if (!['small', 'big'].includes(targetSilo)) {
    return {
      ratingMap: snapshot.ratingMap,
      carryScoreMap: snapshot.carryScoreMap,
      targetSilo,
      siloFallbackPlayers: 0,
      siloRatedPlayers: 0,
    };
  }

  const minSiloGames = Math.max(0, Number(siloOptions?.minGames) || 0);
  const present = [...snapshot.game.redTeam, ...snapshot.game.blueTeam];
  const siloCounts = snapshot.siloCounts[targetSilo] || {};
  const siloRatedPlayers = present.filter(player => (siloCounts[String(player.id)] || 0) >= minSiloGames).length;

  return {
    ratingMap: createHybridRatingMap({
      present: players,
      targetSilo,
      overallRatingMap: snapshot.ratingMap,
      siloRatingMap: snapshot.siloRatingMaps[targetSilo] || {},
      siloCounts,
      siloOptions,
    }),
    carryScoreMap: snapshot.carryScoreMap,
    targetSilo,
    siloFallbackPlayers: present.length - siloRatedPlayers,
    siloRatedPlayers,
  };
}

function evaluate(worstPlayerWeight, sizeBonusPerExtraPlayer, weakLinkOptions, siloOptions, pairOptions) {
  const volleyballOptions = makeOptions(worstPlayerWeight, sizeBonusPerExtraPlayer, weakLinkOptions);
  const stats = createStats();

  for (const snapshot of priorSnapshots) {
    const { game, modelGames } = snapshot;
    const { ratingMap, carryScoreMap, siloFallbackPlayers, siloRatedPlayers } =
      getSnapshotRatingContext(snapshot, siloOptions);
    const marginModel = calibrateMarginModel({
      games: modelGames,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
    });

    if (!marginModel?.sampleSize) continue;

    const actualBaseScore = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap,
      carryScoreMap,
      volleyballOptions,
    });
    const actualScore = applyPairAdjustment(
      actualBaseScore,
      game.redTeam,
      game.blueTeam,
      snapshot.pairMap,
      pairOptions,
      volleyballOptions
    );
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
      pairMap: snapshot.pairMap,
      pairOptions,
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
    if (actualScore.pairUsableLinks > 0) {
      stats.pairFeatureGames += 1;
      stats.pairUsableLinks += actualScore.pairUsableLinks;
    }
    stats.siloFallbackPlayers = (stats.siloFallbackPlayers || 0) + siloFallbackPlayers;
    stats.siloRatedPlayers = (stats.siloRatedPlayers || 0) + siloRatedPlayers;
  }

  return {
    worstPlayerWeight,
    averageWeight: volleyballOptions.averageWeight,
    sizeBonusPerExtraPlayer,
    weakLinkMode: weakLinkOptions?.mode || 'off',
    weakLinkScale: Number(weakLinkOptions?.scale) || 0,
    weakLinkThreshold: Number(weakLinkOptions?.threshold) || 0,
    siloMode: siloOptions?.mode || 'off',
    siloMinGames: Number(siloOptions?.minGames) || 0,
    siloConfidenceGames: Number(siloOptions?.confidenceGames) || 0,
    siloMaxBlend: Number(siloOptions?.maxBlend) || 0,
    siloAdjustmentCap: Number(siloOptions?.adjustmentCap) || 0,
    siloMinDelta: Number(siloOptions?.minDelta) || 0,
    pairMode: pairOptions?.mode || 'off',
    pairMinGames: Number(pairOptions?.minGames) || 0,
    pairConfidenceGames: Number(pairOptions?.confidenceGames) || 0,
    pairMaxBlend: Number(pairOptions?.maxBlend) || 0,
    pairPerPairCap: Number(pairOptions?.perPairCap) || 0,
    pairTeamCap: Number(pairOptions?.teamCap) || 0,
    pairMinDelta: Number(pairOptions?.minDelta) || 0,
    ...summarize(stats),
    avgSiloRatedPlayers: stats.siloRatedPlayers ? stats.siloRatedPlayers / stats.n : 0,
    avgSiloFallbackPlayers: stats.siloFallbackPlayers ? stats.siloFallbackPlayers / stats.n : 0,
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
    'weak'.padStart(12),
    'wScale'.padStart(6),
    'wThr'.padStart(5),
    'silo'.padStart(6),
    'sMin'.padStart(5),
    'sConf'.padStart(5),
    'sMax'.padStart(5),
    'sCap'.padStart(5),
    'sDel'.padStart(5),
    'sUse'.padStart(5),
    'pair'.padStart(6),
    'pMin'.padStart(5),
    'pConf'.padStart(5),
    'pMax'.padStart(5),
    'pCap'.padStart(5),
    'pTeam'.padStart(6),
    'pDel'.padStart(5),
    'pUse'.padStart(5),
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
      String(row.weakLinkMode).slice(0, 12).padStart(12),
      fmt(row.weakLinkScale).padStart(6),
      fmt(row.weakLinkThreshold).padStart(5),
      String(row.siloMode).slice(0, 6).padStart(6),
      fmt(row.siloMinGames, 0).padStart(5),
      fmt(row.siloConfidenceGames, 0).padStart(5),
      fmt(row.siloMaxBlend).padStart(5),
      fmt(row.siloAdjustmentCap).padStart(5),
      fmt(row.siloMinDelta).padStart(5),
      fmt(row.avgSiloRatedPlayers, 1).padStart(5),
      String(row.pairMode).slice(0, 6).padStart(6),
      fmt(row.pairMinGames, 0).padStart(5),
      fmt(row.pairConfidenceGames, 0).padStart(5),
      fmt(row.pairMaxBlend).padStart(5),
      fmt(row.pairPerPairCap).padStart(5),
      fmt(row.pairTeamCap).padStart(6),
      fmt(row.pairMinDelta).padStart(5),
      fmt(row.avgPairUsableLinks, 1).padStart(5),
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

function parseStringListEnv(name, fallback, allowedValues = null) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value && (!allowedValues || allowedValues.includes(value)));

  return values.length > 0 ? values : fallback;
}

const worstWeights = parseListEnv('WORST_WEIGHTS', [0.28, 0.32, 0.34, 0.36]);
const sizeWeights = parseListEnv('SIZE_WEIGHTS', [1.40, 2.00, 2.20, 2.40]);
const weakLinkModes = parseStringListEnv('WEAK_LINK_MODES', ['off', 'avgGap'], ['off', 'avgGap', 'secondWorstGap']);
const weakLinkScales = parseListEnv('WEAK_LINK_SCALES', [0.35, 0.5]);
const weakLinkThresholds = parseListEnv('WEAK_LINK_THRESHOLDS', [2]);
const siloModes = parseStringListEnv('SILO_MODES', ['blend'], ['off', 'hard', 'blend']);
const siloMinGamesList = parseListEnv('SILO_MIN_GAMES', [12]);
const siloConfidenceGamesList = parseListEnv('SILO_CONFIDENCE_GAMES', [6]);
const siloMaxBlendList = parseListEnv('SILO_MAX_BLEND', [0.7]);
const siloAdjustmentCaps = parseListEnv('SILO_ADJUSTMENT_CAPS', [1.5]);
const siloMinDeltas = parseListEnv('SILO_MIN_DELTAS', [0.5]);
const pairModes = parseStringListEnv('PAIR_MODES', ['off'], ['off', 'blend']);
const pairMinGamesList = parseListEnv('PAIR_MIN_GAMES', [5]);
const pairConfidenceGamesList = parseListEnv('PAIR_CONFIDENCE_GAMES', [8]);
const pairMaxBlendList = parseListEnv('PAIR_MAX_BLEND', [0.5]);
const pairPerPairCaps = parseListEnv('PAIR_PER_PAIR_CAPS', [0.5]);
const pairTeamCaps = parseListEnv('PAIR_TEAM_CAPS', [1.0]);
const pairMinDeltas = parseListEnv('PAIR_MIN_DELTAS', [0.25]);
const baselineWorstPlayerWeight = 0.34;
const baselineSizeBonusPerExtraPlayer = 2.20;
const baselineWeakLinkMode = 'avgGap';
const baselineWeakLinkScale = 0.35;
const baselineWeakLinkThreshold = 2.0;
const baselineSiloMode = 'blend';
const baselineSiloMinGames = 12;
const baselineSiloConfidenceGames = 6;
const baselineSiloMaxBlend = 0.7;
const baselineSiloAdjustmentCap = 1.5;
const baselineSiloMinDelta = 0.5;
const baselinePairMode = 'off';
const baselinePairMinGames = 0;

console.log(`DB: ${sourceLabel}`);
console.log(`scoredNonLeague=${scoredGames.length} evaluated=${priorSnapshots.length}`);
console.log('Grid keeps top=.30, second=.24, depth=.10, and shifts weight between average and worst.');
console.log(`weakLinkModes=${weakLinkModes.join(',')} scales=${weakLinkScales.join(',')} thresholds=${weakLinkThresholds.join(',')}`);
console.log(`siloModes=${siloModes.join(',')} minGames=${siloMinGamesList.join(',')}`);
console.log(`siloBlend confidence=${siloConfidenceGamesList.join(',')} maxBlend=${siloMaxBlendList.join(',')} caps=${siloAdjustmentCaps.join(',')} minDelta=${siloMinDeltas.join(',')}`);
console.log(`pairModes=${pairModes.join(',')} minGames=${pairMinGamesList.join(',')}`);
console.log(`pairBlend confidence=${pairConfidenceGamesList.join(',')} maxBlend=${pairMaxBlendList.join(',')} perPairCaps=${pairPerPairCaps.join(',')} teamCaps=${pairTeamCaps.join(',')} minDelta=${pairMinDeltas.join(',')}`);
console.log('');

const rows = [];
let completed = 0;
const started = Date.now();
const total = worstWeights.length *
  sizeWeights.length *
  weakLinkModes.reduce((sum, mode) => {
    if (mode === 'off') return sum + 1;
    return sum + weakLinkScales.length * weakLinkThresholds.length;
  }, 0) *
  siloModes.reduce((sum, mode) => {
    if (mode === 'off') return sum + 1;
    if (mode === 'blend') {
      return sum +
        siloMinGamesList.length *
        siloConfidenceGamesList.length *
        siloMaxBlendList.length *
        siloAdjustmentCaps.length *
        siloMinDeltas.length;
    }
    return sum + siloMinGamesList.length;
  }, 0) *
  pairModes.reduce((sum, mode) => {
    if (mode === 'off') return sum + 1;
    return sum +
      pairMinGamesList.length *
      pairConfidenceGamesList.length *
      pairMaxBlendList.length *
      pairPerPairCaps.length *
      pairTeamCaps.length *
      pairMinDeltas.length;
  }, 0);

for (const worst of worstWeights) {
  for (const size of sizeWeights) {
    for (const mode of weakLinkModes) {
      const weakOptionsList = mode === 'off'
        ? [{ mode: 'off', scale: 0, threshold: 0 }]
        : weakLinkScales.flatMap(scale =>
          weakLinkThresholds.map(threshold => ({ mode, scale, threshold }))
        );

      for (const weakLinkOptions of weakOptionsList) {
        const siloOptionsList = siloModes.flatMap(siloMode => (
          siloMode === 'off'
            ? [{ mode: 'off', minGames: 0 }]
            : siloMode === 'hard'
              ? siloMinGamesList.map(minGames => ({ mode: siloMode, minGames }))
              : siloMinGamesList.flatMap(minGames =>
                siloConfidenceGamesList.flatMap(confidenceGames =>
                  siloMaxBlendList.flatMap(maxBlend =>
                    siloAdjustmentCaps.flatMap(adjustmentCap =>
                      siloMinDeltas.map(minDelta => ({
                        mode: siloMode,
                        minGames,
                        confidenceGames,
                        maxBlend,
                        adjustmentCap,
                        minDelta,
                      }))
                    )
                  )
                )
              )
        ));

        for (const siloOptions of siloOptionsList) {
          const pairOptionsList = pairModes.flatMap(pairMode => (
            pairMode === 'off'
              ? [{ mode: 'off', minGames: 0 }]
              : pairMinGamesList.flatMap(minGames =>
                pairConfidenceGamesList.flatMap(confidenceGames =>
                  pairMaxBlendList.flatMap(maxBlend =>
                    pairPerPairCaps.flatMap(perPairCap =>
                      pairTeamCaps.flatMap(teamCap =>
                        pairMinDeltas.map(minDelta => ({
                          mode: pairMode,
                          minGames,
                          confidenceGames,
                          maxBlend,
                          perPairCap,
                          teamCap,
                          minDelta,
                        }))
                      )
                    )
                  )
                )
              )
          ));

          for (const pairOptions of pairOptionsList) {
            const row = evaluate(worst, size, weakLinkOptions, siloOptions, pairOptions);
            row.score = composite(row);
            rows.push(row);
            completed += 1;
          }
        }
      }
    }
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`completed ${completed}/${total} in ${elapsed}s`);
}

const baseline = rows.filter(row =>
  Math.abs(row.worstPlayerWeight - baselineWorstPlayerWeight) < 1e-9 &&
  Math.abs(row.sizeBonusPerExtraPlayer - baselineSizeBonusPerExtraPlayer) < 1e-9 &&
  row.weakLinkMode === baselineWeakLinkMode &&
  Math.abs(row.weakLinkScale - baselineWeakLinkScale) < 1e-9 &&
  Math.abs(row.weakLinkThreshold - baselineWeakLinkThreshold) < 1e-9 &&
  row.siloMode === baselineSiloMode &&
  Math.abs(row.siloMinGames - baselineSiloMinGames) < 1e-9 &&
  Math.abs(row.siloConfidenceGames - baselineSiloConfidenceGames) < 1e-9 &&
  Math.abs(row.siloMaxBlend - baselineSiloMaxBlend) < 1e-9 &&
  Math.abs(row.siloAdjustmentCap - baselineSiloAdjustmentCap) < 1e-9 &&
  Math.abs(row.siloMinDelta - baselineSiloMinDelta) < 1e-9 &&
  row.pairMode === baselinePairMode &&
  Math.abs(row.pairMinGames - baselinePairMinGames) < 1e-9
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
