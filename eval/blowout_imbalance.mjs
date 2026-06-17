// Targeted test: does BETWEEN-TEAM imbalance predict blowouts (>8)?
// Run: node --import ./register.mjs blowout_imbalance.mjs
import { loadDatabase } from './database.mjs';
import { replayRatings, scoreVolleyballCandidateSplit, getGamesSortedOldestFirst } from '../ratings.js';

const { db, players, games, sourceLabel } = await loadDatabase();
const replay = replayRatings({ players, games, seasonal: true, volleyballAdjusted: true, includeLeagueGames: true, options: { seasonalTaperDays: Math.round(6 * 30.4375) } });
const ratingMap = replay.ratingMap, carryMap = replay.carryMap || {};

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function teamFeatures(ratedPlayers) {
  const r = ratedPlayers.map(p => p.rawOrdinal).sort((a, b) => b - a);
  const best = r[0] ?? 0;
  const nextTwoAvg = mean(r.slice(1, 3));
  const restAvg = mean(r.slice(1));
  const worstTwoAvg = mean(r.slice(-2));
  const avgSigma = mean(ratedPlayers.map(p => Number(p.sigma)));
  return { bestToNextTwoGap: best - nextTwoAvg, bestMinusRest: best - restAvg, worstTwoAvg, avgSigma };
}

const gamesBefore = {};
const dateOrder = {};
const rows = [];
for (const g of getGamesSortedOldestFirst(games)) {
  if (!g) continue;
  const red = g.redTeam || [], blue = g.blueTeam || [];
  const ids = [...red, ...blue].map(p => p.id);
  const order = (dateOrder[g.date] = (dateOrder[g.date] ?? -1) + 1);
  const newCnt = t => t.filter(p => (gamesBefore[p.id] || 0) < 3).length;
  const provCnt = t => t.filter(p => (gamesBefore[p.id] || 0) < 5).length;

  if (!g.isLeagueGame && red.length && blue.length &&
      typeof g.scoreRed === 'number' && typeof g.scoreBlue === 'number' &&
      (g.winner === 'red' || g.winner === 'blue')) {
    const s = scoreVolleyballCandidateSplit({ redPlayers: red, bluePlayers: blue, ratingMap, carryScoreMap: carryMap });
    const rf = teamFeatures(s.redBreakdown.ratedPlayers);
    const bf = teamFeatures(s.blueBreakdown.ratedPlayers);
    const sizeDiff = Math.abs(red.length - blue.length);
    const smaller = Math.min(red.length, blue.length);
    const sand = g.courtType === 'sand' ? 1 : 0;
    rows.push({
      isBlowout: Math.abs(g.scoreRed - g.scoreBlue) > 8 ? 1 : 0,
      fragilityGapImb: Math.abs(rf.bestToNextTwoGap - bf.bestToNextTwoGap),
      weakTailImb: Math.abs(rf.worstTwoAvg - bf.worstTwoAvg),
      starBurdenImb: Math.abs(rf.bestMinusRest - bf.bestMinusRest),
      sigmaImb: Math.abs(rf.avgSigma - bf.avgSigma),
      newCountImb: Math.abs(newCnt(red) - newCnt(blue)),
      provCountImb: Math.abs(provCnt(red) - provCnt(blue)),
      sizeDiff,
      sizeXsand: sizeDiff * sand,
      sizeProp: smaller > 0 ? sizeDiff / smaller : 0,
      sameDayOrder: order,
    });
  }
  for (const id of ids) gamesBefore[id] = (gamesBefore[id] || 0) + 1;
}

const n = rows.length, nbo = rows.reduce((t, r) => t + r.isBlowout, 0);
function pb(feat) {
  const xs = rows.map(r => r[feat]), ys = rows.map(r => r.isBlowout);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const r = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
  const sorted = [...rows].sort((a, b) => a[feat] - b[feat]);
  const lo = sorted.slice(0, Math.floor(n / 2)), hi = sorted.slice(Math.ceil(n / 2));
  const rate = a => (a.reduce((t, x) => t + x.isBlowout, 0) / a.length * 100).toFixed(0) + '%';
  return { r, lo: rate(lo), hi: rate(hi) };
}
console.log(`n=${n}, blowouts=${nbo} (${(nbo / n * 100).toFixed(0)}%)\n`);
console.log('between-team imbalance feature'.padEnd(22), 'corr  ', 'low->high half rate');
console.log('-'.repeat(58));
for (const f of ['fragilityGapImb', 'weakTailImb', 'starBurdenImb', 'sigmaImb', 'newCountImb', 'provCountImb', 'sizeDiff', 'sizeXsand', 'sizeProp', 'sameDayOrder']) {
  const r = pb(f);
  console.log(f.padEnd(22), r.r.toFixed(3).padStart(6), `   ${r.lo} -> ${r.hi}`);
}
