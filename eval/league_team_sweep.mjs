// Eval-only sweep for synthetic league-opponent rating behavior.
//
// This does not change recorded league-game metadata. It only varies how the
// model maps those league games onto synthetic opponent identities and how fast
// those synthetic opponents react to results.
//
// Run from eval/:
//   npm run league:team

import { loadDatabase } from './database.mjs';
import { attachAccIQDeltas, compareAccIQDesc, computeAccIQ } from './metrics.mjs';
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
  console.log(title);
  console.log([
    'label'.padEnd(32),
    'fwdAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'fwdMAE'.padStart(7),
    'backAcc'.padStart(8),
    'backBrier'.padStart(9),
    'backMAE'.padStart(7),
    'AccIQ'.padStart(7),
    'dIQ'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(100));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, 32).padEnd(32),
      pct(row.forward.accuracy).padStart(7),
      fmt(row.forward.brier).padStart(9),
      fmt(row.forward.marginMAE).padStart(7),
      pct(row.back.accuracy).padStart(8),
      fmt(row.back.brier).padStart(9),
      fmt(row.back.marginMAE).padStart(7),
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
console.log('Sweeping leagueTeamRatingMode, leagueOpponentUpdateMultiplier, and league opponent burn-in.');
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
const pregameBayesianGridStep = Number(process.env.LEAGUE_PREGAME_BAYESIAN_GRID_STEP) || DEFAULT_RATING_OPTIONS.leagueBayesianGridStep;

for (const mode of modes) {
  for (const multiplier of multipliers) {
    for (const burnInGames of burnInGamesValues) {
      for (const burnInMultiplier of burnInMultipliers) {
        if (burnInGames === 0 && burnInMultiplier !== 1) continue;
        if (burnInGames > 0 && burnInMultiplier === 1) continue;

        const burnLabel = burnInGames > 0
          ? ` burn ${burnInGames}x${burnInMultiplier.toFixed(2)}`
          : '';

        addCandidate(`${mode} opp x${multiplier.toFixed(2)}${burnLabel}`, {
          leagueTeamRatingMode: mode,
          leagueOpponentUpdateMultiplier: multiplier,
          leagueOpponentBurnInGames: burnInGames,
          leagueOpponentBurnInMultiplier: burnInMultiplier,
          leagueUpdateMultiplier: DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier,
        });

        pregameBayesianSigmas.forEach(sigma => {
          addCandidate(`${mode} bayes seed s${sigma.toFixed(2)} x${multiplier.toFixed(2)}${burnLabel}`, {
            leagueTeamRatingMode: mode,
            leagueOpponentUpdateMultiplier: multiplier,
            leagueOpponentBurnInGames: burnInGames,
            leagueOpponentBurnInMultiplier: burnInMultiplier,
            leagueUpdateMultiplier: DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier,
            leaguePregameBayesianEnabled: true,
            leaguePregameBayesianSigma: sigma,
            leagueBayesianGridStep: pregameBayesianGridStep,
          });
        });
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
const byForwardBrier = [...uniqueRows].sort((a, b) => a.forward.brier - b.forward.brier);
const byForwardMae = [...uniqueRows].sort((a, b) => a.forward.marginMAE - b.forward.marginMAE);
const baselines = uniqueRows.filter(row =>
  row.label === 'exclude league games' ||
  row.label === 'current default'
);

printRows('Baselines', baselines);
printRows('Best AccIQ candidates', byAccIQ, 14);
printRows('Best forward Brier candidates', byForwardBrier, 12);
printRows('Best forward margin-MAE candidates', byForwardMae, 12);
