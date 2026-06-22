// Forward-only sweep for the Stats > Season > Season Ranking board.
//
// This mirrors the page's Season Ranking replay shape:
// - seasonal replay
// - volleyballAdjusted enabled
// - league games included in the rating history
// - non-league completed games used as forward prediction targets

import { loadDatabase } from './database.mjs';
import { computeFwdAccIQ } from './metrics.mjs';
import {
  replayRatings,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  DEFAULT_RATING_OPTIONS,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const SEASON_MONTHS = Number(process.env.SEASON_RANKING_MONTHS) || 6;
const seasonalTaperDays = Math.round(SEASON_MONTHS * 30.4375);
const printLimit = Math.max(1, Number(process.env.SEASON_RANKING_PRINT_LIMIT) || 20);

const baseSeasonRankingOptions = {
  seasonalTaperDays,
  leagueUpdateMultiplier: 1.5,
  leagueMuUpdateMultiplier: 1,
  leagueSigmaUpdateMultiplier: 0.8,
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

function replayFor(options, priorGames = games) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: true,
    volleyballUpdateUsesBalancerContext: true,
    volleyballUpdateContextMode: 'pair',
    includeLeagueGames: true,
    options,
  });
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

function computeForwardQuality(options) {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const stats = createStats();

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const prior = replayFor(options, priorGames);
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: prior.ratingMap,
        carryScoreMap: prior.carryMap || {},
        options,
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

function fwdAccuracyScore(summary) {
  return summary.accuracy === null ? null : Number(summary.accuracy) * 100;
}

function evaluate(label, overrides = {}) {
  const options = {
    ...baseSeasonRankingOptions,
    ...overrides,
  };
  const forward = computeForwardQuality(options);
  return {
    label,
    options,
    forward,
    fwdAccuracyScore: fwdAccuracyScore(forward),
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

function compactOptions(options) {
  const entries = Object.entries(options)
    .filter(([key, value]) => baseSeasonRankingOptions[key] !== value)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? Object.fromEntries(entries) : {};
}

function candidateKey(options) {
  return JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)));
}

const candidateKeys = new Set();
const candidates = [];

function addCandidate(label, overrides = {}) {
  const options = { ...baseSeasonRankingOptions, ...overrides };
  const key = candidateKey(options);
  if (candidateKeys.has(key)) return;
  candidateKeys.add(key);
  candidates.push({ label, overrides });
}

function addOneAtATime(name, values) {
  values.forEach(value => addCandidate(`${name}=${String(value)}`, { [name]: value }));
}

addCandidate('current season ranking', {});

addOneAtATime('useScoreMargin', [false, true]);
addOneAtATime('maxMarginBonus', parseListEnv('SWEEP_MAX_MARGIN_BONUS', [0, 0.05, 0.1, 0.15, 0.2]));
addOneAtATime('marginLogisticMidpoint', parseListEnv('SWEEP_MARGIN_MIDPOINTS', [8, 10, 12, 14, 16]));
addOneAtATime('marginLogisticSteepness', parseListEnv('SWEEP_MARGIN_STEEPNESS', [0.5, 0.7, 0.9, 1.1, 1.3]));
addOneAtATime('closeOvertimeDampenerStep', parseListEnv('SWEEP_CLOSE_STEPS', [0, 0.03, 0.06, 0.1]));
addOneAtATime('burnInGames', parseListEnv('SWEEP_BURN_GAMES', [0, 2, 3, 5, 8]));
parseListEnv('SWEEP_BURN_GAMES', [2, 3, 5, 8]).forEach(burnInGames => {
  parseListEnv('SWEEP_BURN_MULTS', [1.25, 1.5, 2]).forEach(burnInMultiplier => {
    addCandidate(`burn ${burnInGames}x${burnInMultiplier}`, { burnInGames, burnInMultiplier });
  });
});
addOneAtATime('calibrationGames', parseListEnv('SWEEP_CALIBRATION_GAMES', [0, 5, 10, 15, 20]));
addOneAtATime('openSkillScoreMode', ['binary', 'score']);
addOneAtATime('openSkillBetaMultiplier', parseListEnv('SWEEP_BETA_MULTS', [0.6, 0.75, 1, 1.25, 1.5, 2]));
addOneAtATime('openSkillTau', [null, 0, 0.02, 0.05, 0.1]);
addOneAtATime('openSkillPreventSigmaIncrease', [false, true]);
addOneAtATime('streakProtectionEnabled', [false, true]);
addOneAtATime('streakProtectionThresholdRaw', parseListEnv('SWEEP_STREAK_THRESHOLDS', [1, 1.5, 2, 2.5, 3]));
addOneAtATime('streakProtectionMinMultiplier', parseListEnv('SWEEP_STREAK_MIN_MULTS', [0.1, 0.25, 0.4, 0.6]));
addOneAtATime('sessionProtectionEnabled', [false, true]);

const leagueUpdateMultipliers = parseListEnv('SWEEP_LEAGUE_UPDATES', [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5]);
const leagueMuMultipliers = parseListEnv('SWEEP_LEAGUE_MU', [0, 0.5, 0.8, 1, 1.25]);
const leagueSigmaMultipliers = parseListEnv('SWEEP_LEAGUE_SIGMA', [0.4, 0.6, 0.8, 1, 1.2]);
leagueUpdateMultipliers.forEach(leagueUpdateMultiplier => {
  addCandidate(`leagueUpdateMultiplier=${leagueUpdateMultiplier}`, { leagueUpdateMultiplier });
  leagueMuMultipliers.forEach(leagueMuUpdateMultiplier => {
    leagueSigmaMultipliers.forEach(leagueSigmaUpdateMultiplier => {
      addCandidate(
        `league split lu${leagueUpdateMultiplier} mu${leagueMuUpdateMultiplier} sig${leagueSigmaUpdateMultiplier}`,
        { leagueUpdateMultiplier, leagueMuUpdateMultiplier, leagueSigmaUpdateMultiplier }
      );
    });
  });
});

['context', 'pooled', 'level'].forEach(leagueTeamRatingMode => {
  addCandidate(`leagueTeamRatingMode=${leagueTeamRatingMode}`, { leagueTeamRatingMode });
  parseListEnv('SWEEP_LEAGUE_OPPONENT_MULTS', [0, 0.5, 1, 1.5, 2, 3, 4]).forEach(leagueOpponentUpdateMultiplier => {
    addCandidate(
      `${leagueTeamRatingMode} opponent x${leagueOpponentUpdateMultiplier}`,
      { leagueTeamRatingMode, leagueOpponentUpdateMultiplier }
    );
  });
});

['matched', 'dayMatchedOffset'].forEach(leagueOpponentModel => {
  addCandidate(`leagueOpponentModel=${leagueOpponentModel}`, { leagueOpponentModel });
});
parseListEnv('SWEEP_DAY_OFFSET_TRUSTS', [0.25, 0.5, 0.75, 1]).forEach(leagueDayOffsetTrust => {
  addCandidate(`dayMatchedOffset trust ${leagueDayOffsetTrust}`, {
    leagueOpponentModel: 'dayMatchedOffset',
    leagueDayOffsetTrust,
  });
});

parseListEnv('SWEEP_PREGAME_BAYES_SIGMAS', [1, 2, 4]).forEach(leaguePregameBayesianSigma => {
  ['incrementalGrid', 'history'].forEach(leaguePregameBayesianMode => {
    addCandidate(`pregame bayes ${leaguePregameBayesianMode} sigma ${leaguePregameBayesianSigma}`, {
      leaguePregameBayesianEnabled: true,
      leaguePregameBayesianMode,
      leaguePregameBayesianSigma,
    });
  });
});
parseListEnv('SWEEP_PREGAME_SHRINK_GAMES', [4, 8, 12, 20]).forEach(leaguePregameShrinkGames => {
  parseListEnv('SWEEP_PREGAME_SHRINK_POWERS', [0.75, 1, 1.25]).forEach(leaguePregameShrinkPower => {
    addCandidate(`pregame shrink g${leaguePregameShrinkGames} p${leaguePregameShrinkPower}`, {
      leaguePregameShrinkEnabled: true,
      leaguePregameShrinkGames,
      leaguePregameShrinkPower,
    });
  });
});
parseListEnv('SWEEP_PREGAME_SIGMA_FLOORS', [DEFAULT_RATING_OPTIONS.sigma, DEFAULT_RATING_OPTIONS.sigma * 1.5, DEFAULT_RATING_OPTIONS.sigma * 2]).forEach(leaguePregameSigmaFloor => {
  addCandidate(`pregame sigma floor ${leaguePregameSigmaFloor.toFixed(2)}`, {
    leaguePregameSigmaEnabled: true,
    leaguePregameSigmaFloor,
  });
});

const started = Date.now();
console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} qualityTargets=${games.filter(isQualityGame).length}`);
console.log(`seasonMonths=${SEASON_MONTHS} seasonalTaperDays=${seasonalTaperDays}`);
console.log(`uniqueCandidates=${candidates.length}`);

const rows = candidates.map((candidate, index) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`evaluating ${index + 1}/${candidates.length}: ${candidate.label} (${elapsed}s)`);
  return evaluate(candidate.label, candidate.overrides);
});

const baseline = rows.find(row => row.label === 'current season ranking');
rows.forEach(row => {
  row.accuracyDelta = Number(row.forward.accuracy) - Number(baseline.forward.accuracy);
  row.brierDelta = Number(row.forward.brier) - Number(baseline.forward.brier);
  row.fwdAccIQDelta = Number(row.fwdAccIQ) - Number(baseline.fwdAccIQ);
});

function compareForwardAccuracy(a, b) {
  const accDelta = Number(b.forward.accuracy) - Number(a.forward.accuracy);
  if (Math.abs(accDelta) > 1e-12) return accDelta;
  const brierDelta = Number(a.forward.brier) - Number(b.forward.brier);
  if (Math.abs(brierDelta) > 1e-12) return brierDelta;
  return Number(b.fwdAccIQ) - Number(a.fwdAccIQ);
}

function compareBrier(a, b) {
  return Number(a.forward.brier) - Number(b.forward.brier);
}

function printRows(title, sortedRows, limit = printLimit) {
  const labelWidth = 58;
  console.log('');
  console.log(title);
  console.log([
    'label'.padEnd(labelWidth),
    'fwdAcc'.padStart(7),
    'dAcc'.padStart(7),
    'fwdBrier'.padStart(9),
    'dBrier'.padStart(9),
    'conf'.padStart(7),
    'FwdIQ'.padStart(7),
    'dFwd'.padStart(7),
    'options',
  ].join(' '));
  console.log('-'.repeat(labelWidth + 90));
  sortedRows.slice(0, limit).forEach(row => {
    console.log([
      row.label.slice(0, labelWidth).padEnd(labelWidth),
      pct(row.forward.accuracy).padStart(7),
      `${(row.accuracyDelta * 100).toFixed(1)}%`.padStart(7),
      fmt(row.forward.brier).padStart(9),
      fmt(row.brierDelta).padStart(9),
      pct(row.forward.averageConfidence).padStart(7),
      fmt(row.fwdAccIQ, 2).padStart(7),
      fmt(row.fwdAccIQDelta, 2).padStart(7),
      JSON.stringify(compactOptions(row.options)),
    ].join(' '));
  });
}

printRows('Baseline', [baseline], 1);
printRows('Best by raw forward accuracy', [...rows].sort(compareForwardAccuracy));
printRows('Best by forward Brier', [...rows].sort(compareBrier));
printRows('Best by FwdAccIQ', [...rows].sort((a, b) => Number(b.fwdAccIQ) - Number(a.fwdAccIQ)));
