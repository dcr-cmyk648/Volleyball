// Eval-only sweep: provisional/new-player exposure on small teams in multi-team
// session assignment. This approximates the Play page multi-team assignment by
// grouping players present on a historical date, assigning them to balanced
// target team sizes, and trading off strength spread against provisional
// exposure on the smallest teams.

import { loadDatabase } from './database.mjs';
import {
  getGamesSortedOldestFirst,
  getRawOrdinal,
  getVolleyballTeamStrength,
  replayRatings,
} from '../ratings.js';

const { players, games, sourceLabel } = await loadDatabase();

const seasonalTaperDays = Math.round(6 * 30.4375);
const PROV_THRESHOLD = Number(process.env.NEW_TEAM_PROV_THRESHOLD || 5);
const ATTEMPTS = Number(process.env.NEW_TEAM_ATTEMPTS || 2500);
const weights = parseListEnv('NEW_TEAM_WEIGHTS', [0, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1]);
const imbalanceWeights = parseListEnv('NEW_TEAM_IMBALANCE_WEIGHTS', [0, 30]);
const playerCounts = parseListEnv('NEW_TEAM_PLAYER_COUNTS', [12, 13, 14, 15, 16]);
const teamCounts = parseListEnv('NEW_TEAM_COUNTS', [4]);

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(',').map(value => Number(value.trim())).filter(Number.isFinite);
  return parsed.length ? parsed : fallback;
}

function getGameDateValue(game) {
  return typeof game?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(game.date) ? game.date : '';
}

function isScoredNonLeagueGame(game) {
  return (
    game &&
    !game.isLeagueGame &&
    Array.isArray(game.redTeam) &&
    game.redTeam.length > 0 &&
    Array.isArray(game.blueTeam) &&
    game.blueTeam.length > 0 &&
    (game.winner === 'red' || game.winner === 'blue')
  );
}

function getPlayersForGame(game) {
  return [...(game.redTeam || []), ...(game.blueTeam || [])].filter(player => player?.id);
}

function getTargetSizes(totalPlayers, teamCount) {
  const base = Math.floor(totalPlayers / teamCount);
  const remainder = totalPlayers % teamCount;
  return Array.from({ length: teamCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function shuffleCopy(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function assignRandomTeams(present, sizes) {
  const shuffled = shuffleCopy(present);
  const teams = [];
  let cursor = 0;
  sizes.forEach(size => {
    teams.push(shuffled.slice(cursor, cursor + size));
    cursor += size;
  });
  return teams;
}

function averagePairwiseDifference(values) {
  const diffs = [];
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      diffs.push(Math.abs(values[i] - values[j]));
    }
  }
  return diffs.length ? diffs.reduce((sum, value) => sum + value, 0) / diffs.length : 0;
}

function getPlayerRisk(player, ratingMap, counts) {
  const id = String(player.id);
  const gamesPlayed = Math.max(0, Number(counts.get(id)) || 0);
  const skill = ratingMap?.[id] || null;
  const raw = skill ? getRawOrdinal(skill, { seasonalTaperDays }) : 0;
  const sigma = Number(skill?.sigma ?? 25 / 3);
  const lowGamesRisk = Math.max(0, (PROV_THRESHOLD - gamesPlayed) / PROV_THRESHOLD);
  const uncertaintyRisk = Math.max(0, Math.min(1, (sigma - 5) / ((25 / 3) - 5)));
  const lowRatingRisk = Math.max(0, Math.min(1, (-2 - raw) / 5));
  const debutRisk = gamesPlayed === 0 ? 1 : 0;
  return 1 * lowGamesRisk + 0.4 * uncertaintyRisk + 0.4 * lowRatingRisk + 0.8 * debutRisk;
}

function getExposure(teams, ratingMap, counts) {
  return teams.reduce((total, team) => {
    const sizeExposure = team.length <= 3 ? 1.35 : 0;
    if (!sizeExposure) return total;
    return total + team.reduce(
      (sum, player) => sum + getPlayerRisk(player, ratingMap, counts) * sizeExposure,
      0
    );
  }, 0);
}

function getSmallTeamProvisionalCount(teams, counts) {
  return teams.reduce((total, team) => {
    if (team.length > 3) return total;
    return total + team.filter(player => (counts.get(String(player.id)) || 0) < PROV_THRESHOLD).length;
  }, 0);
}

function getAveragePairwiseRiskDifference(risks) {
  const diffs = [];
  for (let i = 0; i < risks.length; i += 1) {
    for (let j = i + 1; j < risks.length; j += 1) {
      diffs.push(Math.abs(risks[i] - risks[j]));
    }
  }
  return diffs.length ? diffs.reduce((sum, value) => sum + value, 0) / diffs.length : 0;
}

function scoreTeams(teams, ratingMap, carryScoreMap, counts) {
  const strengths = teams.map(team => getVolleyballTeamStrength({
    players: team,
    ratingMap,
    carryScoreMap,
  }).strength);
  return {
    spread: Math.max(...strengths) - Math.min(...strengths),
    averagePairwiseDifference: averagePairwiseDifference(strengths),
    exposure: getExposure(teams, ratingMap, counts),
    riskImbalance: getAveragePairwiseRiskDifference(teams.map(team =>
      team.reduce((sum, player) => sum + getPlayerRisk(player, ratingMap, counts), 0)
    )),
    smallTeamProvisionalCount: getSmallTeamProvisionalCount(teams, counts),
  };
}

function createStats() {
  return {
    sessions: 0,
    spread: 0,
    pairDiff: 0,
    exposure: 0,
    smallProv: 0,
    riskImbalance: 0,
    changed: 0,
  };
}

function addStats(stats, selected, baseline) {
  stats.sessions += 1;
  stats.spread += selected.spread;
  stats.pairDiff += selected.averagePairwiseDifference;
  stats.exposure += selected.exposure;
  stats.smallProv += selected.smallTeamProvisionalCount;
  stats.riskImbalance += selected.riskImbalance;
  stats.changed += selected.key !== baseline.key ? 1 : 0;
}

function summarize(stats) {
  return {
    sessions: stats.sessions,
    spread: stats.sessions ? stats.spread / stats.sessions : null,
    pairDiff: stats.sessions ? stats.pairDiff / stats.sessions : null,
    exposure: stats.sessions ? stats.exposure / stats.sessions : null,
    smallProv: stats.sessions ? stats.smallProv / stats.sessions : null,
    riskImbalance: stats.sessions ? stats.riskImbalance / stats.sessions : null,
    changed: stats.sessions ? stats.changed / stats.sessions : null,
  };
}

function teamKey(teams) {
  return teams
    .map(team => team.map(player => String(player.id)).sort().join(','))
    .sort()
    .join('|');
}

function buildSessions() {
  const sorted = getGamesSortedOldestFirst(games);
  const byDate = new Map();
  sorted.forEach(game => {
    if (!isScoredNonLeagueGame(game)) return;
    const date = getGameDateValue(game);
    if (!date) return;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(game);
  });
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function updateCounts(counts, sessionGames) {
  sessionGames.forEach(game => {
    getPlayersForGame(game).forEach(player => {
      const id = String(player.id);
      counts.set(id, (counts.get(id) || 0) + 1);
    });
  });
}

const sortedGames = getGamesSortedOldestFirst(games);
const sessions = buildSessions();
const priorGames = [];
const counts = new Map();
const configKeys = [];
const statsByConfig = new Map();
weights.forEach(weight => {
  imbalanceWeights.forEach(imbalanceWeight => {
    const key = `${weight}:${imbalanceWeight}`;
    configKeys.push({ key, weight, imbalanceWeight });
    statsByConfig.set(key, createStats());
  });
});
let usableSessions = 0;

for (const [date, sessionGames] of sessions) {
  const presentMap = new Map();
  sessionGames.forEach(game => {
    getPlayersForGame(game).forEach(player => presentMap.set(String(player.id), player));
  });
  const present = [...presentMap.values()];
  const teamCount = teamCounts.find(count => playerCounts.includes(present.length) && count > 1);
  const hasProvisional = present.some(player => (counts.get(String(player.id)) || 0) < PROV_THRESHOLD);

  if (teamCount && hasProvisional) {
    const replay = replayRatings({
      players,
      games: priorGames,
      seasonal: true,
      volleyballAdjusted: true,
      volleyballUpdateUsesBalancerContext: true,
      volleyballUpdateContextMode: 'pair',
      includeLeagueGames: true,
      options: { seasonalTaperDays },
    });
    const sizes = getTargetSizes(present.length, teamCount);
    const bestByConfig = new Map(configKeys.map(({ key }) => [key, null]));

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const teams = assignRandomTeams(present, sizes);
      const score = scoreTeams(teams, replay.ratingMap, replay.carryMap || {}, counts);
      score.key = teamKey(teams);
      configKeys.forEach(({ key, weight, imbalanceWeight }) => {
        const objective = score.averagePairwiseDifference +
          weight * score.exposure +
          imbalanceWeight * score.riskImbalance;
        const best = bestByConfig.get(key);
        if (!best || objective < best.objective) {
          bestByConfig.set(key, { ...score, objective });
        }
      });
    }

    const baseline = bestByConfig.get('0:0');
    configKeys.forEach(({ key }) => {
      addStats(statsByConfig.get(key), bestByConfig.get(key), baseline);
    });
    usableSessions += 1;
  }

  updateCounts(counts, sessionGames);
  sessionGames.forEach(game => {
    const match = sortedGames.find(candidate => candidate === game);
    if (match) priorGames.push(match);
  });
}

const baseline = summarize(statsByConfig.get('0:0'));
const fmt = (value, digits = 3) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
const pct = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(0)}%` : 'n/a';

console.log(`DB: ${sourceLabel}`);
console.log(`sessions=${usableSessions} attempts=${ATTEMPTS} provisionalThreshold=<${PROV_THRESHOLD}`);
console.log('weight'.padStart(6), 'imbWt'.padStart(6), 'spread'.padStart(8), 'pairDiff'.padStart(8), 'exposure'.padStart(8), 'riskImb'.padStart(8), 'dRisk'.padStart(8), 'smallProv'.padStart(9), 'changed'.padStart(8));
configKeys.forEach(({ key, weight, imbalanceWeight }) => {
  const row = summarize(statsByConfig.get(key));
  console.log(
    String(weight).padStart(6),
    String(imbalanceWeight).padStart(6),
    fmt(row.spread).padStart(8),
    fmt(row.pairDiff).padStart(8),
    fmt(row.exposure).padStart(8),
    fmt(row.riskImbalance).padStart(8),
    fmt(row.riskImbalance - baseline.riskImbalance).padStart(8),
    fmt(row.smallProv, 2).padStart(9),
    pct(row.changed).padStart(8)
  );
});
