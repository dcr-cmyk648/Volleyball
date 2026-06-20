// Eval-only sweep for synthetic league-opponent rating behavior.
//
// This does not change recorded league-game metadata. It only varies how the
// model maps those league games onto synthetic opponent identities and how fast
// those synthetic opponents react to results.
//
// Run from eval/:
//   npm run league:team

import { loadDatabase } from './database.mjs';
import {
  attachAccIQDeltas,
  compareAccIQDesc,
  computeAccIQ,
  computeBackAccIQ,
  computeFwdAccIQ,
} from './metrics.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  DEFAULT_RATING_OPTIONS,
} from '../ratings.js';

const { db, players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (/^(none|off|false)$/i.test(raw.trim())) return [];

  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value >= 0);

  return values.length > 0 ? values : fallback;
}

function parseModesEnv(fallback) {
  const raw = process.env.LEAGUE_TEAM_MODES;
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value === 'context' || value === 'pooled' || value === 'level');

  return values.length > 0 ? values : fallback;
}

function parseDayOffsetGroupingsEnv(fallback) {
  const raw = process.env.LEAGUE_DAY_OFFSET_GROUPINGS;
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(value => (
      value === 'dateLevel' ||
      value === 'dateLevelCourt' ||
      value === 'dateContext'
    ));

  return values.length > 0 ? values : fallback;
}

function parsePregameBayesianModesEnv(fallback) {
  const raw = process.env.LEAGUE_PREGAME_BAYESIAN_MODES;
  if (!raw) return fallback;

  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value === 'history' || value === 'incrementalGrid');

  return values.length > 0 ? values : fallback;
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

function isScoredNonLeagueGame(game) {
  return (
    isQualityGame(game) &&
    typeof game.scoreRed === 'number' &&
    typeof game.scoreBlue === 'number'
  );
}

function replayFor(options, priorGames = games, includeLeagueGames = true) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames,
    options: {
      seasonalTaperDays,
      ...options,
    },
  });
}

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    scored: 0,
    marginErrSum: 0,
    tierSamples: [],
    tiers: {
      balanced: { games: 0, algorithmGames: 0 },
      imbalanced: { games: 0, algorithmGames: 0 },
      blowout: { games: 0, algorithmGames: 0 },
    },
    algorithmTieredGames: 0,
    algorithmBalancedGames: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    marginMAE: stats.scored ? stats.marginErrSum / stats.scored : null,
    tiers: stats.tiers,
    algorithmTieredGames: stats.algorithmTieredGames,
    algorithmBalancedGames: stats.algorithmBalancedGames,
  };
}

function clampQualityScore(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.min(100, Number(value)));
}

function getMarginQualityComponent(summary) {
  return summary.marginMAE === null ? null : clampQualityScore(100 - Number(summary.marginMAE) * 5);
}

function getBrierQualityComponent(summary) {
  return summary.brier === null ? null : clampQualityScore((1 - Number(summary.brier)) * 100);
}

function getPctQualityComponent(value) {
  return value === null ? null : clampQualityScore(Number(value) * 100);
}

function computeWeightedQualityScore(components) {
  const usable = components.filter(component =>
    component.value !== null && Number.isFinite(Number(component.value)) && component.weight > 0
  );
  const totalWeight = usable.reduce((sum, component) => sum + component.weight, 0);
  if (totalWeight <= 0) return null;

  return clampQualityScore(
    usable.reduce((sum, component) => sum + Number(component.value) * component.weight, 0) / totalWeight
  );
}

function computeVisibleQualityScore(components) {
  const score = computeWeightedQualityScore(components);
  return score === null ? null : Math.round(score);
}

function getQualityTierKey({ actualGap, expectedGap, marginMAE }) {
  const safeError = Math.max(0.01, Number(marginMAE) || 0);
  const excess = Number(actualGap) - Number(expectedGap);
  if (excess <= safeError) return 'balanced';
  if (excess <= safeError * 2) return 'imbalanced';
  return 'blowout';
}

function assignQualityTiers(stats) {
  const summary = summarize(stats);
  const marginMAE = summary.marginMAE;
  if (marginMAE === null) return stats;

  stats.tiers = {
    balanced: { games: 0, algorithmGames: 0 },
    imbalanced: { games: 0, algorithmGames: 0 },
    blowout: { games: 0, algorithmGames: 0 },
  };
  stats.algorithmTieredGames = 0;
  stats.algorithmBalancedGames = 0;

  stats.tierSamples.forEach(sample => {
    const tierKey = getQualityTierKey({
      actualGap: sample.gap,
      expectedGap: sample.expectedGap,
      marginMAE,
    });
    const tier = stats.tiers[tierKey];
    tier.games += 1;
    if (sample.assignmentSource === 'algorithm') {
      tier.algorithmGames += 1;
      stats.algorithmTieredGames += 1;
      if (tierKey === 'balanced') stats.algorithmBalancedGames += 1;
    }
  });

  return stats;
}

function getBalancedRate(summary) {
  const total = Object.values(summary.tiers || {}).reduce((sum, tier) => sum + (Number(tier.games) || 0), 0);
  return total > 0 ? (Number(summary.tiers?.balanced?.games) || 0) / total : null;
}

function getAlgorithmBalancedRate(summary) {
  const algorithmGames = Number(summary.algorithmTieredGames) || 0;
  if (algorithmGames <= 0) return null;
  return (Number(summary.algorithmBalancedGames) || 0) / algorithmGames;
}

function computeExplanatoryQualityScore(summary) {
  return computeWeightedQualityScore([
    { value: getMarginQualityComponent(summary), weight: 50 },
    { value: getBrierQualityComponent(summary), weight: 30 },
    { value: getPctQualityComponent(summary.accuracy), weight: 20 },
  ]);
}

function computePredictiveQualityScore(summary) {
  const algorithmBalancedRate = getAlgorithmBalancedRate(summary);
  const balancedRate = getBalancedRate(summary);
  return computeWeightedQualityScore([
    { value: getMarginQualityComponent(summary), weight: 45 },
    { value: getBrierQualityComponent(summary), weight: 25 },
    {
      value: getPctQualityComponent(algorithmBalancedRate === null ? balancedRate : algorithmBalancedRate),
      weight: 20,
    },
    { value: getPctQualityComponent(summary.accuracy), weight: 10 },
  ]);
}

function recordPrediction(stats, game, score, marginModel) {
  const predictedWinner = score.redWinProbability >= 0.5 ? 'red' : 'blue';
  const yRed = game.winner === 'red' ? 1 : 0;

  stats.n += 1;
  if (predictedWinner === game.winner) stats.correct += 1;
  stats.brierSum += (score.redWinProbability - yRed) ** 2;

  if (
    typeof game.scoreRed === 'number' &&
    typeof game.scoreBlue === 'number' &&
    marginModel?.sampleSize > 0
  ) {
    const gap = Math.abs(game.scoreRed - game.scoreBlue);
    const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);
    stats.scored += 1;
    stats.marginErrSum += Math.abs(predictedGap - gap);
    stats.tierSamples.push({
      gap,
      expectedGap: predictedGap,
      assignmentSource: game.assignmentSource || '',
    });
  }
}

function computeForwardQuality(options, includeLeagueGames = true) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const prior = replayFor(options, priorGames, includeLeagueGames);
      const modelGames = includeLeagueGames
        ? priorGames
        : priorGames.filter(priorGame => !priorGame?.isLeagueGame);
      const marginModel = calibrateMarginModel({
        games: modelGames,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options,
      });
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options,
      });
      recordPrediction(stats, game, score, marginModel);
    }

    priorGames.push(game);
  });

  return summarize(assignQualityTiers(stats));
}

function computeBackQuality(options, includeLeagueGames = true) {
  const replay = replayFor(options, games, includeLeagueGames);
  const modelGames = includeLeagueGames ? games : games.filter(game => !game?.isLeagueGame);
  const marginModel = calibrateMarginModel({
    games: modelGames,
    ratingMap: replay.ratingMap,
    carryScoreMap: replay.carryMap || {},
    options,
  });
  const stats = createStats();

  getGamesSortedOldestFirst(games).forEach(game => {
    if (!isQualityGame(game)) return;
    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
      options,
    });
    recordPrediction(stats, game, score, marginModel);
  });

  return summarize(assignQualityTiers(stats));
}

function evaluate(label, options = {}, includeLeagueGames = true) {
  const forward = computeForwardQuality(options, includeLeagueGames);
  const back = computeBackQuality(options, includeLeagueGames);

  return {
    label,
    options,
    includeLeagueGames,
    forward,
    back,
    fwdAccIQ: computeFwdAccIQ(forward),
    backAccIQ: computeBackAccIQ(back),
    accIQ: computeAccIQ({ forward, back }),
  };
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function printRows(title, rows, limit = rows.length) {
  const labelWidth = 54;
  console.log(title);
  console.log([
    'label'.padEnd(labelWidth),
    'fwdAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'fwdMAE'.padStart(7),
    'backAcc'.padStart(8),
    'backBrier'.padStart(9),
    'backMAE'.padStart(7),
    'FwdIQ'.padStart(7),
    'dFwd'.padStart(7),
    'BackIQ'.padStart(7),
    'dBack'.padStart(7),
    'AccIQ'.padStart(7),
    'dIQ'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(labelWidth + 96));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, labelWidth).padEnd(labelWidth),
      pct(row.forward.accuracy).padStart(7),
      fmt(row.forward.brier).padStart(9),
      fmt(row.forward.marginMAE).padStart(7),
      pct(row.back.accuracy).padStart(8),
      fmt(row.back.brier).padStart(9),
      fmt(row.back.marginMAE).padStart(7),
      fmt(row.fwdAccIQ, 2).padStart(7),
      fmt(row.fwdAccIQDelta, 2).padStart(7),
      fmt(row.backAccIQ, 2).padStart(7),
      fmt(row.backAccIQDelta, 2).padStart(7),
      fmt(row.accIQ, 2).padStart(7),
      fmt(row.accIQDelta, 2).padStart(7),
    ].join(' '));
  });
  console.log('');
}

const leagueGames = games.filter(game => game?.isLeagueGame);
const scoredNonLeagueGames = games.filter(isScoredNonLeagueGame);

console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} leagueGames=${leagueGames.length} scoredNonLeague=${scoredNonLeagueGames.length}`);
console.log('Sweeping league team identity, update rate, pregame shrinkage/sigma, and same-session freeze.');
console.log('');

const candidates = [];
const candidateKeys = new Set();

function candidateKey(options = {}, includeLeagueGames = true) {
  return `${includeLeagueGames}:${JSON.stringify(options)}`;
}

function addCandidate(label, options = {}, includeLeagueGames = true) {
  const key = candidateKey(options, includeLeagueGames);
  if (candidateKeys.has(key)) return;
  candidateKeys.add(key);
  candidates.push({ label, options, includeLeagueGames });
}

addCandidate('exclude league games', {}, false);
addCandidate('current default', {}, true);
addCandidate('current default no league decay', {
  leagueOpponentSeasonalTaperEnabled: false,
}, true);

const modes = parseModesEnv(['context', 'pooled']);
const multipliers = parseListEnv(
  'LEAGUE_OPPONENT_MULTIPLIERS',
  [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]
);
const burnInGamesValues = parseListEnv(
  'LEAGUE_OPPONENT_BURN_IN_GAMES',
  [0, 3]
);
const burnInMultipliers = parseListEnv(
  'LEAGUE_OPPONENT_BURN_IN_MULTIPLIERS',
  [1, 1.5, 2]
);
const pregameBayesianSigmas = parseListEnv(
  'LEAGUE_PREGAME_BAYESIAN_SIGMAS',
  [1, 2, 4]
);
const pregameBayesianModes = parsePregameBayesianModesEnv(['incrementalGrid']);
const pregameBayesianGridStep = Number(process.env.LEAGUE_PREGAME_BAYESIAN_GRID_STEP) || DEFAULT_RATING_OPTIONS.leagueBayesianGridStep;
const leagueUpdateMultipliers = parseListEnv(
  'LEAGUE_UPDATE_MULTIPLIERS',
  [DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier]
);
const matchedLeagueUpdateMultipliers = parseListEnv(
  'MATCHED_LEAGUE_UPDATE_MULTIPLIERS',
  leagueUpdateMultipliers
);
const matchedOffsetRawValues = parseListEnv(
  'MATCHED_LEAGUE_OFFSET_RAWS',
  [0]
);
const dayOffsetLeagueUpdateMultipliers = parseListEnv(
  'DAY_OFFSET_LEAGUE_UPDATE_MULTIPLIERS',
  matchedLeagueUpdateMultipliers
);
const dayOffsetTrustValues = parseListEnv(
  'LEAGUE_DAY_OFFSET_TRUSTS',
  [0.25, 0.5, 0.75, 1]
);
const dayOffsetGroupings = parseDayOffsetGroupingsEnv(['dateLevel']);
const seriesLeagueUpdateMultipliers = parseListEnv(
  'SERIES_LEAGUE_UPDATE_MULTIPLIERS',
  []
);
const splitLeagueUpdateMultipliers = parseListEnv(
  'SPLIT_LEAGUE_UPDATE_MULTIPLIERS',
  []
);
const leagueMuUpdateMultipliers = parseListEnv(
  'LEAGUE_MU_UPDATE_MULTIPLIERS',
  [1]
);
const leagueSigmaUpdateMultipliers = parseListEnv(
  'LEAGUE_SIGMA_UPDATE_MULTIPLIERS',
  [1]
);
const shrinkGamesValues = parseListEnv(
  'LEAGUE_PREGAME_SHRINK_GAMES',
  [4, 8, 12, 20]
);
const shrinkPowerValues = parseListEnv(
  'LEAGUE_PREGAME_SHRINK_POWERS',
  [0.75, 1, 1.25]
);
const sigmaFloorValues = parseListEnv(
  'LEAGUE_PREGAME_SIGMA_FLOORS',
  [DEFAULT_RATING_OPTIONS.sigma, DEFAULT_RATING_OPTIONS.sigma * 1.5, DEFAULT_RATING_OPTIONS.sigma * 2]
);

matchedLeagueUpdateMultipliers.forEach(leagueUpdateMultiplier => {
  matchedOffsetRawValues.forEach(offsetRaw => {
    const label = leagueUpdateMultiplier === DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier
      ? `matched league opponent off ${offsetRaw.toFixed(2)}`
      : `matched league opponent lu${leagueUpdateMultiplier.toFixed(2)} off ${offsetRaw.toFixed(2)}`;
    addCandidate(label, {
      leagueOpponentModel: 'matched',
      leagueUpdateMultiplier,
      leagueMatchedOpponentOffsetRaw: offsetRaw,
    }, true);
  });
});

dayOffsetLeagueUpdateMultipliers.forEach(leagueUpdateMultiplier => {
  dayOffsetGroupings.forEach(grouping => {
    dayOffsetTrustValues.forEach(trust => {
      const groupingLabel = grouping === 'dateLevel' ? '' : ` ${grouping}`;
      const label = `day offset${groupingLabel} lu${leagueUpdateMultiplier.toFixed(2)} trust ${trust.toFixed(2)}`;
      addCandidate(label, {
        leagueOpponentModel: 'dayMatchedOffset',
        leagueUpdateMultiplier,
        leagueDayOffsetTrust: trust,
        leagueDayOffsetGrouping: grouping,
      }, true);
    });
  });
});

seriesLeagueUpdateMultipliers.forEach(leagueUpdateMultiplier => {
  addCandidate(`series aggregate lu${leagueUpdateMultiplier.toFixed(2)}`, {
    leagueSeriesAggregationEnabled: true,
    leagueUpdateMultiplier,
  }, true);

  addCandidate(`series aggregate matched lu${leagueUpdateMultiplier.toFixed(2)}`, {
    leagueSeriesAggregationEnabled: true,
    leagueOpponentModel: 'matched',
    leagueUpdateMultiplier,
  }, true);

  pregameBayesianSigmas.forEach(sigma => {
    pregameBayesianModes.forEach(bayesMode => {
      addCandidate(`series bayes ${bayesMode} lu${leagueUpdateMultiplier.toFixed(2)} seed ${sigma.toFixed(2)}`, {
        leagueSeriesAggregationEnabled: true,
        leagueTeamRatingMode: 'level',
        leaguePregameBayesianEnabled: true,
        leaguePregameBayesianMode: bayesMode,
        leaguePregameBayesianSigma: sigma,
        leagueBayesianGridStep: pregameBayesianGridStep,
        leagueUpdateMultiplier,
      }, true);
    });
  });

  leagueMuUpdateMultipliers.forEach(muMultiplier => {
    leagueSigmaUpdateMultipliers.forEach(sigmaMultiplier => {
      addCandidate(
        `series split lu${leagueUpdateMultiplier.toFixed(2)} mu${muMultiplier.toFixed(2)} sig${sigmaMultiplier.toFixed(2)}`,
        {
          leagueSeriesAggregationEnabled: true,
          leagueUpdateMultiplier,
          leagueMuUpdateMultiplier: muMultiplier,
          leagueSigmaUpdateMultiplier: sigmaMultiplier,
        },
        true
      );
      pregameBayesianSigmas.forEach(sigma => {
        pregameBayesianModes.forEach(bayesMode => {
          addCandidate(
            `series bayes ${bayesMode} split lu${leagueUpdateMultiplier.toFixed(2)} mu${muMultiplier.toFixed(2)} sig${sigmaMultiplier.toFixed(2)} seed ${sigma.toFixed(2)}`,
            {
              leagueSeriesAggregationEnabled: true,
              leagueTeamRatingMode: 'level',
              leaguePregameBayesianEnabled: true,
              leaguePregameBayesianMode: bayesMode,
              leaguePregameBayesianSigma: sigma,
              leagueBayesianGridStep: pregameBayesianGridStep,
              leagueUpdateMultiplier,
              leagueMuUpdateMultiplier: muMultiplier,
              leagueSigmaUpdateMultiplier: sigmaMultiplier,
            },
            true
          );
        });
      });
      addCandidate(
        `series split matched lu${leagueUpdateMultiplier.toFixed(2)} mu${muMultiplier.toFixed(2)} sig${sigmaMultiplier.toFixed(2)}`,
        {
          leagueSeriesAggregationEnabled: true,
          leagueOpponentModel: 'matched',
          leagueUpdateMultiplier,
          leagueMuUpdateMultiplier: muMultiplier,
          leagueSigmaUpdateMultiplier: sigmaMultiplier,
        },
        true
      );
    });
  });
});

splitLeagueUpdateMultipliers.forEach(leagueUpdateMultiplier => {
  leagueMuUpdateMultipliers.forEach(muMultiplier => {
    leagueSigmaUpdateMultipliers.forEach(sigmaMultiplier => {
      addCandidate(
        `split lu${leagueUpdateMultiplier.toFixed(2)} mu${muMultiplier.toFixed(2)} sig${sigmaMultiplier.toFixed(2)}`,
        {
          leagueUpdateMultiplier,
          leagueMuUpdateMultiplier: muMultiplier,
          leagueSigmaUpdateMultiplier: sigmaMultiplier,
        },
        true
      );
      addCandidate(
        `split matched lu${leagueUpdateMultiplier.toFixed(2)} mu${muMultiplier.toFixed(2)} sig${sigmaMultiplier.toFixed(2)}`,
        {
          leagueOpponentModel: 'matched',
          leagueUpdateMultiplier,
          leagueMuUpdateMultiplier: muMultiplier,
          leagueSigmaUpdateMultiplier: sigmaMultiplier,
        },
        true
      );
    });
  });
});

function addLeaguePregameCandidates({
  mode,
  leagueUpdateMultiplier,
  multiplier,
  burnInGames,
  burnInMultiplier,
  burnLabel,
}) {
  const baseOptions = {
    leagueTeamRatingMode: mode,
    leagueOpponentUpdateMultiplier: multiplier,
    leagueOpponentBurnInGames: burnInGames,
    leagueOpponentBurnInMultiplier: burnInMultiplier,
    leagueUpdateMultiplier,
  };

  shrinkGamesValues.forEach(shrinkGames => {
    shrinkPowerValues.forEach(power => {
      addCandidate(`${mode} shrink g${shrinkGames} p${power.toFixed(2)} x${multiplier.toFixed(2)}${burnLabel}`, {
        ...baseOptions,
        leaguePregameShrinkEnabled: true,
        leaguePregameShrinkGames: shrinkGames,
        leaguePregameShrinkPower: power,
      });
    });
  });

  sigmaFloorValues.forEach(sigmaFloor => {
    addCandidate(`${mode} sigma floor ${sigmaFloor.toFixed(2)} x${multiplier.toFixed(2)}${burnLabel}`, {
      ...baseOptions,
      leaguePregameSigmaEnabled: true,
      leaguePregameSigmaFloor: sigmaFloor,
    });
  });

  addCandidate(`${mode} session freeze x${multiplier.toFixed(2)}${burnLabel}`, {
    ...baseOptions,
    leagueSessionFreezeEnabled: true,
  });

  shrinkGamesValues.forEach(shrinkGames => {
    addCandidate(`${mode} shrink+freeze g${shrinkGames} x${multiplier.toFixed(2)}${burnLabel}`, {
      ...baseOptions,
      leaguePregameShrinkEnabled: true,
      leaguePregameShrinkGames: shrinkGames,
      leaguePregameShrinkPower: 1,
      leagueSessionFreezeEnabled: true,
    });
  });

  sigmaFloorValues.forEach(sigmaFloor => {
    addCandidate(`${mode} sigma+freeze ${sigmaFloor.toFixed(2)} x${multiplier.toFixed(2)}${burnLabel}`, {
      ...baseOptions,
      leaguePregameSigmaEnabled: true,
      leaguePregameSigmaFloor: sigmaFloor,
      leagueSessionFreezeEnabled: true,
    });
  });
}

for (const mode of modes) {
  for (const leagueUpdateMultiplier of leagueUpdateMultipliers) {
    for (const multiplier of multipliers) {
      for (const burnInGames of burnInGamesValues) {
        for (const burnInMultiplier of burnInMultipliers) {
          if (burnInGames === 0 && burnInMultiplier !== 1) continue;
          if (burnInGames > 0 && burnInMultiplier === 1) continue;

          const leagueLabel = leagueUpdateMultiplier === DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier
            ? ''
            : ` lu${leagueUpdateMultiplier.toFixed(2)}`;
          const burnLabel = burnInGames > 0
            ? ` burn ${burnInGames}x${burnInMultiplier.toFixed(2)}`
            : '';

          addCandidate(`${mode}${leagueLabel} opp x${multiplier.toFixed(2)}${burnLabel}`, {
            leagueTeamRatingMode: mode,
            leagueOpponentUpdateMultiplier: multiplier,
            leagueOpponentBurnInGames: burnInGames,
            leagueOpponentBurnInMultiplier: burnInMultiplier,
            leagueUpdateMultiplier,
          });

          pregameBayesianSigmas.forEach(sigma => {
            pregameBayesianModes.forEach(bayesMode => {
              addCandidate(`${mode}${leagueLabel} bayes ${bayesMode} seed s${sigma.toFixed(2)} x${multiplier.toFixed(2)}${burnLabel}`, {
                leagueTeamRatingMode: mode,
                leagueOpponentUpdateMultiplier: multiplier,
                leagueOpponentBurnInGames: burnInGames,
                leagueOpponentBurnInMultiplier: burnInMultiplier,
                leagueUpdateMultiplier,
                leaguePregameBayesianEnabled: true,
                leaguePregameBayesianMode: bayesMode,
                leaguePregameBayesianSigma: sigma,
                leagueBayesianGridStep: pregameBayesianGridStep,
              });
            });
          });

          addLeaguePregameCandidates({
            mode,
            leagueUpdateMultiplier,
            multiplier,
            burnInGames,
            burnInMultiplier,
            burnLabel: `${leagueLabel}${burnLabel}`,
          });
        }
      }
    }
  }
}

console.log(`uniqueCandidates=${candidates.length}`);

const started = Date.now();
const uniqueRows = candidates.map((candidate, index) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`evaluating ${index + 1}/${candidates.length}: ${candidate.label} (${elapsed}s)`);
  return evaluate(candidate.label, candidate.options, candidate.includeLeagueGames);
});

attachAccIQDeltas(uniqueRows, row => row.label === 'current default');
const byAccIQ = [...uniqueRows].sort(compareAccIQDesc);
const byFwdAccIQ = [...uniqueRows].sort((a, b) => (Number(b.fwdAccIQ) || -Infinity) - (Number(a.fwdAccIQ) || -Infinity));
const byBackAccIQ = [...uniqueRows].sort((a, b) => (Number(b.backAccIQ) || -Infinity) - (Number(a.backAccIQ) || -Infinity));
const byForwardBrier = [...uniqueRows].sort((a, b) => a.forward.brier - b.forward.brier);
const byForwardMae = [...uniqueRows].sort((a, b) => a.forward.marginMAE - b.forward.marginMAE);
const printLimit = Math.max(1, Number(process.env.LEAGUE_SWEEP_PRINT_LIMIT) || 14);
const baselines = uniqueRows.filter(row =>
  row.label === 'exclude league games' ||
  row.label === 'current default'
);

printRows('Baselines', baselines);
printRows('Best AccIQ candidates', byAccIQ, printLimit);
printRows('Best FwdAccIQ candidates', byFwdAccIQ, printLimit);
printRows('Best BackAccIQ candidates', byBackAccIQ, printLimit);
printRows('Best forward Brier candidates', byForwardBrier, printLimit);
printRows('Best forward margin-MAE candidates', byForwardMae, printLimit);
