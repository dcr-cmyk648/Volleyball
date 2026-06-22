// Compare current Season Ranking history against a hard rolling window.
//
// Blowout risk is measured on forward scored non-league targets:
// - actual blowout: absolute score margin > 8
// - predicted blowout risk: derived from prior expected margin
// - missed blowout risk: actual blowout when prior expected margin <= 5

import { loadDatabase } from './database.mjs';
import {
  calibrateMarginModel,
  getGamesSortedOldestFirst,
  predictExpectedMargin,
  replayRatings,
  scoreVolleyballCandidateSplit,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const DAY_MS = 24 * 60 * 60 * 1000;
const rollingWindowDays = Number(process.env.ROLLING_WINDOW_DAYS) || 30.4375;
const seasonalTaperDays = Math.round(6 * 30.4375);
const fixedLeagueOptions = {
  seasonalTaperDays,
  leagueUpdateMultiplier: 1.5,
  leagueMuUpdateMultiplier: 1,
  leagueSigmaUpdateMultiplier: 0.8,
};

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

function parseGameDate(game) {
  const value = game?.date || game?.createdAt || game?.id;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getWindowedPriorGames(priorGames, targetGame, windowDays) {
  const targetTime = parseGameDate(targetGame);
  if (!Number.isFinite(targetTime)) return priorGames;
  const cutoff = targetTime - windowDays * DAY_MS;
  return priorGames.filter(game => {
    const time = parseGameDate(game);
    return Number.isFinite(time) && time >= cutoff && time <= targetTime;
  });
}

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    confidenceSum: 0,
    scored: 0,
    marginErrSum: 0,
    actualBlowouts: 0,
    predictedBlowoutRiskSum: 0,
    blowoutBrierSum: 0,
    predictedGapSum: 0,
    predictedBlowoutGames: 0,
    expectedCloseGames: 0,
    expectedCloseActualBlowouts: 0,
    expectedBalancedGames: 0,
    expectedBalancedActualBlowouts: 0,
    expectedMismatchGames: 0,
    expectedMismatchActualBlowouts: 0,
    priorGameCountSum: 0,
    priorGameCountMin: Infinity,
    priorGameCountMax: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    confidence: stats.n ? stats.confidenceSum / stats.n : null,
    scored: stats.scored,
    marginMAE: stats.scored ? stats.marginErrSum / stats.scored : null,
    actualBlowoutRate: stats.scored ? stats.actualBlowouts / stats.scored : null,
    averagePredictedBlowoutRisk: stats.scored ? stats.predictedBlowoutRiskSum / stats.scored : null,
    blowoutBrier: stats.scored ? stats.blowoutBrierSum / stats.scored : null,
    averagePredictedGap: stats.scored ? stats.predictedGapSum / stats.scored : null,
    predictedBlowoutRate: stats.scored ? stats.predictedBlowoutGames / stats.scored : null,
    expectedCloseBlowoutRate: stats.expectedCloseGames
      ? stats.expectedCloseActualBlowouts / stats.expectedCloseGames
      : null,
    expectedBalancedBlowoutRate: stats.expectedBalancedGames
      ? stats.expectedBalancedActualBlowouts / stats.expectedBalancedGames
      : null,
    expectedMismatchBlowoutRate: stats.expectedMismatchGames
      ? stats.expectedMismatchActualBlowouts / stats.expectedMismatchGames
      : null,
    expectedCloseGames: stats.expectedCloseGames,
    expectedBalancedGames: stats.expectedBalancedGames,
    expectedMismatchGames: stats.expectedMismatchGames,
    averagePriorGames: stats.n ? stats.priorGameCountSum / stats.n : null,
    minPriorGames: stats.priorGameCountMin === Infinity ? 0 : stats.priorGameCountMin,
    maxPriorGames: stats.priorGameCountMax,
  };
}

function replayFor(priorGames, options) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: true,
    volleyballUpdateUsesBalancerContext: true,
    volleyballUpdateContextMode: 'pair',
    includeLeagueGames: true,
    options,
  });
}

function computeForwardQuality({ label, getModelGames, ratingOptions }) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const modelGames = getModelGames(priorGames, game);
      const prior = replayFor(modelGames, ratingOptions);
      const marginModel = calibrateMarginModel({
        games: modelGames,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options: ratingOptions,
      });
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options: ratingOptions,
      });

      const redProbability = Number(score.redWinProbability);
      if (Number.isFinite(redProbability)) {
        const predictedWinner = redProbability >= 0.5 ? 'red' : 'blue';
        const yRed = game.winner === 'red' ? 1 : 0;
        stats.n += 1;
        if (predictedWinner === game.winner) stats.correct += 1;
        stats.brierSum += (redProbability - yRed) ** 2;
        stats.confidenceSum += Math.max(redProbability, 1 - redProbability);
        stats.priorGameCountSum += modelGames.length;
        stats.priorGameCountMin = Math.min(stats.priorGameCountMin, modelGames.length);
        stats.priorGameCountMax = Math.max(stats.priorGameCountMax, modelGames.length);
      }

      if (isScored(game) && (marginModel?.sampleSize || 0) > 0) {
        const actualGap = Math.abs(game.scoreRed - game.scoreBlue);
        const expectedGap = predictExpectedMargin(score.strengthDiff, marginModel);
        const actualBlowout = actualGap > 8 ? 1 : 0;
        const blowoutRisk = clamp((expectedGap - 4) / 8, 0.02, 0.98);

        stats.scored += 1;
        stats.marginErrSum += Math.abs(expectedGap - actualGap);
        stats.actualBlowouts += actualBlowout;
        stats.predictedBlowoutRiskSum += blowoutRisk;
        stats.blowoutBrierSum += (actualBlowout - blowoutRisk) ** 2;
        stats.predictedGapSum += expectedGap;
        if (expectedGap > 8) stats.predictedBlowoutGames += 1;

        if (expectedGap <= 5) {
          stats.expectedCloseGames += 1;
          stats.expectedCloseActualBlowouts += actualBlowout;
        }
        if (expectedGap <= 8) {
          stats.expectedBalancedGames += 1;
          stats.expectedBalancedActualBlowouts += actualBlowout;
        }
        if (expectedGap > 8) {
          stats.expectedMismatchGames += 1;
          stats.expectedMismatchActualBlowouts += actualBlowout;
        }
      }
    }

    priorGames.push(game);
  });

  return {
    label,
    summary: summarize(stats),
  };
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(1)}%`;
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function diffPct(value, baseline) {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(baseline))) return 'n/a';
  return `${((Number(value) - Number(baseline)) * 100).toFixed(1)}pp`;
}

function printComparison(rows) {
  const baseline = rows[0].summary;
  console.log([
    'variant'.padEnd(28),
    'priorG'.padStart(7),
    'acc'.padStart(7),
    'dAcc'.padStart(8),
    'brier'.padStart(8),
    'MAE'.padStart(7),
    'actualBO'.padStart(9),
    'predRisk'.padStart(9),
    'boBrier'.padStart(8),
    'closeBO'.padStart(9),
    '<=8BO'.padStart(8),
    '>8BO'.padStart(8),
  ].join(' '));
  console.log('-'.repeat(132));
  rows.forEach(row => {
    const s = row.summary;
    console.log([
      row.label.padEnd(28),
      fmt(s.averagePriorGames, 1).padStart(7),
      pct(s.accuracy).padStart(7),
      diffPct(s.accuracy, baseline.accuracy).padStart(8),
      fmt(s.brier).padStart(8),
      fmt(s.marginMAE, 2).padStart(7),
      pct(s.actualBlowoutRate).padStart(9),
      pct(s.averagePredictedBlowoutRisk).padStart(9),
      fmt(s.blowoutBrier).padStart(8),
      `${pct(s.expectedCloseBlowoutRate)} (${s.expectedCloseGames})`.padStart(9),
      `${pct(s.expectedBalancedBlowoutRate)} (${s.expectedBalancedGames})`.padStart(8),
      `${pct(s.expectedMismatchBlowoutRate)} (${s.expectedMismatchGames})`.padStart(8),
    ].join(' '));
  });
}

const variants = [
  computeForwardQuality({
    label: 'current season ranking',
    getModelGames: priorGames => priorGames,
    ratingOptions: fixedLeagueOptions,
  }),
  computeForwardQuality({
    label: `${rollingWindowDays.toFixed(1)}d hard window`,
    getModelGames: (priorGames, game) => getWindowedPriorGames(priorGames, game, rollingWindowDays),
    ratingOptions: fixedLeagueOptions,
  }),
  computeForwardQuality({
    label: `${rollingWindowDays.toFixed(1)}d window+taper`,
    getModelGames: (priorGames, game) => getWindowedPriorGames(priorGames, game, rollingWindowDays),
    ratingOptions: {
      ...fixedLeagueOptions,
      seasonalTaperDays: Math.round(rollingWindowDays),
    },
  }),
];

console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} qualityTargets=${games.filter(isQualityGame).length}`);
console.log(`fixedLeagueOptions=${JSON.stringify(fixedLeagueOptions)}`);
console.log(`rollingWindowDays=${rollingWindowDays}`);
console.log('');
printComparison(variants);
