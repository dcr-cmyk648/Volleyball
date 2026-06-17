// Does ANY pregame feature predict blowouts (>8)? If none do, blowouts are
// variance the balancer cannot prevent. Run: node --import ./register.mjs blowout_features.mjs
import { loadDatabase } from './database.mjs';
import { replayRatings, scoreVolleyballCandidateSplit, getGamesSortedOldestFirst } from '../ratings.js';

const { db, players, games, sourceLabel } = await loadDatabase();
const replay = replayRatings({ players, games, seasonal: true, volleyballAdjusted: true, includeLeagueGames: true, options: { seasonalTaperDays: Math.round(6 * 30.4375) } });
const ratingMap = replay.ratingMap, carryMap = replay.carryMap || {};

const lastPlayed = {}; const dayMs = 86400000;
const rows = [];
for (const g of getGamesSortedOldestFirst(games)) {
  if (!g || g.isLeagueGame) continue;
  const red = g.redTeam, blue = g.blueTeam;
  const ids = [...(red || []), ...(blue || [])].map(p => p.id);
  const gd = g.date ? Date.parse(g.date + 'T00:00:00') : null;
  let maxRust = 0;
  if (gd != null) { for (const id of ids) if (lastPlayed[id] != null) maxRust = Math.max(maxRust, (gd - lastPlayed[id]) / dayMs); for (const id of ids) lastPlayed[id] = gd; }
  if (!red?.length || !blue?.length) continue;
  if (typeof g.scoreRed !== 'number' || typeof g.scoreBlue !== 'number') continue;
  if (g.winner !== 'red' && g.winner !== 'blue') continue;
  const s = scoreVolleyballCandidateSplit({ redPlayers: red, bluePlayers: blue, ratingMap, carryScoreMap: carryMap });
  const rb = s.redBreakdown, bb = s.blueBreakdown;
  rows.push({
    isBlowout: Math.abs(g.scoreRed - g.scoreBlue) > 8 ? 1 : 0,
    absSd: Math.abs(s.strengthDiff),
    absSizeDiff: Math.abs(red.length - blue.length),
    spreadSum: (rb.bestRating - rb.worstRating) + (bb.bestRating - bb.worstRating),
    maxSpread: Math.max(rb.bestRating - rb.worstRating, bb.bestRating - bb.worstRating),
    sigmaSum: ids.reduce((t, id) => t + (ratingMap[id] ? Number(ratingMap[id].sigma) : 0), 0),
    skillLevel: (rb.averageRating + bb.averageRating) / 2,
    maxRust,
  });
}
const n = rows.length;
function pb(feat) { // point-biserial corr of feat with isBlowout
  const xs = rows.map(r => r[feat]), ys = rows.map(r => r.isBlowout);
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  // blowout rate in top half vs bottom half by this feature
  const sorted = [...rows].sort((a, b) => a[feat] - b[feat]);
  const lo = sorted.slice(0, Math.floor(n / 2)), hi = sorted.slice(Math.floor(n / 2));
  const rate = a => (a.reduce((t, r) => t + r.isBlowout, 0) / a.length * 100).toFixed(0) + '%';
  return { r: sxy / Math.sqrt(sxx * syy), loRate: rate(lo), hiRate: rate(hi) };
}
console.log(`n=${n}, blowouts=${rows.reduce((t, r) => t + r.isBlowout, 0)}\n`);
console.log('feature'.padEnd(12), 'corr   ', 'lowHalf->highHalf blowout rate');
console.log('-'.repeat(52));
for (const f of ['absSd', 'absSizeDiff', 'spreadSum', 'maxSpread', 'sigmaSum', 'skillLevel', 'maxRust']) {
  const r = pb(f);
  console.log(f.padEnd(12), r.r.toFixed(3).padStart(6), `   ${r.loRate} -> ${r.hiRate}`);
}
