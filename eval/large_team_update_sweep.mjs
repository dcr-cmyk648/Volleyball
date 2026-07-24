// Forward sweep for the per-player rating-update damper used when team size
// exceeds the configured reference size.
//
// Run from the repository root:
//   VBALL_DB=/absolute/path/to/default_database npm run sweep:large-team-updates

import { loadDatabase } from './database.mjs';
import {
  DEFAULT_RATING_OPTIONS,
  getGamesSortedOldestFirst,
  replayRatings,
  scoreVolleyballCandidateSplit,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();
const seasonalTaperDays = Math.round(6 * 30.4375);
const sortedGames = getGamesSortedOldestFirst(games);

function parseList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
  return values.length ? values : fallback;
}

function isQualityGame(game) {
  return Boolean(
    game &&
    !game.isLeagueGame &&
    Array.isArray(game.redTeam) &&
    game.redTeam.length &&
    Array.isArray(game.blueTeam) &&
    game.blueTeam.length &&
    Number.isFinite(Number(game.scoreRed)) &&
    Number.isFinite(Number(game.scoreBlue)) &&
    (game.winner === 'red' || game.winner === 'blue')
  );
}

function getGameSideSizes(game) {
  const red = Array.isArray(game?.redTeam) ? game.redTeam.length : 0;
  const blue = game?.isLeagueGame
    ? Math.max(0, Number(game?.leagueOpponent?.size) || red)
    : Array.isArray(game?.blueTeam)
      ? game.blueTeam.length
      : 0;
  return [red, blue];
}

function isMassiveGame(game) {
  return Math.max(...getGameSideSizes(game)) >= 7;
}

function getRealPlayerIds(game) {
  const ids = new Set((game?.redTeam || []).map(player => String(player.id)));
  if (!game?.isLeagueGame) {
    (game?.blueTeam || []).forEach(player => ids.add(String(player.id)));
  }
  return ids;
}

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    logLossSum: 0,
    confidenceSum: 0,
  };
}

function addPrediction(stats, redProbability, game) {
  const probability = Math.max(0.001, Math.min(0.999, Number(redProbability)));
  if (!Number.isFinite(probability)) return;
  const yRed = game.winner === 'red' ? 1 : 0;
  stats.n += 1;
  stats.correct += (probability >= 0.5 ? 'red' : 'blue') === game.winner ? 1 : 0;
  stats.brierSum += (probability - yRed) ** 2;
  stats.logLossSum += -(yRed * Math.log(probability) + (1 - yRed) * Math.log(1 - probability));
  stats.confidenceSum += Math.max(probability, 1 - probability);
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n ? stats.correct / stats.n : null,
    brier: stats.n ? stats.brierSum / stats.n : null,
    logLoss: stats.n ? stats.logLossSum / stats.n : null,
    confidence: stats.n ? stats.confidenceSum / stats.n : null,
  };
}

function replayFor(priorGames, options) {
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

function evaluate(referenceSize, exponent) {
  const options = {
    seasonalTaperDays,
    leagueUpdateMultiplier: DEFAULT_RATING_OPTIONS.leagueUpdateMultiplier,
    leagueMuUpdateMultiplier: DEFAULT_RATING_OPTIONS.leagueMuUpdateMultiplier,
    leagueSigmaUpdateMultiplier: DEFAULT_RATING_OPTIONS.leagueSigmaUpdateMultiplier,
    largeTeamUpdateDampingReferenceSize: referenceSize,
    largeTeamUpdateDampingExponent: exponent,
  };
  const priorGames = [];
  const exposedPlayerIds = new Set();
  const all = createStats();
  const massiveTargets = createStats();
  const exposedTargets = createStats();
  const recentTargets = createStats();
  const latestDates = sortedGames
    .map(game => game?.date)
    .filter(Boolean)
    .sort()
    .slice(-60);
  const recentCutoff = latestDates[0] || '';

  for (const game of sortedGames) {
    if (isQualityGame(game)) {
      const replay = replayFor(priorGames, options);
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: replay.ratingMap,
        carryScoreMap: replay.carryMap || {},
        options,
      });
      const probability = score.redWinProbability;
      addPrediction(all, probability, game);
      if (isMassiveGame(game)) addPrediction(massiveTargets, probability, game);
      if ([...getRealPlayerIds(game)].some(id => exposedPlayerIds.has(id))) {
        addPrediction(exposedTargets, probability, game);
      }
      if (game.date >= recentCutoff) addPrediction(recentTargets, probability, game);
    }

    priorGames.push(game);
    if (isMassiveGame(game)) {
      getRealPlayerIds(game).forEach(id => exposedPlayerIds.add(id));
    }
  }

  const finalReplay = replayFor(sortedGames, options);
  return {
    referenceSize,
    exponent,
    all: summarize(all),
    massiveTargets: summarize(massiveTargets),
    exposedTargets: summarize(exposedTargets),
    recentTargets: summarize(recentTargets),
    standings: finalReplay.standings
      .filter(row => !String(row.id).startsWith('league_team'))
      .sort((a, b) => b.rawOrdinal - a.rawOrdinal),
  };
}

function fmt(value, digits = 4) {
  return value === null || !Number.isFinite(Number(value))
    ? 'n/a'
    : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value))
    ? 'n/a'
    : `${(Number(value) * 100).toFixed(1)}%`;
}

const referenceSizes = parseList('LARGE_TEAM_REFERENCE_SIZES', [5, 6, 7]);
const exponents = parseList('LARGE_TEAM_DAMPING_EXPONENTS', [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5]);
const rows = [];

console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} massiveGames=${games.filter(isMassiveGame).length}`);
console.log(`qualityTargets=${games.filter(isQualityGame).length} massiveQualityTargets=${games.filter(game => isQualityGame(game) && isMassiveGame(game)).length}`);

for (const referenceSize of referenceSizes) {
  for (const exponent of exponents) {
    console.error(`evaluating reference=${referenceSize} exponent=${exponent}`);
    rows.push(evaluate(referenceSize, exponent));
  }
}

const baseline = rows.find(row => row.referenceSize === 6 && row.exponent === 1);
if (!baseline) throw new Error('The sweep must include the production baseline reference=6 exponent=1.');
const baselineTop10 = new Set(baseline.standings.slice(0, 10).map(row => String(row.id)));

rows.forEach(row => {
  row.allBrierDelta = Number(row.all.brier) - Number(baseline.all.brier);
  row.exposedBrierDelta = Number(row.exposedTargets.brier) - Number(baseline.exposedTargets.brier);
  row.recentBrierDelta = Number(row.recentTargets.brier) - Number(baseline.recentTargets.brier);
  row.top10Overlap = row.standings.slice(0, 10)
    .filter(player => baselineTop10.has(String(player.id)))
    .length;
});

rows.sort((a, b) => {
  const allDelta = Number(a.all.brier) - Number(b.all.brier);
  if (Math.abs(allDelta) > 1e-12) return allDelta;
  return Number(a.exposedTargets.brier) - Number(b.exposedTargets.brier);
});

console.log('');
console.log([
  'ref'.padStart(3),
  'exp'.padStart(5),
  'all n'.padStart(5),
  'all acc'.padStart(8),
  'all brier'.padStart(10),
  'd all'.padStart(9),
  'exposed n'.padStart(9),
  'exp brier'.padStart(10),
  'd exp'.padStart(9),
  'recent n'.padStart(8),
  'rec brier'.padStart(10),
  'd rec'.padStart(9),
  'mass n'.padStart(6),
  'mass brier'.padStart(11),
  'top10'.padStart(6),
].join(' '));

rows.forEach(row => {
  console.log([
    String(row.referenceSize).padStart(3),
    fmt(row.exponent, 2).padStart(5),
    String(row.all.n).padStart(5),
    pct(row.all.accuracy).padStart(8),
    fmt(row.all.brier).padStart(10),
    fmt(row.allBrierDelta).padStart(9),
    String(row.exposedTargets.n).padStart(9),
    fmt(row.exposedTargets.brier).padStart(10),
    fmt(row.exposedBrierDelta).padStart(9),
    String(row.recentTargets.n).padStart(8),
    fmt(row.recentTargets.brier).padStart(10),
    fmt(row.recentBrierDelta).padStart(9),
    String(row.massiveTargets.n).padStart(6),
    fmt(row.massiveTargets.brier).padStart(11),
    `${row.top10Overlap}/10`.padStart(6),
  ].join(' '));
});
