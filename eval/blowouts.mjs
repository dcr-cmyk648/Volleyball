// Are blowouts (>8 pt margin) driven by strength MISMATCH (balancing can prevent)
// or by even-matchup variance (balancing cannot)? Run: node --import ./register.mjs blowouts.mjs
import { readFileSync } from 'node:fs';
import {
  replayRatings, scoreVolleyballCandidateSplit, getGamesSortedOldestFirst,
} from '../ratings.js';

const db = JSON.parse(readFileSync('C:/Users/rowla/Documents/Volleyball/default_database', 'utf8'));
const players = db.players || [];
const games = db.games || [];

const replay = replayRatings({
  players, games, seasonal: true, volleyballAdjusted: true, includeLeagueGames: true,
  options: { seasonalTaperDays: Math.round(6 * 30.4375) },
});
const ratingMap = replay.ratingMap;
const carryMap = replay.carryMap || {};

const rows = [];
for (const g of getGamesSortedOldestFirst(games)) {
  if (!g || g.isLeagueGame) continue;
  if (!g.redTeam?.length || !g.blueTeam?.length) continue;
  if (typeof g.scoreRed !== 'number' || typeof g.scoreBlue !== 'number') continue;
  if (g.winner !== 'red' && g.winner !== 'blue') continue;
  const s = scoreVolleyballCandidateSplit({ redPlayers: g.redTeam, bluePlayers: g.blueTeam, ratingMap, carryScoreMap: carryMap });
  const absMargin = Math.abs(g.scoreRed - g.scoreBlue);
  const absSd = Math.abs(s.strengthDiff);
  // Did the model's favorite (higher strength side) actually win?
  const favorite = s.strengthDiff >= 0 ? 'red' : 'blue';
  rows.push({ absMargin, absSd, isBlowout: absMargin > 8, favoriteWon: favorite === g.winner, winProb: Math.max(s.redWinProbability, s.blueWinProbability) });
}

const n = rows.length;
const blowouts = rows.filter(r => r.isBlowout);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// Tertiles of |strengthDiff|
const sorted = [...rows].sort((a, b) => a.absSd - b.absSd);
const t1 = sorted.slice(0, Math.floor(n / 3));
const t2 = sorted.slice(Math.floor(n / 3), Math.floor(2 * n / 3));
const t3 = sorted.slice(Math.floor(2 * n / 3));
const rate = a => (a.filter(r => r.isBlowout).length / a.length * 100);

console.log(`games=${n}, blowouts(>8)=${blowouts.length} (${(blowouts.length / n * 100).toFixed(0)}%)\n`);

console.log('blowout rate by strength-gap tertile (|strengthDiff|):');
console.log(`  even    (|sd| ${t1[0].absSd.toFixed(1)}-${t1[t1.length - 1].absSd.toFixed(2)}): ${rate(t1).toFixed(0)}%  (${t1.filter(r => r.isBlowout).length}/${t1.length})`);
console.log(`  middle  (|sd| ${t2[0].absSd.toFixed(2)}-${t2[t2.length - 1].absSd.toFixed(2)}): ${rate(t2).toFixed(0)}%  (${t2.filter(r => r.isBlowout).length}/${t2.length})`);
console.log(`  mismatch(|sd| ${t3[0].absSd.toFixed(2)}-${t3[t3.length - 1].absSd.toFixed(2)}): ${rate(t3).toFixed(0)}%  (${t3.filter(r => r.isBlowout).length}/${t3.length})`);

// Point-biserial correlation between |sd| and blowout
const sd = rows.map(r => r.absSd), bo = rows.map(r => r.isBlowout ? 1 : 0);
const ms = mean(sd), mb = mean(bo);
let sxy = 0, sxx = 0, syy = 0;
for (let i = 0; i < n; i++) { const dx = sd[i] - ms, dy = bo[i] - mb; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
console.log(`\ncorr(|strengthDiff|, isBlowout) = ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`);

console.log(`\namong blowouts: avg |strengthDiff| = ${mean(blowouts.map(r => r.absSd)).toFixed(2)}  vs non-blowout = ${mean(rows.filter(r => !r.isBlowout).map(r => r.absSd)).toFixed(2)}`);
console.log(`among blowouts: favorite won = ${blowouts.filter(r => r.favoriteWon).length}/${blowouts.length}  (rest were upset blowouts)`);
