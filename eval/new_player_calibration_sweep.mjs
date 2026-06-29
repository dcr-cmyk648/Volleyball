// Eval-only sweep for new/provisional player calibration.
//
// This focuses on forward prediction quality for games involving players with
// limited prior history, especially players whose eventual rating is far from
// the population average. It does not change production code.

import { loadDatabase } from './database.mjs';
import {
  getGamesSortedOldestFirst,
  replayRatings,
  scoreVolleyballCandidateSplit,
  getRawOrdinal,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const PROVISIONAL_GAMES = Number(process.env.NEW_PLAYER_PROVISIONAL_GAMES || 8);
const OUTLIER_RAW = Number(process.env.NEW_PLAYER_OUTLIER_RAW || 3);
const PRINT_LIMIT = Number(process.env.NEW_PLAYER_PRINT_LIMIT || 18);

const baseRatingOptions = {
  seasonalTaperDays,
};

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
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

function getPlayerIds(game) {
  return [...(game.redTeam || []), ...(game.blueTeam || [])]
    .map(player => String(player.id));
}

function cloneSkill(skill) {
  return skill ? { mu: skill.mu, sigma: skill.sigma } : skill;
}

function playerName(id) {
  return players.find(player => String(player.id) === String(id))?.name || String(id);
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function getFinalRawMap() {
  const replay = replayRatings({
    players,
    games,
    seasonal: true,
    volleyballAdjusted: true,
    includeLeagueGames: true,
    options: baseRatingOptions,
  });
  const map = new Map();
  players.forEach(player => {
    const skill = replay.ratingMap[String(player.id)] || replay.ratingMap[player.id];
    if (skill) map.set(String(player.id), getRawOrdinal(skill, baseRatingOptions));
  });
  return map;
}

const finalRawMap = getFinalRawMap();
const finalRawValues = [...finalRawMap.values()];
const finalRawAverage = mean(finalRawValues);
const outlierIds = new Set(
  [...finalRawMap.entries()]
    .filter(([, raw]) => Math.abs(raw - finalRawAverage) >= OUTLIER_RAW)
    .map(([id]) => id)
);

function createStats() {
  return {
    n: 0,
    correct: 0,
    brier: 0,
    logLoss: 0,
    confidence: 0,
    scored: 0,
    margin: 0,
    blowouts8: 0,
    blowouts10: 0,
  };
}

function record(stats, game, probability, winner) {
  const p = Math.min(0.999999, Math.max(0.000001, Number(probability)));
  if (!Number.isFinite(p)) return;
  const y = winner === 'red' ? 1 : 0;
  stats.n += 1;
  stats.correct += (p >= 0.5 ? 'red' : 'blue') === winner ? 1 : 0;
  stats.brier += (p - y) ** 2;
  stats.logLoss += y ? -Math.log(p) : -Math.log(1 - p);
  stats.confidence += Math.max(p, 1 - p);

  if (typeof game?.scoreRed === 'number' && typeof game?.scoreBlue === 'number') {
    const margin = Math.abs(game.scoreRed - game.scoreBlue);
    stats.scored += 1;
    stats.margin += margin;
    stats.blowouts8 += margin > 8 ? 1 : 0;
    stats.blowouts10 += margin > 10 ? 1 : 0;
  }
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brier / stats.n : null,
    logLoss: stats.n ? stats.logLoss / stats.n : null,
    confidence: stats.n ? stats.confidence / stats.n : null,
    scored: stats.scored,
    avgMargin: stats.scored ? stats.margin / stats.scored : null,
    blowout8Rate: stats.scored ? stats.blowouts8 / stats.scored : null,
    blowout10Rate: stats.scored ? stats.blowouts10 / stats.scored : null,
  };
}

function addGameCounts(counts, game) {
  getPlayerIds(game).forEach(id => {
    counts.set(id, (counts.get(id) || 0) + 1);
  });
}

function updateBootstrapState(state, game, probability) {
  const yRed = game.winner === 'red' ? 1 : 0;
  const redResidual = yRed - probability;
  const blueResidual = (1 - yRed) - (1 - probability);

  (game.redTeam || []).forEach(player => {
    const id = String(player.id);
    const current = state.get(id) || { residual: 0, games: 0 };
    current.residual += redResidual;
    current.games += 1;
    state.set(id, current);
  });
  (game.blueTeam || []).forEach(player => {
    const id = String(player.id);
    const current = state.get(id) || { residual: 0, games: 0 };
    current.residual += blueResidual;
    current.games += 1;
    state.set(id, current);
  });
}

function applyBootstrapAdjustment(ratingMap, counts, bootstrapState, options) {
  const scale = Number(options.bootstrapScale) || 0;
  if (!scale) return ratingMap;

  const shrinkage = Math.max(0, Number(options.bootstrapShrinkage) || 0);
  const cap = Math.max(0, Number(options.bootstrapCapRaw) || 0);
  const adjusted = { ...ratingMap };

  players.forEach(player => {
    const id = String(player.id);
    const priorGames = counts.get(id) || 0;
    if (priorGames <= 0 || priorGames >= PROVISIONAL_GAMES) return;

    const state = bootstrapState.get(id);
    const skill = ratingMap[id];
    if (!state || !skill) return;

    const confidence = state.games / (state.games + shrinkage);
    const rawAdjustment = Math.max(-cap, Math.min(cap, state.residual * scale * confidence));
    adjusted[id] = {
      ...cloneSkill(skill),
      mu: skill.mu + rawAdjustment,
    };
  });

  return adjusted;
}

function evaluate(candidate) {
  const ratingOptions = {
    ...baseRatingOptions,
    ...(candidate.ratingOptions || {}),
  };
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const priorCounts = new Map();
  const bootstrapState = new Map();

  const all = createStats();
  const provisional = createStats();
  const outlier = createStats();
  const early = createStats();
  const smallTeam = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const replay = replayRatings({
        players,
        games: priorGames,
        seasonal: true,
        volleyballAdjusted: true,
        includeLeagueGames: true,
        options: ratingOptions,
        volleyballOptions: candidate.volleyballOptions || {},
      });
      const ratingMap = applyBootstrapAdjustment(
        replay.ratingMap,
        priorCounts,
        bootstrapState,
        candidate
      );
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap,
        carryScoreMap: replay.carryMap || {},
        options: ratingOptions,
        volleyballOptions: candidate.volleyballOptions || {},
      });
      const p = Number(score.redWinProbability);
      const ids = getPlayerIds(game);
      const priorGameValues = ids.map(id => priorCounts.get(id) || 0);
      const hasProvisional = priorGameValues.some(count => count < PROVISIONAL_GAMES);
      const hasBrandNew = priorGameValues.some(count => count === 0);
      const hasOutlier = ids.some(id => outlierIds.has(id) && (priorCounts.get(id) || 0) < PROVISIONAL_GAMES);
      const newOnSmallSide = (
        game.redTeam.length <= 3 &&
        game.redTeam.some(player => (priorCounts.get(String(player.id)) || 0) < PROVISIONAL_GAMES)
      ) || (
        game.blueTeam.length <= 3 &&
        game.blueTeam.some(player => (priorCounts.get(String(player.id)) || 0) < PROVISIONAL_GAMES)
      );

      record(all, game, p, game.winner);
      if (hasProvisional) record(provisional, game, p, game.winner);
      if (hasBrandNew) record(early, game, p, game.winner);
      if (hasOutlier) record(outlier, game, p, game.winner);
      if (newOnSmallSide) record(smallTeam, game, p, game.winner);

      if (Number.isFinite(p)) {
        updateBootstrapState(bootstrapState, game, p);
      }
    }

    addGameCounts(priorCounts, game);
    priorGames.push(game);
  });

  return {
    ...candidate,
    all: summarize(all),
    provisional: summarize(provisional),
    outlier: summarize(outlier),
    early: summarize(early),
    smallTeam: summarize(smallTeam),
  };
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(1)}%`;
}

function delta(value, base, digits = 3) {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(base))) return 'n/a';
  const diff = Number(value) - Number(base);
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(digits)}`;
}

function configFor(row) {
  const config = {};
  if (row.ratingOptions && Object.keys(row.ratingOptions).length) config.rating = row.ratingOptions;
  if (row.bootstrapScale) {
    config.bootstrap = {
      scale: row.bootstrapScale,
      shrinkage: row.bootstrapShrinkage,
      capRaw: row.bootstrapCapRaw,
    };
  }
  return JSON.stringify(config);
}

function printRows(title, rows, baseline, metric = 'provisional', limit = PRINT_LIMIT) {
  console.log(`\n${title}`);
  console.log([
    'label'.padEnd(34),
    'allAcc'.padStart(7),
    'provAcc'.padStart(8),
    'dProv'.padStart(7),
    'provBr'.padStart(8),
    'dBr'.padStart(8),
    'provBO8'.padStart(8),
    'provMgn'.padStart(8),
    'outAcc'.padStart(8),
    'earlyAcc'.padStart(8),
    'smallAcc'.padStart(8),
    'config',
  ].join(' '));
  console.log('-'.repeat(132));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, 34).padEnd(34),
      pct(row.all.accuracy).padStart(7),
      pct(row.provisional.accuracy).padStart(8),
      `${((Number(row.provisional.accuracy) - Number(baseline.provisional.accuracy)) * 100).toFixed(1)}%`.padStart(7),
      fmt(row.provisional.brier).padStart(8),
      delta(row.provisional.brier, baseline.provisional.brier).padStart(8),
      pct(row.provisional.blowout8Rate).padStart(8),
      fmt(row.provisional.avgMargin, 2).padStart(8),
      pct(row.outlier.accuracy).padStart(8),
      pct(row.early.accuracy).padStart(8),
      pct(row.smallTeam.accuracy).padStart(8),
      configFor(row),
    ].join(' '));
  });
}

const candidates = [
  { label: 'current default' },
];

parseListEnv('NEW_BURN_GAMES', [0, 3, 5, 8, 10]).forEach(burnInGames => {
  parseListEnv('NEW_BURN_MULTS', [1, 1.5, 2, 2.5]).forEach(burnInMultiplier => {
    if (burnInGames === 0 && burnInMultiplier !== 1) return;
    if (burnInGames > 0 && burnInMultiplier === 1) return;
    candidates.push({
      label: `burn ${burnInGames}x${burnInMultiplier}`,
      ratingOptions: { burnInGames, burnInMultiplier },
    });
  });
});

parseListEnv('NEW_CALIBRATION_GAMES', [0, 5, 10, 15, 20, 25]).forEach(calibrationGames => {
  candidates.push({
    label: `calibration ${calibrationGames}`,
    ratingOptions: { calibrationGames },
  });
});

for (const burnInGames of parseListEnv('NEW_BURN_COMBO_GAMES', [5, 8, 10])) {
  for (const burnInMultiplier of parseListEnv('NEW_BURN_COMBO_MULTS', [1.5, 2, 2.5])) {
    for (const calibrationGames of parseListEnv('NEW_CALIBRATION_COMBO_GAMES', [0, 10, 15, 20])) {
      candidates.push({
        label: `burn ${burnInGames}x${burnInMultiplier} cal${calibrationGames}`,
        ratingOptions: { burnInGames, burnInMultiplier, calibrationGames },
      });
    }
  }
}

for (const bootstrapScale of parseListEnv('NEW_BOOTSTRAP_SCALES', [0.5, 1, 1.5, 2, 3, 4])) {
  for (const bootstrapShrinkage of parseListEnv('NEW_BOOTSTRAP_SHRINKAGES', [1, 3, 5, 8])) {
    candidates.push({
      label: `bootstrap s${bootstrapScale} sh${bootstrapShrinkage}`,
      bootstrapScale,
      bootstrapShrinkage,
      bootstrapCapRaw: 4,
    });
  }
}

if (process.env.NEW_INCLUDE_MARGIN !== '0') {
  parseListEnv('NEW_MARGIN_BURN_GAMES', [3, 5, 8]).forEach(burnInGames => {
    parseListEnv('NEW_MARGIN_BURN_MULTS', [1.5, 2]).forEach(burnInMultiplier => {
      parseListEnv('NEW_MARGIN_MAX_BONUS', [0.05, 0.1, 0.15, 0.2]).forEach(maxMarginBonus => {
        candidates.push({
          label: `margin burn ${burnInGames}x${burnInMultiplier} mb${maxMarginBonus}`,
          ratingOptions: {
            useScoreMargin: true,
            burnInGames,
            burnInMultiplier,
            maxMarginBonus,
          },
        });
      });
    });
  });

  parseListEnv('NEW_MARGIN_ONLY_BONUS', [0.05, 0.1, 0.15, 0.2]).forEach(maxMarginBonus => {
    candidates.push({
      label: `margin default mb${maxMarginBonus}`,
      ratingOptions: {
        useScoreMargin: true,
        maxMarginBonus,
      },
    });
  });
}

console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length}`);
console.log(`provisionalGames=<${PROVISIONAL_GAMES}; outlierRaw>=${OUTLIER_RAW}`);
console.log(`outlierPlayers=${[...outlierIds].map(id => playerName(id)).join(', ') || 'none'}`);
console.log(`candidates=${candidates.length}`);

const rows = candidates.map(evaluate);
const baseline = rows.find(row => row.label === 'current default');

printRows(
  'Best provisional accuracy',
  [...rows].sort((a, b) =>
    Number(b.provisional.accuracy) - Number(a.provisional.accuracy) ||
    Number(a.provisional.brier) - Number(b.provisional.brier)
  ),
  baseline
);

printRows(
  'Best provisional Brier',
  [...rows].sort((a, b) =>
    Number(a.provisional.brier) - Number(b.provisional.brier) ||
    Number(b.provisional.accuracy) - Number(a.provisional.accuracy)
  ),
  baseline
);

printRows(
  'Best outlier provisional accuracy',
  [...rows].sort((a, b) =>
    Number(b.outlier.accuracy) - Number(a.outlier.accuracy) ||
    Number(a.outlier.brier) - Number(b.outlier.brier)
  ),
  baseline
);
