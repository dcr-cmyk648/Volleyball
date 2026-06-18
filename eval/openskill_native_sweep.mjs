// Compare the current volleyball evidence wrapper against OpenSkill-native
// update tunables: score mode, beta, tau, and sigma-increase limiting.

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
} from '../ratings.js';
import { computeSinglePassAccIQ } from './metrics.mjs';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const MIN_MARGIN_SAMPLES = Number(process.env.OPEN_SKILL_NATIVE_MIN_MARGIN_SAMPLES || 12);
const MODE = process.env.OPEN_SKILL_NATIVE_MODE || 'back';
const SWEEP = process.env.OPEN_SKILL_NATIVE_SWEEP || 'focused';
const VARIANT_FILTER = (process.env.OPEN_SKILL_NATIVE_VARIANTS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : fallback;
}

function getFocusedVariants() {
  return [
  {
    label: 'current-wrapper',
    ratingOptions: {},
  },
  {
    label: 'raw-score+wrapper',
    ratingOptions: { openSkillScoreMode: 'rawScore' },
  },
  {
    label: 'margin-score+wrapper',
    ratingOptions: { openSkillScoreMode: 'marginScore' },
  },
  ...[1.25, 1.5, 2].map(multiplier => ({
    label: `beta${multiplier}+wrapper`,
    ratingOptions: { openSkillBetaMultiplier: multiplier },
  })),
  {
    label: 'tau0.1limit+wrapper',
    ratingOptions: { openSkillTau: 0.10, openSkillPreventSigmaIncrease: true },
  },
  {
    label: 'binary-native-only',
    ratingOptions: { openSkillEvidenceMultiplierMode: 'none' },
  },
  {
    label: 'raw-score-native-only',
    ratingOptions: { openSkillScoreMode: 'rawScore', openSkillEvidenceMultiplierMode: 'none' },
  },
  {
    label: 'margin-score-native-only',
    ratingOptions: { openSkillScoreMode: 'marginScore', openSkillEvidenceMultiplierMode: 'none' },
  },
  {
    label: 'beta1.5-native-only',
    ratingOptions: { openSkillBetaMultiplier: 1.5, openSkillEvidenceMultiplierMode: 'none' },
  },
  {
    label: 'base-evidence-only',
    ratingOptions: { openSkillEvidenceMultiplierMode: 'baseOnly' },
  },
  {
    label: 'seasonal-only',
    ratingOptions: { openSkillEvidenceMultiplierMode: 'seasonalOnly' },
  },
  ];
}

function getBroadVariants() {
  const betaMultipliers = parseListEnv('OPEN_SKILL_NATIVE_BETAS', [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
  const taus = parseListEnv('OPEN_SKILL_NATIVE_TAUS', [0, 0.025, 0.05, 0.1, 0.2, 0.35]);
  const evidenceModes = (process.env.OPEN_SKILL_NATIVE_EVIDENCE_MODES || 'volleyball,baseOnly,seasonalOnly,none')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const rows = [];

  rows.push({ label: 'current-wrapper', ratingOptions: {} });

  for (const evidenceMode of evidenceModes) {
    for (const betaMultiplier of betaMultipliers) {
      rows.push({
        label: `ev-${evidenceMode}-beta${betaMultiplier}`,
        ratingOptions: {
          openSkillEvidenceMultiplierMode: evidenceMode,
          openSkillBetaMultiplier: betaMultiplier,
        },
      });
    }

    for (const tau of taus) {
      if (tau <= 0) continue;
      rows.push({
        label: `ev-${evidenceMode}-tau${tau}limit`,
        ratingOptions: {
          openSkillEvidenceMultiplierMode: evidenceMode,
          openSkillTau: tau,
          openSkillPreventSigmaIncrease: true,
        },
      });
      rows.push({
        label: `ev-${evidenceMode}-tau${tau}`,
        ratingOptions: {
          openSkillEvidenceMultiplierMode: evidenceMode,
          openSkillTau: tau,
          openSkillPreventSigmaIncrease: false,
        },
      });
    }
  }

  return rows;
}

function getWrapperBetaVariants() {
  const finalMins = parseListEnv('OPEN_SKILL_NATIVE_FINAL_MINS', [0.65, 0.75, 0.85]);
  const finalMaxes = parseListEnv('OPEN_SKILL_NATIVE_FINAL_MAXES', [1.20, 1.35, 1.50]);
  const marginBonuses = parseListEnv('OPEN_SKILL_NATIVE_MARGIN_BONUSES', [0.05, 0.10, 0.15]);
  const surpriseClamps = [
    { label: 's025-175', minUpdateMultiplier: 0.25, maxUpdateMultiplier: 1.75 },
    { label: 's035-200', minUpdateMultiplier: 0.35, maxUpdateMultiplier: 2.00 },
    { label: 's050-150', minUpdateMultiplier: 0.50, maxUpdateMultiplier: 1.50 },
  ];
  const rows = [
    { label: 'current-wrapper', ratingOptions: {} },
    { label: 'beta0.5-current', ratingOptions: { openSkillBetaMultiplier: 0.5 } },
  ];

  for (const finalMin of finalMins) {
    for (const finalMax of finalMaxes) {
      for (const marginBonus of marginBonuses) {
        for (const surpriseClamp of surpriseClamps) {
          rows.push({
            label: `b05-f${finalMin}-${finalMax}-m${marginBonus}-${surpriseClamp.label}`,
            ratingOptions: {
              openSkillBetaMultiplier: 0.5,
              maxMarginBonus: marginBonus,
            },
            volleyballOptions: {
              finalUpdateMultiplierMin: finalMin,
              finalUpdateMultiplierMax: finalMax,
              minUpdateMultiplier: surpriseClamp.minUpdateMultiplier,
              maxUpdateMultiplier: surpriseClamp.maxUpdateMultiplier,
            },
          });
        }
      }
    }
  }

  return rows;
}

function getStreakVariants() {
  const modes = (process.env.STREAK_MODES || 'net,deltaShuffle,playerReplay')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const windows = parseListEnv('STREAK_WINDOWS', [6]);
  const minGamesList = parseListEnv('STREAK_MIN_GAMES', [10, 14]);
  const thresholds = parseListEnv('STREAK_THRESHOLDS', [2, 3, 4]);
  const minMultipliers = parseListEnv('STREAK_MIN_MULTIPLIERS', [0.35, 0.5, 0.65]);
  const strengths = parseListEnv('STREAK_STRENGTHS', [0.5, 1]);
  const shuffleIterations = parseListEnv('STREAK_SHUFFLE_ITERATIONS', [30]);
  const applyTargets = (process.env.STREAK_APPLY_TO || 'skill')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const rows = [
    { label: 'current-wrapper', ratingOptions: {} },
  ];

  for (const mode of modes) {
    for (const window of windows) {
      for (const minGames of minGamesList) {
        for (const threshold of thresholds) {
          for (const minMultiplier of minMultipliers) {
            for (const strength of strengths) {
              for (const iterations of shuffleIterations) {
                for (const applyTo of applyTargets) {
                  rows.push({
                    label: `streak-${mode}-${applyTo}-w${window}-g${minGames}-t${threshold}-m${minMultiplier}-s${strength}-i${iterations}`,
                    ratingOptions: {
                      streakProtectionEnabled: true,
                      streakProtectionMode: mode,
                      streakProtectionWindow: window,
                      streakProtectionMinGames: minGames,
                      streakProtectionThresholdRaw: threshold,
                      streakProtectionMinMultiplier: minMultiplier,
                      streakProtectionStrength: strength,
                      streakProtectionShuffleIterations: iterations,
                      streakProtectionApplyTo: applyTo,
                    },
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  return rows;
}

function getSessionVariants() {
  const minPriorGamesList = parseListEnv('SESSION_MIN_PRIOR_GAMES', [10, 14, 18]);
  const minSessionGamesList = parseListEnv('SESSION_MIN_SESSION_GAMES', [3, 4, 5]);
  const thresholds = parseListEnv('SESSION_THRESHOLDS', [1.5, 2, 2.5, 3]);
  const minMultipliers = parseListEnv('SESSION_MIN_MULTIPLIERS', [0.25, 0.35, 0.5]);
  const strengths = parseListEnv('SESSION_STRENGTHS', [0.5, 1]);
  const applyTargets = (process.env.SESSION_APPLY_TO || 'muOnly')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const rows = [
    { label: 'current-wrapper', ratingOptions: {} },
  ];

  for (const minPriorGames of minPriorGamesList) {
    for (const minSessionGames of minSessionGamesList) {
      for (const threshold of thresholds) {
        for (const minMultiplier of minMultipliers) {
          for (const strength of strengths) {
            for (const applyTo of applyTargets) {
              rows.push({
                label: `session-${applyTo}-p${minPriorGames}-g${minSessionGames}-t${threshold}-m${minMultiplier}-s${strength}`,
                ratingOptions: {
                  sessionProtectionEnabled: true,
                  sessionProtectionMinPriorGames: minPriorGames,
                  sessionProtectionMinSessionGames: minSessionGames,
                  sessionProtectionThresholdRaw: threshold,
                  sessionProtectionMinMultiplier: minMultiplier,
                  sessionProtectionStrength: strength,
                  sessionProtectionApplyTo: applyTo,
                },
              });
            }
          }
        }
      }
    }
  }

  return rows;
}

const variants = SWEEP === 'broad'
  ? getBroadVariants()
  : SWEEP === 'wrapperBeta'
    ? getWrapperBetaVariants()
    : SWEEP === 'streak'
      ? getStreakVariants()
      : SWEEP === 'session'
        ? getSessionVariants()
        : getFocusedVariants();

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

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    scored: 0,
    marginErrSum: 0,
    blowoutBrierSum: 0,
    actualBlowouts: 0,
    wideOutliers: 0,
    severeWideOutliers: 0,
  };
}

function summarize(stats) {
  const summary = {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    marginMAE: stats.scored ? stats.marginErrSum / stats.scored : null,
    blowoutBrier: stats.scored ? stats.blowoutBrierSum / stats.scored : null,
    blowoutRate: stats.scored ? stats.actualBlowouts / stats.scored : null,
    wideOutlierRate: stats.scored ? stats.wideOutliers / stats.scored : null,
    severeWideOutlierRate: stats.scored ? stats.severeWideOutliers / stats.scored : null,
  };
  return {
    ...summary,
    accIQ: computeSinglePassAccIQ(summary),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function replayFor(priorGames, variant) {
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
      ...(variant.ratingOptions || {}),
    },
    volleyballOptions: variant.volleyballOptions || {},
  });
}

function evaluateForward(variant) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const priorMarginResiduals = [];
  const stats = createStats();

  for (const game of sortedGames) {
    if (isQualityGame(game)) {
      const replay = replayFor(priorGames, variant);
      const marginModel = calibrateMarginModel({
        games: priorGames,
        ratingMap: replay.ratingMap,
        carryScoreMap: replay.carryMap || {},
        options: {
          seasonalTaperDays,
          ...(variant.ratingOptions || {}),
        },
        volleyballOptions: {
          ...DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
          ...(variant.volleyballOptions || {}),
        },
      });
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: replay.ratingMap,
        carryScoreMap: replay.carryMap || {},
        volleyballOptions: {
          ...DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
          ...(variant.volleyballOptions || {}),
        },
      });
      const yRed = game.winner === 'red' ? 1 : 0;
      const predictedWinner = score.redWinProbability >= 0.5 ? 'red' : 'blue';

      stats.n += 1;
      if (predictedWinner === game.winner) stats.correct += 1;
      stats.brierSum += (score.redWinProbability - yRed) ** 2;

      if (isScored(game) && (marginModel?.sampleSize || 0) >= MIN_MARGIN_SAMPLES) {
        const expected = predictExpectedMargin(score.strengthDiff, marginModel);
        const actual = Math.abs(game.scoreRed - game.scoreBlue);
        const residual = actual - expected;
        const residualSd = stddev(priorMarginResiduals);
        const z = residualSd > 0 ? residual / residualSd : 0;
        const blowoutActual = actual > 8 ? 1 : 0;
        const blowoutProb = clamp((expected - 4) / 8, 0.02, 0.98);

        stats.scored += 1;
        stats.marginErrSum += Math.abs(expected - actual);
        stats.blowoutBrierSum += (blowoutActual - blowoutProb) ** 2;
        stats.actualBlowouts += blowoutActual;
        stats.wideOutliers += z >= 1 ? 1 : 0;
        stats.severeWideOutliers += z >= 1.5 ? 1 : 0;
        priorMarginResiduals.push(residual);
      }
    }

    priorGames.push(game);
  }

  return summarize(stats);
}

function evaluateBack(variant) {
  const stats = createStats();
  const replay = replayFor(games, variant);
  const marginModel = calibrateMarginModel({
    games,
    ratingMap: replay.ratingMap,
    carryScoreMap: replay.carryMap || {},
    options: {
      seasonalTaperDays,
      ...(variant.ratingOptions || {}),
    },
    volleyballOptions: {
      ...DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
      ...(variant.volleyballOptions || {}),
    },
  });
  const scoredRows = [];

  getGamesSortedOldestFirst(games).forEach(game => {
    if (!isQualityGame(game)) return;
    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
      volleyballOptions: {
        ...DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
        ...(variant.volleyballOptions || {}),
      },
    });
    const yRed = game.winner === 'red' ? 1 : 0;
    const predictedWinner = score.redWinProbability >= 0.5 ? 'red' : 'blue';

    stats.n += 1;
    if (predictedWinner === game.winner) stats.correct += 1;
    stats.brierSum += (score.redWinProbability - yRed) ** 2;

    if (isScored(game) && (marginModel?.sampleSize || 0) >= MIN_MARGIN_SAMPLES) {
      const expected = predictExpectedMargin(score.strengthDiff, marginModel);
      const actual = Math.abs(game.scoreRed - game.scoreBlue);
      const residual = actual - expected;
      const blowoutActual = actual > 8 ? 1 : 0;
      const blowoutProb = clamp((expected - 4) / 8, 0.02, 0.98);

      scoredRows.push({ residual });
      stats.scored += 1;
      stats.marginErrSum += Math.abs(expected - actual);
      stats.blowoutBrierSum += (blowoutActual - blowoutProb) ** 2;
      stats.actualBlowouts += blowoutActual;
    }
  });

  const residualSd = stddev(scoredRows.map(row => row.residual));
  scoredRows.forEach(row => {
    const z = residualSd > 0 ? row.residual / residualSd : 0;
    stats.wideOutliers += z >= 1 ? 1 : 0;
    stats.severeWideOutliers += z >= 1.5 ? 1 : 0;
  });

  return summarize(stats);
}

function fmt(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
}

function pct(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(0)}%` : 'n/a';
}

function printRows(title, rows) {
  const labelWidth = Math.max(26, ...rows.map(row => row.label.length));
  console.log(`\n${title}`);
  console.log([
    'variant'.padEnd(labelWidth),
    'AccIQ'.padStart(7),
    'dIQ'.padStart(7),
    'acc'.padStart(6),
    'brier'.padStart(7),
    'MAE'.padStart(7),
    'dMAE'.padStart(7),
    'boBrier'.padStart(8),
    'wide'.padStart(6),
    'severe'.padStart(7),
  ].join('  '));
  console.log('-'.repeat(labelWidth + 78));
  rows.forEach(row => {
    console.log([
      row.label.padEnd(labelWidth),
      fmt(row.accIQ, 2).padStart(7),
      fmt(row.accIQDelta, 2).padStart(7),
      pct(row.accuracy).padStart(6),
      fmt(row.brier, 3).padStart(7),
      fmt(row.marginMAE, 3).padStart(7),
      fmt(row.marginMAEDelta, 3).padStart(7),
      fmt(row.blowoutBrier, 3).padStart(8),
      pct(row.wideOutlierRate).padStart(6),
      pct(row.severeWideOutlierRate).padStart(7),
    ].join('  '));
  });
}

console.log(`DB: ${sourceLabel}`);
const selectedVariants = VARIANT_FILTER.length
  ? variants.filter(variant => VARIANT_FILTER.includes(variant.label))
  : variants;

console.log(`variants=${selectedVariants.length} minMarginSamples=${MIN_MARGIN_SAMPLES} mode=${MODE}`);

const rows = selectedVariants.map(variant => ({
  label: variant.label,
  ...(MODE === 'forward' ? evaluateForward(variant) : evaluateBack(variant)),
}));
const baseline = rows.find(row => row.label === 'current-wrapper');
rows.forEach(row => {
  row.accIQDelta = Number(row.accIQ) - Number(baseline?.accIQ);
  row.marginMAEDelta = Number(baseline?.marginMAE) - Number(row.marginMAE);
});

printRows('All variants', rows);
printRows('Best by AccIQ', [...rows].sort((a, b) => b.accIQ - a.accIQ).slice(0, 12));
printRows('Best by margin MAE', [...rows].sort((a, b) => a.marginMAE - b.marginMAE).slice(0, 12));
printRows('Lowest wide-outlier rate', [...rows].sort((a, b) =>
  a.wideOutlierRate - b.wideOutlierRate ||
  b.accIQ - a.accIQ
).slice(0, 12));
