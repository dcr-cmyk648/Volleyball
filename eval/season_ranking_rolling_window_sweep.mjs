// Forward-only Season Ranking parameter sweep with a hard rolling history window.
//
// League handling is fixed at the current app Season Ranking settings. Each
// forward target is predicted from only the prior games inside ROLLING_WINDOW_DAYS.

import { loadDatabase } from './database.mjs';
import { computeFwdAccIQ } from './metrics.mjs';
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

const DAY_MS = 24 * 60 * 60 * 1000;
const rollingWindowDays = Number(process.env.ROLLING_WINDOW_DAYS) || 30.4375;
const printLimit = Math.max(1, Number(process.env.SEASON_RANKING_PRINT_LIMIT) || 15);
const defaultSeasonalTaperDays = Math.round(6 * 30.4375);
const fixedLeagueOptions = {
  leagueUpdateMultiplier: 1.5,
  leagueMuUpdateMultiplier: 1,
  leagueSigmaUpdateMultiplier: 0.8,
};
const baseRatingOptions = {
  seasonalTaperDays: defaultSeasonalTaperDays,
  ...fixedLeagueOptions,
};

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(',').map(value => Number(value.trim())).filter(Number.isFinite);
  return values.length ? values : fallback;
}

function parseGameDate(game) {
  const value = game?.date || game?.createdAt || game?.id;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function getWindowedPriorGames(priorGames, targetGame) {
  const targetTime = parseGameDate(targetGame);
  if (!Number.isFinite(targetTime)) return priorGames;
  const cutoff = targetTime - rollingWindowDays * DAY_MS;
  return priorGames.filter(game => {
    const time = parseGameDate(game);
    return Number.isFinite(time) && time >= cutoff && time <= targetTime;
  });
}

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getTargetSilo(game) {
  const largest = Math.max(game?.redTeam?.length || 0, game?.blueTeam?.length || 0);
  if (largest >= 5) return 'big';
  if (largest >= 3) return 'small';
  return 'overall';
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
    expectedCloseGames: 0,
    expectedCloseActualBlowouts: 0,
    priorGameCountSum: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    averageConfidence: stats.n ? stats.confidenceSum / stats.n : null,
    scored: stats.scored,
    marginMAE: stats.scored ? stats.marginErrSum / stats.scored : null,
    actualBlowoutRate: stats.scored ? stats.actualBlowouts / stats.scored : null,
    averagePredictedBlowoutRisk: stats.scored ? stats.predictedBlowoutRiskSum / stats.scored : null,
    blowoutBrier: stats.scored ? stats.blowoutBrierSum / stats.scored : null,
    expectedCloseBlowoutRate: stats.expectedCloseGames
      ? stats.expectedCloseActualBlowouts / stats.expectedCloseGames
      : null,
    expectedCloseGames: stats.expectedCloseGames,
    averagePriorGames: stats.n ? stats.priorGameCountSum / stats.n : null,
  };
}

function replayFor({ ratingOptions, volleyballOptions, updateContextMode }, modelGames) {
  return replayRatings({
    players,
    games: modelGames,
    seasonal: true,
    volleyballAdjusted: true,
    volleyballUpdateUsesBalancerContext: updateContextMode !== 'off',
    volleyballUpdateContextMode: updateContextMode === 'off' ? 'pair' : updateContextMode,
    includeLeagueGames: true,
    options: ratingOptions,
    volleyballOptions,
  });
}

function buildScoringContext({ prior, modelGames, game, ratingOptions, volleyballOptions, scoringContextMode }) {
  const usesSilo = scoringContextMode === 'silo' || scoringContextMode === 'full';
  const usesPair = scoringContextMode === 'pair' || scoringContextMode === 'full';
  let ratingMap = prior.ratingMap;

  if (usesSilo) {
    const adjustedMap = buildEnvironmentAdjustedRatingMap({
      players,
      games: modelGames,
      baseRatingMap: prior.ratingMap,
      ratingOptions,
      volleyballOptions,
      teamCount: 2,
      playerCount: game.redTeam.length + game.blueTeam.length,
      targetSilo: getTargetSilo(game),
    });
    ratingMap = {
      ...prior.ratingMap,
      ...adjustedMap,
    };
  }

  const pairAdjustmentMap = usesPair
    ? buildPairAdjustmentMap({
      players,
      games: modelGames,
      ratingOptions,
      volleyballOptions,
      seasonal: true,
    })
    : null;

  return { ratingMap, pairAdjustmentMap };
}

function computeForwardQuality({ ratingOptions, volleyballOptions, updateContextMode, scoringContextMode }) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const modelGames = getWindowedPriorGames(priorGames, game);
      const prior = replayFor({ ratingOptions, volleyballOptions, updateContextMode }, modelGames);
      const { ratingMap, pairAdjustmentMap } = buildScoringContext({
        prior,
        modelGames,
        game,
        ratingOptions,
        volleyballOptions,
        scoringContextMode,
      });
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap,
        carryScoreMap: prior.carryMap || {},
        options: ratingOptions,
        volleyballOptions,
        pairAdjustmentMap,
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
      }

      const marginModel = calibrateMarginModel({
        games: modelGames,
        ratingMap,
        carryScoreMap: prior.carryMap || {},
        options: ratingOptions,
        volleyballOptions,
      });
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
        if (expectedGap <= 5) {
          stats.expectedCloseGames += 1;
          stats.expectedCloseActualBlowouts += actualBlowout;
        }
      }
    }
    priorGames.push(game);
  });

  return summarize(stats);
}

function evaluate(candidate) {
  const ratingOptions = {
    ...baseRatingOptions,
    ...(candidate.ratingOptions || {}),
  };
  const volleyballOptions = {
    ...(candidate.volleyballOptions || {}),
  };
  const updateContextMode = candidate.updateContextMode || 'pair';
  const scoringContextMode = candidate.scoringContextMode || 'off';
  const forward = computeForwardQuality({
    ratingOptions,
    volleyballOptions,
    updateContextMode,
    scoringContextMode,
  });
  return {
    ...candidate,
    ratingOptions,
    volleyballOptions,
    updateContextMode,
    scoringContextMode,
    forward,
    fwdAccIQ: computeFwdAccIQ({
      ...forward,
      tiers: {},
      algorithmTieredGames: 0,
      algorithmBalancedGames: 0,
    }),
  };
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(1)}%`;
}

function keyFor(candidate) {
  return JSON.stringify({
    ratingOptions: Object.entries({ ...(candidate.ratingOptions || {}) }).sort(([a], [b]) => a.localeCompare(b)),
    volleyballOptions: Object.entries({ ...(candidate.volleyballOptions || {}) }).sort(([a], [b]) => a.localeCompare(b)),
    updateContextMode: candidate.updateContextMode || 'pair',
    scoringContextMode: candidate.scoringContextMode || 'off',
  });
}

const candidates = [];
const candidateKeys = new Set();

function addCandidate(label, group, config = {}) {
  const candidate = { label, group, ...config };
  const key = keyFor(candidate);
  if (candidateKeys.has(key)) return;
  candidateKeys.add(key);
  candidates.push(candidate);
}

function addRatingOneAtATime(group, name, values) {
  values.forEach(value => addCandidate(`${name}=${String(value)}`, group, {
    ratingOptions: { [name]: value },
  }));
}

addCandidate('one-month hard window', 'baseline');

['off', 'pair', 'silo', 'full'].forEach(updateContextMode => {
  addCandidate(`update context ${updateContextMode}`, 'update-context', { updateContextMode });
});
['off', 'pair', 'silo', 'full'].forEach(scoringContextMode => {
  addCandidate(`scoring context ${scoringContextMode}`, 'scoring-context', { scoringContextMode });
});

addRatingOneAtATime('rating-update', 'useScoreMargin', [false, true]);
addRatingOneAtATime('rating-update', 'maxMarginBonus', parseListEnv('SWEEP_MAX_MARGIN_BONUS', [0, 0.05, 0.1, 0.15, 0.2]));
addRatingOneAtATime('rating-update', 'marginLogisticMidpoint', parseListEnv('SWEEP_MARGIN_MIDPOINTS', [8, 10, 12, 14, 16]));
addRatingOneAtATime('rating-update', 'marginLogisticSteepness', parseListEnv('SWEEP_MARGIN_STEEPNESS', [0.5, 0.7, 0.9, 1.1, 1.3]));
addRatingOneAtATime('rating-update', 'burnInGames', parseListEnv('SWEEP_BURN_GAMES', [0, 2, 3, 5, 8]));
addRatingOneAtATime('rating-update', 'calibrationGames', parseListEnv('SWEEP_CALIBRATION_GAMES', [0, 5, 10, 15, 20]));
addRatingOneAtATime('rating-update', 'openSkillBetaMultiplier', parseListEnv('SWEEP_BETA_MULTS', [0.6, 0.75, 1, 1.25, 1.5, 2]));
addRatingOneAtATime('rating-update', 'openSkillTau', [null, 0, 0.02, 0.05, 0.1]);
addRatingOneAtATime('rating-update', 'openSkillPreventSigmaIncrease', [false, true]);
addRatingOneAtATime('rating-update', 'streakProtectionEnabled', [false, true]);
addRatingOneAtATime('rating-update', 'sessionProtectionEnabled', [false, true]);

parseListEnv('SWEEP_CARRY_SCALES', [0, 4, 8, 12, 16, 20, 24, 32]).forEach(carryScale => {
  parseListEnv('SWEEP_CARRY_CONFIDENCE_GAMES', [2, 4, 6, 8, 12, 16]).forEach(carryConfidenceGames => {
    addCandidate(`carry ${carryScale}/g${carryConfidenceGames}`, 'carry', {
      volleyballOptions: { carryScale, carryConfidenceGames },
    });
  });
});

parseListEnv('SWEEP_PROBABILITY_SCALES', [3.0, 3.5, 4.0, 4.2, 4.5, 5.0, 5.5, 6.0]).forEach(probabilityScale => {
  parseListEnv('SWEEP_PROBABILITY_TEMPERATURES', [1, 1.25, 1.5, 1.75, 2.0]).forEach(probabilityTemperature => {
    addCandidate(`prob ${probabilityScale}/t${probabilityTemperature}`, 'probability', {
      volleyballOptions: { probabilityScale, probabilityTemperature },
    });
  });
});

['off', 'blend'].forEach(pairAdjustmentMode => {
  addCandidate(`pair mode ${pairAdjustmentMode}`, 'pair', {
    scoringContextMode: 'pair',
    volleyballOptions: { pairAdjustmentMode },
  });
});
parseListEnv('SWEEP_PAIR_MIN_GAMES', [2, 4, 6, 8, 10, 12]).forEach(pairAdjustmentMinGames => {
  parseListEnv('SWEEP_PAIR_MAX_BLENDS', [0.25, 0.5, 0.75, 1]).forEach(pairAdjustmentMaxBlend => {
    addCandidate(`pair min${pairAdjustmentMinGames} blend${pairAdjustmentMaxBlend}`, 'pair', {
      scoringContextMode: 'pair',
      volleyballOptions: {
        pairAdjustmentMode: 'blend',
        pairAdjustmentMinGames,
        pairAdjustmentMaxBlend,
      },
    });
  });
});

['off', 'blend'].forEach(environmentSiloMode => {
  addCandidate(`silo mode ${environmentSiloMode}`, 'silo', {
    scoringContextMode: 'silo',
    volleyballOptions: { environmentSiloMode },
  });
});
parseListEnv('SWEEP_SILO_MIN_GAMES', [4, 8, 12, 16, 20]).forEach(environmentSiloMinGames => {
  parseListEnv('SWEEP_SILO_MAX_BLENDS', [0.25, 0.5, 0.7, 1]).forEach(environmentSiloMaxBlend => {
    addCandidate(`silo min${environmentSiloMinGames} blend${environmentSiloMaxBlend}`, 'silo', {
      scoringContextMode: 'silo',
      volleyballOptions: {
        environmentSiloMode: 'blend',
        environmentSiloMinGames,
        environmentSiloMaxBlend,
      },
    });
  });
});

function compactConfig(row) {
  const ratingEntries = Object.entries(row.ratingOptions)
    .filter(([key, value]) => baseRatingOptions[key] !== value)
    .filter(([key]) => !Object.prototype.hasOwnProperty.call(fixedLeagueOptions, key))
    .sort(([a], [b]) => a.localeCompare(b));
  const volleyballEntries = Object.entries(row.volleyballOptions)
    .sort(([a], [b]) => a.localeCompare(b));
  const config = {};
  if (ratingEntries.length) config.rating = Object.fromEntries(ratingEntries);
  if (volleyballEntries.length) config.volleyball = Object.fromEntries(volleyballEntries);
  if (row.updateContextMode !== 'pair') config.updateContextMode = row.updateContextMode;
  if (row.scoringContextMode !== 'off') config.scoringContextMode = row.scoringContextMode;
  return config;
}

function compareForwardAccuracy(a, b) {
  const accDelta = Number(b.forward.accuracy) - Number(a.forward.accuracy);
  if (Math.abs(accDelta) > 1e-12) return accDelta;
  const brierDelta = Number(a.forward.brier) - Number(b.forward.brier);
  if (Math.abs(brierDelta) > 1e-12) return brierDelta;
  return Number(b.fwdAccIQ) - Number(a.fwdAccIQ);
}

function compareBlowoutRisk(a, b) {
  const brierDelta = Number(a.forward.blowoutBrier) - Number(b.forward.blowoutBrier);
  if (Math.abs(brierDelta) > 1e-12) return brierDelta;
  return Number(a.forward.marginMAE) - Number(b.forward.marginMAE);
}

function printRows(title, sortedRows, baseline, limit = printLimit) {
  const labelWidth = 42;
  console.log('');
  console.log(title);
  console.log([
    'group'.padEnd(14),
    'label'.padEnd(labelWidth),
    'acc'.padStart(7),
    'dAcc'.padStart(7),
    'brier'.padStart(8),
    'conf'.padStart(7),
    'MAE'.padStart(6),
    'predBO'.padStart(8),
    'boBrier'.padStart(8),
    'closeBO'.padStart(8),
    'FwdIQ'.padStart(7),
    'dFwd'.padStart(7),
    'config',
  ].join(' '));
  console.log('-'.repeat(labelWidth + 126));
  sortedRows.slice(0, limit).forEach(row => {
    console.log([
      row.group.padEnd(14),
      row.label.slice(0, labelWidth).padEnd(labelWidth),
      pct(row.forward.accuracy).padStart(7),
      `${((Number(row.forward.accuracy) - Number(baseline.forward.accuracy)) * 100).toFixed(1)}%`.padStart(7),
      fmt(row.forward.brier).padStart(8),
      pct(row.forward.averageConfidence).padStart(7),
      fmt(row.forward.marginMAE, 2).padStart(6),
      pct(row.forward.averagePredictedBlowoutRisk).padStart(8),
      fmt(row.forward.blowoutBrier).padStart(8),
      `${pct(row.forward.expectedCloseBlowoutRate)}(${row.forward.expectedCloseGames})`.padStart(8),
      fmt(row.fwdAccIQ, 2).padStart(7),
      fmt(Number(row.fwdAccIQ) - Number(baseline.fwdAccIQ), 2).padStart(7),
      JSON.stringify(compactConfig(row)),
    ].join(' '));
  });
}

const started = Date.now();
console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} qualityTargets=${games.filter(isQualityGame).length}`);
console.log(`fixedLeagueOptions=${JSON.stringify(fixedLeagueOptions)}`);
console.log(`rollingWindowDays=${rollingWindowDays}`);
console.log(`uniqueCandidates=${candidates.length}`);

const rows = candidates.map((candidate, index) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`evaluating ${index + 1}/${candidates.length}: ${candidate.label} (${elapsed}s)`);
  return evaluate(candidate);
});

const baseline = rows.find(row => row.label === 'one-month hard window');
const groups = [...new Set(rows.map(row => row.group))];

printRows('Baseline', [baseline], baseline, 1);
printRows('Best by raw forward accuracy', [...rows].sort(compareForwardAccuracy), baseline);
printRows('Best by FwdAccIQ', [...rows].sort((a, b) => Number(b.fwdAccIQ) - Number(a.fwdAccIQ)), baseline);
printRows('Best by blowout-risk Brier', [...rows].sort(compareBlowoutRisk), baseline);
groups.forEach(group => {
  const groupRows = rows.filter(row => row.group === group);
  printRows(`Best within ${group}`, groupRows.sort(compareForwardAccuracy), baseline, Math.min(8, printLimit));
});
