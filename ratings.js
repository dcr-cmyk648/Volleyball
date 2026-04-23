// ratings.js
// Shared rating engine for the Volleyball app.

import {
  rating,
  rate,
  ordinal,
  predictWin,
  predictDraw,
} from "https://esm.sh/openskill@4.1.1";

export const PLAYER_STORAGE_KEY = 'gameDayPlayers';
export const GAME_STORAGE_KEY = 'gameDayGames';
export const PAGE_STATE_KEY = 'gameDayMainPageState';

export const LEAGUE_TEAM_ID = 'league_team';
export const LEAGUE_TEAM_NAME = 'League Team';
export const LEAGUE_TEAM_SIZE = 6;

export const LEAGUE_TEAM_MEMBER_COUNT = 6;
export const LEAGUE_TEAM_MEMBER_IDS = Array.from(
  { length: LEAGUE_TEAM_MEMBER_COUNT },
  (_, i) => `${LEAGUE_TEAM_ID}_${i + 1}`
);

export const DEFAULT_RATING_OPTIONS = {
  mu: 25,
  sigma: 25 / 3,
  ordinalSigmaMultiplier: 3,
  useScoreMargin: true,
  maxMarginBonus: 0.25,
  marginScale: 20,
};

export const DISPLAY_RATING_BASE = 1500;
export const DISPLAY_RATING_SCALE = 50;

// Seasonal ranking settings:
// - 0 days old: full weight
// - ~90+ days old: near-minimal impact
export const SEASONAL_FULL_WEIGHT_DAYS = 7;
export const SEASONAL_TAPER_DAYS = 90;
export const SEASONAL_MIN_WEIGHT = 0.05;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cloneSimple(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseDateString(dateString) {
  if (!dateString || typeof dateString !== 'string') return null;
  const date = new Date(`${dateString}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(fromDate, toDate) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(0, Math.floor((toDate.getTime() - fromDate.getTime()) / msPerDay));
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function getMostRecentGameDate(gamesList) {
  const parsedDates = gamesList
    .map(game => parseDateString(game?.date))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());

  return parsedDates.length ? parsedDates[parsedDates.length - 1] : null;
}

export function getSeasonalWeight(gameDateString, referenceDate = null) {
  const gameDate = parseDateString(gameDateString);
  if (!gameDate || !referenceDate) return 1;

  const ageDays = daysBetween(gameDate, referenceDate);

  if (ageDays <= SEASONAL_FULL_WEIGHT_DAYS) {
    return 1;
  }

  if (ageDays >= SEASONAL_TAPER_DAYS) {
    return SEASONAL_MIN_WEIGHT;
  }

  const progress =
    (ageDays - SEASONAL_FULL_WEIGHT_DAYS) /
    (SEASONAL_TAPER_DAYS - SEASONAL_FULL_WEIGHT_DAYS);

  const eased = easeOutCubic(clamp(progress, 0, 1));
  return 1 - eased * (1 - SEASONAL_MIN_WEIGHT);
}

export function mergeRatingOptions(overrides = {}) {
  return { ...DEFAULT_RATING_OPTIONS, ...overrides };
}

export function makeInitialRating(options = {}) {
  const cfg = mergeRatingOptions(options);
  return rating({ mu: cfg.mu, sigma: cfg.sigma });
}

export function getDisplayedRating(skill, options = {}) {
  const cfg = mergeRatingOptions(options);
  try {
    return ordinal(skill, { z: cfg.ordinalSigmaMultiplier });
  } catch {
    const mu = Number(skill?.mu ?? cfg.mu);
    const sigma = Number(skill?.sigma ?? cfg.sigma);
    return mu - cfg.ordinalSigmaMultiplier * sigma;
  }
}

export function getGamesSortedOldestFirst(gamesList) {
  return [...gamesList].sort((a, b) => {
    const dateA = a?.date || '';
    const dateB = b?.date || '';
    if (dateA !== dateB) {
      return dateA.localeCompare(dateB);
    }
    const idA = typeof a?.id === 'number' ? a.id : 0;
    const idB = typeof b?.id === 'number' ? b.id : 0;
    return idA - idB;
  });
}

export function getScoreMarginFactor(scoreRed, scoreBlue, options = {}) {
  const cfg = mergeRatingOptions(options);
  if (!cfg.useScoreMargin) return 1;

  const red = toFiniteNumber(scoreRed, null);
  const blue = toFiniteNumber(scoreBlue, null);
  if (red === null || blue === null) return 1;

  const pointDiff = Math.abs(red - blue);
  const bonus = clamp(pointDiff / cfg.marginScale, 0, cfg.maxMarginBonus);
  return 1 + bonus;
}

// Converts volleyball score margin into a bounded pair that preserves who won,
// but does not let blowouts dominate the update.
export function buildBoundedModelScores(scoreRed, scoreBlue, winner, options = {}) {
  const marginFactor = getScoreMarginFactor(scoreRed, scoreBlue, options);

  if (winner === 'red') {
    return {
      modelScores: [marginFactor, 1],
      marginFactor,
    };
  }

  return {
    modelScores: [1, marginFactor],
    marginFactor,
  };
}

export function applySeasonalWeightToModelScores(modelScores, seasonalWeight) {
  const safeWeight = clamp(seasonalWeight, SEASONAL_MIN_WEIGHT, 1);

  return modelScores.map(score => {
    // Keep loser score at 1 and pull winner score toward 1 as games get older.
    return 1 + (Number(score) - 1) * safeWeight;
  });
}

export function ensureRatingEntry(ratingMap, playerId, options = {}) {
  if (!ratingMap[playerId]) {
    ratingMap[playerId] = makeInitialRating(options);
  }
  return ratingMap[playerId];
}

export function ensureRatingsForGame(ratingMap, game, options = {}) {
  const redTeam = Array.isArray(game?.redTeam) ? game.redTeam : [];
  const blueTeam = Array.isArray(game?.blueTeam) ? game.blueTeam : [];

  redTeam.forEach(player => ensureRatingEntry(ratingMap, player.id, options));

  if (game?.isLeagueGame) {
    LEAGUE_TEAM_MEMBER_IDS.forEach(id => ensureRatingEntry(ratingMap, id, options));
  } else {
    blueTeam.forEach(player => ensureRatingEntry(ratingMap, player.id, options));
  }
}

function getRedTeamIds(game) {
  return (Array.isArray(game?.redTeam) ? game.redTeam : []).map(player => player.id);
}

function getBlueTeamIds(game) {
  if (game?.isLeagueGame) {
    return LEAGUE_TEAM_MEMBER_IDS;
  }
  return (Array.isArray(game?.blueTeam) ? game.blueTeam : []).map(player => player.id);
}

function buildTeamObjectsFromIds(ids, ratingMap) {
  return ids.map(id => ratingMap[id]);
}

function applyUpdatedTeam(ids, updatedTeam, ratingMap) {
  ids.forEach((id, index) => {
    ratingMap[id] = updatedTeam[index];
  });
}

export function rateSingleGame(game, ratingMap, options = {}) {
  const cfg = mergeRatingOptions(options);
  ensureRatingsForGame(ratingMap, game, cfg);

  const redIds = getRedTeamIds(game);
  const blueIds = getBlueTeamIds(game);

  const redBefore = redIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getDisplayedRating(ratingMap[id], cfg),
  }));

  const blueBefore = blueIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getDisplayedRating(ratingMap[id], cfg),
  }));

  const redTeam = buildTeamObjectsFromIds(redIds, ratingMap);
  const blueTeam = buildTeamObjectsFromIds(blueIds, ratingMap);

  const { modelScores, marginFactor } = buildBoundedModelScores(
    game?.scoreRed,
    game?.scoreBlue,
    game?.winner,
    cfg
  );

  const seasonalWeight =
    typeof cfg.seasonalWeight === 'number' ? cfg.seasonalWeight : 1;

  const weightedModelScores = applySeasonalWeightToModelScores(
    modelScores,
    seasonalWeight
  );

  const [updatedRedTeam, updatedBlueTeam] = rate(
    [redTeam, blueTeam],
    {
      score: weightedModelScores,
    }
  );

  applyUpdatedTeam(redIds, updatedRedTeam, ratingMap);
  applyUpdatedTeam(blueIds, updatedBlueTeam, ratingMap);

  const redAfter = redIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getDisplayedRating(ratingMap[id], cfg),
  }));

  const blueAfter = blueIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getDisplayedRating(ratingMap[id], cfg),
  }));

  return {
    game: cloneSimple(game),
    marginFactor,
    seasonalWeight,
    before: {
      red: redBefore,
      blue: blueBefore,
    },
    after: {
      red: redAfter,
      blue: blueAfter,
    },
  };
}

export function replayRatings({
  players = [],
  games = [],
  options = {},
  seasonal = false,
} = {}) {
  const cfg = mergeRatingOptions(options);
  const ratingMap = {};
  const statsMap = {};
  const history = [];

  players.forEach(player => {
    ratingMap[player.id] = makeInitialRating(cfg);
    statsMap[player.id] = {
      id: player.id,
      name: player.name,
      wins: 0,
      games: 0,
    };
  });

  const sortedGames = getGamesSortedOldestFirst(games);
  const referenceDate = seasonal ? getMostRecentGameDate(sortedGames) : null;

  sortedGames.forEach(game => {
    const seasonalWeight = seasonal
      ? getSeasonalWeight(game?.date, referenceDate)
      : 1;

    const historyEntry = rateSingleGame(game, ratingMap, {
      ...cfg,
      seasonalWeight,
    });

    history.push(historyEntry);

    const redTeam = Array.isArray(game.redTeam) ? game.redTeam : [];
    const blueTeam = Array.isArray(game.blueTeam) ? game.blueTeam : [];

    redTeam.forEach(player => {
      if (!statsMap[player.id]) {
        statsMap[player.id] = { id: player.id, name: player.name, wins: 0, games: 0 };
      }
      statsMap[player.id].games += 1;
      if (game.winner === 'red') {
        statsMap[player.id].wins += 1;
      }
    });

    if (!game.isLeagueGame) {
      blueTeam.forEach(player => {
        if (!statsMap[player.id]) {
          statsMap[player.id] = { id: player.id, name: player.name, wins: 0, games: 0 };
        }
        statsMap[player.id].games += 1;
        if (game.winner === 'blue') {
          statsMap[player.id].wins += 1;
        }
      });
    }
  });

  const standings = Object.values(statsMap)
    .map(player => {
      const skill = ratingMap[player.id] ?? makeInitialRating(cfg);
      return {
        id: player.id,
        name: player.name,
        rating: getDisplayedRating(skill, cfg),
        mu: Number(skill.mu),
        sigma: Number(skill.sigma),
        wins: player.wins,
        games: player.games,
        winrate: player.games > 0 ? player.wins / player.games : 0.5,
      };
    })
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.games !== a.games) return b.games - a.games;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  const leagueMembers = LEAGUE_TEAM_MEMBER_IDS.map(
    id => ratingMap[id] ?? makeInitialRating(cfg)
  );

  const leagueMu =
    leagueMembers.reduce((sum, s) => sum + Number(s.mu), 0) / leagueMembers.length;

  const leagueSigma =
    leagueMembers.reduce((sum, s) => sum + Number(s.sigma), 0) / leagueMembers.length;

  const leagueSkill = { mu: leagueMu, sigma: leagueSigma };

  const leagueTeam = {
    id: LEAGUE_TEAM_ID,
    name: LEAGUE_TEAM_NAME,
    rating: getDisplayedRating(leagueSkill, cfg),
    mu: Number(leagueSkill.mu),
    sigma: Number(leagueSkill.sigma),
    wins: 0,
    games: 0,
    winrate: 0.5,
  };

  games.forEach(game => {
    if (game.isLeagueGame) {
      leagueTeam.games += 1;
      if (game.winner === 'blue') {
        leagueTeam.wins += 1;
      }
    }
  });

  leagueTeam.winrate = leagueTeam.games > 0 ? leagueTeam.wins / leagueTeam.games : 0.5;

  standings.push(leagueTeam);
  standings.sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.games !== a.games) return b.games - a.games;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    ratingMap,
    statsMap,
    standings,
    history,
    leagueTeam,
  };
}

export function scoreCandidateSplit({ redPlayers, bluePlayers, ratingMap, options = {} }) {
  const cfg = mergeRatingOptions(options);

  redPlayers.forEach(player => ensureRatingEntry(ratingMap, player.id, cfg));
  bluePlayers.forEach(player => ensureRatingEntry(ratingMap, player.id, cfg));

  const redTeam = redPlayers.map(player => ratingMap[player.id]);
  const blueTeam = bluePlayers.map(player => ratingMap[player.id]);

  const redWinProbability = predictWin([redTeam, blueTeam])?.[0] ?? 0.5;
  const blueWinProbability = 1 - redWinProbability;
  const drawProxy = predictDraw([redTeam, blueTeam]) ?? 0;

  const fairness = 1 - Math.abs(redWinProbability - 0.5) * 2;

  return {
    redPlayers,
    bluePlayers,
    redWinProbability,
    blueWinProbability,
    drawProxy,
    fairness,
  };
}

export function getPlayerRatingsForList(players, ratingMap, options = {}) {
  const cfg = mergeRatingOptions(options);
  return players.map(player => {
    const skill = ratingMap[player.id] ?? makeInitialRating(cfg);
    return {
      ...player,
      rating: getDisplayedRating(skill, cfg),
      mu: Number(skill.mu),
      sigma: Number(skill.sigma),
    };
  });
}

export function toDisplayRating(value) {
  return DISPLAY_RATING_BASE + Number(value) * DISPLAY_RATING_SCALE;
}

export function formatDisplayedRating(value) {
  return `${Math.round(toDisplayRating(value))}`;
}

export function formatMu(value) {
  return Number(value).toFixed(2);
}

export function formatSigma(value) {
  return Number(value).toFixed(2);
}
