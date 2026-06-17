// Exact OpenSkill sweep for league-game update strength.
//
// This is eval-only. It sweeps ratings.js's leagueUpdateMultiplier option and
// measures downstream quality on non-league games.
//
// Run from eval/:
//   npm run league

import { loadDatabase } from './database.mjs';
import { attachAccIQDeltas, compareAccIQDesc, computeAccIQ, computeSinglePassAccIQ } from './metrics.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
} from '../ratings.js';

const { db, players, games, sourceLabel } = await loadDatabase();

const SEASON_MONTHS = 6;
const seasonalTaperDays = Math.round(SEASON_MONTHS * 30.4375);

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

function replayFor(options, priorGames = games, includeLeagueGames = true, replayConfig = {}) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: Boolean(replayConfig.volleyballAdjusted),
    volleyballUpdateUsesBalancerContext: replayConfig.volleyballUpdateUsesBalancerContext,
    volleyballUpdateContextMode: replayConfig.volleyballUpdateContextMode,
    includeLeagueGames,
    options: {
      seasonalTaperDays,
      ...options,
    },
    volleyballOptions: replayConfig.volleyballOptions || {},
  });
}

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    scored: 0,
    marginErrSum: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    marginMAE: stats.scored ? stats.marginErrSum / stats.scored : null,
  };
}

function recordPrediction(stats, game, score, marginModel) {
  const predictedWinner = score.redWinProbability >= 0.5 ? 'red' : 'blue';
  const yRed = game.winner === 'red' ? 1 : 0;

  stats.n += 1;
  if (predictedWinner === game.winner) stats.correct += 1;
  stats.brierSum += Math.pow(score.redWinProbability - yRed, 2);

  if (
    typeof game.scoreRed === 'number' &&
    typeof game.scoreBlue === 'number' &&
    marginModel?.sampleSize > 0
  ) {
    const gap = Math.abs(game.scoreRed - game.scoreBlue);
    const predictedGap = predictExpectedMargin(score.strengthDiff, marginModel);
    stats.scored += 1;
    stats.marginErrSum += Math.abs(predictedGap - gap);
  }
}

function computeForwardQuality(options, includeLeagueGames = true, replayConfig = {}) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const prior = replayFor(options, priorGames, includeLeagueGames, replayConfig);
      const marginModel = calibrateMarginModel({
        games: includeLeagueGames ? priorGames : priorGames.filter(g => !g?.isLeagueGame),
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options,
        volleyballOptions: replayConfig.volleyballOptions || {},
      });
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options,
        volleyballOptions: replayConfig.volleyballOptions || {},
      });
      recordPrediction(stats, game, score, marginModel);
    }

    priorGames.push(game);
  });

  return summarize(stats);
}

function computeBackQuality(options, includeLeagueGames = true, replayConfig = {}) {
  const replay = replayFor(options, games, includeLeagueGames, replayConfig);
  const modelGames = includeLeagueGames ? games : games.filter(g => !g?.isLeagueGame);
  const marginModel = calibrateMarginModel({
    games: modelGames,
    ratingMap: replay.ratingMap,
    carryScoreMap: replay.carryMap || {},
    options,
    volleyballOptions: replayConfig.volleyballOptions || {},
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
      volleyballOptions: replayConfig.volleyballOptions || {},
    });
    recordPrediction(stats, game, score, marginModel);
  });

  return summarize(stats);
}

function evaluate(label, options = {}, includeLeagueGames = true, replayConfig = {}) {
  const forward = computeForwardQuality(options, includeLeagueGames, replayConfig);
  const back = computeBackQuality(options, includeLeagueGames, replayConfig);
  return {
    label,
    options,
    includeLeagueGames,
    replayConfig,
    forward,
    back,
    accIQ: computeAccIQ({ forward, back }),
  };
}

function evaluateBackOnly(label, options = {}, includeLeagueGames = true, replayConfig = {}) {
  const back = computeBackQuality(options, includeLeagueGames, replayConfig);
  return {
    label,
    options,
    includeLeagueGames,
    replayConfig,
    forward: null,
    back,
    accIQ: computeSinglePassAccIQ(back),
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
    'label'.padEnd(34),
    'fwdAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'fwdMAE'.padStart(7),
    'backAcc'.padStart(8),
    'backBrier'.padStart(9),
    'backMAE'.padStart(7),
    'AccIQ'.padStart(7),
    'dIQ'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(106));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, 34).padEnd(34),
      pct(row.forward?.accuracy ?? null).padStart(7),
      fmt(row.forward?.brier ?? null).padStart(9),
      fmt(row.forward?.marginMAE ?? null).padStart(7),
      pct(row.back.accuracy).padStart(8),
      fmt(row.back.brier).padStart(9),
      fmt(row.back.marginMAE).padStart(7),
      fmt(row.accIQ, 2).padStart(7),
      fmt(row.accIQDelta, 2).padStart(7),
    ].join(' '));
  });
  console.log('');
}

const leagueGames = games.filter(g => g?.isLeagueGame);
const scoredNonLeagueGames = games.filter(isScoredNonLeagueGame);

console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} leagueGames=${leagueGames.length} scoredNonLeague=${scoredNonLeagueGames.length}`);
console.log('');

const leagueMultipliers = [
  0, 0.15, 0.25, 0.35, 0.5, 0.65, 0.8,
  1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0,
];

const updateModes = [
  {
    prefix: 'global',
    replayConfig: {},
  },
  {
    prefix: 'surprise plain',
    replayConfig: {
      volleyballAdjusted: true,
      volleyballUpdateUsesBalancerContext: false,
    },
  },
  {
    prefix: 'surprise pair',
    replayConfig: {
      volleyballAdjusted: true,
      volleyballUpdateUsesBalancerContext: true,
      volleyballUpdateContextMode: 'pair',
    },
  },
  {
    prefix: 'surprise full',
    replayConfig: {
      volleyballAdjusted: true,
      volleyballUpdateUsesBalancerContext: true,
      volleyballUpdateContextMode: 'full',
    },
  },
];

const candidates = [
  { label: 'exclude league games', options: {}, includeLeagueGames: false, replayConfig: {} },
  { label: 'current default', options: {}, includeLeagueGames: true, replayConfig: {} },
  { label: 'league x1.00', options: { leagueUpdateMultiplier: 1.0 }, includeLeagueGames: true, replayConfig: {} },
];

for (const mode of updateModes) {
  for (const multiplier of leagueMultipliers) {
    candidates.push({
      label: `${mode.prefix} league x${multiplier.toFixed(2)}`,
      options: { leagueUpdateMultiplier: multiplier },
      includeLeagueGames: true,
      replayConfig: mode.replayConfig,
    });
  }
}

for (const multiplier of [2.25, 2.75, 3.25]) {
  candidates.push({
    label: `surprise full league x${multiplier.toFixed(2)}`,
    options: { leagueUpdateMultiplier: multiplier },
    includeLeagueGames: true,
    replayConfig: updateModes[3].replayConfig,
  });
}

const uniqueCandidates = [];
const seen = new Set();
candidates.forEach(candidate => {
  const key = `${candidate.includeLeagueGames}:${JSON.stringify(candidate.options)}:${JSON.stringify(candidate.replayConfig)}`;
  if (seen.has(key)) return;
  seen.add(key);
  uniqueCandidates.push(candidate);
});

const broadBackRows = uniqueCandidates.map(candidate =>
  evaluateBackOnly(candidate.label, candidate.options, candidate.includeLeagueGames, candidate.replayConfig)
);
attachAccIQDeltas(broadBackRows, row => row.label === 'current default');
const byBackAccIQ = [...broadBackRows].sort(compareAccIQDesc);
const byBackBrier = [...broadBackRows].sort((a, b) => a.back.brier - b.back.brier);
const byBackMae = [...broadBackRows].sort((a, b) => a.back.marginMAE - b.back.marginMAE);

printRows('Broad back-quality scan', byBackAccIQ, 25);
printRows('Best back Brier candidates', byBackBrier, 15);
printRows('Best back margin-MAE candidates', byBackMae, 15);

const selectedKeys = new Set();
const selectedCandidates = [];
function selectCandidate(candidate) {
  const key = `${candidate.includeLeagueGames}:${JSON.stringify(candidate.options)}:${JSON.stringify(candidate.replayConfig)}`;
  if (selectedKeys.has(key)) return;
  selectedKeys.add(key);
  selectedCandidates.push(candidate);
}

uniqueCandidates
  .filter(candidate =>
    candidate.label === 'exclude league games' ||
    candidate.label === 'current default' ||
    candidate.label === 'league x1.00'
  )
  .forEach(selectCandidate);
byBackAccIQ.slice(0, 10).forEach(row => selectCandidate(row));
broadBackRows
  .filter(row =>
    row.label.includes('x2.50') ||
    row.label.includes('x2.75') ||
    row.label.includes('x3.00') ||
    row.label.includes('x3.25')
  )
  .forEach(selectCandidate);

const fullRows = selectedCandidates.map(candidate =>
  evaluate(candidate.label, candidate.options, candidate.includeLeagueGames, candidate.replayConfig)
);
attachAccIQDeltas(fullRows, row => row.label === 'current default');
const byAccIQ = [...fullRows].sort(compareAccIQDesc);
const byForwardBrier = [...fullRows].sort((a, b) => a.forward.brier - b.forward.brier);
const byForwardMae = [...fullRows].sort((a, b) => a.forward.marginMAE - b.forward.marginMAE);
const baselines = fullRows.filter(row =>
  row.label === 'exclude league games' ||
  row.label === 'current default'
);

printRows('Forward/back baselines', baselines);
printRows('Best forward/back AccIQ candidates', byAccIQ, 20);
printRows('Best forward Brier candidates', byForwardBrier, 12);
printRows('Best forward margin-MAE candidates', byForwardMae, 12);
