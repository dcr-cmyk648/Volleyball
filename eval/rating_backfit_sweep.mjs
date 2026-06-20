// Rating-section back-fit sweep.
//
// This is intentionally narrower than the balancer harness: it evaluates final
// ratings against completed historical games, so rating-only display knobs can
// be tuned separately from forward team-balance behavior.

import { loadDatabase } from './database.mjs';
import { attachAccIQDeltas, computeAccIQ, computeBackAccIQ, computeFwdAccIQ } from './metrics.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const printLimit = Math.max(1, Number(process.env.RATING_BACKFIT_PRINT_LIMIT) || 20);

const ratingLeagueBase = {
  leagueSeriesAggregationEnabled: true,
  leagueUpdateMultiplier: 1.5,
  leagueMuUpdateMultiplier: 1,
  leagueSigmaUpdateMultiplier: 0.8,
};

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

function parseModesEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
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

function replayFor(options, priorGames = games) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames: true,
    options: {
      seasonalTaperDays,
      ...options,
    },
  });
}

function recordPrediction(stats, game, score, marginModel) {
  const yRed = game.winner === 'red' ? 1 : 0;
  const predictedWinner = score.redWinProbability >= 0.5 ? 'red' : 'blue';

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
  }
}

function evaluateForward(options) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const replay = replayFor(options, priorGames);
      const marginModel = calibrateMarginModel({
        games: priorGames,
        ratingMap: replay.ratingMap,
        carryScoreMap: replay.carryMap || {},
        options,
      });
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: replay.ratingMap,
        carryScoreMap: replay.carryMap || {},
        options,
      });
      recordPrediction(stats, game, score, marginModel);
    }

    priorGames.push(game);
  });

  return summarize(stats);
}

function evaluateBack(options) {
  const replay = replayFor(options);
  const marginModel = calibrateMarginModel({
    games,
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

  return summarize(stats);
}

function printForwardCheckRows(title, rows, limit = rows.length) {
  const labelWidth = 56;
  console.log(title);
  console.log([
    'label'.padEnd(labelWidth),
    'fwdAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'fwdMAE'.padStart(7),
    'FwdIQ'.padStart(7),
    'BackIQ'.padStart(7),
    'AccIQ'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(labelWidth + 64));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, labelWidth).padEnd(labelWidth),
      pct(row.forward.accuracy).padStart(7),
      fmt(row.forward.brier).padStart(9),
      fmt(row.forward.marginMAE).padStart(7),
      fmt(row.fwdAccIQ, 2).padStart(7),
      fmt(row.backAccIQ, 2).padStart(7),
      fmt(row.accIQ, 2).padStart(7),
    ].join(' '));
  });
  console.log('');
}

function fmt(value, digits = 3) {
  return value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function printRows(title, rows, limit = rows.length) {
  const labelWidth = 56;
  console.log(title);
  console.log([
    'label'.padEnd(labelWidth),
    'backAcc'.padStart(8),
    'backBrier'.padStart(9),
    'backMAE'.padStart(7),
    'BackIQ'.padStart(7),
    'dBack'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(labelWidth + 48));
  rows.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, labelWidth).padEnd(labelWidth),
      pct(row.back.accuracy).padStart(8),
      fmt(row.back.brier).padStart(9),
      fmt(row.back.marginMAE).padStart(7),
      fmt(row.backAccIQ, 2).padStart(7),
      fmt(row.backAccIQDelta, 2).padStart(7),
    ].join(' '));
  });
  console.log('');
}

const candidates = [];
const candidateKeys = new Set();

function addCandidate(label, options = {}) {
  const key = JSON.stringify(options);
  if (candidateKeys.has(key)) return;
  candidateKeys.add(key);
  candidates.push({ label, options });
}

addCandidate('current default', {});
addCandidate('rating league base', ratingLeagueBase);

const leagueUpdates = parseListEnv('RATING_LEAGUE_UPDATE_MULTIPLIERS', [1, 1.25, 1.5, 1.75, 2, 2.5]);
const leagueSigmas = parseListEnv('RATING_LEAGUE_SIGMA_MULTIPLIERS', [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2]);
const burnInGamesValues = parseListEnv('RATING_BURN_IN_GAMES', [0, 2, 3, 5, 8]);
const burnInMultipliers = parseListEnv('RATING_BURN_IN_MULTIPLIERS', [1, 1.25, 1.5, 1.75, 2]);
const calibrationGamesValues = parseListEnv('RATING_CALIBRATION_GAMES', [0, 5, 10, 15, 20, 25]);
const seasonalDaysValues = parseListEnv('RATING_SEASONAL_DAYS', [90, 120, 180, 240, 365]);
const betaMultipliers = parseListEnv('RATING_BETA_MULTIPLIERS', [0.5, 0.75, 1, 1.25, 1.5]);
const evidenceModes = parseModesEnv('RATING_EVIDENCE_MODES', ['volleyball', 'baseOnly', 'seasonalOnly', 'none']);

leagueUpdates.forEach(leagueUpdateMultiplier => {
  leagueSigmas.forEach(leagueSigmaUpdateMultiplier => {
    addCandidate(
      `rating league lu${leagueUpdateMultiplier.toFixed(2)} sig${leagueSigmaUpdateMultiplier.toFixed(2)}`,
      {
        ...ratingLeagueBase,
        leagueUpdateMultiplier,
        leagueSigmaUpdateMultiplier,
      }
    );
  });
});

burnInGamesValues.forEach(burnInGames => {
  burnInMultipliers.forEach(burnInMultiplier => {
    if (burnInGames === 0 && burnInMultiplier !== 1) return;
    if (burnInGames > 0 && burnInMultiplier === 1) return;
    addCandidate(`rating burn ${burnInGames}x${burnInMultiplier.toFixed(2)}`, {
      ...ratingLeagueBase,
      burnInGames,
      burnInMultiplier,
    });
  });
});

calibrationGamesValues.forEach(calibrationGames => {
  addCandidate(`rating calibration ${calibrationGames}`, {
    ...ratingLeagueBase,
    calibrationGames,
  });
});

seasonalDaysValues.forEach(days => {
  addCandidate(`rating seasonal ${days}d`, {
    ...ratingLeagueBase,
    seasonalTaperDays: days,
  });
});

betaMultipliers.forEach(openSkillBetaMultiplier => {
  addCandidate(`rating beta ${openSkillBetaMultiplier.toFixed(2)}`, {
    ...ratingLeagueBase,
    openSkillBetaMultiplier,
  });
});

evidenceModes.forEach(openSkillEvidenceMultiplierMode => {
  addCandidate(`rating evidence ${openSkillEvidenceMultiplierMode}`, {
    ...ratingLeagueBase,
    openSkillEvidenceMultiplierMode,
  });
});

for (const burnInGames of burnInGamesValues) {
  for (const burnInMultiplier of burnInMultipliers) {
    if (burnInGames === 0 && burnInMultiplier !== 1) continue;
    if (burnInGames > 0 && burnInMultiplier === 1) continue;
    for (const calibrationGames of calibrationGamesValues) {
      addCandidate(`rating burn ${burnInGames}x${burnInMultiplier.toFixed(2)} cal${calibrationGames}`, {
        ...ratingLeagueBase,
        burnInGames,
        burnInMultiplier,
        calibrationGames,
      });
    }
  }
}

console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} uniqueCandidates=${candidates.length}`);

const rows = candidates.map(candidate => {
  const back = evaluateBack(candidate.options);
  return {
    ...candidate,
    back,
    backAccIQ: computeBackAccIQ(back),
  };
});

attachAccIQDeltas(rows, row => row.label === 'rating league base');

const byBackAccIQ = [...rows].sort((a, b) => (Number(b.backAccIQ) || -Infinity) - (Number(a.backAccIQ) || -Infinity));
const baselines = rows.filter(row => row.label === 'current default' || row.label === 'rating league base');

printRows('Baselines', baselines);
printRows('Best BackAccIQ candidates', byBackAccIQ, printLimit);
printRows('Best back Brier candidates', [...rows].sort((a, b) => a.back.brier - b.back.brier), printLimit);
printRows('Best back margin-MAE candidates', [...rows].sort((a, b) => a.back.marginMAE - b.back.marginMAE), printLimit);

const forwardCheckKeys = new Set();
const forwardCheckRows = [...baselines, ...byBackAccIQ.slice(0, Math.min(printLimit, 12))]
  .filter(row => {
    const key = JSON.stringify(row.options);
    if (forwardCheckKeys.has(key)) return false;
    forwardCheckKeys.add(key);
    return true;
  })
  .map(row => {
    const forward = evaluateForward(row.options);
    return {
      ...row,
      forward,
      fwdAccIQ: computeFwdAccIQ(forward),
      accIQ: computeAccIQ({ forward, back: row.back }),
    };
  });

printForwardCheckRows('Forward sanity check for top back-fit candidates', forwardCheckRows);
