// Sweeps rating-stability knobs (surprise softening, final-multiplier cap) and
// probabilityScale through the real ratings.js model. Weights stay at defaults.
// Run: node --import ./register.mjs stability.mjs
import { readFileSync } from 'node:fs';
import {
  replayRatings, calibrateMarginModel, predictExpectedMargin,
  scoreVolleyballCandidateSplit, getGamesSortedOldestFirst,
} from '../ratings.js';

const db = JSON.parse(readFileSync('C:/Users/rowla/Documents/Volleyball/default_database', 'utf8'));
const players = db.players || [];
const games = db.games || [];
const seasonalTaperDays = Math.round(6 * 30.4375);

function evaluate(vb = {}) {
  const replay = replayRatings({
    players, games, seasonal: true, volleyballAdjusted: true, includeLeagueGames: true,
    volleyballOptions: vb, options: { seasonalTaperDays },
  });
  const ratingMap = replay.ratingMap;
  const carryMap = replay.carryMap || {};
  const marginModel = calibrateMarginModel({ games, ratingMap, carryScoreMap: carryMap, volleyballOptions: vb });
  const analyzable = getGamesSortedOldestFirst(games).filter(g =>
    g && !g.isLeagueGame && g.redTeam?.length && g.blueTeam?.length &&
    (g.winner === 'red' || g.winner === 'blue'));
  let correct = 0, scored = 0, mae = 0;
  for (const g of analyzable) {
    const s = scoreVolleyballCandidateSplit({ redPlayers: g.redTeam, bluePlayers: g.blueTeam, ratingMap, carryScoreMap: carryMap, volleyballOptions: vb });
    if ((s.redWinProbability >= 0.5 ? 'red' : 'blue') === g.winner) correct++;
    if (typeof g.scoreRed === 'number' && typeof g.scoreBlue === 'number') {
      mae += Math.abs(predictExpectedMargin(s.strengthDiff, marginModel) - (g.scoreRed - g.scoreBlue));
      scored++;
    }
  }
  return { acc: correct / analyzable.length, mae: mae / scored, slope: marginModel.marginSlope };
}

const cap = (min, max) => ({ finalUpdateMultiplierMin: min, finalUpdateMultiplierMax: max });
const configs = [
  ['baseline (current)', {}],
  ['soften 0.75', { surpriseSoftening: 0.75 }],
  ['soften 0.50', { surpriseSoftening: 0.50 }],
  ['cap [0.50,1.75]', cap(0.50, 1.75)],
  ['cap [0.60,1.60]', cap(0.60, 1.60)],
  ['probScale 3.5', { probabilityScale: 3.5 }],
  ['probScale 5.5', { probabilityScale: 5.5 }],
  ['probScale 6.5', { probabilityScale: 6.5 }],
  ['soften 0.5 + cap [0.5,1.75]', { surpriseSoftening: 0.5, ...cap(0.5, 1.75) }],
  ['soften 0.5 + cap + probScale 5.5', { surpriseSoftening: 0.5, ...cap(0.5, 1.75), probabilityScale: 5.5 }],
];

console.log('config'.padEnd(38), 'acc ', 'MAE ', 'slope');
console.log('-'.repeat(60));
for (const [label, vb] of configs) {
  const r = evaluate(vb);
  console.log(label.padEnd(38), (r.acc * 100).toFixed(0).padStart(3) + '%', r.mae.toFixed(3).padStart(5), r.slope.toFixed(3).padStart(6));
}
