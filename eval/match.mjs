// Find which replay config reproduces the in-app QC numbers.
import { readFileSync } from 'node:fs';
import {
  replayRatings, calibrateMarginModel, predictExpectedMargin,
  scoreVolleyballCandidateSplit, getGamesSortedOldestFirst,
} from '../ratings.js';

const db = JSON.parse(readFileSync('C:/Users/rowla/Documents/Volleyball/default_database', 'utf8'));
const players = db.players || [];
const games = db.games || [];

function run(volleyballAdjusted, includeLeagueGames, months) {
  const replay = replayRatings({
    players, games, seasonal: true, volleyballAdjusted, includeLeagueGames,
    options: { seasonalTaperDays: Math.round(months * 30.4375) },
  });
  const ratingMap = replay.ratingMap;
  const carryMap = replay.carryMap || {};
  const marginModel = calibrateMarginModel({ games, ratingMap, carryScoreMap: carryMap });
  const analyzable = getGamesSortedOldestFirst(games).filter(g =>
    g && !g.isLeagueGame && g.redTeam?.length && g.blueTeam?.length &&
    (g.winner === 'red' || g.winner === 'blue'));
  let correct = 0, scored = 0, mae = 0;
  for (const g of analyzable) {
    const s = scoreVolleyballCandidateSplit({ redPlayers: g.redTeam, bluePlayers: g.blueTeam, ratingMap, carryScoreMap: carryMap });
    if ((s.redWinProbability >= 0.5 ? 'red' : 'blue') === g.winner) correct++;
    if (typeof g.scoreRed === 'number' && typeof g.scoreBlue === 'number') {
      const actual = g.scoreRed - g.scoreBlue;
      mae += Math.abs(predictExpectedMargin(s.strengthDiff, marginModel) - actual);
      scored++;
    }
  }
  console.log(
    `vbAdj=${volleyballAdjusted?1:0} league=${includeLeagueGames?1:0} mo=${months}`.padEnd(28),
    `n=${analyzable.length}`, `acc=${(correct / analyzable.length * 100).toFixed(0)}%`, `MAE=${(mae / scored).toFixed(2)}`,
  );
}

for (const va of [true, false]) {
  for (const lg of [false, true]) {
    for (const mo of [3, 6, 12]) run(va, lg, mo);
  }
}
