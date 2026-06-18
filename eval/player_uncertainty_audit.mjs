// Eval-only audit: can uncertainty-like player signals identify games whose
// margins land outside the model's expected range?
//
// The empirical features avoid direct game-count thresholds. Sparse players are
// not labeled "new" by count; they either show model uncertainty through sigma
// or produce unstable empirical evidence once they have observations.

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
const MIN_PRIOR_MARGIN_GAMES = Number(process.env.UNCERTAINTY_MIN_PRIOR_GAMES || 12);
const Z_THRESHOLD = Number(process.env.UNCERTAINTY_Z || 1);
const MAX_PLAYERS = Number(process.env.UNCERTAINTY_PLAYERS || 20);

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

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

function getNameById() {
  return new Map(players.map(player => [String(player.id), player.name || String(player.id)]));
}

function getPlayerRaw(player, ratingMap) {
  const skill = ratingMap?.[player.id] || makeInitialRating({ seasonalTaperDays });
  return getRawOrdinal(skill, { seasonalTaperDays });
}

function getPlayerSigma(player, ratingMap) {
  const skill = ratingMap?.[player.id] || makeInitialRating({ seasonalTaperDays });
  return Number(skill.sigma);
}

function addPlayerStat(map, id, patch) {
  const key = String(id);
  if (!map.has(key)) {
    map.set(key, {
      id: key,
      residuals: [],
      absResiduals: [],
      downsideResiduals: [],
      ratingDeltas: [],
      absRatingDeltas: [],
      sessionResiduals: new Map(),
      surpriseParticipations: [],
    });
  }
  const row = map.get(key);
  if (Number.isFinite(patch.residual)) {
    row.residuals.push(patch.residual);
    row.absResiduals.push(Math.abs(patch.residual));
    if (patch.residual < 0) row.downsideResiduals.push(Math.abs(patch.residual));
    if (patch.date) {
      const list = row.sessionResiduals.get(patch.date) || [];
      list.push(patch.residual);
      row.sessionResiduals.set(patch.date, list);
    }
  }
  if (Number.isFinite(patch.ratingDelta)) {
    row.ratingDeltas.push(patch.ratingDelta);
    row.absRatingDeltas.push(Math.abs(patch.ratingDelta));
  }
  if (Number.isFinite(patch.gameSurprise)) {
    row.surpriseParticipations.push(patch.gameSurprise);
  }
}

function getPriorMarginResidualSd({ priorGames, ratingMap, carryScoreMap, marginModel }) {
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
    const expected = predictExpectedMargin(score.strengthDiff, marginModel);
    const actual = Math.abs(game.scoreRed - game.scoreBlue);
    residuals.push(actual - expected);
  });
  return stddev(residuals);
}

function createUncertaintyMap(history) {
  const stats = new Map();

  (Array.isArray(history) ? history : []).forEach(entry => {
    const game = entry.game || {};
    if (game.isLeagueGame) return;

    const winner = game.winner === 'blue' ? 'blue' : 'red';
    const redProbability = Number(entry.volleyballWinnerProbability ?? entry.openSkillWinnerProbability ?? 0.5);
    const redProb = Number.isFinite(redProbability) ? redProbability : 0.5;
    const gameSurprise = Number.isFinite(Number(game.marginResidualZ))
      ? Math.max(0, Number(game.marginResidualZ))
      : null;

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
        const ratingDelta = Number.isFinite(beforeRating) && Number.isFinite(afterRating)
          ? afterRating - beforeRating
          : null;

        addPlayerStat(stats, id, {
          residual,
          ratingDelta,
          date: game.date || '',
          gameSurprise,
        });
      });
    });
  });

  const rawRows = [...stats.values()].map(row => {
    const sessionMeans = [...row.sessionResiduals.values()].map(mean);
    return {
      id: row.id,
      residualStd: stddev(row.residuals),
      avgAbsResidual: mean(row.absResiduals),
      downsideMean: mean(row.downsideResiduals),
      ratingPathStd: stddev(row.ratingDeltas),
      avgAbsRatingDelta: mean(row.absRatingDeltas),
      sessionStd: stddev(sessionMeans),
      surpriseParticipation: mean(row.surpriseParticipations),
    };
  });

  const fields = [
    'residualStd',
    'avgAbsResidual',
    'downsideMean',
    'ratingPathStd',
    'avgAbsRatingDelta',
    'sessionStd',
    'surpriseParticipation',
  ];
  const quartiles = Object.fromEntries(fields.map(field => [field, {
    q25: quantile(rawRows.map(row => row[field]), 0.25),
    q75: quantile(rawRows.map(row => row[field]), 0.75),
  }]));

  const map = new Map();
  rawRows.forEach(row => {
    const normalized = Object.fromEntries(fields.map(field => [
      `n${field[0].toUpperCase()}${field.slice(1)}`,
      robustNormalize(row[field], quartiles[field].q25, quartiles[field].q75),
    ]));

    map.set(row.id, {
      ...row,
      ...normalized,
      residualUncertainty:
        0.55 * normalized.nResidualStd +
        0.30 * normalized.nAvgAbsResidual +
        0.15 * normalized.nDownsideMean,
      pathInstability:
        0.65 * normalized.nRatingPathStd +
        0.35 * normalized.nAvgAbsRatingDelta,
      sessionUncertainty: normalized.nSessionStd,
      surpriseUncertainty: normalized.nSurpriseParticipation,
    });
  });

  return map;
}

function createPlayerFeatureRows({ team, ratingMap, uncertaintyMap }) {
  return team.map(player => {
    const empirical = uncertaintyMap.get(String(player.id)) || {};
    return {
      id: String(player.id),
      name: player.name || String(player.id),
      raw: getPlayerRaw(player, ratingMap),
      sigma: getPlayerSigma(player, ratingMap),
      residualUncertainty: empirical.residualUncertainty || 0,
      pathInstability: empirical.pathInstability || 0,
      sessionUncertainty: empirical.sessionUncertainty || 0,
      surpriseUncertainty: empirical.surpriseUncertainty || 0,
    };
  });
}

function teamMetric(rows, field, mode) {
  const values = rows.map(row => Number(row[field]) || 0);
  if (!values.length) return 0;
  if (mode === 'max') return Math.max(...values);
  if (mode === 'top2') return mean([...values].sort((a, b) => b - a).slice(0, Math.min(2, values.length)));
  return mean(values);
}

function addSnapshotFeature(snapshot, featureName, redRows, blueRows, field, mode) {
  const red = teamMetric(redRows, field, mode);
  const blue = teamMetric(blueRows, field, mode);
  snapshot[`${featureName}Max`] = Math.max(red, blue);
  snapshot[`${featureName}Gap`] = Math.abs(red - blue);
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
      const expectedMargin = predictExpectedMargin(score.strengthDiff, marginModel);
      const actualMargin = Math.abs(game.scoreRed - game.scoreBlue);
      const residual = actualMargin - expectedMargin;
      const residualSd = getPriorMarginResidualSd({
        priorGames,
        ratingMap: replay.ratingMap,
        carryScoreMap: replay.carryMap || {},
        marginModel,
      });
      const z = residualSd > 0 ? residual / residualSd : 0;
      const uncertaintyMap = createUncertaintyMap(replay.history);
      const redRows = createPlayerFeatureRows({
        team: game.redTeam,
        ratingMap: replay.ratingMap,
        uncertaintyMap,
      });
      const blueRows = createPlayerFeatureRows({
        team: game.blueTeam,
        ratingMap: replay.ratingMap,
        uncertaintyMap,
      });
      const row = {
        date: game.date || '',
        scoreText: `${game.scoreRed}-${game.scoreBlue}`,
        actualMargin,
        expectedMargin,
        residual,
        z,
        favoriteWon: (score.strengthDiff >= 0 ? 'red' : 'blue') === game.winner,
        redNames: redRows.map(player => player.name).join('/'),
        blueNames: blueRows.map(player => player.name).join('/'),
      };

      addSnapshotFeature(row, 'sigmaAvg', redRows, blueRows, 'sigma', 'avg');
      addSnapshotFeature(row, 'sigmaTop2', redRows, blueRows, 'sigma', 'top2');
      addSnapshotFeature(row, 'residAvg', redRows, blueRows, 'residualUncertainty', 'avg');
      addSnapshotFeature(row, 'residTop2', redRows, blueRows, 'residualUncertainty', 'top2');
      addSnapshotFeature(row, 'pathAvg', redRows, blueRows, 'pathInstability', 'avg');
      addSnapshotFeature(row, 'pathTop2', redRows, blueRows, 'pathInstability', 'top2');
      addSnapshotFeature(row, 'sessionAvg', redRows, blueRows, 'sessionUncertainty', 'avg');
      addSnapshotFeature(row, 'sessionTop2', redRows, blueRows, 'sessionUncertainty', 'top2');
      addSnapshotFeature(row, 'surpriseAvg', redRows, blueRows, 'surpriseUncertainty', 'avg');
      addSnapshotFeature(row, 'surpriseTop2', redRows, blueRows, 'surpriseUncertainty', 'top2');

      rows.push(row);
    }

    priorGames.push({
      ...game,
      // Attach the margin surprise to this game so future player-level surprise
      // participation can learn from prior expected-range misses.
      marginResidualZ: rows.at(-1)?.date === game.date && rows.at(-1)?.scoreText === `${game.scoreRed}-${game.scoreBlue}`
        ? rows.at(-1).z
        : null,
    });
  }

  return { rows, enrichedGames: priorGames };
}

function pct(value) {
  return `${(Number(value) * 100).toFixed(0)}%`;
}

function fmt(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
}

function avg(rows, field) {
  return mean(rows.map(row => Number(row[field])).filter(Number.isFinite));
}

function rate(rows, predicate) {
  return rows.length ? rows.filter(predicate).length / rows.length : 0;
}

function topQuartileRate(rows, field, targetPredicate) {
  const threshold = quantile(rows.map(row => Number(row[field])), 0.75);
  const top = rows.filter(row => Number(row[field]) >= threshold);
  return {
    threshold,
    rate: rate(top, targetPredicate),
    n: top.length,
  };
}

function annotateCompositeFeatures(rows) {
  const baseFields = [
    'sigmaTop2Max',
    'residTop2Max',
    'pathTop2Max',
    'sessionTop2Max',
    'surpriseTop2Max',
  ];
  const quartiles = Object.fromEntries(baseFields.map(field => [field, {
    q25: quantile(rows.map(row => Number(row[field])), 0.25),
    q75: quantile(rows.map(row => Number(row[field])), 0.75),
  }]));

  rows.forEach(row => {
    const sigma = robustNormalize(row.sigmaTop2Max, quartiles.sigmaTop2Max.q25, quartiles.sigmaTop2Max.q75);
    const residual = robustNormalize(row.residTop2Max, quartiles.residTop2Max.q25, quartiles.residTop2Max.q75);
    const path = robustNormalize(row.pathTop2Max, quartiles.pathTop2Max.q25, quartiles.pathTop2Max.q75);
    const session = robustNormalize(row.sessionTop2Max, quartiles.sessionTop2Max.q25, quartiles.sessionTop2Max.q75);
    const surprise = robustNormalize(row.surpriseTop2Max, quartiles.surpriseTop2Max.q25, quartiles.surpriseTop2Max.q75);

    row.modelUnknownComposite = sigma;
    row.empiricalInstabilityComposite = 0.40 * residual + 0.30 * path + 0.30 * session;
    row.fullUncertaintyComposite = 0.45 * sigma + 0.25 * residual + 0.15 * path + 0.15 * session;
    row.surpriseWeightedComposite = 0.35 * sigma + 0.20 * residual + 0.15 * path + 0.15 * session + 0.15 * surprise;
  });
}

function printFeatureAudit(rows, label, targetPredicate) {
  const fields = [
    ['sigmaAvgMax', 'sigma avg max'],
    ['sigmaTop2Max', 'sigma top2 max'],
    ['residAvgMax', 'residual avg max'],
    ['residTop2Max', 'residual top2 max'],
    ['pathAvgMax', 'path avg max'],
    ['pathTop2Max', 'path top2 max'],
    ['sessionAvgMax', 'session avg max'],
    ['sessionTop2Max', 'session top2 max'],
    ['surpriseAvgMax', 'surprise avg max'],
    ['surpriseTop2Max', 'surprise top2 max'],
    ['modelUnknownComposite', 'model unknown cmp'],
    ['empiricalInstabilityComposite', 'empirical cmp'],
    ['fullUncertaintyComposite', 'full uncert cmp'],
    ['surpriseWeightedComposite', 'surprise cmp'],
  ];

  console.log(`\n${label}`);
  console.log([
    'feature'.padEnd(18),
    'corrZ'.padStart(7),
    'corrAbsZ'.padStart(8),
    'allAvg'.padStart(8),
    'outAvg'.padStart(8),
    'topQ out'.padStart(9),
    'topQ n'.padStart(6),
  ].join('  '));
  console.log('-'.repeat(86));

  fields.forEach(([field, name]) => {
    const outliers = rows.filter(targetPredicate);
    const topQ = topQuartileRate(rows, field, targetPredicate);
    console.log([
      name.slice(0, 18).padEnd(18),
      fmt(pearson(rows.map(row => Number(row[field]) || 0), rows.map(row => row.z)), 3).padStart(7),
      fmt(pearson(rows.map(row => Number(row[field]) || 0), rows.map(row => Math.abs(row.z))), 3).padStart(8),
      fmt(avg(rows, field), 3).padStart(8),
      fmt(avg(outliers, field), 3).padStart(8),
      pct(topQ.rate).padStart(9),
      String(topQ.n).padStart(6),
    ].join('  '));
  });
}

function printOutliers(rows) {
  const wide = rows.filter(row => row.z >= Z_THRESHOLD).sort((a, b) => b.z - a.z);
  console.log('\nWide outliers with uncertainty features');
  console.log([
    '#'.padStart(2),
    'date'.padEnd(10),
    'score'.padEnd(7),
    'z'.padStart(5),
    'sig'.padStart(5),
    'resid'.padStart(6),
    'path'.padStart(6),
    'sess'.padStart(6),
    'surp'.padStart(6),
    'teams',
  ].join('  '));
  console.log('-'.repeat(145));
  wide.slice(0, 18).forEach((row, index) => {
    console.log([
      String(index + 1).padStart(2),
      row.date.padEnd(10),
      row.scoreText.padEnd(7),
      fmt(row.z, 2).padStart(5),
      fmt(row.sigmaTop2Max, 2).padStart(5),
      fmt(row.residTop2Max, 2).padStart(6),
      fmt(row.pathTop2Max, 2).padStart(6),
      fmt(row.sessionTop2Max, 2).padStart(6),
      fmt(row.surpriseTop2Max, 2).padStart(6),
      `${row.redNames}  vs  ${row.blueNames}`,
    ].join('  '));
  });
}

function printCurrentPlayers(enrichedGames) {
  const nameById = getNameById();
  const replay = replayFor(enrichedGames);
  const uncertaintyMap = createUncertaintyMap(replay.history);
  const rows = players
    .map(player => {
      const empirical = uncertaintyMap.get(String(player.id)) || {};
      const skill = replay.ratingMap?.[player.id] || makeInitialRating({ seasonalTaperDays });
      return {
        id: String(player.id),
        name: nameById.get(String(player.id)) || String(player.id),
        raw: getRawOrdinal(skill, { seasonalTaperDays }),
        sigma: Number(skill.sigma),
        residual: empirical.residualUncertainty || 0,
        path: empirical.pathInstability || 0,
        session: empirical.sessionUncertainty || 0,
        surprise: empirical.surpriseUncertainty || 0,
        composite:
          0.25 * (empirical.residualUncertainty || 0) +
          0.25 * (empirical.pathInstability || 0) +
          0.25 * (empirical.sessionUncertainty || 0) +
          0.25 * (empirical.surpriseUncertainty || 0),
      };
    })
    .sort((a, b) => b.composite - a.composite)
    .slice(0, MAX_PLAYERS);

  console.log('\nCurrent top empirical uncertainty players');
  console.log([
    'player'.padEnd(18),
    'raw'.padStart(7),
    'sigma'.padStart(6),
    'resid'.padStart(7),
    'path'.padStart(7),
    'session'.padStart(7),
    'surprise'.padStart(8),
    'comp'.padStart(7),
  ].join('  '));
  console.log('-'.repeat(82));
  rows.forEach(row => {
    console.log([
      row.name.slice(0, 18).padEnd(18),
      fmt(row.raw, 2).padStart(7),
      fmt(row.sigma, 2).padStart(6),
      fmt(row.residual, 2).padStart(7),
      fmt(row.path, 2).padStart(7),
      fmt(row.session, 2).padStart(7),
      fmt(row.surprise, 2).padStart(8),
      fmt(row.composite, 2).padStart(7),
    ].join('  '));
  });
}

const { rows, enrichedGames } = buildRows();
annotateCompositeFeatures(rows);
const widePredicate = row => row.z >= Z_THRESHOLD;
const severePredicate = row => row.z >= 1.5;
const closePredicate = row => row.z <= -Z_THRESHOLD;

console.log(`DB: ${sourceLabel}`);
console.log(`Analyzed scored non-league games with at least ${MIN_PRIOR_MARGIN_GAMES} prior margin samples.`);
console.log(`n=${rows.length} wide=${rows.filter(widePredicate).length} (${pct(rate(rows, widePredicate))}) severeWide=${rows.filter(severePredicate).length} close=${rows.filter(closePredicate).length}`);

printFeatureAudit(rows, 'Wide-margin signal audit', widePredicate);
printFeatureAudit(rows, 'Severe wide-margin signal audit', severePredicate);
printOutliers(rows);
printCurrentPlayers(enrichedGames);
