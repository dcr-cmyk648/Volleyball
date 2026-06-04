// Internal QC harness: runs the real ratings.js model over the local database
// and reports model-fit metrics for different volleyball-balance option sets.
//
// Run: node --import ./register.mjs quality.mjs
//
// NOTE: within5 / avgDiff / blowouts are computed from ACTUAL recorded scores,
// so they do NOT change with model weights — only acc / MAE / slope do.
// Those outcome metrics only move when teams are formed differently (forward-looking).

import { readFileSync } from 'node:fs';
import {
  replayRatings,
  calibrateMarginModel,
  predictExpectedMargin,
  scoreVolleyballCandidateSplit,
  getGamesSortedOldestFirst,
} from '../ratings.js';

const DB_PATH = process.env.VBALL_DB || 'C:/Users/rowla/Documents/Volleyball/default_database';
const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
const players = db.players || [];
const games = db.games || [];

const SEASON_MONTHS = 6;
const seasonalTaperDays = Math.round(SEASON_MONTHS * 30.4375);

function evaluate(label, vbOverrides = {}) {
  const replay = replayRatings({
    players,
    games,
    seasonal: true,
    volleyballAdjusted: true,
    includeLeagueGames: true,
    volleyballOptions: vbOverrides,
    options: { seasonalTaperDays },
  });
  const ratingMap = replay.ratingMap;
  const carryMap = replay.carryMap || {};

  const marginModel = calibrateMarginModel({
    games,
    ratingMap,
    carryScoreMap: carryMap,
    volleyballOptions: vbOverrides,
  });

  const analyzable = getGamesSortedOldestFirst(games).filter(g =>
    g && !g.isLeagueGame &&
    Array.isArray(g.redTeam) && g.redTeam.length &&
    Array.isArray(g.blueTeam) && g.blueTeam.length &&
    (g.winner === 'red' || g.winner === 'blue'));

  let correct = 0, scored = 0, within5 = 0, diffSum = 0, maeSum = 0, blowouts = 0;
  for (const g of analyzable) {
    const score = scoreVolleyballCandidateSplit({
      redPlayers: g.redTeam,
      bluePlayers: g.blueTeam,
      ratingMap,
      carryScoreMap: carryMap,
      volleyballOptions: vbOverrides,
    });
    const pred = score.redWinProbability >= 0.5 ? 'red' : 'blue';
    if (pred === g.winner) correct++;
    if (typeof g.scoreRed === 'number' && typeof g.scoreBlue === 'number') {
      const absd = Math.abs(g.scoreRed - g.scoreBlue);
      diffSum += absd;
      if (absd <= 5) within5++;
      if (absd > 8) blowouts++;
      scored++;
      maeSum += Math.abs(predictExpectedMargin(score.strengthDiff, marginModel) - absd);
    }
  }

  return {
    label,
    n: analyzable.length,
    acc: correct / analyzable.length,
    mae: scored ? maeSum / scored : NaN,
    within5: scored ? within5 / scored : NaN,
    avgDiff: scored ? diffSum / scored : NaN,
    blowouts,
    slope: marginModel.slope,
    baseMargin: marginModel.baseMargin,
  };
}

const w = (t, s, a, d, wr) => ({
  topPlayerWeight: t, secondPlayerWeight: s, averageWeight: a, depthWeight: d, worstPlayerWeight: wr,
});

const sets = [
  ['current default (.30/.24/.28/.10/.08)', {}],
  ['old top-heavy (.45/.20/.17/.12/.06)', w(.45, .20, .17, .12, .06)],
  ['proportional (.30/.23/.28/.12/.07)', w(.30, .23, .28, .12, .07)],
  ['aggressive (.28/.24/.30/.10/.08)', w(.28, .24, .30, .10, .08)],
  ['flat-ish (.25/.22/.33/.12/.08)', w(.25, .22, .33, .12, .08)],
];

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
console.log('games analyzed:', evaluate('', {}).n, '\n');
console.log('set'.padEnd(42), 'acc ', 'MAE ', 'w5% ', 'avgD', 'blow', 'slope');
console.log('-'.repeat(80));
for (const [label, ov] of sets) {
  const r = evaluate(label, ov);
  console.log(
    r.label.padEnd(42),
    (r.acc * 100).toFixed(0).padStart(3) + '%',
    fmt(r.mae, 2).padStart(4),
    (r.within5 * 100).toFixed(0).padStart(3) + '%',
    fmt(r.avgDiff, 1).padStart(4),
    String(r.blowouts).padStart(4),
    fmt(r.slope, 3).padStart(6),
  );
}
