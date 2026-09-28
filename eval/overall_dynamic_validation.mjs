// Frozen-data, whole-date holdouts: no game from a test session enters its fit.
// Scores point share, which is the model's likelihood (not win probability).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { calculateOverallDynamicScoreboard as calculate, toOverallDynamicDisplayRating } from '../overall-dynamic-ratings.js';

const db = JSON.parse(fs.readFileSync(process.env.VBALL_DB || 'default_database', 'utf8'));
const baseRef = process.env.VBALL_BASE_REF || '4e4eb16';
const baseSource = (process.env.VBALL_BASE_SOURCE
  ? fs.readFileSync(process.env.VBALL_BASE_SOURCE, 'utf8')
  : execFileSync('git', ['show', `${baseRef}:overall-dynamic-ratings.js`], { encoding: 'utf8' }))
  .replace('"./bayesian-ratings.js"', JSON.stringify(new URL('../bayesian-ratings.js', import.meta.url).href));
const { calculateOverallDynamicScoreboard: baseline } = await import(`data:text/javascript;base64,${Buffer.from(baseSource).toString('base64')}`);
const dateOf = g => String(g.date || g.gameDate || g.createdAt).slice(0, 10);
const dates = [...new Set(db.games.map(dateOf))].sort();
const count = Number(process.env.VBALL_VALIDATION_DATES || 8);
const skipLatest = Number(process.env.VBALL_VALIDATION_SKIP_LATEST || 0);
const testDates = dates.slice(Math.max(0, dates.length - skipLatest - count), dates.length - skipLatest);
const variants = [
  { name: 'deployed', fit: baseline },
  { name: 'skill-and-form', fit: calculate },
  { name: 'broad-start-and-context', fit: calculate, options: { initialSdPublic: 300, contextSdPublic: 100 } },
  { name: 'wider-start', fit: calculate, options: { initialSdPublic: 600, contextSdPublic: 100 } },
  { name: 'anchored-broad-start', fit: calculate, options: { initialSdPublic: 300 } },
].filter(v => (process.env.VBALL_VARIANTS || 'deployed,skill-and-form').split(',').includes(v.name));
const results = [];
for (const variant of variants) {
  const errors = [];
  for (const date of testDates) {
    const train = db.games.filter(g => dateOf(g) < date);
    const test = db.games.filter(g => dateOf(g) === date);
    const before = variant.fit({ players: db.players, games: train, options: variant.options });
    const means = new Map(before.ratings.map(r => [String(r.id), (r.mu - 25) * 50]));
    const rates = new Map(before.playerRates.players.map(r => [String(r.id), r.rate]));
    // Completed sessions contribute their learned exposure drift at the next appearance.
    const skill = p => {
      const id = String(p.id), last = before.history[id]?.at(-1);
      return (means.get(id) || 0) + (last ? (rates.get(id) || 0) * last.deltaH : 0);
    };
    const average = team => team.reduce((sum, p) => sum + skill(p), 0) / team.length;
    for (const g of test) {
      const sr = Number(g.scoreRed), sb = Number(g.scoreBlue);
      if (!Number.isFinite(sr) || !Number.isFinite(sb) || sr + sb <= 0 || !g.redTeam?.length || (!g.isLeagueGame && !g.blueTeam?.length)) continue;
      const bracket = g.isLeagueGame && (g.leaguePhase === 'bracket' || ['2026-08-19', '2026-08-20'].includes(date));
      const opponent = g.isLeagueGame
        ? (before.diagnostics.fittedLeagueContexts[String(g.leagueOpponent?.id || 'league-date-context')] || 0) + (bracket ? before.diagnostics.bracketPublic : 0)
        : average(g.blueTeam);
      const eta = (average(g.redTeam) - opponent) / (25 / 3 * 50);
      const p = 1 / (1 + Math.exp(-eta)), q = (sr + 0.5) / (sr + sb + 1);
      errors.push({ league: !!g.isLeagueGame, absolute: Math.abs(p - q), square: (p - q) ** 2, ce: -q * Math.log(p) - (1 - q) * Math.log(1 - p) });
    }
    console.error(`${variant.name}: ${date}, ${train.length} prior games, ${test.length} held out`);
  }
  const summarize = rows => ({ games: rows.length, pointShareMAE: rows.reduce((s, r) => s + r.absolute, 0) / rows.length, pointShareRMSE: Math.sqrt(rows.reduce((s, r) => s + r.square, 0) / rows.length), pointShareCrossEntropy: rows.reduce((s, r) => s + r.ce, 0) / rows.length });
  const final = variant.fit({ ...db, options: variant.options });
  const visible = final.ratings.filter(r => r.games >= 10 && !r.isSynthetic);
  const modelUnits = visible.map(r => 1500 + (r.mu - 25) * 50);
  const publicValues = visible.map(r => variant.fit === baseline ? 1500 + r.mu * 50 : toOverallDynamicDisplayRating(r.mu));
  const range = values => [Math.round(Math.min(...values)), Math.round(Math.max(...values))];
  results.push({ model: variant.name, all: summarize(errors), league: summarize(errors.filter(r => r.league)), internal: summarize(errors.filter(r => !r.league)), centeredModelUnitRange: range(modelUnits), publicDisplayRange: range(publicValues) });
}
console.log(JSON.stringify({ baseRef, source: db.source, testDates, results }, null, 2));
