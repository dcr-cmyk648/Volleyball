// Offline display calibration only; never run this inside the scoreboard.
// node --import ./eval/register.mjs eval/overall_display_calibration.mjs
import fs from 'node:fs';
import {
  replayRatings,
  getSeasonRankingDisplayRawOrdinal,
  getSeasonRankingMaxUnpenalizedDisplayRating,
  toDisplayRating,
} from '../ratings.js';
import {
  calculateOverallDynamicScoreboard,
  toOverallDynamicDisplayRating,
  OVERALL_DYNAMIC_DISPLAY_MULTIPLIER,
} from '../overall-dynamic-ratings.js';

const db = JSON.parse(fs.readFileSync(process.env.VBALL_DB || 'default_database', 'utf8'));
const normal = replayRatings({
  players: db.players, games: db.games, seasonal: true, volleyballAdjusted: true,
  volleyballUpdateUsesBalancerContext: true, volleyballUpdateContextMode: 'pair',
  includeLeagueGames: true,
  options: {
    seasonalTaperDays: 180, leagueDisplayEstimateEnabled: false,
    leagueUpdateMultiplier: 1.25, leagueMuUpdateMultiplier: 1, leagueSigmaUpdateMultiplier: 1,
  },
}).standings.filter(row => !row.isLeagueContext && row.games > 0);
const maxGames = Math.max(...normal.map(row => row.games));
const maxRating = getSeasonRankingMaxUnpenalizedDisplayRating(normal);
const bayesian = calculateOverallDynamicScoreboard(db);
const byId = new Map(bayesian.ratings.map(row => [String(row.id), row]));
const sample = normal.flatMap(row => {
  const bayes = byId.get(String(row.id));
  if (!bayes || bayes.games < 10) return [];
  return [{
    name: row.name,
    normal: toDisplayRating(getSeasonRankingDisplayRawOrdinal({
      ...row, scoreboardMaxGames: maxGames, scoreboardMaxUnpenalizedDisplayRating: maxRating,
    })),
    previousBayesian: 1500 + 50 * (bayes.mu - 25),
    calibratedBayesian: toOverallDynamicDisplayRating(bayes.mu),
  }];
});
function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * p;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}
function summary(key) {
  const values = sample.map(row => row[key]);
  const q25 = quantile(values, 0.25), q75 = quantile(values, 0.75);
  return { q25, q75, iqr: q75 - q25, range: [Math.min(...values), Math.max(...values)] };
}
const ordinary = summary('normal'), previous = summary('previousBayesian');
console.log(JSON.stringify({
  source: db.source, games: db.games.length, matchedPlayers: sample.length,
  method: 'Same players with at least ten Bayesian games; match middle-50% width around fixed 1500',
  normal: ordinary, previousBayesian: previous, calibratedBayesian: summary('calibratedBayesian'),
  measuredIqrRatio: ordinary.iqr / previous.iqr,
  fixedDisplayMultiplier: OVERALL_DYNAMIC_DISPLAY_MULTIPLIER,
  note: 'Multiplier is frozen in source, never recomputed by the live app.',
}, null, 2));
