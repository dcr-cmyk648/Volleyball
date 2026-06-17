// Exact OpenSkill grid search for score-margin formulas.
//
// This is eval-only. It generates a temporary copy of ratings.js whose
// getScoreMarginDetails() can switch between the production power formula,
// no margin, and a point-difference logistic curve via rating options.
//
// Run from eval/:
//   npm run margin:grid

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { loadDatabase } from './database.mjs';
import { attachAccIQDeltas, compareAccIQDesc, computeAccIQ } from './metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { db, players, games, sourceLabel } = await loadDatabase();

const SEASON_MONTHS = 6;
const seasonalTaperDays = Math.round(SEASON_MONTHS * 30.4375);
const TARGET_GAME_ID = 1781140940087;
const SHIV_ID = '1776129662289';
const NIKI_ID = '1776129503948';

const sourcePath = resolve(__dirname, '../ratings.js');
const source = readFileSync(sourcePath, 'utf8');
const start = source.indexOf('export function getScoreMarginDetails');
const end = source.indexOf('export function getScoreMarginFactor', start);

if (start < 0 || end < 0) {
  throw new Error(`Could not locate getScoreMarginDetails() in ratings.js at ${sourcePath}`);
}

const replacement = String.raw`export function getScoreMarginDetails(scoreRed, scoreBlue, options = {}) {
  const cfg = mergeRatingOptions(options);

  const emptyDetails = {
    marginFactor: 1,
    blowoutBonusFactor: 1,
    closeOvertimeDampener: 1,
    pointDiff: null,
    winnerScore: null,
    loserScore: null,
    isCloseOvertime: false,
  };

  if (!cfg.useScoreMargin) return emptyDetails;

  const red = toFiniteNumber(scoreRed, null);
  const blue = toFiniteNumber(scoreBlue, null);
  if (red === null || blue === null) return emptyDetails;

  const pointDiff = Math.abs(red - blue);
  const winnerScore = Math.max(red, blue);
  const loserScore = Math.min(red, blue);
  const totalPoints = winnerScore + loserScore;
  const dominanceMargin = totalPoints > 0 ? winnerScore / totalPoints - 0.5 : 0;
  const scale = Number(cfg.marginBonusScale) || 4.0;
  const power = Number(cfg.marginBonusPower) || 1.5;
  const maxBonus = Number.isFinite(Number(cfg.maxMarginBonus))
    ? Number(cfg.maxMarginBonus)
    : DEFAULT_RATING_OPTIONS.maxMarginBonus;
  let rawBonus = scale * Math.pow(Math.max(0, dominanceMargin), power);

  if (cfg._marginFormula === 'logistic') {
    const midpoint = Number.isFinite(Number(cfg._marginLogisticMidpoint))
      ? Number(cfg._marginLogisticMidpoint)
      : 9;
    const steepness = Number.isFinite(Number(cfg._marginLogisticSteepness))
      ? Number(cfg._marginLogisticSteepness)
      : 0.55;
    const sigmoid = value => 1 / (1 + Math.exp(-value));
    const floor = sigmoid(-steepness * midpoint);
    const value = sigmoid(steepness * (pointDiff - midpoint));
    rawBonus = maxBonus * clamp((value - floor) / Math.max(0.0001, 1 - floor), 0, 1);
  }

  const bonus = clamp(rawBonus, 0, maxBonus);
  const blowoutBonusFactor = 1 + bonus;

  const isCloseOvertime =
    winnerScore >= 25 &&
    pointDiff === 2;

  let closeOvertimeDampener = 1;

  if (isCloseOvertime) {
    const overtimePoints = Math.max(1, winnerScore - 25);
    const dampenerStep = Number(cfg.closeOvertimeDampenerStep) || DEFAULT_RATING_OPTIONS.closeOvertimeDampenerStep;
    const dampenerMin = Number(cfg.closeOvertimeDampenerMin) || DEFAULT_RATING_OPTIONS.closeOvertimeDampenerMin;

    closeOvertimeDampener = clamp(
      1 - overtimePoints * dampenerStep,
      dampenerMin,
      1
    );
  }

  return {
    marginFactor: blowoutBonusFactor * closeOvertimeDampener,
    blowoutBonusFactor,
    closeOvertimeDampener,
    pointDiff,
    winnerScore,
    loserScore,
    isCloseOvertime,
  };
}`;

const tempDir = join(tmpdir(), 'volleyball-margin-grid');
mkdirSync(tempDir, { recursive: true });
const tempPath = join(tempDir, `ratings-grid-${Date.now()}.mjs`);
writeFileSync(tempPath, source.slice(0, start) + replacement + '\n\n' + source.slice(end));

const ratings = await import(pathToFileURL(tempPath).href);
const {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  getScoreMarginFactor,
  toDisplayRating,
} = ratings;

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
    finalUpdateMultiplier: entry.finalUpdateMultiplier,
    shivDelta: delta(SHIV_ID),
    nikiDelta: delta(NIKI_ID),
  };
}

function powerVariant(maxMarginBonus, marginBonusScale, marginBonusPower) {
  return {
    family: 'power',
    label: `power cap${maxMarginBonus.toFixed(2)} scale${marginBonusScale.toFixed(2)} pow${marginBonusPower.toFixed(2)}`,
    options: { maxMarginBonus, marginBonusScale, marginBonusPower },
  };
}

function logisticVariant(maxMarginBonus, midpoint, steepness) {
  return {
    family: 'logistic',
    label: `logistic cap${maxMarginBonus.toFixed(2)} mid${midpoint.toFixed(1)} k${steepness.toFixed(2)}`,
    options: {
      _marginFormula: 'logistic',
      maxMarginBonus,
      _marginLogisticMidpoint: midpoint,
      _marginLogisticSteepness: steepness,
    },
  };
}

const variants = [
  { family: 'none', label: 'no score margin', options: { useScoreMargin: false } },
  { family: 'current', label: 'current cap0.40 scale4 pow1.5', options: {} },
];

for (const cap of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40]) {
  for (const scale of [0.75, 1.0, 1.5, 2.0, 4.0]) {
    for (const power of [1.0, 1.5, 2.0]) {
      variants.push(powerVariant(cap, scale, power));
    }
  }
}

for (const cap of [0.10, 0.15, 0.20, 0.25, 0.30, 0.40]) {
  for (const midpoint of [5, 7, 9, 12]) {
    for (const steepness of [0.25, 0.45, 0.70, 0.90]) {
      variants.push(logisticVariant(cap, midpoint, steepness));
    }
  }
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

console.log(`DB: ${sourceLabel}`);
console.log(`variants=${variants.length} qualityGames=${games.filter(isQualityGame).length}`);
console.log('This exact sweep may take a while because play-forward replays before each quality game.');
console.log('');

const rows = [];
let completed = 0;
const started = Date.now();

for (const variant of variants) {
  const forward = computeForwardQuality(variant.options);
  const back = computeBackQuality(variant.options);
  const impact = getTargetImpact(variant.options);
  rows.push({
    ...variant,
    forward,
    back,
    impact,
    accIQ: computeAccIQ({ forward, back }),
    factor2510: getScoreMarginFactor(25, 10, variant.options),
    factor2515: getScoreMarginFactor(25, 15, variant.options),
    factor2523: getScoreMarginFactor(25, 23, variant.options),
  });

  completed += 1;
  if (completed % 50 === 0 || completed === variants.length) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.error(`completed ${completed}/${variants.length} in ${elapsed}s`);
  }
}

function printRows(title, selected, limit = 12) {
  console.log(title);
  console.log([
    'label'.padEnd(38),
    'fwdAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'fwdMAE'.padStart(7),
    'backAcc'.padStart(8),
    'backBrier'.padStart(9),
    'backMAE'.padStart(7),
    'AccIQ'.padStart(7),
    'dIQ'.padStart(7),
    '25-10'.padStart(6),
    'Shiv'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(120));
  selected.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, 38).padEnd(38),
      pct(row.forward.accuracy).padStart(7),
      fmt(row.forward.brier).padStart(9),
      fmt(row.forward.marginMAE).padStart(7),
      pct(row.back.accuracy).padStart(8),
      fmt(row.back.brier).padStart(9),
      fmt(row.back.marginMAE).padStart(7),
      fmt(row.accIQ, 2).padStart(7),
      fmt(row.accIQDelta, 2).padStart(7),
      fmt(row.factor2510).padStart(6),
      fmt(row.impact?.shivDelta, 1).padStart(7),
    ].join(' '));
  });
  console.log('');
}

attachAccIQDeltas(rows, row => row.family === 'current');
const byAccIQ = [...rows].sort(compareAccIQDesc);
const byForwardBrier = [...rows].sort((a, b) => a.forward.brier - b.forward.brier);
const byForwardMae = [...rows].sort((a, b) => a.forward.marginMAE - b.forward.marginMAE);
const byBackBrier = [...rows].sort((a, b) => a.back.brier - b.back.brier);
const byFamilyBest = family => [...rows]
  .filter(row => row.family === family)
  .sort(compareAccIQDesc);

printRows('Best AccIQ candidates', byAccIQ, 15);
printRows('Best forward Brier candidates', byForwardBrier, 10);
printRows('Best forward margin-MAE candidates', byForwardMae, 10);
printRows('Best back Brier candidates', byBackBrier, 10);
printRows('Best power candidates', byFamilyBest('power'), 10);
printRows('Best logistic candidates', byFamilyBest('logistic'), 10);

const current = rows.find(row => row.family === 'current');
const none = rows.find(row => row.family === 'none');

console.log('Baselines');
[current, none].forEach(row => {
  console.log(`${row.label}: fwdAcc=${pct(row.forward.accuracy)} fwdBrier=${fmt(row.forward.brier)} fwdMAE=${fmt(row.forward.marginMAE)} AccIQ=${fmt(row.accIQ, 2)} dIQ=${fmt(row.accIQDelta, 2)} backBrier=${fmt(row.back.brier)} 25-10=${fmt(row.factor2510)} Shiv=${fmt(row.impact?.shivDelta, 1)}`);
});
