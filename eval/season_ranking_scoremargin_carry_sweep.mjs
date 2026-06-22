// Focused forward-only sweep for Season Ranking:
// score-margin updates disabled plus carry-score settings.
//
// League handling is fixed at the current app Season Ranking settings.

import { loadDatabase } from './database.mjs';
import { computeFwdAccIQ } from './metrics.mjs';
import {
  getGamesSortedOldestFirst,
  replayRatings,
  scoreVolleyballCandidateSplit,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const fixedLeagueOptions = {
  leagueUpdateMultiplier: 1.5,
  leagueMuUpdateMultiplier: 1,
  leagueSigmaUpdateMultiplier: 0.8,
};
const baseRatingOptions = {
  seasonalTaperDays,
  ...fixedLeagueOptions,
};

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(',').map(value => Number(value.trim())).filter(Number.isFinite);
  return values.length ? values : fallback;
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

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    averageConfidenceSum: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    averageConfidence: stats.n ? stats.averageConfidenceSum / stats.n : null,
  };
}

function replayFor({ ratingOptions, volleyballOptions }, priorGames) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: true,
    volleyballUpdateUsesBalancerContext: true,
    volleyballUpdateContextMode: 'pair',
    includeLeagueGames: true,
    options: ratingOptions,
    volleyballOptions,
  });
}

function computeForwardQuality({ ratingOptions, volleyballOptions }) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const prior = replayFor({ ratingOptions, volleyballOptions }, priorGames);
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options: ratingOptions,
        volleyballOptions,
      });
      const redProbability = Number(score.redWinProbability);
      if (Number.isFinite(redProbability)) {
        const predictedWinner = redProbability >= 0.5 ? 'red' : 'blue';
        const yRed = game.winner === 'red' ? 1 : 0;
        stats.n += 1;
        if (predictedWinner === game.winner) stats.correct += 1;
        stats.brierSum += (redProbability - yRed) ** 2;
        stats.averageConfidenceSum += Math.max(redProbability, 1 - redProbability);
      }
    }
    priorGames.push(game);
  });

  return summarize(stats);
}

function evaluate(label, group, { ratingOptions = {}, volleyballOptions = {} } = {}) {
  const mergedRatingOptions = {
    ...baseRatingOptions,
    ...ratingOptions,
  };
  const forward = computeForwardQuality({
    ratingOptions: mergedRatingOptions,
    volleyballOptions,
  });
  return {
    label,
    group,
    ratingOptions: mergedRatingOptions,
    volleyballOptions,
    forward,
    fwdAccIQ: computeFwdAccIQ({
      ...forward,
      marginMAE: null,
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
  return config;
}

function compareRows(a, b) {
  const accDelta = Number(b.forward.accuracy) - Number(a.forward.accuracy);
  if (Math.abs(accDelta) > 1e-12) return accDelta;
  const brierDelta = Number(a.forward.brier) - Number(b.forward.brier);
  if (Math.abs(brierDelta) > 1e-12) return brierDelta;
  return Number(b.fwdAccIQ) - Number(a.fwdAccIQ);
}

function printRows(title, rows, baseline, limit = 25) {
  const labelWidth = 36;
  console.log('');
  console.log(title);
  console.log([
    'group'.padEnd(12),
    'label'.padEnd(labelWidth),
    'fwdAcc'.padStart(7),
    'dAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'dBrier'.padStart(9),
    'conf'.padStart(7),
    'FwdIQ'.padStart(7),
    'dFwd'.padStart(7),
    'config',
  ].join(' '));
  console.log('-'.repeat(labelWidth + 108));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.group.padEnd(12),
      row.label.slice(0, labelWidth).padEnd(labelWidth),
      pct(row.forward.accuracy).padStart(7),
      `${((Number(row.forward.accuracy) - Number(baseline.forward.accuracy)) * 100).toFixed(1)}%`.padStart(7),
      fmt(row.forward.brier).padStart(9),
      fmt(Number(row.forward.brier) - Number(baseline.forward.brier)).padStart(9),
      pct(row.forward.averageConfidence).padStart(7),
      fmt(row.fwdAccIQ, 2).padStart(7),
      fmt(Number(row.fwdAccIQ) - Number(baseline.fwdAccIQ), 2).padStart(7),
      JSON.stringify(compactConfig(row)),
    ].join(' '));
  });
}

const carryScales = parseListEnv('SWEEP_CARRY_SCALES', [0, 4, 8, 12, 16, 20, 24, 28, 32, 40]);
const carryConfidenceGamesList = parseListEnv('SWEEP_CARRY_CONFIDENCE_GAMES', [2, 4, 6, 8, 10, 12, 16, 20]);

const candidates = [
  ['current season ranking', 'baseline', {}],
  ['no score margin', 'score-margin', { ratingOptions: { useScoreMargin: false } }],
];

carryScales.forEach(carryScale => {
  carryConfidenceGamesList.forEach(carryConfidenceGames => {
    candidates.push([
      `carry ${carryScale}/g${carryConfidenceGames}`,
      'carry-only',
      { volleyballOptions: { carryScale, carryConfidenceGames } },
    ]);
    candidates.push([
      `no margin + carry ${carryScale}/g${carryConfidenceGames}`,
      'combo',
      {
        ratingOptions: { useScoreMargin: false },
        volleyballOptions: { carryScale, carryConfidenceGames },
      },
    ]);
  });
});

const started = Date.now();
console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} qualityTargets=${games.filter(isQualityGame).length}`);
console.log(`fixedLeagueOptions=${JSON.stringify(fixedLeagueOptions)}`);
console.log(`carryScales=${carryScales.join(',')}`);
console.log(`carryConfidenceGames=${carryConfidenceGamesList.join(',')}`);
console.log(`uniqueCandidates=${candidates.length}`);

const rows = candidates.map(([label, group, config], index) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`evaluating ${index + 1}/${candidates.length}: ${label} (${elapsed}s)`);
  return evaluate(label, group, config);
});

const baseline = rows.find(row => row.group === 'baseline');
printRows('Baseline', [baseline], baseline, 1);
printRows('Best overall', [...rows].sort(compareRows), baseline);
printRows('Best combos only', rows.filter(row => row.group === 'combo').sort(compareRows), baseline);
printRows('Best carry-only', rows.filter(row => row.group === 'carry-only').sort(compareRows), baseline, 12);
