// ratings.js
// Shared rating engine for the Volleyball app.
//
// Architecture:
// - Backend model uses OpenSkill skill objects: { mu, sigma }.
// - Raw rating / raw ordinal = mu - z * sigma. This stays on OpenSkill scale.
// - Volleyball balancing uses raw ordinal scale, not public display scale.
// - Public display rating is only created at UI/display boundaries:
//     displayRating = 1500 + rawOrdinal * 50
// - Leaderboard rating is display/ranking only. It is confidence-adjusted so
//   low-game players are pulled toward baseline until they have more data.
// - Leaderboard rating must not feed back into OpenSkill updates or team balancing.

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

export const LEAGUE_LEVEL_REC = 'rec';
export const LEAGUE_LEVEL_INTERMEDIATE = 'intermediate';
export const COURT_TYPE_INDOOR = 'indoor';
export const COURT_TYPE_SAND = 'sand';

export const LEAGUE_CONTEXTS = [
  {
    id: `${LEAGUE_TEAM_ID}_rec_indoor`,
    key: 'rec_indoor',
    level: LEAGUE_LEVEL_REC,
    courtType: COURT_TYPE_INDOOR,
    name: 'Rec League Indoor',
  },
  {
    id: `${LEAGUE_TEAM_ID}_rec_sand`,
    key: 'rec_sand',
    level: LEAGUE_LEVEL_REC,
    courtType: COURT_TYPE_SAND,
    name: 'Rec League Sand',
  },
  {
    id: `${LEAGUE_TEAM_ID}_intermediate_indoor`,
    key: 'intermediate_indoor',
    level: LEAGUE_LEVEL_INTERMEDIATE,
    courtType: COURT_TYPE_INDOOR,
    name: 'Intermediate League Indoor',
  },
  {
    id: `${LEAGUE_TEAM_ID}_intermediate_sand`,
    key: 'intermediate_sand',
    level: LEAGUE_LEVEL_INTERMEDIATE,
    courtType: COURT_TYPE_SAND,
    name: 'Intermediate League Sand',
  },
];

export const LEAGUE_TEAM_MEMBER_COUNT = 12;

export const LEAGUE_TEAM_MEMBER_IDS = LEAGUE_CONTEXTS.flatMap(context =>
  Array.from(
    { length: LEAGUE_TEAM_MEMBER_COUNT },
    (_, i) => `${context.id}_${i + 1}`
  )
);

export const DISPLAY_RATING_BASE = 1500;
export const DISPLAY_RATING_SCALE = 50;

export const SEASONAL_FULL_WEIGHT_DAYS = 7;
export const SEASONAL_TAPER_DAYS = 180;
export const SEASONAL_MIN_WEIGHT = 0.05;

export const DEFAULT_RATING_OPTIONS = {
  mu: 25,
  sigma: 25 / 3,
  ordinalSigmaMultiplier: 3,

  useScoreMargin: true,

  // Blowout bonus — uses dominance ratio (winner's share of total points) rather than raw point diff.
  // Formula: bonus = marginBonusScale × (dominanceMargin ^ marginBonusPower)
  // where dominanceMargin = winnerScore / (winnerScore + loserScore) - 0.5
  //
  // Representative values (cap = maxMarginBonus = 0.40):
  //   25-23 → 1.01x   25-21 → 1.04x   25-20 → 1.05x
  //   25-15 → 1.18x   25-10 → 1.40x   25-5  → 1.40x (capped)
  maxMarginBonus: 0.40,
  marginBonusScale: 4.0,
  marginBonusPower: 1.5,

  // Close two-point dampener:
  // A game that finishes 25-23, 26-24, 27-25, etc. is evidence that the teams
  // were well balanced, so rating movement is reduced. The dampener bottoms out at 0.65x.
  closeOvertimeDampenerMin: 0.65,
  closeOvertimeDampenerStep: 0.08,

  seasonalTaperDays: 180,

  // Burn-in: first N games for a player count more, so they reach their true level faster.
  // The update delta (both mu and sigma movement) is scaled up by burnInMultiplier for games
  // where the player has fewer than burnInGames games of history.
  burnInGames: 3,
  burnInMultiplier: 1.5,

  // Two-pass calibration: players with ≤ calibrationGames total games in the dataset
  // get their pass-1 final rating used as the starting point for a second replay pass.
  // This corrects for the inaccurate 1500 default start without a recursive loop.
  // Set to 0 to disable.
  calibrationGames: 10,

  // Leaderboard-only confidence adjustment.
  // This does NOT affect OpenSkill updates or team balancing.
  //
  // Formula:
  //   confidence = (games / (games + leaderboardConfidenceGames)) ^ leaderboardConfidencePower
  //   leaderboardRaw = rawOrdinal * confidence
  //
  // With confidenceGames=8 and power=1.10:
  //   3 games  ≈ 24% confidence
  //   5 games  ≈ 35% confidence
  //   10 games ≈ 53% confidence
  //   20 games ≈ 68% confidence
  //   33 games ≈ 79% confidence
  //
  // This makes it hard for 3-5 game players to sit near the top unless their raw result
  // is extremely strong, while still letting weekly results matter.
  leaderboardConfidenceGames: 8,
  leaderboardConfidencePower: 1.10,
};

// These constants are now calibrated to raw OpenSkill ordinal scale,
// not the 1500-ish public display scale.
// Previous display-scale values were:
//   sizeBonusPerExtraPlayer: 35
//   probabilityScale: 220
//
// Since display rating = 1500 + rawOrdinal * 50,
// divide by 50:
//   35 / 50 = 0.7
//   220 / 50 = 4.4
export const VERSION = 'beta-20260605-9';

export const DEFAULT_VOLLEYBALL_BALANCE_OPTIONS = {
  // Depth-emphasis weights: reduced single-star dominance so two weak players on a
  // small team drag the team down more (better reflects close-game reality).
  topPlayerWeight: 0.30,
  secondPlayerWeight: 0.24,
  averageWeight: 0.28,
  depthWeight: 0.10,
  // worstPlayerWeight is scaled by match closeness at runtime — full weight only in even matchups
  worstPlayerWeight: 0.08,
  // Carry score: bonus raw ordinal added to top player's effective rating
  // when they have a history of winning above their team's modeled probability
  carryScale: 8,
  carryConfidenceGames: 15,
  sizeBonusPerExtraPlayer: 0.7,
  probabilityScale: 4.4,
  // Post-hoc probability calibration. This sharpens displayed/model win
  // probabilities without changing team-strength construction.
  probabilityTemperature: 0.75,
  minWinProbability: 0.05,
  maxWinProbability: 0.95,
  minUpdateMultiplier: 0.35,
  maxUpdateMultiplier: 2.0,
  // Hard cap on the per-game volatility core (marginFactor * surpriseMultiplier),
  // applied before seasonal weighting and size damping. Keeps one surprising blowout
  // from whipsawing the leaderboard, without overriding seasonal taper of old games.
  finalUpdateMultiplierMin: 0.5,
  finalUpdateMultiplierMax: 1.75,
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

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function getEffectiveVolleyballSize(players) {
  return Math.min(Array.isArray(players) ? players.length : 0, LEAGUE_TEAM_SIZE);
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

// Backend raw rating / raw ordinal.
// This stays on OpenSkill scale and is safe for backend model logic.
export function getRawOrdinal(skill, options = {}) {
  const cfg = mergeRatingOptions(options);

  try {
    return ordinal(skill, { z: cfg.ordinalSigmaMultiplier });
  } catch {
    const mu = Number(skill?.mu ?? cfg.mu);
    const sigma = Number(skill?.sigma ?? cfg.sigma);
    return mu - cfg.ordinalSigmaMultiplier * sigma;
  }
}

// Backward-compatible alias.
// Important: this returns raw ordinal, NOT the 1500-ish public score.
export function getDisplayedRating(skill, options = {}) {
  return getRawOrdinal(skill, options);
}

export function toDisplayRating(rawOrdinal) {
  return DISPLAY_RATING_BASE + Number(rawOrdinal) * DISPLAY_RATING_SCALE;
}

export function getDisplayRatingFromSkill(skill, options = {}) {
  return toDisplayRating(getRawOrdinal(skill, options));
}

// Leaderboard-only confidence adjustment.
// This pulls low-game ratings toward baseline 1500 for standings display/sorting.
// It must not be used by balancing or OpenSkill updates.
export function getLeaderboardRawOrdinal(rawOrdinal, games = 0, options = {}) {
  const cfg = mergeRatingOptions(options);
  const safeGames = Math.max(0, Number(games) || 0);
  const confidenceGames = Math.max(1, Number(cfg.leaderboardConfidenceGames) || 8);
  const confidencePower = Math.max(0.1, Number(cfg.leaderboardConfidencePower) || 1);

  const baseConfidence = safeGames / (safeGames + confidenceGames);
  const confidence = Math.pow(baseConfidence, confidencePower);

  return Number(rawOrdinal) * confidence;
}

export function getLeaderboardRawOrdinalFromSkill(skill, games = 0, options = {}) {
  return getLeaderboardRawOrdinal(getRawOrdinal(skill, options), games, options);
}

export function getLeaderboardDisplayRatingFromSkill(skill, games = 0, options = {}) {
  return toDisplayRating(getLeaderboardRawOrdinalFromSkill(skill, games, options));
}

export function formatDisplayedRating(rawOrdinal) {
  return `${Math.round(toDisplayRating(rawOrdinal))}`;
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

export function getLeagueLevel(game) {
  if (!game?.isLeagueGame) return null;
  return game.level === LEAGUE_LEVEL_INTERMEDIATE
    ? LEAGUE_LEVEL_INTERMEDIATE
    : LEAGUE_LEVEL_REC;
}

export function getCourtType(game) {
  return game?.courtType === COURT_TYPE_SAND
    ? COURT_TYPE_SAND
    : COURT_TYPE_INDOOR;
}

export function getLeagueContextKey(game) {
  const level = getLeagueLevel(game);
  if (!level) return null;
  const courtType = getCourtType(game);
  return `${level}_${courtType}`;
}

export function getLeagueContext(game) {
  const key = getLeagueContextKey(game);
  return LEAGUE_CONTEXTS.find(context => context.key === key) || LEAGUE_CONTEXTS[0];
}

export function getLeagueContextById(id) {
  return LEAGUE_CONTEXTS.find(context => String(context.id) === String(id)) || null;
}

export function isLeagueContextId(id) {
  return Boolean(getLeagueContextById(id));
}

function getLeagueTeamMemberIdsForContext(context, count = LEAGUE_TEAM_SIZE) {
  const safeCount = Math.max(1, Number(count) || LEAGUE_TEAM_SIZE);
  return Array.from(
    { length: safeCount },
    (_, i) => `${context.id}_${i + 1}`
  );
}

function getLeagueTeamPlayersForGame(game) {
  const context = getLeagueContext(game);
  const redCount = Array.isArray(game?.redTeam) && game.redTeam.length > 0
    ? game.redTeam.length
    : LEAGUE_TEAM_SIZE;

  return getLeagueTeamMemberIdsForContext(context, redCount).map((id, index) => ({
    id,
    name: `${context.name} ${index + 1}`,
  }));
}

function getBluePlayersForVolleyballModel(game) {
  if (game?.isLeagueGame) {
    return getLeagueTeamPlayersForGame(game);
  }

  return Array.isArray(game?.blueTeam) ? game.blueTeam : [];
}

function getIncludedGames(games, includeLeagueGames = true) {
  const safeGames = Array.isArray(games) ? games : [];

  if (includeLeagueGames) {
    return safeGames;
  }

  return safeGames.filter(game => !game?.isLeagueGame);
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

  if (ageDays <= SEASONAL_FULL_WEIGHT_DAYS) return 1;

  const inflectionPoint = Math.max(
    SEASONAL_FULL_WEIGHT_DAYS + 1,
    safeSeasonDays - 30
  );

  const steepness = 6 / Math.max(14, safeSeasonDays);

  const logistic =
    1 / (1 + Math.exp(steepness * (ageDays - inflectionPoint)));

  const normalizedAtRecent =
    1 / (1 + Math.exp(steepness * (SEASONAL_FULL_WEIGHT_DAYS - inflectionPoint)));

  const scaled = logistic / normalizedAtRecent;

  return clamp(
    SEASONAL_MIN_WEIGHT + scaled * (1 - SEASONAL_MIN_WEIGHT),
    SEASONAL_MIN_WEIGHT,
    1
  );
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

      // When both games carry a createdAt timestamp, use it for a precise same-day ordering.
      const tsA = a.game?.createdAt ?? null;
      const tsB = b.game?.createdAt ?? null;
      if (tsA !== null && tsB !== null) {
        return tsA - tsB;
      }

      return b.originalIndex - a.originalIndex;
    })
    .map(entry => entry.game);
}

export function getScoreMarginDetails(scoreRed, scoreBlue, options = {}) {
  const cfg = mergeRatingOptions(options);

  const emptyDetails = {
    marginFactor: 1,
    blowoutBonusFactor: 1,
    closeOvertimeDampener: 1,
    pointDiff: null,
    winnerScore: null,
    loserScore: null,
    isCloseOvertime: false,
  };

  if (!cfg.useScoreMargin) return emptyDetails;

  const red = toFiniteNumber(scoreRed, null);
  const blue = toFiniteNumber(scoreBlue, null);
  if (red === null || blue === null) return emptyDetails;

  const pointDiff = Math.abs(red - blue);
  const winnerScore = Math.max(red, blue);
  const loserScore = Math.min(red, blue);

  // Dominance ratio: winner's fraction of total points, shifted so 50/50 = 0.
  // This naturally encodes loser score — 25-21 has lower dominance than 25-17 even though
  // both might be considered a 4-point or 8-point margin.
  const totalPoints = winnerScore + loserScore;
  const dominanceMargin = totalPoints > 0 ? winnerScore / totalPoints - 0.5 : 0;
  const scale = Number(cfg.marginBonusScale) || 4.0;
  const power = Number(cfg.marginBonusPower) || 1.5;
  const rawBonus = scale * Math.pow(Math.max(0, dominanceMargin), power);
  const bonus = clamp(rawBonus, 0, cfg.maxMarginBonus);
  const blowoutBonusFactor = 1 + bonus;

  const isCloseOvertime =
    winnerScore >= 25 &&
    pointDiff === 2;

  let closeOvertimeDampener = 1;

  if (isCloseOvertime) {
    const overtimePoints = Math.max(1, winnerScore - 25);
    const dampenerStep = Number(cfg.closeOvertimeDampenerStep) || DEFAULT_RATING_OPTIONS.closeOvertimeDampenerStep;
    const dampenerMin = Number(cfg.closeOvertimeDampenerMin) || DEFAULT_RATING_OPTIONS.closeOvertimeDampenerMin;

    closeOvertimeDampener = clamp(
      1 - overtimePoints * dampenerStep,
      dampenerMin,
      1
    );
  }

  return {
    marginFactor: blowoutBonusFactor * closeOvertimeDampener,
    blowoutBonusFactor,
    closeOvertimeDampener,
    pointDiff,
    winnerScore,
    loserScore,
    isCloseOvertime,
  };
}

export function getScoreMarginFactor(scoreRed, scoreBlue, options = {}) {
  return getScoreMarginDetails(scoreRed, scoreBlue, options).marginFactor;
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
    getBlueTeamIds(game).forEach(id => ensureRatingEntry(ratingMap, id, options));
  } else {
    blueTeam.forEach(player => ensureRatingEntry(ratingMap, player.id, options));
  }
}

function getRedTeamIds(game) {
  return (Array.isArray(game?.redTeam) ? game.redTeam : []).map(player => player.id);
}

function getBlueTeamIds(game) {
  if (game?.isLeagueGame) {
    const context = getLeagueContext(game);
    const redCount = Array.isArray(game?.redTeam) && game.redTeam.length > 0
      ? game.redTeam.length
      : LEAGUE_TEAM_SIZE;

    return getLeagueTeamMemberIdsForContext(context, redCount);
  }

  return (Array.isArray(game?.blueTeam) ? game.blueTeam : []).map(player => player.id);
}

function buildTeamObjectsFromIds(ids, ratingMap) {
  return ids.map(id => ratingMap[id]);
}

function findRatingEntry(entries, playerId) {
  return entries.find(entry => String(entry.id) === String(playerId)) || null;
}

function syncRatingEntry(entries, playerId, skill, options = {}) {
  const entry = findRatingEntry(entries, playerId);
  if (!entry || !skill) return;
  entry.mu = Number(skill.mu);
  entry.sigma = Number(skill.sigma);
  entry.rating = getRawOrdinal(skill, options);
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

// Updates a running carry score for a player after a game.
// carry score = mean(actual_outcome - pre_game_team_win_probability) across all games.
// Positive = consistently wins more than the model expects; negative = underperforms expectations.
function updateCarryScore(carryMap, id, isWinner, teamWinProb) {
  const contribution = (isWinner ? 1 : 0) - teamWinProb;
  if (!carryMap[id]) {
    carryMap[id] = { totalContribution: 0, games: 0, score: 0 };
  }
  carryMap[id].totalContribution += contribution;
  carryMap[id].games += 1;
  carryMap[id].score = carryMap[id].totalContribution / carryMap[id].games;
}

export function getVolleyballTeamStrength({
  players = [],
  ratingMap = {},
  carryScoreMap = {},
  ratingOptions = {},
  volleyballOptions = {},
} = {}) {
  const ratingCfg = mergeRatingOptions(ratingOptions);
  const volleyballCfg = mergeVolleyballBalanceOptions(volleyballOptions);
  const baselineRawOrdinal = getRawOrdinal(makeInitialRating(ratingCfg), ratingCfg);

  const ratedPlayers = players.map(player => {
    const skill = ratingMap[player.id] ?? makeInitialRating(ratingCfg);
    const rawOrdinal = getRawOrdinal(skill, ratingCfg);

    return {
      ...player,
      rawOrdinal,
      // Backward-compatible alias for older UI code.
      rating: rawOrdinal,
      displayRating: toDisplayRating(rawOrdinal),
      mu: Number(skill.mu),
      sigma: Number(skill.sigma),
    };
  });

  const ratings = ratedPlayers.map(player => player.rawOrdinal);

  if (!ratings.length) {
    return {
      teamSize: 0,
      effectiveTeamSize: 0,
      strength: baselineRawOrdinal,
      baseStrength: baselineRawOrdinal,
      averageRating: baselineRawOrdinal,
      medianRating: baselineRawOrdinal,
      bestRating: baselineRawOrdinal,
      secondBestRating: baselineRawOrdinal,
      depthRating: baselineRawOrdinal,
      worstRating: baselineRawOrdinal,
      sizeAdjustment: 0,
      ratedPlayers,
    };
  }

  const averageRating = getAverage(ratings);
  const medianRating = getMedian(ratings);
  const bestRating = getTopValue(ratings, 0, averageRating);
  const secondBestRating = getTopValue(ratings, 1, averageRating);
  // 3rd best player — meaningful depth metric for volleyball rotations
  const depthRating = getTopValue(ratings, 2, averageRating);
  // Worst player — weak-link effect; weight is further scaled by match closeness in scoreVolleyballCandidateSplit
  const worstRating = ratings.length ? Math.min(...ratings) : averageRating;

  // Carry bonus: if the top player has a proven track record of winning above team expectations,
  // boost their effective contribution. Confidence scales with game count to avoid noise on few games.
  const topPlayer = ratedPlayers.reduce((best, p) =>
    (p.rawOrdinal > (best?.rawOrdinal ?? -Infinity)) ? p : best, null
  );
  let adjustedBestRating = bestRating;
  if (topPlayer && carryScoreMap[topPlayer.id]) {
    const carryStats = carryScoreMap[topPlayer.id];
    const confidenceGames = Math.max(1, Number(volleyballCfg.carryConfidenceGames) || 15);
    const confidence = carryStats.games / (carryStats.games + confidenceGames);
    // Only positive carry: boost proven stars, don't further penalise underperformers
    const carryBonus = carryStats.score * (Number(volleyballCfg.carryScale) || 8) * confidence;
    adjustedBestRating = bestRating + carryBonus;
  }

  const baseStrength =
    volleyballCfg.topPlayerWeight * adjustedBestRating +
    volleyballCfg.secondPlayerWeight * secondBestRating +
    volleyballCfg.averageWeight * averageRating +
    volleyballCfg.depthWeight * depthRating +
    volleyballCfg.worstPlayerWeight * worstRating;

  return {
    teamSize: players.length,
    effectiveTeamSize: getEffectiveVolleyballSize(players),
    strength: baseStrength,
    baseStrength,
    averageRating,
    medianRating,
    bestRating,
    adjustedBestRating,
    secondBestRating,
    depthRating,
    worstRating,
    sizeAdjustment: 0,
    ratedPlayers,
  };
}

export function scoreVolleyballCandidateSplit({
  redPlayers,
  bluePlayers,
  ratingMap,
  carryScoreMap = {},
  options = {},
  volleyballOptions = {},
  ignoreSizeAdjustment = false,
} = {}) {
  const ratingCfg = mergeRatingOptions(options);
  const volleyballCfg = mergeVolleyballBalanceOptions(volleyballOptions);

  redPlayers.forEach(player => ensureRatingEntry(ratingMap, player.id, ratingCfg));
  bluePlayers.forEach(player => ensureRatingEntry(ratingMap, player.id, ratingCfg));

  const redStrengthBase = getVolleyballTeamStrength({
    players: redPlayers,
    ratingMap,
    carryScoreMap,
    ratingOptions: ratingCfg,
    volleyballOptions: volleyballCfg,
  });

  const blueStrengthBase = getVolleyballTeamStrength({
    players: bluePlayers,
    ratingMap,
    carryScoreMap,
    ratingOptions: ratingCfg,
    volleyballOptions: volleyballCfg,
  });

  const redEffectiveSize = getEffectiveVolleyballSize(redPlayers);
  const blueEffectiveSize = getEffectiveVolleyballSize(bluePlayers);

  const sizeDiff = ignoreSizeAdjustment ? 0 : redEffectiveSize - blueEffectiveSize;
  const redSizeAdjustment = ignoreSizeAdjustment ? 0 : sizeDiff * volleyballCfg.sizeBonusPerExtraPlayer;
  const blueSizeAdjustment = ignoreSizeAdjustment ? 0 : -sizeDiff * volleyballCfg.sizeBonusPerExtraPlayer;

  // Conditional worst player weight: scale down when one team has a dominant star.
  // In a close matchup (matchCloseness ≈ 1) the weak link matters; in a lopsided one it doesn't.
  const redWorstContrib = volleyballCfg.worstPlayerWeight * redStrengthBase.worstRating;
  const blueWorstContrib = volleyballCfg.worstPlayerWeight * blueStrengthBase.worstRating;
  const redWithoutWorst = redStrengthBase.baseStrength - redWorstContrib + redSizeAdjustment;
  const blueWithoutWorst = blueStrengthBase.baseStrength - blueWorstContrib + blueSizeAdjustment;
  const matchCloseness = Math.max(0, 1 - Math.abs(redWithoutWorst - blueWithoutWorst) / (volleyballCfg.probabilityScale * 1.5));

  const redStrength = redWithoutWorst + redWorstContrib * matchCloseness;
  const blueStrength = blueWithoutWorst + blueWorstContrib * matchCloseness;

  const strengthDiff = redStrength - blueStrength;

  const probabilityTemperature = Math.max(
    0.01,
    Number(volleyballCfg.probabilityTemperature) || 1
  );
  const rawRedWinProbability = sigmoid(
    (strengthDiff / volleyballCfg.probabilityScale) / probabilityTemperature
  );
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

// Calibrates the expected point GAP (absolute margin) from team strength
// difference, fit over historical scored non-league games using current ratings:
//   expectedGap = baseMargin + slope * |strengthDiff|
// Fit by ordinary least squares on |actualMargin| vs |strengthDiff|. Using
// magnitudes is sign-agnostic, so it is unaffected by the winner=red convention
// in 4+-team games. The baseMargin intercept captures the inherent gap of a
// race to 21/25 even when teams are perfectly balanced (~5 points in practice).
export function calibrateMarginModel({
  games = [],
  ratingMap = {},
  carryScoreMap = {},
  options = {},
  volleyballOptions = {},
} = {}) {
  const xs = [];
  const ys = [];

  getIncludedGames(games, false).forEach(game => {
    const redPlayers = Array.isArray(game.redTeam) ? game.redTeam : [];
    const bluePlayers = Array.isArray(game.blueTeam) ? game.blueTeam : [];

    if (!redPlayers.length || !bluePlayers.length) return;
    if (typeof game.scoreRed !== 'number' || typeof game.scoreBlue !== 'number') return;

    const score = scoreVolleyballCandidateSplit({
      redPlayers,
      bluePlayers,
      ratingMap,
      carryScoreMap,
      options,
      volleyballOptions,
    });

    xs.push(Math.abs(score.strengthDiff));
    ys.push(Math.abs(game.scoreRed - game.scoreBlue));
  });

  const sampleSize = xs.length;
  if (sampleSize === 0) {
    return { baseMargin: 0, slope: 0, sampleSize: 0 };
  }

  const meanX = xs.reduce((a, b) => a + b, 0) / sampleSize;
  const meanY = ys.reduce((a, b) => a + b, 0) / sampleSize;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) * (xs[i] - meanX);
  }

  const slope = sxx > 0 ? sxy / sxx : 0;
  const baseMargin = meanY - slope * meanX;

  return { baseMargin, slope, sampleSize };
}

// Expected point gap (always >= 0) for a given strength difference.
export function predictExpectedMargin(strengthDiff, marginModel) {
  if (!marginModel) return 0;
  const base = Number.isFinite(marginModel.baseMargin) ? marginModel.baseMargin : 0;
  const slope = Number.isFinite(marginModel.slope) ? marginModel.slope : 0;
  return Math.max(0, base + slope * Math.abs(strengthDiff));
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
    ignoreSizeAdjustment: Boolean(game?.isLeagueGame),
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

  // Keep rating-update surprise on the original probability scale. The
  // probabilityTemperature calibration is for prediction/UI confidence only,
  // and should not silently retune replayed ratings.
  const updateVolleyballOptions = {
    ...volleyballOptions,
    probabilityTemperature: 1,
  };

  const volleyballWinnerProbability = clamp(
    getVolleyballWinnerProbability(game, ratingMap, options, updateVolleyballOptions) ?? openSkillWinnerProbability,
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
    rating: getRawOrdinal(ratingMap[id], cfg),
  }));

  const blueBefore = blueIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getRawOrdinal(ratingMap[id], cfg),
  }));

  const redTeam = buildTeamObjectsFromIds(redIds, ratingMap);
  const blueTeam = buildTeamObjectsFromIds(blueIds, ratingMap);

  const marginDetails = getScoreMarginDetails(
    game?.scoreRed,
    game?.scoreBlue,
    cfg
  );

  const marginFactor = marginDetails.marginFactor;

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

  const vbCfg = mergeVolleyballBalanceOptions(volleyballOptions);
  // Cap the volatility core (margin x surprise) before applying seasonal weight,
  // so seasonal taper of old games is preserved. Normal volleyball margins are
  // noisy, so keep ordinary single-game results from receiving blowout-level movement.
  const marginSensitiveMax = Number.isFinite(marginDetails.pointDiff)
    ? marginDetails.pointDiff <= 1 ? 1.00 :
      marginDetails.pointDiff === 2 ? 1.05 :
      marginDetails.pointDiff <= 3 ? 1.10 :
      marginDetails.pointDiff <= 5 ? 1.20 :
      marginDetails.pointDiff <= 8 ? 1.40 :
      vbCfg.finalUpdateMultiplierMax
    : vbCfg.finalUpdateMultiplierMax;
  const cappedVolatility = clamp(
    marginFactor * adjustment.multiplier,
    vbCfg.finalUpdateMultiplierMin,
    Math.min(vbCfg.finalUpdateMultiplierMax, marginSensitiveMax)
  );
  const baseUpdateMultiplier = cappedVolatility * seasonalWeight;

  // Per-team size damping: players on teams larger than 6 have less individual impact
  // per game (more rotations, fewer touches). Damper = 6 / teamSize for teams > 6.
  const redSizeDamper = LEAGUE_TEAM_SIZE / Math.max(LEAGUE_TEAM_SIZE, redIds.length);
  const blueSizeDamper = LEAGUE_TEAM_SIZE / Math.max(LEAGUE_TEAM_SIZE, blueIds.length);
  const redFinalMultiplier = baseUpdateMultiplier * redSizeDamper;
  const blueFinalMultiplier = baseUpdateMultiplier * blueSizeDamper;
  // Keep finalUpdateMultiplier as the base (pre-size-damping) for display purposes
  const finalUpdateMultiplier = baseUpdateMultiplier;

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
    multiplier: redFinalMultiplier,
    options: cfg,
  });

  applyUpdateMultiplier({
    ids: blueIds,
    beforeEntries: blueBefore,
    updatedTeam: updatedBlueTeam,
    ratingMap,
    multiplier: blueFinalMultiplier,
    options: cfg,
  });

  const redAfter = redIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getRawOrdinal(ratingMap[id], cfg),
  }));

  const blueAfter = blueIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getRawOrdinal(ratingMap[id], cfg),
  }));

  return {
    game: cloneSimple(game),
    marginFactor,
    blowoutBonusFactor: marginDetails.blowoutBonusFactor,
    closeOvertimeDampener: marginDetails.closeOvertimeDampener,
    pointDiff: marginDetails.pointDiff,
    winnerScore: marginDetails.winnerScore,
    loserScore: marginDetails.loserScore,
    isCloseOvertime: marginDetails.isCloseOvertime,
    seasonalWeight,
    redSizeDamper,
    blueSizeDamper,
    redFinalMultiplier,
    blueFinalMultiplier,
    volleyballAdjusted,
    volleyballUpdateMultiplier: adjustment.multiplier,
    finalUpdateMultiplier,
    openSkillWinnerProbability: adjustment.openSkillWinnerProbability,
    volleyballWinnerProbability: adjustment.volleyballWinnerProbability,
    leagueContext: game?.isLeagueGame ? cloneSimple(getLeagueContext(game)) : null,
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

function buildLeagueTeamFromContext(context, ratingMap, cfg, includedGames) {
  const memberIds = getLeagueTeamMemberIdsForContext(context, LEAGUE_TEAM_MEMBER_COUNT);
  const members = memberIds.map(id => ratingMap[id] ?? makeInitialRating(cfg));

  const leagueMu =
    members.reduce((sum, s) => sum + Number(s.mu), 0) / members.length;

  const leagueSigma =
    members.reduce((sum, s) => sum + Number(s.sigma), 0) / members.length;

  const leagueSkill = { mu: leagueMu, sigma: leagueSigma };

  const leagueTeam = {
    id: context.id,
    name: context.name,
    rawOrdinal: getRawOrdinal(leagueSkill, cfg),
    displayRating: getDisplayRatingFromSkill(leagueSkill, cfg),
    leaderboardRawOrdinal: 0,
    leaderboardRating: DISPLAY_RATING_BASE,
    // Backward-compatible alias used by existing stats/index pages.
    rating: 0,
    mu: Number(leagueSkill.mu),
    sigma: Number(leagueSkill.sigma),
    wins: 0,
    games: 0,
    winrate: 0.5,
    isLeagueContext: true,
    leagueContext: cloneSimple(context),
  };

  includedGames.forEach(game => {
    if (game?.isLeagueGame && getLeagueContextKey(game) === context.key) {
      leagueTeam.games += 1;
      if (game.winner === 'blue') leagueTeam.wins += 1;
    }
  });

  leagueTeam.winrate = leagueTeam.games > 0 ? leagueTeam.wins / leagueTeam.games : 0.5;
  leagueTeam.leaderboardRawOrdinal = getLeaderboardRawOrdinal(leagueTeam.rawOrdinal, leagueTeam.games, cfg);
  leagueTeam.leaderboardRating = toDisplayRating(leagueTeam.leaderboardRawOrdinal);
  leagueTeam.rating = leagueTeam.leaderboardRawOrdinal;

  return leagueTeam;
}

export function replayRatings({
  players = [],
  games = [],
  options = {},
  seasonal = false,
  volleyballAdjusted = false,
  volleyballOptions = {},
  includeLeagueGames = true,
  _calibratedStarts = null,
} = {}) {
  const cfg = mergeRatingOptions(options);
  const ratingMap = {};
  const statsMap = {};
  const history = [];
  const carryMap = {};
  const includedGames = getIncludedGames(games, includeLeagueGames);
  const seasonalTaperDays =
    typeof cfg.seasonalTaperDays === 'number'
      ? cfg.seasonalTaperDays
      : SEASONAL_TAPER_DAYS;

  players.forEach(player => {
    const calibrated = _calibratedStarts?.[player.id];
    ratingMap[player.id] = calibrated
      ? rating({ mu: Number(calibrated.mu), sigma: Number(calibrated.sigma) })
      : makeInitialRating(cfg);
    statsMap[player.id] = {
      id: player.id,
      name: player.name,
      wins: 0,
      games: 0,
    };
  });

  const sortedGames = getGamesSortedOldestFirst(includedGames);
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

    // Burn-in: players in their first N games get a scaled-up update so they
    // reach their true rating faster. statsMap.games is the pre-game count here.
    const burnInGames = Number(cfg.burnInGames) || 0;
    const burnInMult = Number(cfg.burnInMultiplier) || 1;
    if (burnInGames > 0 && burnInMult > 1 && _calibratedStarts === null) {
      const applyBurnIn = (beforeEntries, afterEntries) => {
        beforeEntries.forEach((before, i) => {
          const gamesPlayed = statsMap[before.id]?.games ?? 0;
          if (gamesPlayed < burnInGames) {
            const after = afterEntries[i];
            const newMu = before.mu + (after.mu - before.mu) * burnInMult;
            const newSigma = clamp(
              before.sigma + (after.sigma - before.sigma) * burnInMult,
              1,
              cfg.sigma
            );
            ratingMap[before.id] = rating({ mu: newMu, sigma: newSigma });
            // Update historyEntry in-place so trend page reflects burn-in values
            after.mu = newMu;
            after.sigma = newSigma;
            after.rating = getRawOrdinal(ratingMap[before.id], cfg);
          }
        });
      };
      applyBurnIn(historyEntry.before.red, historyEntry.after.red);
      applyBurnIn(historyEntry.before.blue, historyEntry.after.blue);
    }

    // Pass 2: freeze calibrated players within their calibration window.
    // Their calibrated seed was used as input so opponents get correctly re-rated,
    // but we restore it afterward so the calibrated player doesn't accumulate
    // double credit from replaying early games on top of the corrected start.
    // Pre-game statsMap.games < calibrationGames means this is one of their
    // first calibrationGames games (the window where they were seeded incorrectly
    // in pass 1 and are now being corrected for opponents' benefit only).
    if (_calibratedStarts !== null) {
      const calibrationGamesLimit = Number(cfg.calibrationGames) || 0;
      [...getRedTeamIds(game), ...getBlueTeamIds(game)].forEach(id => {
        const cal = _calibratedStarts[id];
        if (cal && (statsMap[id]?.games ?? 0) < calibrationGamesLimit) {
          const calibratedSkill = rating({ mu: Number(cal.mu), sigma: Number(cal.sigma) });
          ratingMap[id] = calibratedSkill;
          syncRatingEntry(historyEntry.after.red, id, calibratedSkill, cfg);
          syncRatingEntry(historyEntry.after.blue, id, calibratedSkill, cfg);
        }
      });
    }

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

    // Update carry scores using the pre-game volleyball win probability from this game result.
    // Fall back to OpenSkill probability if volleyball probability isn't available.
    const winnerProb = historyEntry.volleyballWinnerProbability ??
      historyEntry.openSkillWinnerProbability ??
      0.5;
    const winnerSide = game.winner === 'blue' ? 'blue' : 'red';

    redTeam.forEach(player => {
      const isWinner = winnerSide === 'red';
      updateCarryScore(carryMap, String(player.id), isWinner, isWinner ? winnerProb : 1 - winnerProb);
    });

    // Skip league team members — they are synthetic entities, not real players
    if (!game.isLeagueGame) {
      blueTeam.forEach(player => {
        const isWinner = winnerSide === 'blue';
        updateCarryScore(carryMap, String(player.id), isWinner, isWinner ? winnerProb : 1 - winnerProb);
      });
    }
  });

  const standings = Object.values(statsMap)
    .map(player => {
      const skill = ratingMap[player.id] ?? makeInitialRating(cfg);
      const rawOrdinal = getRawOrdinal(skill, cfg);
      const leaderboardRawOrdinal = getLeaderboardRawOrdinal(rawOrdinal, player.games, cfg);

      return {
        id: player.id,
        name: player.name,

        // Backend/diagnostic values.
        mu: Number(skill.mu),
        sigma: Number(skill.sigma),
        rawOrdinal,

        // Public normal rating without leaderboard confidence correction.
        displayRating: toDisplayRating(rawOrdinal),

        // Leaderboard-only adjusted rating.
        leaderboardRawOrdinal,
        leaderboardRating: toDisplayRating(leaderboardRawOrdinal),

        // Backward-compatible alias used by current stats.html:
        // stats.html calls formatDisplayedRating(player.rating),
        // so rating must be raw ordinal on the chosen display/ranking basis.
        rating: leaderboardRawOrdinal,

        wins: player.wins,
        games: player.games,
        winrate: player.games > 0 ? player.wins / player.games : 0.5,

        // Carry score: how consistently this player wins above their team's modeled probability.
        // effectiveCarryScore is confidence-weighted for display.
        carryScore: (() => {
          const cs = carryMap[String(player.id)];
          return cs ? cs.score : 0;
        })(),
        carryGames: (() => {
          const cs = carryMap[String(player.id)];
          return cs ? cs.games : 0;
        })(),
        carryConfidence: (() => {
          const cs = carryMap[String(player.id)];
          if (!cs || cs.games === 0) return 0;
          const cg = Number(DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryConfidenceGames) || 15;
          return cs.games / (cs.games + cg);
        })(),
        effectiveCarryScore: (() => {
          const cs = carryMap[String(player.id)];
          if (!cs || cs.games === 0) return 0;
          const cg = Number(DEFAULT_VOLLEYBALL_BALANCE_OPTIONS.carryConfidenceGames) || 15;
          const confidence = cs.games / (cs.games + cg);
          return cs.score * confidence;
        })(),
      };
    });

  const leagueTeams = LEAGUE_CONTEXTS.map(context =>
    buildLeagueTeamFromContext(context, ratingMap, cfg, includedGames)
  );

  if (includeLeagueGames) {
    leagueTeams
      .filter(team => team.games > 0)
      .forEach(team => standings.push(team));
  }

  standings.sort((a, b) => {
    if (b.leaderboardRating !== a.leaderboardRating) return b.leaderboardRating - a.leaderboardRating;
    if (b.rawOrdinal !== a.rawOrdinal) return b.rawOrdinal - a.rawOrdinal;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.games !== a.games) return b.games - a.games;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const leagueTeam = leagueTeams.find(team => team.games > 0) || leagueTeams[0];

  // Two-pass calibration: on the first pass (_calibratedStarts === null), collect the
  // final ratings for players with few total games and re-run from those starting points.
  // The second pass uses _calibratedStarts !== null, so it falls through to the return.
  const calibrationGames = Number(cfg.calibrationGames) || 0;
  if (calibrationGames > 0 && _calibratedStarts === null) {
    const calibratedStarts = {};
    Object.values(statsMap).forEach(stat => {
      if (stat.games > 0 && stat.games <= calibrationGames) {
        const skill = ratingMap[stat.id];
        if (skill) {
          calibratedStarts[stat.id] = { mu: Number(skill.mu), sigma: Number(skill.sigma) };
        }
      }
    });

    if (Object.keys(calibratedStarts).length > 0) {
      return replayRatings({
        players,
        games,
        options,
        seasonal,
        volleyballAdjusted,
        volleyballOptions,
        includeLeagueGames,
        _calibratedStarts: calibratedStarts,
      });
    }
  }

  return {
    ratingMap,
    statsMap,
    standings,
    history,
    leagueTeam,
    leagueTeams,
    volleyballAdjusted,
    includeLeagueGames,
    carryMap,
    calibratedStartMap: _calibratedStarts || {},
  };
}

function getLeagueContextTimelineEntry({
  game,
  context,
  chronologicalIndex,
  result,
}) {
  const beforeEntries = result.before.blue;
  const afterEntries = result.after.blue;

  if (!beforeEntries.length || !afterEntries.length) return null;

  const beforeRating = getAverage(beforeEntries.map(entry => entry.rating));
  const afterRating = getAverage(afterEntries.map(entry => entry.rating));
  const beforeMu = getAverage(beforeEntries.map(entry => entry.mu));
  const afterMu = getAverage(afterEntries.map(entry => entry.mu));
  const beforeSigma = getAverage(beforeEntries.map(entry => entry.sigma));
  const afterSigma = getAverage(afterEntries.map(entry => entry.sigma));

  return {
    gameId: game.id,
    chronologicalIndex,
    date: game.date || '',
    winner: game.winner,
    side: 'blue',
    won: game.winner === 'blue',
    isLeagueGame: true,
    leagueContext: cloneSimple(context),
    courtType: getCourtType(game),
    displayWinnerColor: game.displayWinnerColor || null,
    displayLoserColor: game.displayLoserColor || null,
    scoreRed: typeof game.scoreRed === 'undefined' ? null : game.scoreRed,
    scoreBlue: typeof game.scoreBlue === 'undefined' ? null : game.scoreBlue,

    ratingBefore: beforeRating,
    ratingAfter: afterRating,
    displayRatingBefore: toDisplayRating(beforeRating),
    displayRatingAfter: toDisplayRating(afterRating),

    muBefore: beforeMu,
    muAfter: afterMu,
    sigmaBefore: beforeSigma,
    sigmaAfter: afterSigma,

    marginFactor: result.marginFactor,
    blowoutBonusFactor: result.blowoutBonusFactor,
    closeOvertimeDampener: result.closeOvertimeDampener,
    pointDiff: result.pointDiff,
    winnerScore: result.winnerScore,
    loserScore: result.loserScore,
    isCloseOvertime: result.isCloseOvertime,
    seasonalWeight: result.seasonalWeight,
    volleyballAdjusted: result.volleyballAdjusted,
    volleyballUpdateMultiplier: result.volleyballUpdateMultiplier,
    finalUpdateMultiplier: result.finalUpdateMultiplier,
    openSkillWinnerProbability: result.openSkillWinnerProbability,
    volleyballWinnerProbability: result.volleyballWinnerProbability,
    redTeam: Array.isArray(game.redTeam) ? cloneSimple(game.redTeam) : [],
    blueTeam: [],
    leagueOpponent: {
      id: context.id,
      name: context.name,
      size: result.before.blue.length,
    },
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
  includeLeagueGames = true,
  _calibratedStarts = null,
} = {}) {
  const cfg = mergeRatingOptions(options);
  const ratingMap = {};
  const statsMap = {};
  const timeline = [];
  const includedGames = getIncludedGames(games, includeLeagueGames);
  const seasonalTaperDays =
    typeof cfg.seasonalTaperDays === 'number'
      ? cfg.seasonalTaperDays
      : SEASONAL_TAPER_DAYS;

  const leagueContext = getLeagueContextById(playerId);

  players.forEach(player => {
    const calibrated = _calibratedStarts?.[player.id];
    ratingMap[player.id] = calibrated
      ? rating({ mu: Number(calibrated.mu), sigma: Number(calibrated.sigma) })
      : makeInitialRating(cfg);
    statsMap[player.id] = { id: player.id, name: player.name, games: 0 };
  });

  const sortedGames = getGamesSortedOldestFirst(includedGames);
  const referenceDate = seasonal ? getMostRecentGameDate(sortedGames) : null;

  sortedGames.forEach((game, chronologicalIndex) => {
    const seasonalWeight = seasonal
      ? getSeasonalWeight(game?.date, referenceDate, seasonalTaperDays)
      : 1;

    const result = rateSingleGame(game, ratingMap, {
      ...cfg,
      seasonalWeight,
      volleyballAdjusted,
      volleyballOptions,
    });

    // Burn-in: match replayRatings — amplify updates for players in their first N games.
    const burnInGames = Number(cfg.burnInGames) || 0;
    const burnInMult = Number(cfg.burnInMultiplier) || 1;
    if (burnInGames > 0 && burnInMult > 1 && _calibratedStarts === null) {
      const applyBurnIn = (beforeEntries, afterEntries) => {
        beforeEntries.forEach((before, i) => {
          const gamesPlayed = statsMap[before.id]?.games ?? 0;
          if (gamesPlayed < burnInGames) {
            const after = afterEntries[i];
            const newMu = before.mu + (after.mu - before.mu) * burnInMult;
            const newSigma = clamp(
              before.sigma + (after.sigma - before.sigma) * burnInMult,
              1,
              cfg.sigma
            );
            ratingMap[before.id] = rating({ mu: newMu, sigma: newSigma });
            after.mu = newMu;
            after.sigma = newSigma;
            after.rating = getRawOrdinal(ratingMap[before.id], cfg);
          }
        });
      };
      applyBurnIn(result.before.red, result.after.red);
      applyBurnIn(result.before.blue, result.after.blue);
    }

    // Calibration freeze: match replayRatings — restore seeded rating within calibration window.
    if (_calibratedStarts !== null) {
      const calibrationGamesLimit = Number(cfg.calibrationGames) || 0;
      [...getRedTeamIds(game), ...getBlueTeamIds(game)].forEach(id => {
        const cal = _calibratedStarts[id];
        if (cal && (statsMap[id]?.games ?? 0) < calibrationGamesLimit) {
          const calibratedSkill = rating({ mu: Number(cal.mu), sigma: Number(cal.sigma) });
          ratingMap[id] = calibratedSkill;
          syncRatingEntry(result.after.red, id, calibratedSkill, cfg);
          syncRatingEntry(result.after.blue, id, calibratedSkill, cfg);
        }
      });
    }

    // Update statsMap game counts (must happen after burn-in/freeze reads pre-game count).
    const redTeam = Array.isArray(game.redTeam) ? game.redTeam : [];
    const blueTeam = Array.isArray(game.blueTeam) ? game.blueTeam : [];
    redTeam.forEach(player => {
      if (!statsMap[player.id]) statsMap[player.id] = { id: player.id, name: player.name, games: 0 };
      statsMap[player.id].games += 1;
    });
    if (!game.isLeagueGame) {
      blueTeam.forEach(player => {
        if (!statsMap[player.id]) statsMap[player.id] = { id: player.id, name: player.name, games: 0 };
        statsMap[player.id].games += 1;
      });
    }

    const isRequestedLeagueContext =
      leagueContext &&
      game?.isLeagueGame &&
      getLeagueContextKey(game) === leagueContext.key;

    if (isRequestedLeagueContext) {
      const leagueEntry = getLeagueContextTimelineEntry({
        game,
        context: leagueContext,
        chronologicalIndex,
        result,
      });

      if (leagueEntry) timeline.push(leagueEntry);
      return;
    }

    const playerIds = getGamePlayerIds(game);

    if (!playerIds.includes(String(playerId))) {
      return;
    }

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
      leagueContext: game?.isLeagueGame ? cloneSimple(getLeagueContext(game)) : null,
      courtType: getCourtType(game),
      displayWinnerColor: game.displayWinnerColor || null,
      displayLoserColor: game.displayLoserColor || null,
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
      blowoutBonusFactor: result.blowoutBonusFactor,
      closeOvertimeDampener: result.closeOvertimeDampener,
      pointDiff: result.pointDiff,
      winnerScore: result.winnerScore,
      loserScore: result.loserScore,
      isCloseOvertime: result.isCloseOvertime,
      seasonalWeight: result.seasonalWeight,
      volleyballAdjusted: result.volleyballAdjusted,
      volleyballUpdateMultiplier: result.volleyballUpdateMultiplier,
      finalUpdateMultiplier: result.finalUpdateMultiplier,
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
    const rawOrdinal = getRawOrdinal(skill, cfg);

    return {
      ...player,
      rawOrdinal,
      // Backward-compatible alias. Existing index.html averages `rating`
      // and then calls formatDisplayedRating(), so this must stay raw ordinal.
      rating: rawOrdinal,
      displayRating: toDisplayRating(rawOrdinal),
      mu: Number(skill.mu),
      sigma: Number(skill.sigma),
    };
  });
}
