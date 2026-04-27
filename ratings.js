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
  seasonalTaperDays: 180,
};

export const DISPLAY_RATING_BASE = 1500;
export const DISPLAY_RATING_SCALE = 50;

export const SEASONAL_FULL_WEIGHT_DAYS = 7;
export const SEASONAL_TAPER_DAYS = 180;
export const SEASONAL_MIN_WEIGHT = 0.05;

export const DEFAULT_VOLLEYBALL_BALANCE_OPTIONS = {
  topPlayerWeight: 0.40,
  secondPlayerWeight: 0.25,
  averageWeight: 0.25,
  depthWeight: 0.10,
  sizeBonusPerExtraPlayer: 35,
  probabilityScale: 220,
  minWinProbability: 0.05,
  maxWinProbability: 0.95,
  minUpdateMultiplier: 0.35,
  maxUpdateMultiplier: 2.0,
};

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

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function getEffectiveVolleyballSize(players) {
  return Math.min(Array.isArray(players) ? players.length : 0, LEAGUE_TEAM_SIZE);
}

function getLeagueTeamPlayers() {
  return LEAGUE_TEAM_MEMBER_IDS.map((id, index) => ({
    id,
    name: `${LEAGUE_TEAM_NAME} ${index + 1}`,
  }));
}

function getBluePlayersForVolleyballModel(game) {
  if (game?.isLeagueGame) {
    return getLeagueTeamPlayers();
  }

  return Array.isArray(game?.blueTeam) ? game.blueTeam : [];
}

export function getMostRecentGameDate(gamesList) {
  const parsedDates = gamesList
    .map(game => parseDateString(game?.date))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());

  return parsedDates.length ? parsedDates[parsedDates.length - 1] : null;
}

export function getSeasonalWeight(
  gameDateString,
  referenceDate = null,
  seasonDays = SEASONAL_TAPER_DAYS
) {
  const gameDate = parseDateString(gameDateString);
  if (!gameDate || !referenceDate) return 1;

  const safeSeasonDays = Math.max(30, Number(seasonDays) || SEASONAL_TAPER_DAYS);
  const ageDays = daysBetween(gameDate, referenceDate);

  const fullImpactDays = Math.max(
    SEASONAL_FULL_WEIGHT_DAYS,
    safeSeasonDays - 30
  );

  if (ageDays <= fullImpactDays) return 1;

  const inflectionPoint = safeSeasonDays;
  const steepness = 0.12;

  const logistic =
    1 / (1 + Math.exp(steepness * (ageDays - inflectionPoint)));

  return SEASONAL_MIN_WEIGHT + logistic * (1 - SEASONAL_MIN_WEIGHT);
}

export function mergeRatingOptions(overrides = {}) {
  return { ...DEFAULT_RATING_OPTIONS, ...overrides };
}

export function mergeVolleyballBalanceOptions(overrides = {}) {
  return { ...DEFAULT_VOLLEYBALL_BALANCE_OPTIONS, ...overrides };
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
  return [...gamesList]
    .map((game, originalIndex) => ({ game, originalIndex }))
    .sort((a, b) => {
      const dateA = a.game?.date || '';
      const dateB = b.game?.date || '';

      if (dateA !== dateB) {
        return dateA.localeCompare(dateB);
      }

      return b.originalIndex - a.originalIndex;
    })
    .map(entry => entry.game);
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
  if (game?.isLeagueGame) return LEAGUE_TEAM_MEMBER_IDS;
  return (Array.isArray(game?.blueTeam) ? game.blueTeam : []).map(player => player.id);
}

function buildTeamObjectsFromIds(ids, ratingMap) {
  return ids.map(id => ratingMap[id]);
}

function findRatingEntry(entries, playerId) {
  return entries.find(entry => String(entry.id) === String(playerId)) || null;
}

function getGamePlayerIds(game) {
  const redIds = getRedTeamIds(game).map(String);
  const blueIds = getBlueTeamIds(game).map(String);
  return [...redIds, ...blueIds];
}

function getPlayerResultForGame(game, playerId) {
  const playerIdString = String(playerId);
  const redIds = getRedTeamIds(game).map(String);
  const blueIds = getBlueTeamIds(game).map(String);

  const side = redIds.includes(playerIdString)
    ? 'red'
    : blueIds.includes(playerIdString)
      ? 'blue'
      : '';

  if (!side) return null;

  return {
    side,
    won: game.winner === side,
  };
}

function getAverage(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function getMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function getTopValue(values, index, fallback) {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => b - a);
  return typeof sorted[index] === 'number' ? sorted[index] : fallback;
}

export function getVolleyballTeamStrength({
  players = [],
  ratingMap = {},
  ratingOptions = {},
  volleyballOptions = {},
} = {}) {
  const ratingCfg = mergeRatingOptions(ratingOptions);
  const volleyballCfg = mergeVolleyballBalanceOptions(volleyballOptions);

  const ratedPlayers = players.map(player => {
    const skill = ratingMap[player.id] ?? makeInitialRating(ratingCfg);
    const rawRating = getDisplayedRating(skill, ratingCfg);
    const displayRating = toDisplayRating(rawRating);

    return {
      ...player,
      rawRating,
      displayRating,
      mu: Number(skill.mu),
      sigma: Number(skill.sigma),
    };
  });

  const ratings = ratedPlayers.map(player => player.displayRating);

  if (!ratings.length) {
    return {
      teamSize: 0,
      effectiveTeamSize: 0,
      strength: DISPLAY_RATING_BASE,
      baseStrength: DISPLAY_RATING_BASE,
      averageRating: DISPLAY_RATING_BASE,
      medianRating: DISPLAY_RATING_BASE,
      bestRating: DISPLAY_RATING_BASE,
      secondBestRating: DISPLAY_RATING_BASE,
      depthRating: DISPLAY_RATING_BASE,
      sizeAdjustment: 0,
      ratedPlayers,
    };
  }

  const averageRating = getAverage(ratings);
  const medianRating = getMedian(ratings);
  const bestRating = getTopValue(ratings, 0, averageRating);
  const secondBestRating = getTopValue(ratings, 1, averageRating);
  const depthRating = (averageRating + medianRating) / 2;

  const baseStrength =
    volleyballCfg.topPlayerWeight * bestRating +
    volleyballCfg.secondPlayerWeight * secondBestRating +
    volleyballCfg.averageWeight * averageRating +
    volleyballCfg.depthWeight * depthRating;

  return {
    teamSize: players.length,
    effectiveTeamSize: getEffectiveVolleyballSize(players),
    strength: baseStrength,
    baseStrength,
    averageRating,
    medianRating,
    bestRating,
    secondBestRating,
    depthRating,
    sizeAdjustment: 0,
    ratedPlayers,
  };
}

export function scoreVolleyballCandidateSplit({
  redPlayers,
  bluePlayers,
  ratingMap,
  options = {},
  volleyballOptions = {},
} = {}) {
  const ratingCfg = mergeRatingOptions(options);
  const volleyballCfg = mergeVolleyballBalanceOptions(volleyballOptions);

  redPlayers.forEach(player => ensureRatingEntry(ratingMap, player.id, ratingCfg));
  bluePlayers.forEach(player => ensureRatingEntry(ratingMap, player.id, ratingCfg));

  const redStrengthBase = getVolleyballTeamStrength({
    players: redPlayers,
    ratingMap,
    ratingOptions: ratingCfg,
    volleyballOptions: volleyballCfg,
  });

  const blueStrengthBase = getVolleyballTeamStrength({
    players: bluePlayers,
    ratingMap,
    ratingOptions: ratingCfg,
    volleyballOptions: volleyballCfg,
  });

  const redEffectiveSize = getEffectiveVolleyballSize(redPlayers);
  const blueEffectiveSize = getEffectiveVolleyballSize(bluePlayers);

  const sizeDiff = redEffectiveSize - blueEffectiveSize;
  const redSizeAdjustment = sizeDiff * volleyballCfg.sizeBonusPerExtraPlayer;
  const blueSizeAdjustment = -sizeDiff * volleyballCfg.sizeBonusPerExtraPlayer;

  const redStrength = redStrengthBase.baseStrength + redSizeAdjustment;
  const blueStrength = blueStrengthBase.baseStrength + blueSizeAdjustment;

  const strengthDiff = redStrength - blueStrength;

  const rawRedWinProbability = sigmoid(strengthDiff / volleyballCfg.probabilityScale);
  const redWinProbability = clamp(
    rawRedWinProbability,
    volleyballCfg.minWinProbability,
    volleyballCfg.maxWinProbability
  );

  const blueWinProbability = 1 - redWinProbability;
  const fairness = 1 - Math.abs(redWinProbability - 0.5) * 2;
  const drawProxy = fairness;

  return {
    model: 'volleyball-adjusted',
    redPlayers,
    bluePlayers,
    redWinProbability,
    blueWinProbability,
    drawProxy,
    fairness,

    redStrength,
    blueStrength,
    strengthDiff,

    redTeamSize: redPlayers.length,
    blueTeamSize: bluePlayers.length,
    redEffectiveSize,
    blueEffectiveSize,
    sizeDiff,

    redSizeAdjustment,
    blueSizeAdjustment,

    redBreakdown: {
      ...redStrengthBase,
      strength: redStrength,
      sizeAdjustment: redSizeAdjustment,
      effectiveTeamSize: redEffectiveSize,
    },

    blueBreakdown: {
      ...blueStrengthBase,
      strength: blueStrength,
      sizeAdjustment: blueSizeAdjustment,
      effectiveTeamSize: blueEffectiveSize,
    },
  };
}

function getOpenSkillWinnerProbability(redTeam, blueTeam, winner) {
  const predicted = predictWin([redTeam, blueTeam]);
  const redProbability = predicted?.[0] ?? 0.5;
  const blueProbability = predicted?.[1] ?? (1 - redProbability);

  return winner === 'red' ? redProbability : blueProbability;
}

function getVolleyballWinnerProbability(game, ratingMap, options = {}, volleyballOptions = {}) {
  const redPlayers = Array.isArray(game?.redTeam) ? game.redTeam : [];
  const bluePlayers = getBluePlayersForVolleyballModel(game);

  const score = scoreVolleyballCandidateSplit({
    redPlayers,
    bluePlayers,
    ratingMap,
    options,
    volleyballOptions,
  });

  return game?.winner === 'red'
    ? score.redWinProbability
    : score.blueWinProbability;
}

function applyUpdateMultiplier({
  ids,
  beforeEntries,
  updatedTeam,
  ratingMap,
  multiplier,
  options = {},
}) {
  const cfg = mergeRatingOptions(options);

  ids.forEach((id, index) => {
    const before = beforeEntries[index];
    const after = updatedTeam[index];

    const nextMu = before.mu + (Number(after.mu) - before.mu) * multiplier;
    const nextSigma = before.sigma + (Number(after.sigma) - before.sigma) * multiplier;

    ratingMap[id] = rating({
      mu: nextMu,
      sigma: clamp(nextSigma, 1, cfg.sigma),
    });
  });
}

function getVolleyballUpdateMultiplier({
  game,
  redTeam,
  blueTeam,
  ratingMap,
  options = {},
  volleyballOptions = {},
}) {
  if (!game) {
    return {
      multiplier: 1,
      openSkillWinnerProbability: null,
      volleyballWinnerProbability: null,
    };
  }

  const volleyballCfg = mergeVolleyballBalanceOptions(volleyballOptions);

  const openSkillWinnerProbability = clamp(
    getOpenSkillWinnerProbability(redTeam, blueTeam, game.winner),
    0.01,
    0.99
  );

  const volleyballWinnerProbability = clamp(
    getVolleyballWinnerProbability(game, ratingMap, options, volleyballOptions) ?? openSkillWinnerProbability,
    0.01,
    0.99
  );

  const openSkillSurprise = 1 - openSkillWinnerProbability;
  const volleyballSurprise = 1 - volleyballWinnerProbability;

  const rawMultiplier = volleyballSurprise / openSkillSurprise;

  return {
    multiplier: clamp(
      rawMultiplier,
      volleyballCfg.minUpdateMultiplier,
      volleyballCfg.maxUpdateMultiplier
    ),
    openSkillWinnerProbability,
    volleyballWinnerProbability,
  };
}

export function rateSingleGame(game, ratingMap, options = {}) {
  const cfg = mergeRatingOptions(options);
  const volleyballAdjusted = Boolean(options?.volleyballAdjusted);
  const volleyballOptions = options?.volleyballOptions || {};

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

  const marginFactor = getScoreMarginFactor(
    game?.scoreRed,
    game?.scoreBlue,
    cfg
  );

  const seasonalWeight =
    typeof cfg.seasonalWeight === 'number' ? cfg.seasonalWeight : 1;

  const adjustment = volleyballAdjusted
    ? getVolleyballUpdateMultiplier({
        game,
        redTeam,
        blueTeam,
        ratingMap,
        options: cfg,
        volleyballOptions,
      })
    : {
        multiplier: 1,
        openSkillWinnerProbability: null,
        volleyballWinnerProbability: null,
      };

  const finalUpdateMultiplier =
    marginFactor * seasonalWeight * adjustment.multiplier;

  const outcomeScores = game?.winner === 'red'
    ? [1, 0]
    : [0, 1];

  const [updatedRedTeam, updatedBlueTeam] = rate(
    [redTeam, blueTeam],
    {
      score: outcomeScores,
    }
  );

  applyUpdateMultiplier({
    ids: redIds,
    beforeEntries: redBefore,
    updatedTeam: updatedRedTeam,
    ratingMap,
    multiplier: finalUpdateMultiplier,
    options: cfg,
  });

  applyUpdateMultiplier({
    ids: blueIds,
    beforeEntries: blueBefore,
    updatedTeam: updatedBlueTeam,
    ratingMap,
    multiplier: finalUpdateMultiplier,
    options: cfg,
  });

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
    volleyballAdjusted,
    volleyballUpdateMultiplier: adjustment.multiplier,
    finalUpdateMultiplier,
    openSkillWinnerProbability: adjustment.openSkillWinnerProbability,
    volleyballWinnerProbability: adjustment.volleyballWinnerProbability,
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
  volleyballAdjusted = false,
  volleyballOptions = {},
} = {}) {
  const cfg = mergeRatingOptions(options);
  const ratingMap = {};
  const statsMap = {};
  const history = [];
  const seasonalTaperDays =
    typeof cfg.seasonalTaperDays === 'number'
      ? cfg.seasonalTaperDays
      : SEASONAL_TAPER_DAYS;

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
      ? getSeasonalWeight(game?.date, referenceDate, seasonalTaperDays)
      : 1;

    const historyEntry = rateSingleGame(game, ratingMap, {
      ...cfg,
      seasonalWeight,
      volleyballAdjusted,
      volleyballOptions,
    });

    history.push(historyEntry);

    const redTeam = Array.isArray(game.redTeam) ? game.redTeam : [];
    const blueTeam = Array.isArray(game.blueTeam) ? game.blueTeam : [];

    redTeam.forEach(player => {
      if (!statsMap[player.id]) {
        statsMap[player.id] = { id: player.id, name: player.name, wins: 0, games: 0 };
      }
      statsMap[player.id].games += 1;
      if (game.winner === 'red') statsMap[player.id].wins += 1;
    });

    if (!game.isLeagueGame) {
      blueTeam.forEach(player => {
        if (!statsMap[player.id]) {
          statsMap[player.id] = { id: player.id, name: player.name, wins: 0, games: 0 };
        }
        statsMap[player.id].games += 1;
        if (game.winner === 'blue') statsMap[player.id].wins += 1;
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
      if (game.winner === 'blue') leagueTeam.wins += 1;
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
    volleyballAdjusted,
  };
}

export function getPlayerRatingTimeline({
  players = [],
  games = [],
  playerId,
  options = {},
  seasonal = false,
  volleyballAdjusted = false,
  volleyballOptions = {},
} = {}) {
  const cfg = mergeRatingOptions(options);
  const ratingMap = {};
  const timeline = [];
  const seasonalTaperDays =
    typeof cfg.seasonalTaperDays === 'number'
      ? cfg.seasonalTaperDays
      : SEASONAL_TAPER_DAYS;

  players.forEach(player => {
    ratingMap[player.id] = makeInitialRating(cfg);
  });

  const sortedGames = getGamesSortedOldestFirst(games);
  const referenceDate = seasonal ? getMostRecentGameDate(sortedGames) : null;

  sortedGames.forEach((game, chronologicalIndex) => {
    const playerIds = getGamePlayerIds(game);

    if (!playerIds.includes(String(playerId))) {
      ensureRatingsForGame(ratingMap, game, cfg);
      return;
    }

    const seasonalWeight = seasonal
      ? getSeasonalWeight(game?.date, referenceDate, seasonalTaperDays)
      : 1;

    const result = rateSingleGame(game, ratingMap, {
      ...cfg,
      seasonalWeight,
      volleyballAdjusted,
      volleyballOptions,
    });

    const beforeEntries = [...result.before.red, ...result.before.blue];
    const afterEntries = [...result.after.red, ...result.after.blue];

    const before = findRatingEntry(beforeEntries, playerId);
    const after = findRatingEntry(afterEntries, playerId);
    const playerResult = getPlayerResultForGame(game, playerId);

    if (!before || !after || !playerResult) return;

    timeline.push({
      gameId: game.id,
      chronologicalIndex,
      date: game.date || '',
      winner: game.winner,
      side: playerResult.side,
      won: playerResult.won,
      isLeagueGame: Boolean(game.isLeagueGame),
      scoreRed: typeof game.scoreRed === 'undefined' ? null : game.scoreRed,
      scoreBlue: typeof game.scoreBlue === 'undefined' ? null : game.scoreBlue,
      ratingBefore: before.rating,
      ratingAfter: after.rating,
      displayRatingBefore: toDisplayRating(before.rating),
      displayRatingAfter: toDisplayRating(after.rating),
      muBefore: before.mu,
      muAfter: after.mu,
      sigmaBefore: before.sigma,
      sigmaAfter: after.sigma,
      marginFactor: result.marginFactor,
      seasonalWeight: result.seasonalWeight,
      volleyballAdjusted: result.volleyballAdjusted,
      volleyballUpdateMultiplier: result.volleyballUpdateMultiplier,
      openSkillWinnerProbability: result.openSkillWinnerProbability,
      volleyballWinnerProbability: result.volleyballWinnerProbability,
      redTeam: Array.isArray(game.redTeam) ? cloneSimple(game.redTeam) : [],
      blueTeam: Array.isArray(game.blueTeam) ? cloneSimple(game.blueTeam) : [],
      leagueOpponent: game.leagueOpponent ? cloneSimple(game.leagueOpponent) : null,
    });
  });

  return timeline;
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
    model: 'openskill',
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
    const rawRating = getDisplayedRating(skill, cfg);
    return {
      ...player,
      rating: rawRating,
      displayRating: toDisplayRating(rawRating),
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

export function formatPublicRating(value) {
  return `${Math.round(Number(value))}`;
}

export function formatMu(value) {
  return Number(value).toFixed(2);
}

export function formatSigma(value) {
  return Number(value).toFixed(2);
}
