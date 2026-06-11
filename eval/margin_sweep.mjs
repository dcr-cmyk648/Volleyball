// Exact OpenSkill margin sweep for the local volleyball database.
//
// Run from eval/:
//   npm run margin
//
// Optional:
//   VBALL_DB=/path/to/default_database npm run margin

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  getScoreMarginFactor,
  toDisplayRating,
} from '../ratings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.VBALL_DB || resolve(__dirname, '../default_database');
const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
const players = db.players || [];
const games = db.games || [];

const SEASON_MONTHS = 6;
const seasonalTaperDays = Math.round(SEASON_MONTHS * 30.4375);
const TARGET_GAME_ID = 1781140940087;
const SHIV_ID = '1776129662289';
const NIKI_ID = '1776129503948';

const variants = [
  ['current tiny convex', {}],
  ['no score margin', { useScoreMargin: false }],
  ['tiny cap25', { maxMarginBonus: 0.25 }],
  ['tiny cap20', { maxMarginBonus: 0.20 }],
  ['tiny cap15', { maxMarginBonus: 0.15 }],
  ['tiny cap10', { maxMarginBonus: 0.10 }],
  ['tiny scale2', { marginBonusScale: 2.0 }],
  ['tiny scale1', { marginBonusScale: 1.0 }],
  ['linear scale1 cap25', { marginBonusScale: 1.0, marginBonusPower: 1.0, maxMarginBonus: 0.25 }],
  ['pow1.2 cap25', { marginBonusPower: 1.2, maxMarginBonus: 0.25 }],
];

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

function replayFor(ratingOptions, priorGames = games) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames: true,
    options: {
      seasonalTaperDays,
      ...ratingOptions,
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
    within5: 0,
    blowouts8: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    marginMAE: stats.scored ? stats.marginErrSum / stats.scored : null,
    within5: stats.scored ? stats.within5 / stats.scored : null,
    blowoutRate: stats.scored ? stats.blowouts8 / stats.scored : null,
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
    if (gap <= 5) stats.within5 += 1;
    if (gap > 8) stats.blowouts8 += 1;
  }
}

function computeForwardQuality(ratingOptions) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const prior = replayFor(ratingOptions, priorGames);
      const marginModel = calibrateMarginModel({
        games: priorGames,
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
      recordPrediction(stats, game, score, marginModel);
    }

    priorGames.push(game);
  });

  return summarize(stats);
}

function computeBackQuality(ratingOptions) {
  const replay = replayFor(ratingOptions);
  const marginModel = calibrateMarginModel({
    games,
    ratingMap: replay.ratingMap,
    carryScoreMap: replay.carryMap || {},
    options: ratingOptions,
  });
  const stats = createStats();

  getGamesSortedOldestFirst(games).forEach(game => {
    if (!isQualityGame(game)) return;
    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
      options: ratingOptions,
    });
    recordPrediction(stats, game, score, marginModel);
  });

  return summarize(stats);
}

function getTargetImpact(ratingOptions) {
  const replay = replayFor(ratingOptions);
  const entry = replay.history.find(item => item.game?.id === TARGET_GAME_ID);
  if (!entry) return null;

  const beforeById = new Map(
    [...(entry.before.red || []), ...(entry.before.blue || [])].map(player => [String(player.id), player])
  );
  const afterById = new Map(
    [...(entry.after.red || []), ...(entry.after.blue || [])].map(player => [String(player.id), player])
  );
  const delta = id => {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    if (!before || !after) return null;
    return toDisplayRating(after.rating) - toDisplayRating(before.rating);
  };

  return {
    marginFactor: entry.marginFactor,
    volleyballUpdateMultiplier: entry.volleyballUpdateMultiplier,
    finalUpdateMultiplier: entry.finalUpdateMultiplier,
    shivDelta: delta(SHIV_ID),
    nikiDelta: delta(NIKI_ID),
  };
}

function formatPercent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits = 3) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

console.log(`DB: ${DB_PATH}`);
console.log(`players=${players.length} games=${games.length} qualityGames=${games.filter(isQualityGame).length}`);
console.log('');

console.log('Common score margin factors:');
[
  [25, 23],
  [25, 21],
  [25, 15],
  [25, 10],
  [25, 8],
  [28, 26],
].forEach(([red, blue]) => {
  const factors = variants.slice(0, 6).map(([label, options]) =>
    `${label.split(' ')[0]}=${getScoreMarginFactor(red, blue, options).toFixed(3)}`
  );
  console.log(`${red}-${blue}: ${factors.join(' ')}`);
});

console.log('');
console.log(
  [
    'variant'.padEnd(30),
    'fwdAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'fwdMAE'.padStart(8),
    'backAcc'.padStart(8),
    'backBrier'.padStart(10),
    'backMAE'.padStart(8),
  ].join(' ')
);
console.log('-'.repeat(86));

const rows = variants.map(([label, options]) => ({
  label,
  options,
  forward: computeForwardQuality(options),
  back: computeBackQuality(options),
  impact: getTargetImpact(options),
}));

rows.forEach(row => {
  console.log(
    [
      row.label.slice(0, 30).padEnd(30),
      formatPercent(row.forward.accuracy).padStart(7),
      formatNumber(row.forward.brier).padStart(9),
      formatNumber(row.forward.marginMAE).padStart(8),
      formatPercent(row.back.accuracy).padStart(8),
      formatNumber(row.back.brier).padStart(10),
      formatNumber(row.back.marginMAE).padStart(8),
    ].join(' ')
  );
});

console.log('');
console.log('Target game 1781140940087, 2026-06-10 25-10 impact:');
console.log(
  [
    'variant'.padEnd(30),
    'margin'.padStart(7),
    'vbMult'.padStart(7),
    'final'.padStart(7),
    'ShivDelta'.padStart(10),
    'NikiDelta'.padStart(10),
  ].join(' ')
);
console.log('-'.repeat(78));
rows.forEach(row => {
  const impact = row.impact || {};
  console.log(
    [
      row.label.slice(0, 30).padEnd(30),
      formatNumber(impact.marginFactor).padStart(7),
      formatNumber(impact.volleyballUpdateMultiplier).padStart(7),
      formatNumber(impact.finalUpdateMultiplier).padStart(7),
      formatNumber(impact.shivDelta, 1).padStart(10),
      formatNumber(impact.nikiDelta, 1).padStart(10),
    ].join(' ')
  );
});

const bestForwardBrier = rows.reduce((best, row) =>
  row.forward.brier < best.forward.brier ? row : best
);
const bestForwardMae = rows.reduce((best, row) =>
  row.forward.marginMAE < best.forward.marginMAE ? row : best
);
const bestBackBrier = rows.reduce((best, row) =>
  row.back.brier < best.back.brier ? row : best
);

console.log('');
console.log(`Best forward Brier: ${bestForwardBrier.label} (${formatNumber(bestForwardBrier.forward.brier)})`);
console.log(`Best forward margin MAE: ${bestForwardMae.label} (${formatNumber(bestForwardMae.forward.marginMAE)})`);
console.log(`Best back Brier: ${bestBackBrier.label} (${formatNumber(bestBackBrier.back.brier)})`);
