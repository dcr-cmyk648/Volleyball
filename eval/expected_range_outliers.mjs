// Replay-time audit for games whose final score landed outside the model's
// expected margin range. This is eval-only and uses only prior games for each
// prediction.

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
  getRawOrdinal,
  makeInitialRating,
  DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const MIN_PRIOR_MARGIN_GAMES = Number(process.env.OUTLIER_MIN_PRIOR_GAMES || 12);
const Z_THRESHOLD = Number(process.env.OUTLIER_Z || 1);
const MAX_ROWS = Number(process.env.OUTLIER_ROWS || 30);
const BAD_PLAYER_RAW = Number(process.env.OUTLIER_BAD_RAW || 0);
const NEW_PLAYER_GAMES = Number(process.env.OUTLIER_NEW_GAMES || 4);

function isScoredNonLeagueGame(game) {
  return (
    game &&
    !game.isLeagueGame &&
    Array.isArray(game.redTeam) &&
    game.redTeam.length > 0 &&
    Array.isArray(game.blueTeam) &&
    game.blueTeam.length > 0 &&
    typeof game.scoreRed === 'number' &&
    typeof game.scoreBlue === 'number' &&
    (game.winner === 'red' || game.winner === 'blue')
  );
}

function replayFor(priorGames) {
  return replayRatings({
    players,
    games: priorGames,
    seasonal: true,
    volleyballAdjusted: true,
    volleyballUpdateUsesBalancerContext: true,
    volleyballUpdateContextMode: 'pair',
    includeLeagueGames: true,
    options: {
      seasonalTaperDays,
      leagueDisplayEstimateEnabled: true,
    },
  });
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
    : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / (values.length - 1));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function robustNormalize(value, q25, q75) {
  const denom = Math.max(1e-9, q75 - q25);
  return clamp((Number(value) - q25) / denom, 0, 2);
}

function getPlayerName(player) {
  return player?.name || player?.id || 'Unknown';
}

function teamNames(team) {
  return team.map(getPlayerName).join('/');
}

function getPlayerRaw(player, ratingMap) {
  const skill = ratingMap?.[player.id] || makeInitialRating({ seasonalTaperDays });
  return getRawOrdinal(skill, { seasonalTaperDays });
}

function getTeamRawRatings(team, ratingMap) {
  return team
    .map(player => getPlayerRaw(player, ratingMap))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function bottomMean(ratings, n) {
  return mean(ratings.slice(0, Math.min(n, ratings.length)));
}

function countBadPlayers(ratings) {
  return ratings.filter(rating => rating < BAD_PLAYER_RAW).length;
}

function getPriorGameCounts(history) {
  const counts = new Map();
  (Array.isArray(history) ? history : []).forEach(entry => {
    const game = entry.game || {};
    const teams = [
      ...(Array.isArray(game.redTeam) ? game.redTeam : []),
      ...(game.isLeagueGame ? [] : (Array.isArray(game.blueTeam) ? game.blueTeam : [])),
    ];
    teams.forEach(player => {
      if (!player?.id) return;
      const id = String(player.id);
      counts.set(id, (counts.get(id) || 0) + 1);
    });
  });
  return counts;
}

function createVolatilityRows(history) {
  const rows = new Map();

  const rowFor = id => {
    const key = String(id);
    if (!rows.has(key)) {
      rows.set(key, {
        id: key,
        games: 0,
        residuals: [],
        absResiduals: [],
        deltas: [],
        absDeltas: [],
        badTail: 0,
      });
    }
    return rows.get(key);
  };

  (Array.isArray(history) ? history : []).forEach(entry => {
    const game = entry.game || {};
    if (game.isLeagueGame) return;

    const winner = game.winner === 'blue' ? 'blue' : 'red';
    const redProbability = Number(entry.volleyballWinnerProbability ?? entry.openSkillWinnerProbability ?? 0.5);
    const redProb = Number.isFinite(redProbability) ? redProbability : 0.5;

    ['red', 'blue'].forEach(side => {
      const before = Array.isArray(entry.before?.[side]) ? entry.before[side] : [];
      const after = Array.isArray(entry.after?.[side]) ? entry.after[side] : [];
      const probability = side === 'red' ? redProb : 1 - redProb;
      const actual = winner === side ? 1 : 0;
      const residual = actual - probability;

      before.forEach((player, index) => {
        const id = String(player.id);
        if (id.startsWith('league_team_')) return;

        const afterPlayer = after[index];
        const beforeRating = Number(player.rating);
        const afterRating = Number(afterPlayer?.rating);
        const delta = Number.isFinite(beforeRating) && Number.isFinite(afterRating)
          ? afterRating - beforeRating
          : null;
        const row = rowFor(id);

        row.games += 1;
        row.residuals.push(residual);
        row.absResiduals.push(Math.abs(residual));
        if (Number.isFinite(delta)) {
          row.deltas.push(delta);
          row.absDeltas.push(Math.abs(delta));
        }
        if (residual <= -0.35) row.badTail += 1;
      });
    });
  });

  const rawRows = [...rows.values()].map(row => ({
    id: row.id,
    games: row.games,
    outcomeStd: stddev(row.residuals),
    avgAbsOutcome: mean(row.absResiduals),
    deltaStd: stddev(row.deltas),
    avgAbsDelta: mean(row.absDeltas),
    downsideTail: row.games > 0 ? row.badTail / row.games : 0,
    confidence: row.games >= 6 ? clamp((row.games - 5) / 11, 0, 1) : 0,
  }));

  const q = field => ({
    q25: quantile(rawRows.map(row => row[field]), 0.25),
    q75: quantile(rawRows.map(row => row[field]), 0.75),
  });
  const qs = {
    outcomeStd: q('outcomeStd'),
    avgAbsOutcome: q('avgAbsOutcome'),
    deltaStd: q('deltaStd'),
    avgAbsDelta: q('avgAbsDelta'),
    downsideTail: q('downsideTail'),
  };

  const map = new Map();
  rawRows.forEach(row => {
    const nOutcomeStd = robustNormalize(row.outcomeStd, qs.outcomeStd.q25, qs.outcomeStd.q75);
    const nAvgAbsOutcome = robustNormalize(row.avgAbsOutcome, qs.avgAbsOutcome.q25, qs.avgAbsOutcome.q75);
    const nDeltaStd = robustNormalize(row.deltaStd, qs.deltaStd.q25, qs.deltaStd.q75);
    const nAvgAbsDelta = robustNormalize(row.avgAbsDelta, qs.avgAbsDelta.q25, qs.avgAbsDelta.q75);
    const nDownsideTail = robustNormalize(row.downsideTail, qs.downsideTail.q25, qs.downsideTail.q75);
    map.set(row.id, {
      ...row,
      volatility: row.confidence * (0.45 * nOutcomeStd + 0.25 * nDeltaStd + 0.20 * nAvgAbsOutcome + 0.10 * nDownsideTail),
      downside: row.confidence * (0.45 * nOutcomeStd + 0.25 * nDownsideTail + 0.20 * nDeltaStd + 0.10 * nAvgAbsDelta),
    });
  });

  return map;
}

function teamVolatility(team, volatilityMap, field) {
  return mean(team.map(player => volatilityMap.get(String(player.id))?.[field] || 0));
}

function getResidualSd({ priorGames, ratingMap, carryScoreMap, marginModel }) {
  const residuals = [];
  getGamesSortedOldestFirst(priorGames).forEach(game => {
    if (!isScoredNonLeagueGame(game)) return;
    const score = scoreVolleyballCandidateSplit({
      redPlayers: game.redTeam,
      bluePlayers: game.blueTeam,
      ratingMap,
      carryScoreMap,
      volleyballOptions: DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
    });
    const predicted = predictExpectedMargin(score.strengthDiff, marginModel);
    const actual = Math.abs(game.scoreRed - game.scoreBlue);
    residuals.push(actual - predicted);
  });
  return stddev(residuals);
}

function buildRows() {
  const sortedGames = getGamesSortedOldestFirst(games);
  const priorGames = [];
  const rows = [];

  for (const game of sortedGames) {
    if (!isScoredNonLeagueGame(game)) {
      priorGames.push(game);
      continue;
    }

    const replay = replayFor(priorGames);
    const marginModel = calibrateMarginModel({
      games: priorGames,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
      options: { seasonalTaperDays },
      volleyballOptions: DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
    });

    if ((marginModel?.sampleSize || 0) >= MIN_PRIOR_MARGIN_GAMES) {
      const score = scoreVolleyballCandidateSplit({
        redPlayers: game.redTeam,
        bluePlayers: game.blueTeam,
        ratingMap: replay.ratingMap,
        carryScoreMap: replay.carryMap || {},
        volleyballOptions: DEFAULT_VOLLEYBALL_BALANCE_OPTIONS,
      });
      const residualSd = getResidualSd({
        priorGames,
        ratingMap: replay.ratingMap,
        carryScoreMap: replay.carryMap || {},
        marginModel,
      });
      const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
      const expectedMargin = predictExpectedMargin(score.strengthDiff, marginModel);
      const residual = actualMargin - expectedMargin;
      const z = residualSd > 0 ? residual / residualSd : 0;
      const favorite = score.strengthDiff >= 0 ? 'red' : 'blue';
      const priorCounts = getPriorGameCounts(replay.history);
      const volatilityMap = createVolatilityRows(replay.history);
      const redRaw = getTeamRawRatings(game.redTeam, replay.ratingMap);
      const blueRaw = getTeamRawRatings(game.blueTeam, replay.ratingMap);
      const redNew = game.redTeam.filter(player => (priorCounts.get(String(player.id)) || 0) < NEW_PLAYER_GAMES).length;
      const blueNew = game.blueTeam.filter(player => (priorCounts.get(String(player.id)) || 0) < NEW_PLAYER_GAMES).length;
      const redBad = countBadPlayers(redRaw);
      const blueBad = countBadPlayers(blueRaw);

      rows.push({
        date: game.date || '',
        scoreText: `${game.scoreRed}-${game.scoreBlue}`,
        winner: game.winner,
        favorite,
        favoriteWon: favorite === game.winner,
        redNames: teamNames(game.redTeam),
        blueNames: teamNames(game.blueTeam),
        redSize: game.redTeam.length,
        blueSize: game.blueTeam.length,
        actualMargin,
        expectedMargin,
        residual,
        residualSd,
        z,
        strengthDiff: score.strengthDiff,
        winProbFavorite: Math.max(score.redWinProbability, score.blueWinProbability),
        redBad,
        blueBad,
        maxBad: Math.max(redBad, blueBad),
        badGap: Math.abs(redBad - blueBad),
        redNew,
        blueNew,
        maxNew: Math.max(redNew, blueNew),
        newGap: Math.abs(redNew - blueNew),
        redBottom2: bottomMean(redRaw, 2),
        blueBottom2: bottomMean(blueRaw, 2),
        bottom2Gap: Math.abs(bottomMean(redRaw, 2) - bottomMean(blueRaw, 2)),
        redWorst: redRaw[0],
        blueWorst: blueRaw[0],
        worstGap: Math.abs((redRaw[0] ?? 0) - (blueRaw[0] ?? 0)),
        volatilityGap: Math.abs(
          teamVolatility(game.redTeam, volatilityMap, 'volatility') -
          teamVolatility(game.blueTeam, volatilityMap, 'volatility')
        ),
        maxTeamVolatility: Math.max(
          teamVolatility(game.redTeam, volatilityMap, 'volatility'),
          teamVolatility(game.blueTeam, volatilityMap, 'volatility')
        ),
        downsideGap: Math.abs(
          teamVolatility(game.redTeam, volatilityMap, 'downside') -
          teamVolatility(game.blueTeam, volatilityMap, 'downside')
        ),
        maxTeamDownside: Math.max(
          teamVolatility(game.redTeam, volatilityMap, 'downside'),
          teamVolatility(game.blueTeam, volatilityMap, 'downside')
        ),
      });
    }

    priorGames.push(game);
  }

  return rows;
}

function pct(value) {
  return `${(Number(value) * 100).toFixed(0)}%`;
}

function fmt(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
}

function rate(rows, predicate) {
  return rows.length ? rows.filter(predicate).length / rows.length : 0;
}

function avg(rows, field) {
  return mean(rows.map(row => Number(row[field])).filter(Number.isFinite));
}

function printGameRows(title, rows) {
  console.log(`\n${title}`);
  console.log([
    '#'.padStart(2),
    'date'.padEnd(10),
    'score'.padEnd(7),
    'act'.padStart(4),
    'exp'.padStart(5),
    'resid'.padStart(6),
    'z'.padStart(5),
    'fav'.padEnd(4),
    'bad'.padStart(5),
    'new'.padStart(5),
    'b2gap'.padStart(6),
    'vol'.padStart(5),
    'down'.padStart(5),
    'teams',
  ].join('  '));
  console.log('-'.repeat(154));
  rows.slice(0, MAX_ROWS).forEach((row, index) => {
    console.log([
      String(index + 1).padStart(2),
      row.date.padEnd(10),
      row.scoreText.padEnd(7),
      fmt(row.actualMargin, 0).padStart(4),
      fmt(row.expectedMargin, 1).padStart(5),
      fmt(row.residual, 1).padStart(6),
      fmt(row.z, 2).padStart(5),
      (row.favoriteWon ? 'won' : 'lost').padEnd(4),
      `${row.redBad}-${row.blueBad}`.padStart(5),
      `${row.redNew}-${row.blueNew}`.padStart(5),
      fmt(row.bottom2Gap, 1).padStart(6),
      fmt(row.maxTeamVolatility, 2).padStart(5),
      fmt(row.maxTeamDownside, 2).padStart(5),
      `${row.redNames}  vs  ${row.blueNames}`,
    ].join('  '));
  });
}

function printComparison(label, allRows, outliers) {
  console.log(`\n${label}`);
  console.log([
    'group'.padEnd(13),
    'n'.padStart(4),
    'margin'.padStart(7),
    'expected'.padStart(8),
    'favWon'.padStart(7),
    'maxBad>=2'.padStart(9),
    'badGap>=2'.padStart(9),
    'maxNew>=2'.padStart(9),
    'b2gap'.padStart(7),
    'volMax'.padStart(7),
    'downMax'.padStart(7),
  ].join('  '));
  console.log('-'.repeat(110));

  [
    ['all', allRows],
    ['outliers', outliers],
  ].forEach(([name, rows]) => {
    console.log([
      name.padEnd(13),
      String(rows.length).padStart(4),
      fmt(avg(rows, 'actualMargin'), 2).padStart(7),
      fmt(avg(rows, 'expectedMargin'), 2).padStart(8),
      pct(rate(rows, row => row.favoriteWon)).padStart(7),
      pct(rate(rows, row => row.maxBad >= 2)).padStart(9),
      pct(rate(rows, row => row.badGap >= 2)).padStart(9),
      pct(rate(rows, row => row.maxNew >= 2)).padStart(9),
      fmt(avg(rows, 'bottom2Gap'), 2).padStart(7),
      fmt(avg(rows, 'maxTeamVolatility'), 2).padStart(7),
      fmt(avg(rows, 'maxTeamDownside'), 2).padStart(7),
    ].join('  '));
  });
}

const rows = buildRows();
const wideOutliers = rows
  .filter(row => row.z >= Z_THRESHOLD)
  .sort((a, b) => b.z - a.z || b.residual - a.residual);
const closeOutliers = rows
  .filter(row => row.z <= -Z_THRESHOLD)
  .sort((a, b) => a.z - b.z || a.residual - b.residual);
const severeWideOutliers = rows.filter(row => row.z >= 1.5);

console.log(`DB: ${sourceLabel}`);
console.log(`Analyzed scored non-league games with at least ${MIN_PRIOR_MARGIN_GAMES} prior margin samples.`);
console.log(`Expected range: expected margin +/- ${fmt(Z_THRESHOLD, 2)} prior residual SD.`);
console.log(`n=${rows.length} wideOutliers=${wideOutliers.length} (${pct(wideOutliers.length / rows.length)}) closeOutliers=${closeOutliers.length} (${pct(closeOutliers.length / rows.length)}) severeWide>=1.5sd=${severeWideOutliers.length}`);

printComparison('Wide-margin commonality check', rows, wideOutliers);
printComparison('Severe wide-margin commonality check', rows, severeWideOutliers);
printGameRows('Wide outliers: actual margin above expected range', wideOutliers);
printGameRows('Close outliers: actual margin below expected range', closeOutliers);
