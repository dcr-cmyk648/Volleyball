// ratings.js
// Shared rating engine for the Volleyball app.
//
// Architecture:
// - Backend model uses OpenSkill skill objects: { mu, sigma }.
// - Raw rating / raw ordinal = mu - z * sigma. This stays on OpenSkill scale.
// - Volleyball balancing uses raw ordinal scale, not public display scale.
// - Public display rating is only created at UI/display boundaries.
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
export const LEAGUE_PHASE_BRACKET = 'bracket';

const BASE_LEAGUE_CONTEXTS = [
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

function getLeagueBracketContextName(context) {
  return context.key === 'rec_indoor'
    ? 'Rec League Bracket'
    : `${context.name} Bracket`;
}

export const LEAGUE_CONTEXTS = BASE_LEAGUE_CONTEXTS.flatMap(context => [
  context,
  {
    ...context,
    id: `${context.id}_${LEAGUE_PHASE_BRACKET}`,
    key: `${context.key}_${LEAGUE_PHASE_BRACKET}`,
    phase: LEAGUE_PHASE_BRACKET,
    name: getLeagueBracketContextName(context),
  },
]);

const POOLED_LEAGUE_CONTEXT = {
  id: `${LEAGUE_TEAM_ID}_pooled`,
  key: 'pooled',
  level: 'pooled',
  courtType: 'pooled',
  name: LEAGUE_TEAM_NAME,
};

const LEVEL_POOLED_LEAGUE_CONTEXTS = [
  {
    id: `${LEAGUE_TEAM_ID}_${LEAGUE_LEVEL_REC}`,
    key: LEAGUE_LEVEL_REC,
    level: LEAGUE_LEVEL_REC,
    courtType: 'pooled',
    name: 'League - Rec',
  },
  {
    id: `${LEAGUE_TEAM_ID}_${LEAGUE_LEVEL_INTERMEDIATE}`,
    key: LEAGUE_LEVEL_INTERMEDIATE,
    level: LEAGUE_LEVEL_INTERMEDIATE,
    courtType: 'pooled',
    name: 'League - Intermediate',
  },
];

export const LEAGUE_TEAM_MEMBER_COUNT = 12;

export const LEAGUE_TEAM_MEMBER_IDS = [
  ...LEAGUE_CONTEXTS,
  POOLED_LEAGUE_CONTEXT,
  ...LEVEL_POOLED_LEAGUE_CONTEXTS,
].flatMap(context =>
  Array.from(
    { length: LEAGUE_TEAM_MEMBER_COUNT },
    (_, i) => `${context.id}_${i + 1}`
  )
);

export const DISPLAY_RATING_BASE = 1500;
export const DISPLAY_RATING_SCALE = 50;

export const PUBLIC_RATING_FLOOR = 1200;
export const PUBLIC_RATING_CEILING = 2500;
export const PUBLIC_RATING_THEORETICAL_SIGMA = 0;
export const PUBLIC_RATING_MIN_GAMES = 5;
export const PUBLIC_RATING_LOW_GAME_PENALTY = 2.5;
export const PUBLIC_RATING_LOW_GAME_PENALTY_GAMES = 8;
export const PUBLIC_RATING_LOW_GAME_PENALTY_POWER = 1.10;
export const SEASON_RANKING_DISPLAY_ORDINAL_SIGMA_MULTIPLIER = 3.5;
export const SEASON_RANKING_MISSING_GAME_PENALTY_POINTS = 5;
export const SEASON_RANKING_OVER_FIFTY_GAME_PENALTY_POINTS = 1;

export const SEASONAL_FULL_WEIGHT_DAYS = 7;
export const SEASONAL_TAPER_DAYS = 180;
export const SEASONAL_MIN_WEIGHT = 0.05;

export const DEFAULT_RATING_OPTIONS = {
  mu: 25,
  sigma: 25 / 3,
  ordinalSigmaMultiplier: 3,

  useScoreMargin: false,

  // League games use a matched external opponent: the league team is modeled as
  // equal to the real team before each game, then the result is counted as
  // slightly stronger evidence than a mixed casual game.
  leagueUpdateMultiplier: 1.25,
  // Eval/modeling knobs for league opponents. The database still records exact
  // league context metadata; this controls only rating identity/modeling.
  leagueTeamRatingMode: 'level',
  leagueOpponentModel: 'matched',
  leagueMatchedOpponentOffsetRaw: 0,
  leagueDayOffsetGrouping: 'dateLevel',
  leagueDayOffsetTrust: 1,
  leagueDayOffsetMaxRaw: 6,
  leagueDayOffsetGridStep: 0.25,
  leagueDayOffsetPriorSd: 3,
  leagueSeriesAggregationEnabled: true,
  leagueMuUpdateMultiplier: 1,
  leagueSigmaUpdateMultiplier: 1,
  leagueOpponentUpdateMultiplier: 1,
  leagueOpponentBurnInGames: 0,
  leagueOpponentBurnInMultiplier: 1,
  includeLeagueBracketGames: true,
  leagueDisplayRatingMode: 'bayesian',
  leagueDisplayShuffleIterations: 60,
  leagueDisplayEstimateEnabled: false,
  leagueBayesianPriorSd: 4,
  leagueBayesianGridStep: 0.1,
  leaguePregameBayesianEnabled: false,
  leaguePregameBayesianMode: 'incrementalGrid',
  leaguePregameBayesianSigma: 2,
  leaguePregameShrinkEnabled: false,
  leaguePregameShrinkGames: 12,
  leaguePregameShrinkPower: 1,
  leaguePregameSigmaEnabled: false,
  leaguePregameSigmaFloor: 25 / 3,
  leagueSessionFreezeEnabled: false,
  leagueOpponentSeasonalTaperEnabled: false,

  // Blowout bonus — delayed logistic point-differential bonus. This keeps ordinary
  // close and mid-margin wins near 1.0x, while still adding a small capped reward
  // for clear blowouts.
  //
  // Representative factors:
  //   25-23 → 1.00x   25-21 → 1.00x   25-20 → 1.00x
  //   25-15 → 1.03x   25-10 → 1.09x   25-5 → 1.10x (near cap)
  marginBonusFormula: 'logistic',
  maxMarginBonus: 0.10,
  marginLogisticMidpoint: 12,
  marginLogisticSteepness: 0.90,
  // Legacy dominance-power options remain supported for eval overrides.
  marginBonusScale: 0.60,
  marginBonusPower: 1.20,

  // Close two-point dampener:
  // Disabled by default. It remains configurable, but current replay fit favors
  // treating narrow wins as ordinary wins.
  closeOvertimeDampenerMin: 1,
  closeOvertimeDampenerStep: 0,

  seasonalTaperDays: 180,

  // Burn-in: first N games for a player count more, so they reach their true level faster.
  // The update delta (both mu and sigma movement) is scaled up by burnInMultiplier for games
  // where the player has fewer than burnInGames games of history.
  burnInGames: 5,
  burnInMultiplier: 2,

  // Two-pass calibration: players with ≤ calibrationGames total games in the dataset
  // get their pass-1 final rating used as the starting point for a second replay pass.
  // This corrects for the inaccurate 1500 default start without a recursive loop.
  // Set to 0 to disable.
  calibrationGames: 10,

  // Eval/modeling knobs for OpenSkill-native update tuning. Defaults preserve
  // the current behavior: binary win/loss scores, package-default beta, and no tau.
  openSkillScoreMode: 'binary',
  openSkillBetaMultiplier: 0.6,
  openSkillTau: null,
  openSkillPreventSigmaIncrease: false,
  openSkillEvidenceMultiplierMode: 'volleyball',

  // Streak protection: dampen a player's current update when a recent same-sign
  // run is meaningfully less likely than random ordering of that player's recent
  // update deltas.
  streakProtectionEnabled: true,
  streakProtectionMode: 'deltaShuffle',
  streakProtectionWindow: 6,
  streakProtectionMinGames: 14,
  streakProtectionThresholdRaw: 2,
  streakProtectionMinMultiplier: 0.25,
  streakProtectionStrength: 1,
  streakProtectionShuffleIterations: 20,
  streakProtectionApplyTo: 'muOnly',

  // Session protection: default-off eval knob for dampening same-day pileups.
  // Unlike rolling streak protection, this resets when the player reaches a new
  // session/date, so later good/bad days can still move the rating normally.
  sessionProtectionEnabled: false,
  sessionProtectionMinPriorGames: 14,
  sessionProtectionMinSessionGames: 4,
  sessionProtectionThresholdRaw: 2,
  sessionProtectionMinMultiplier: 0.25,
  sessionProtectionStrength: 1,
  sessionProtectionApplyTo: 'muOnly',

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
export const VERSION = 'beta-20260720-1';

export const DEFAULT_VOLLEYBALL_BALANCE_OPTIONS = {
  // Flatter team-strength weights. Forward validation favored restoring
  // average-team signal over heavy weak-link emphasis.
  topPlayerWeight: 0.25,
  secondPlayerWeight: 0.22,
  averageWeight: 0.33,
  depthWeight: 0.12,
  // worstPlayerWeight is scaled by match closeness at runtime — full weight only in even matchups
  worstPlayerWeight: 0.08,
  // Carry score: bonus raw ordinal added to top player's effective rating
  // when they have a history of winning above their team's modeled probability
  carryScale: 16,
  carryConfidenceGames: 8,
  sizeBonusPerExtraPlayer: 2.2,
  sizeBonusByBaseSizeEnabled: true,
  sizeBonusByBaseSize: {
    3: 2.2,
    4: 1.4,
    5: 2.6,
    6: 0,
  },
  weakLinkPenaltyMode: 'avgGap',
  weakLinkPenaltyScale: 0.35,
  weakLinkPenaltyThreshold: 2.0,
  environmentSiloMode: 'blend',
  environmentSiloMinGames: 12,
  environmentSiloConfidenceGames: 6,
  environmentSiloMaxBlend: 0.7,
  environmentSiloAdjustmentCap: 1.5,
  environmentSiloMinDelta: 0.5,
  pairAdjustmentMode: 'blend',
  pairAdjustmentMinGames: 8,
  pairAdjustmentConfidenceGames: 4,
  pairAdjustmentMaxBlend: 0.75,
  pairAdjustmentPerPairCap: 0.5,
  pairAdjustmentTeamCap: 0.75,
  pairAdjustmentMinDelta: 0.1,
  probabilityScale: 4.2,
  // Post-hoc probability calibration. This sharpens displayed/model win
  // probabilities without changing team-strength construction.
  probabilityTemperature: 1.5,
  minWinProbability: 0.05,
  maxWinProbability: 0.95,
  minUpdateMultiplier: 0.35,
  maxUpdateMultiplier: 2.0,
  // Hard cap on the per-game volatility core (marginFactor * surpriseMultiplier),
  // applied before seasonal weighting and size damping. Keeps one surprising blowout
  // from whipsawing the leaderboard, without overriding seasonal taper of old games.
  finalUpdateMultiplierMin: 0.75,
  finalUpdateMultiplierMax: 1.35,
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

function getVolleyballSizeBonusPerExtraPlayer(redPlayers, bluePlayers, volleyballCfg) {
  if (!volleyballCfg.sizeBonusByBaseSizeEnabled) {
    return Number(volleyballCfg.sizeBonusPerExtraPlayer) || 0;
  }

  const redSize = Array.isArray(redPlayers) ? redPlayers.length : 0;
  const blueSize = Array.isArray(bluePlayers) ? bluePlayers.length : 0;
  const baseSize = Math.min(redSize, blueSize);
  if (baseSize <= 0 || redSize === blueSize) return 0;

  const sizeBonusByBaseSize = volleyballCfg.sizeBonusByBaseSize || {};
  if (baseSize >= 6 && Number.isFinite(Number(sizeBonusByBaseSize[6]))) {
    return Number(sizeBonusByBaseSize[6]);
  }
  if (Number.isFinite(Number(sizeBonusByBaseSize[baseSize]))) {
    return Number(sizeBonusByBaseSize[baseSize]);
  }
  return Number(volleyballCfg.sizeBonusPerExtraPlayer) || 0;
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

export function getOverallStandingsRawOrdinal(rawOrdinal, games = 0, options = {}) {
  const raw = Number(rawOrdinal);
  if (!Number.isFinite(raw) || raw <= 0) return Number.isFinite(raw) ? raw : 0;

  const safeGames = Math.max(0, Number(games) || 0);
  const maxPenalty = Math.max(0, Number(options.lowGamePenalty ?? PUBLIC_RATING_LOW_GAME_PENALTY) || 0);
  const penaltyGames = Math.max(1, Number(options.lowGamePenaltyGames ?? PUBLIC_RATING_LOW_GAME_PENALTY_GAMES) || 1);
  const penaltyPower = Math.max(0.1, Number(options.lowGamePenaltyPower ?? PUBLIC_RATING_LOW_GAME_PENALTY_POWER) || 1);
  const missingConfidence = Math.pow(penaltyGames / (safeGames + penaltyGames), penaltyPower);
  const penalty = maxPenalty * missingConfidence;

  return raw - penalty;
}

export function getSeasonRankingGameCountPenaltyPoints(
  games,
  scoreboardMaxGames,
  baseDisplayRating
) {
  if (Number(baseDisplayRating) < DISPLAY_RATING_BASE) return 0;

  const from = Math.max(0, Number(games) || 0);
  const to = Math.max(from, Number(scoreboardMaxGames) || 0);
  const underTenGames = Math.max(0, Math.min(to, 10) - Math.min(from, 10));
  const underFiftyGames = Math.max(0, Math.min(to, 50) - Math.max(from, 10));
  const behindLeaderGames = Number(baseDisplayRating) >= 1500
    ? Math.max(0, to - Math.max(from, 50))
    : 0;

  return underTenGames * 10 +
    underFiftyGames * SEASON_RANKING_MISSING_GAME_PENALTY_POINTS +
    behindLeaderGames * SEASON_RANKING_OVER_FIFTY_GAME_PENALTY_POINTS;
}

export function getSeasonRankingUnpenalizedRawOrdinal(player = {}) {
  const mu = Number(player?.mu);
  const sigma = Number(player?.sigma);
  const fallbackRaw = Number(player?.rawOrdinal ?? player?.rating);

  return Number.isFinite(mu) && Number.isFinite(sigma)
    ? mu - SEASON_RANKING_DISPLAY_ORDINAL_SIGMA_MULTIPLIER * sigma
    : Number.isFinite(fallbackRaw)
      ? fallbackRaw
      : 0;
}

export function getSeasonRankingMaxUnpenalizedDisplayRating(players = []) {
  return (Array.isArray(players) ? players : []).reduce(
    (max, player) => Math.max(
      max,
      toDisplayRating(getSeasonRankingUnpenalizedRawOrdinal(player))
    ),
    DISPLAY_RATING_BASE
  );
}

export function getSeasonRankingPenaltyPhase(
  unpenalizedDisplayRating,
  scoreboardMaxUnpenalizedDisplayRating
) {
  const rating = Number(unpenalizedDisplayRating);
  const boardMax = Number(scoreboardMaxUnpenalizedDisplayRating);
  if (!Number.isFinite(rating) || rating <= DISPLAY_RATING_BASE) return 0;
  if (!Number.isFinite(boardMax) || boardMax <= DISPLAY_RATING_BASE) return 0;

  return clamp(
    (rating - DISPLAY_RATING_BASE) / (boardMax - DISPLAY_RATING_BASE),
    0,
    1
  );
}

export function getSeasonRankingDisplayRawOrdinal(player = {}, options = {}) {
  const rawOrdinal = getSeasonRankingUnpenalizedRawOrdinal(player);

  if (options.removeConfidencePenalty) {
    return rawOrdinal;
  }

  const unpenalizedDisplayRating = toDisplayRating(rawOrdinal);
  const scoreboardMaxRatingValue = player?.scoreboardMaxUnpenalizedDisplayRating;
  const scoreboardMaxUnpenalizedDisplayRating = Number.isFinite(Number(scoreboardMaxRatingValue))
    ? Number(scoreboardMaxRatingValue)
    : unpenalizedDisplayRating;
  const penaltyPhase = getSeasonRankingPenaltyPhase(
    unpenalizedDisplayRating,
    scoreboardMaxUnpenalizedDisplayRating
  );
  if (penaltyPhase <= 0) return rawOrdinal;

  const games = Math.max(0, Number(player?.games) || 0);
  const fullyConfidenceAdjusted = getOverallStandingsRawOrdinal(rawOrdinal, games, options);
  const confidenceAdjusted = rawOrdinal -
    (rawOrdinal - fullyConfidenceAdjusted) * penaltyPhase;
  const scoreboardMaxGamesValue = player?.scoreboardMaxGames;
  const scoreboardMaxGames = Number(scoreboardMaxGamesValue);
  if (scoreboardMaxGamesValue === null || typeof scoreboardMaxGamesValue === 'undefined') {
    return confidenceAdjusted;
  }
  if (!Number.isFinite(scoreboardMaxGames)) return confidenceAdjusted;

  const penaltyPoints = getSeasonRankingGameCountPenaltyPoints(
    games,
    scoreboardMaxGames,
    toDisplayRating(confidenceAdjusted)
  );
  return confidenceAdjusted - penaltyPoints * penaltyPhase / DISPLAY_RATING_SCALE;
}

function getRawOrdinalFromMuSigma(mu, sigma, options = {}) {
  const z = Number(options.ordinalSigmaMultiplier ?? DEFAULT_RATING_OPTIONS.ordinalSigmaMultiplier);
  return Number(mu) - z * Number(sigma);
}

export function getPublicRatingDisplayScale({
  players = [],
  games = [],
  options = {},
  seasonal = true,
  volleyballAdjusted = false,
  volleyballOptions = {},
  volleyballUpdateUsesBalancerContext = true,
  volleyballUpdateContextMode = 'pair',
  includeLeagueGames = true,
  minGames = PUBLIC_RATING_MIN_GAMES,
  lowGamePenalty = PUBLIC_RATING_LOW_GAME_PENALTY,
  lowGamePenaltyGames = PUBLIC_RATING_LOW_GAME_PENALTY_GAMES,
  lowGamePenaltyPower = PUBLIC_RATING_LOW_GAME_PENALTY_POWER,
  theoreticalSigma = PUBLIC_RATING_THEORETICAL_SIGMA,
} = {}) {
  const displayOptions = {
    lowGamePenalty,
    lowGamePenaltyGames,
    lowGamePenaltyPower,
    ordinalSigmaMultiplier:
      Number(options.ordinalSigmaMultiplier ?? DEFAULT_RATING_OPTIONS.ordinalSigmaMultiplier),
  };
  const startingSigma = Number(options.sigma ?? DEFAULT_RATING_OPTIONS.sigma);
  const replayOptions = {
    players,
    seasonal,
    volleyballAdjusted,
    volleyballOptions,
    volleyballUpdateUsesBalancerContext,
    volleyballUpdateContextMode,
    includeLeagueGames,
    options,
  };
  const sortedGames = getGamesSortedOldestFirst(getIncludedGames(games, includeLeagueGames, options));

  let historyMinMu = null;
  let historyMaxMu = null;
  let maxSigma = Number.isFinite(startingSigma) ? startingSigma : -Infinity;
  let minSigma = Infinity;

  for (let i = 0; i <= sortedGames.length; i += 1) {
    const prefixGames = sortedGames.slice(0, i).map((game, index) =>
      game && game.createdAt == null
        ? { ...game, createdAt: index }
        : game
    );
    const replay = replayRatings({
      ...replayOptions,
      games: prefixGames,
    });

    (replay.standings || []).forEach(player => {
      if ((Number(player.games) || 0) < minGames) return;

      const mu = Number(player.mu);
      const sigma = Number(player.sigma);
      if (!Number.isFinite(mu) || !Number.isFinite(sigma)) return;

      const entry = {
        id: player.id,
        name: player.name,
        games: Number(player.games) || 0,
        wins: Number(player.wins) || 0,
        mu,
        sigma,
      };

      if (!historyMinMu || mu < historyMinMu.mu) {
        historyMinMu = entry;
      }
      if (!historyMaxMu || mu > historyMaxMu.mu) {
        historyMaxMu = entry;
      }
      if (sigma > maxSigma) {
        maxSigma = sigma;
      }
      if (sigma < minSigma) {
        minSigma = sigma;
      }
    });
  }

  if (!historyMinMu || !historyMaxMu || !Number.isFinite(maxSigma) || !Number.isFinite(minSigma)) {
    return null;
  }

  const lowerRaw = getRawOrdinalFromMuSigma(historyMinMu.mu, maxSigma, displayOptions);
  const upperRaw = Number(historyMaxMu.mu) - minSigma;

  if (!(lowerRaw < upperRaw)) {
    return null;
  }

  return {
    lowerRaw,
    upperRaw,
    floor: PUBLIC_RATING_FLOOR,
    ceiling: PUBLIC_RATING_CEILING,
    historyMinMu,
    historyMaxMu,
    maxSigma,
    minSigma,
    theoreticalSigma,
    lowGamePenalty,
    lowGamePenaltyGames,
    lowGamePenaltyPower,
    minGames,
  };
}

export function toPublicDisplayRating(rawOrdinal, displayScale = null) {
  const raw = Number(rawOrdinal);
  if (!Number.isFinite(raw)) return DISPLAY_RATING_BASE;
  if (!displayScale) return toDisplayRating(raw);

  const lowerRaw = Number(displayScale.lowerRaw);
  const upperRaw = Number(displayScale.upperRaw);
  if (!(lowerRaw < upperRaw)) return toDisplayRating(raw);

  const floor = Number(displayScale.floor ?? PUBLIC_RATING_FLOOR);
  const ceiling = Number(displayScale.ceiling ?? PUBLIC_RATING_CEILING);
  const t = clamp((raw - lowerRaw) / (upperRaw - lowerRaw), 0, 1);
  return floor + (ceiling - floor) * t;
}

export function formatPublicDisplayRating(rawOrdinal, displayScale = null) {
  return `${Math.round(toPublicDisplayRating(rawOrdinal, displayScale))}`;
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

function getLeagueLeaderboardRawOrdinal(rawOrdinal) {
  return Number.isFinite(Number(rawOrdinal)) ? Number(rawOrdinal) : 0;
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

export function getLeaguePhase(game) {
  return game?.leaguePhase === LEAGUE_PHASE_BRACKET
    ? LEAGUE_PHASE_BRACKET
    : '';
}

export function getLeagueContextKey(game) {
  const level = getLeagueLevel(game);
  if (!level) return null;
  const courtType = getCourtType(game);
  const baseKey = `${level}_${courtType}`;
  return getLeaguePhase(game) === LEAGUE_PHASE_BRACKET
    ? `${baseKey}_${LEAGUE_PHASE_BRACKET}`
    : baseKey;
}

export function getLeagueContext(game) {
  const key = getLeagueContextKey(game);
  return LEAGUE_CONTEXTS.find(context => context.key === key) || LEAGUE_CONTEXTS[0];
}

export function getLeagueContextById(id) {
  if (String(id) === String(POOLED_LEAGUE_CONTEXT.id)) return POOLED_LEAGUE_CONTEXT;
  const levelContext = LEVEL_POOLED_LEAGUE_CONTEXTS.find(context => String(context.id) === String(id));
  if (levelContext) return levelContext;
  return LEAGUE_CONTEXTS.find(context => String(context.id) === String(id)) || null;
}

export function isLeagueContextId(id) {
  return Boolean(getLeagueContextById(id));
}

function isSyntheticLeagueMemberId(id) {
  return String(id || '').startsWith(`${LEAGUE_TEAM_ID}_`) && /_\d+$/.test(String(id || ''));
}

function getLeagueTeamMemberIdsForContext(context, count = LEAGUE_TEAM_SIZE) {
  const safeCount = Math.max(1, Number(count) || LEAGUE_TEAM_SIZE);
  return Array.from(
    { length: safeCount },
    (_, i) => `${context.id}_${i + 1}`
  );
}

function getLeagueTeamMemberCountForContext(context, gamesList = []) {
  const matchingCounts = (Array.isArray(gamesList) ? gamesList : [])
    .filter(game => gameMatchesLeagueContext(game, context))
    .map(game => Array.isArray(game?.redTeam) ? game.redTeam.length : 0)
    .filter(count => count > 0);

  return matchingCounts.length
    ? Math.max(...matchingCounts)
    : LEAGUE_TEAM_SIZE;
}

export function getLeagueRatingContext(game, options = {}) {
  const cfg = mergeRatingOptions(options);
  if (cfg.leagueTeamRatingMode === 'pooled') return POOLED_LEAGUE_CONTEXT;
  if (cfg.leagueTeamRatingMode === 'level') {
    const level = getLeagueLevel(game);
    return LEVEL_POOLED_LEAGUE_CONTEXTS.find(context => context.level === level) ||
      LEVEL_POOLED_LEAGUE_CONTEXTS[0];
  }
  return getLeagueContext(game);
}

function getLeagueTeamContextsForMode(options = {}) {
  const cfg = mergeRatingOptions(options);
  if (cfg.leagueTeamRatingMode === 'pooled') return [POOLED_LEAGUE_CONTEXT];
  if (cfg.leagueTeamRatingMode === 'level') return LEVEL_POOLED_LEAGUE_CONTEXTS;
  return LEAGUE_CONTEXTS;
}

function gameMatchesLeagueContext(game, context) {
  if (!game?.isLeagueGame || !context) return false;
  if (context.key === POOLED_LEAGUE_CONTEXT.key) return true;
  if (LEVEL_POOLED_LEAGUE_CONTEXTS.some(levelContext => levelContext.key === context.key)) {
    return getLeagueLevel(game) === context.level;
  }
  return getLeagueContextKey(game) === context.key;
}

function getLeagueTeamPlayersForGame(game, options = {}) {
  const context = getLeagueRatingContext(game, options);
  const redCount = Array.isArray(game?.redTeam) && game.redTeam.length > 0
    ? game.redTeam.length
    : LEAGUE_TEAM_SIZE;

  return getLeagueTeamMemberIdsForContext(context, redCount).map((id, index) => ({
    id,
    name: `${context.name} ${index + 1}`,
  }));
}

function getBluePlayersForVolleyballModel(game, options = {}) {
  if (game?.isLeagueGame) {
    return getLeagueTeamPlayersForGame(game, options);
  }

  return Array.isArray(game?.blueTeam) ? game.blueTeam : [];
}

function isLeagueBracketGame(game) {
  return Boolean(game?.isLeagueGame && game?.leaguePhase === 'bracket');
}

function getIncludedGames(games, includeLeagueGames = true, options = {}) {
  const safeGames = Array.isArray(games) ? games : [];
  const includeLeagueBracketGames = options?.includeLeagueBracketGames === true;

  if (includeLeagueGames && includeLeagueBracketGames) {
    return safeGames;
  }

  return safeGames.filter(game => {
    if (!includeLeagueGames && game?.isLeagueGame) return false;
    return includeLeagueBracketGames || !isLeagueBracketGame(game);
  });
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

  const totalPoints = winnerScore + loserScore;
  const dominanceMargin = totalPoints > 0 ? winnerScore / totalPoints - 0.5 : 0;
  const scale = Number(cfg.marginBonusScale) || 4.0;
  const power = Number(cfg.marginBonusPower) || 1.5;
  const maxBonus = Number.isFinite(Number(cfg.maxMarginBonus))
    ? Number(cfg.maxMarginBonus)
    : DEFAULT_RATING_OPTIONS.maxMarginBonus;
  let rawBonus = scale * Math.pow(Math.max(0, dominanceMargin), power);

  if (cfg.marginBonusFormula === 'logistic') {
    const midpoint = Number.isFinite(Number(cfg.marginLogisticMidpoint))
      ? Number(cfg.marginLogisticMidpoint)
      : DEFAULT_RATING_OPTIONS.marginLogisticMidpoint;
    const steepness = Number.isFinite(Number(cfg.marginLogisticSteepness))
      ? Number(cfg.marginLogisticSteepness)
      : DEFAULT_RATING_OPTIONS.marginLogisticSteepness;
    const floor = sigmoid(-steepness * midpoint);
    const value = sigmoid(steepness * (pointDiff - midpoint));
    rawBonus = maxBonus * clamp((value - floor) / Math.max(0.0001, 1 - floor), 0, 1);
  }

  const bonus = clamp(rawBonus, 0, maxBonus);
  const blowoutBonusFactor = 1 + bonus;

  const isCloseOvertime =
    winnerScore >= 25 &&
    pointDiff === 2;

  let closeOvertimeDampener = 1;

  if (isCloseOvertime) {
    const overtimePoints = Math.max(1, winnerScore - 25);
    const dampenerStep = Number.isFinite(Number(cfg.closeOvertimeDampenerStep))
      ? Number(cfg.closeOvertimeDampenerStep)
      : DEFAULT_RATING_OPTIONS.closeOvertimeDampenerStep;
    const dampenerMin = Number.isFinite(Number(cfg.closeOvertimeDampenerMin))
      ? Number(cfg.closeOvertimeDampenerMin)
      : DEFAULT_RATING_OPTIONS.closeOvertimeDampenerMin;

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
    getBlueTeamIds(game, options).forEach(id => ensureRatingEntry(ratingMap, id, options));
  } else {
    blueTeam.forEach(player => ensureRatingEntry(ratingMap, player.id, options));
  }
}

function getRedTeamIds(game) {
  return (Array.isArray(game?.redTeam) ? game.redTeam : []).map(player => player.id);
}

function getBlueTeamIds(game, options = {}) {
  if (game?.isLeagueGame) {
    const context = getLeagueRatingContext(game, options);
    const redCount = Array.isArray(game?.redTeam) && game.redTeam.length > 0
      ? game.redTeam.length
      : LEAGUE_TEAM_SIZE;

    return getLeagueTeamMemberIdsForContext(context, redCount);
  }

  return (Array.isArray(game?.blueTeam) ? game.blueTeam : []).map(player => player.id);
}

function getSkillFromRawOrdinal(rawOrdinal, cfg, sigmaOverride = null) {
  const sigma = clamp(
    Number(sigmaOverride ?? cfg.sigma) || cfg.sigma,
    0.1,
    cfg.sigma
  );
  return rating({
    mu: Number(rawOrdinal) + Number(cfg.ordinalSigmaMultiplier) * sigma,
    sigma,
  });
}

function seedPregameBayesianLeagueOpponent(game, ratingMap, history, cfg, posteriorMap = null) {
  if (cfg.leaguePregameBayesianEnabled !== true || !game?.isLeagueGame) {
    return null;
  }

  const context = getLeagueRatingContext(game, cfg);
  const rawOrdinal = cfg.leaguePregameBayesianMode === 'incrementalGrid'
    ? getIncrementalBayesianLeagueRaw({ context, posteriorMap, cfg })
    : getBayesianLeagueRawFromHistory({ context, history, cfg });
  if (!Number.isFinite(rawOrdinal)) return null;

  const skill = getSkillFromRawOrdinal(rawOrdinal, cfg, cfg.leaguePregameBayesianSigma);
  getLeagueTeamMemberIdsForContext(context, LEAGUE_TEAM_MEMBER_COUNT).forEach(id => {
    ratingMap[id] = rating({ mu: Number(skill.mu), sigma: Number(skill.sigma) });
  });

  return rawOrdinal;
}

function getLeagueOpponentPregameGameCount(ids, leagueOpponentStatsMap = {}) {
  const counts = ids
    .map(id => Number(leagueOpponentStatsMap[String(id)]?.games) || 0)
    .filter(count => Number.isFinite(count));

  return counts.length ? Math.max(...counts) : 0;
}

function applyPregameLeagueOpponentAdjustment(game, ratingMap, leagueOpponentStatsMap, cfg) {
  if (!game?.isLeagueGame) return;
  if (cfg.leaguePregameShrinkEnabled !== true && cfg.leaguePregameSigmaEnabled !== true) return;

  const ids = getBlueTeamIds(game, cfg);
  const gamesPlayed = getLeagueOpponentPregameGameCount(ids, leagueOpponentStatsMap);
  const shrinkGames = Math.max(0, Number(cfg.leaguePregameShrinkGames) || 0);
  const shrinkPower = Math.max(0.1, Number(cfg.leaguePregameShrinkPower) || 1);
  const confidence = shrinkGames > 0
    ? Math.pow(gamesPlayed / (gamesPlayed + shrinkGames), shrinkPower)
    : 1;
  const sigmaFloor = Math.max(0.1, Number(cfg.leaguePregameSigmaFloor) || cfg.sigma);

  ids.forEach(id => {
    const current = ratingMap[id] ?? makeInitialRating(cfg);
    let raw = getRawOrdinal(current, cfg);
    let sigma = Number(current.sigma);

    if (cfg.leaguePregameShrinkEnabled === true) {
      raw *= confidence;
    }
    if (cfg.leaguePregameSigmaEnabled === true) {
      sigma = Math.max(sigma, sigmaFloor);
    }

    ratingMap[id] = getSkillFromRawOrdinal(raw, cfg, sigma);
  });
}

function getLeagueSessionFreezeKey(game, cfg) {
  if (!game?.isLeagueGame || cfg.leagueSessionFreezeEnabled !== true) return null;
  const context = getLeagueRatingContext(game, cfg);
  return `${context.id}:${game.date || game.createdAt || game.id || ''}`;
}

function cloneRatingSkill(skill, cfg) {
  return rating({
    mu: Number(skill?.mu ?? cfg.mu),
    sigma: clamp(Number(skill?.sigma ?? cfg.sigma), 1, cfg.sigma),
  });
}

function applyLeagueSessionPregameFreeze(game, ratingMap, sessionMap, cfg) {
  const key = getLeagueSessionFreezeKey(game, cfg);
  if (!key || !sessionMap) return null;

  const ids = getBlueTeamIds(game, cfg);
  let state = sessionMap.get(key);
  if (!state) {
    state = {
      baseline: new Map(),
      accumulated: new Map(),
    };
    ids.forEach(id => {
      state.baseline.set(String(id), cloneRatingSkill(ratingMap[id] ?? makeInitialRating(cfg), cfg));
      state.accumulated.set(String(id), { mu: 0, sigma: 0 });
    });
    sessionMap.set(key, state);
  }

  ids.forEach(id => {
    const baseline = state.baseline.get(String(id)) ?? makeInitialRating(cfg);
    ratingMap[id] = cloneRatingSkill(baseline, cfg);
  });

  return { key, ids, state };
}

function finalizeLeagueSessionFreeze(freeze, result, ratingMap, cfg) {
  if (!freeze || !result?.before?.blue || !result?.after?.blue) return;

  freeze.ids.forEach((id, index) => {
    const before = result.before.blue[index];
    const after = result.after.blue[index];
    if (!before || !after) return;

    const key = String(id);
    const currentAccum = freeze.state.accumulated.get(key) || { mu: 0, sigma: 0 };
    const nextAccum = {
      mu: currentAccum.mu + (Number(after.mu) - Number(before.mu)),
      sigma: currentAccum.sigma + (Number(after.sigma) - Number(before.sigma)),
    };
    freeze.state.accumulated.set(key, nextAccum);

    const baseline = freeze.state.baseline.get(key) ?? makeInitialRating(cfg);
    const nextSkill = rating({
      mu: Number(baseline.mu) + nextAccum.mu,
      sigma: clamp(Number(baseline.sigma) + nextAccum.sigma, 1, cfg.sigma),
    });
    ratingMap[id] = nextSkill;

    after.mu = Number(nextSkill.mu);
    after.sigma = Number(nextSkill.sigma);
    after.rating = getRawOrdinal(nextSkill, cfg);
  });
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

function cloneSkill(skill) {
  return skill ? { mu: Number(skill.mu), sigma: Number(skill.sigma) } : null;
}

function cloneRatingForRate(skill, cfg = {}) {
  return rating({
    mu: Number(skill?.mu ?? cfg.mu),
    sigma: clamp(Number(skill?.sigma ?? cfg.sigma), 1, cfg.sigma),
  });
}

function shiftSkillRawOrdinal(skill, rawOffset, cfg = {}) {
  const sigma = clamp(Number(skill?.sigma ?? cfg.sigma), 1, cfg.sigma);
  const raw = getRawOrdinal(skill, cfg);
  return rating({
    mu: raw + Number(rawOffset || 0) + Number(cfg.ordinalSigmaMultiplier) * sigma,
    sigma,
  });
}

function isMatchedLeagueOpponentModel(cfg = {}) {
  return cfg.leagueOpponentModel === 'matched' ||
    cfg.leagueOpponentModel === 'dayMatchedOffset';
}

function getLeagueDayOffsetKey(game, cfg = {}) {
  if (!game?.isLeagueGame) return null;
  const date = game.date || 'unknown-date';
  const level = getLeagueLevel(game) || LEAGUE_LEVEL_REC;
  if (cfg.leagueDayOffsetGrouping === 'dateLevelCourt') {
    return `${date}:${level}:${getCourtType(game)}`;
  }
  if (cfg.leagueDayOffsetGrouping === 'dateContext') {
    return `${date}:${getLeagueContextKey(game) || level}`;
  }
  return `${date}:${level}`;
}

function getLeagueMatchedRawOffset(game, cfg = {}) {
  const fixedOffset = Number(cfg.leagueMatchedOpponentOffsetRaw);
  if (Number.isFinite(fixedOffset)) return fixedOffset;

  if (cfg.leagueOpponentModel !== 'dayMatchedOffset') return 0;
  const key = getLeagueDayOffsetKey(game, cfg);
  const map = cfg._leagueDayMatchedOffsetRawMap;
  const value = key && map?.get ? map.get(key) : null;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function getShiftedMatchedLeagueTeam(redTeam, rawOffset, cfg = {}) {
  return redTeam.map(skill => shiftSkillRawOrdinal(skill, rawOffset, cfg));
}

function estimateLeagueDayMatchedOffset({
  games = [],
  ratingMap = {},
  cfg = {},
} = {}) {
  const leagueGames = (Array.isArray(games) ? games : []).filter(game =>
    game?.isLeagueGame &&
    Array.isArray(game.redTeam) &&
    game.redTeam.length > 0 &&
    (game.winner === 'red' || game.winner === 'blue')
  );
  if (!leagueGames.length) return 0;

  const maxRaw = Math.max(0, Number(cfg.leagueDayOffsetMaxRaw) || 0);
  const step = clamp(Number(cfg.leagueDayOffsetGridStep) || 0.25, 0.05, Math.max(0.05, maxRaw || 0.05));
  const priorSd = Math.max(0.1, Number(cfg.leagueDayOffsetPriorSd) || 3);
  const trust = clamp(Number(cfg.leagueDayOffsetTrust), 0, 1);
  let bestOffset = 0;
  let bestLogLikelihood = -Infinity;

  for (let offset = -maxRaw; offset <= maxRaw + 0.0001; offset += step) {
    let logLikelihood = -0.5 * (offset / priorSd) ** 2;

    leagueGames.forEach(game => {
      const redTeam = getRedTeamIds(game).map(id =>
        cloneRatingForRate(ratingMap[id] ?? makeInitialRating(cfg), cfg)
      );
      const blueTeam = getShiftedMatchedLeagueTeam(redTeam, offset, cfg);
      const redWinProbability = clamp(predictWin([redTeam, blueTeam])?.[0] ?? 0.5, 0.001, 0.999);
      logLikelihood += game.winner === 'red'
        ? Math.log(redWinProbability)
        : Math.log(1 - redWinProbability);
    });

    if (logLikelihood > bestLogLikelihood) {
      bestLogLikelihood = logLikelihood;
      bestOffset = offset;
    }
  }

  return bestOffset * trust;
}

function ensureLeagueDayMatchedOffset({
  game,
  sortedGames = [],
  ratingMap = {},
  offsetMap = null,
  cfg = {},
} = {}) {
  if (cfg.leagueOpponentModel !== 'dayMatchedOffset' || !game?.isLeagueGame || !offsetMap) {
    return;
  }

  const key = getLeagueDayOffsetKey(game, cfg);
  if (!key || offsetMap.has(key)) return;

  const dayGames = sortedGames.filter(candidate =>
    candidate?.isLeagueGame &&
    getLeagueDayOffsetKey(candidate, cfg) === key
  );
  offsetMap.set(key, estimateLeagueDayMatchedOffset({
    games: dayGames,
    ratingMap,
    cfg,
  }));
}

function getScoreboardSideSize(game, side) {
  const team = Array.isArray(game?.[`${side}Team`]) ? game[`${side}Team`] : [];
  return team.length;
}

function isSmallEnvironmentSize(size) {
  return size === 3 || size === 4;
}

function isBigEnvironmentSize(size) {
  return size >= 5;
}

function getEnvironmentSiloForGame(game) {
  const redSize = getScoreboardSideSize(game, 'red');
  const blueSize = game?.isLeagueGame ? 0 : getScoreboardSideSize(game, 'blue');
  if (game?.isLeagueGame || isBigEnvironmentSize(redSize) || isBigEnvironmentSize(blueSize)) return 'big';
  if (isSmallEnvironmentSize(redSize) || isSmallEnvironmentSize(blueSize)) return 'small';
  return 'overall';
}

function getEnvironmentSiloForPlayers(teamCount, playerCount) {
  const teams = Math.max(1, Number(teamCount) || 1);
  const largestTeamSize = Math.ceil(Math.max(0, Number(playerCount) || 0) / teams);
  if (isBigEnvironmentSize(largestTeamSize)) return 'big';
  if (isSmallEnvironmentSize(largestTeamSize)) return 'small';
  return 'overall';
}

function countEnvironmentSiloGames(games, silo) {
  const counts = {};
  (Array.isArray(games) ? games : []).forEach(game => {
    if (getEnvironmentSiloForGame(game) !== silo) return;

    const add = player => {
      if (!player?.id) return;
      const id = String(player.id);
      counts[id] = (counts[id] || 0) + 1;
    };

    if (Array.isArray(game.redTeam)) game.redTeam.forEach(add);
    if (!game.isLeagueGame && Array.isArray(game.blueTeam)) game.blueTeam.forEach(add);
  });
  return counts;
}

function getEnvironmentAdjustedSkill({ overallSkill, siloSkill, siloGames, ratingOptions, volleyballOptions }) {
  if (!overallSkill) return cloneSkill(siloSkill) || makeInitialRating(ratingOptions);
  if (!siloSkill) return cloneSkill(overallSkill);

  const overallRaw = getRawOrdinal(overallSkill, ratingOptions);
  const siloRaw = getRawOrdinal(siloSkill, ratingOptions);
  const delta = siloRaw - overallRaw;
  const minDelta = Math.max(0, Number(volleyballOptions.environmentSiloMinDelta) || 0);
  if (Math.abs(delta) < minDelta) return cloneSkill(overallSkill);

  const confidenceGames = Math.max(0.01, Number(volleyballOptions.environmentSiloConfidenceGames) || 6);
  const maxBlend = clamp(Number(volleyballOptions.environmentSiloMaxBlend) || 0, 0, 1);
  const adjustmentCap = Math.max(0, Number(volleyballOptions.environmentSiloAdjustmentCap) || Infinity);
  const blend = Math.min(maxBlend, siloGames / (siloGames + confidenceGames));
  const adjustment = clamp(delta * blend, -adjustmentCap, adjustmentCap);
  return getSkillFromRawOrdinal(overallRaw + adjustment, ratingOptions, overallSkill.sigma);
}

export function buildEnvironmentAdjustedRatingMap({
  players = [],
  games = [],
  baseRatingMap = {},
  ratingOptions = {},
  volleyballOptions = {},
  teamCount = 2,
  playerCount = 0,
  targetSilo = null,
} = {}) {
  const ratingCfg = mergeRatingOptions(ratingOptions);
  const volleyballCfg = mergeVolleyballBalanceOptions(volleyballOptions);
  if (volleyballCfg.environmentSiloMode !== 'blend') return baseRatingMap;

  const silo = targetSilo || getEnvironmentSiloForPlayers(teamCount, playerCount);
  if (!['small', 'big'].includes(silo)) return baseRatingMap;

  const includedGames = getIncludedGames(games, true, ratingCfg);
  const siloGames = includedGames.filter(game => getEnvironmentSiloForGame(game) === silo);
  if (!siloGames.length) return baseRatingMap;

  const siloReplay = replayRatings({
    players,
    games: siloGames,
    options: ratingCfg,
    seasonal: true,
    volleyballAdjusted: false,
    includeLeagueGames: true,
  });
  const siloCounts = countEnvironmentSiloGames(includedGames, silo);
  const minGames = Math.max(0, Number(volleyballCfg.environmentSiloMinGames) || 0);
  const adjustedMap = {};

  players.forEach(player => {
    if (!player?.id) return;
    const id = String(player.id);
    const overallSkill = baseRatingMap[id] || makeInitialRating(ratingCfg);
    const siloSkill = siloReplay.ratingMap?.[id];
    const gamesInSilo = siloCounts[id] || 0;
    adjustedMap[id] = gamesInSilo >= minGames
      ? getEnvironmentAdjustedSkill({
        overallSkill,
        siloSkill,
        siloGames: gamesInSilo,
        ratingOptions: ratingCfg,
        volleyballOptions: volleyballCfg,
      })
      : cloneSkill(overallSkill);
  });

  return adjustedMap;
}

function getSameTeamPairKeys(players = []) {
  const ids = players
    .map(player => player?.id)
    .filter(id => id !== undefined && id !== null)
    .map(String)
    .sort();
  const keys = [];

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      keys.push(`${ids[i]}|${ids[j]}`);
    }
  }

  return keys;
}

function addPairObservation(pairMap, key, value) {
  const current = pairMap.get(key) || { total: 0, count: 0 };
  current.total += value;
  current.count += 1;
  pairMap.set(key, current);
}

function updatePairAdjustmentMap(pairMap, redTeam, blueTeam, residual) {
  getSameTeamPairKeys(redTeam).forEach(key => addPairObservation(pairMap, key, residual));
  getSameTeamPairKeys(blueTeam).forEach(key => addPairObservation(pairMap, key, -residual));
}

function gameCanLearnPairSignal(game, redPlayers, bluePlayers) {
  return (
    !game?.isLeagueGame &&
    redPlayers.length >= 2 &&
    bluePlayers.length >= 2 &&
    typeof game?.scoreRed === 'number' &&
    typeof game?.scoreBlue === 'number' &&
    (game?.winner === 'red' || game?.winner === 'blue')
  );
}

function learnPairAdjustmentFromGame({
  pairMap,
  game,
  ratingMap,
  ratingOptions,
  volleyballOptions,
}) {
  if (!pairMap) return;
  const redPlayers = Array.isArray(game?.redTeam) ? game.redTeam : [];
  const bluePlayers = Array.isArray(game?.blueTeam) ? game.blueTeam : [];
  if (!gameCanLearnPairSignal(game, redPlayers, bluePlayers)) return;

  const score = scoreVolleyballCandidateSplit({
    redPlayers,
    bluePlayers,
    ratingMap,
    options: ratingOptions,
    volleyballOptions: {
      ...volleyballOptions,
      pairAdjustmentMode: 'off',
    },
  });
  updatePairAdjustmentMap(
    pairMap,
    redPlayers,
    bluePlayers,
    (game.winner === 'red' ? 1 : 0) - score.redWinProbability
  );
}

function getPairAdjustmentForTeam(players = [], pairMap, volleyballOptions = {}) {
  if (!pairMap || volleyballOptions.pairAdjustmentMode !== 'blend') {
    return { adjustment: 0, usablePairs: 0 };
  }

  const minGames = Math.max(0, Number(volleyballOptions.pairAdjustmentMinGames) || 0);
  const confidenceGames = Math.max(0.01, Number(volleyballOptions.pairAdjustmentConfidenceGames) || 4);
  const maxBlend = clamp(Number(volleyballOptions.pairAdjustmentMaxBlend) || 0, 0, 1);
  const perPairCap = Math.max(0, Number(volleyballOptions.pairAdjustmentPerPairCap) || 0);
  const teamCap = Math.max(0, Number(volleyballOptions.pairAdjustmentTeamCap) || Infinity);
  const minDelta = Math.max(0, Number(volleyballOptions.pairAdjustmentMinDelta) || 0);
  let total = 0;
  let usablePairs = 0;

  getSameTeamPairKeys(players).forEach(key => {
    const stat = pairMap.get(key);
    if (!stat || stat.count < minGames) return;

    const raw = stat.total / stat.count;
    if (Math.abs(raw) < minDelta) return;

    const blend = Math.min(maxBlend, stat.count / (stat.count + confidenceGames));
    total += clamp(raw * blend, -perPairCap, perPairCap);
    usablePairs += 1;
  });

  return {
    adjustment: clamp(total, -teamCap, teamCap),
    usablePairs,
  };
}

export function buildPairAdjustmentMap({
  players = [],
  games = [],
  ratingOptions = {},
  volleyballOptions = {},
  seasonal = true,
} = {}) {
  const ratingCfg = mergeRatingOptions(ratingOptions);
  const volleyballCfg = mergeVolleyballBalanceOptions(volleyballOptions);
  const pairMap = new Map();

  if (volleyballCfg.pairAdjustmentMode !== 'blend') return pairMap;

  const ratingMap = {};
  players.forEach(player => {
    if (!player?.id) return;
    ratingMap[player.id] = makeInitialRating(ratingCfg);
  });

  const includedGames = getIncludedGames(games, true, ratingCfg);
  const sortedGames = aggregateLeagueSeriesGames(
    getGamesSortedOldestFirst(includedGames),
    ratingCfg
  );
  const seasonalTaperDays =
    typeof ratingCfg.seasonalTaperDays === 'number'
      ? ratingCfg.seasonalTaperDays
      : SEASONAL_TAPER_DAYS;
  const referenceDate = seasonal ? getMostRecentGameDate(sortedGames) : null;

  sortedGames.forEach(game => {
    const redPlayers = Array.isArray(game?.redTeam) ? game.redTeam : [];
    const bluePlayers = Array.isArray(game?.blueTeam) ? game.blueTeam : [];
    if (gameCanLearnPairSignal(game, redPlayers, bluePlayers)) {
      learnPairAdjustmentFromGame({
        pairMap,
        game,
        ratingMap,
        ratingOptions: ratingCfg,
        volleyballOptions: volleyballCfg,
      });
    }

    const seasonalWeight = seasonal
      ? getSeasonalWeight(game?.date, referenceDate, seasonalTaperDays)
      : 1;
    rateSingleGame(game, ratingMap, {
      ...ratingCfg,
      seasonalWeight,
      volleyballAdjusted: true,
      volleyballOptions: volleyballCfg,
    });
  });

  return pairMap;
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
    const carryScale = Number.isFinite(Number(volleyballCfg.carryScale))
      ? Number(volleyballCfg.carryScale)
      : 8;
    const carryBonus = carryStats.score * carryScale * confidence;
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

function getSecondWorstRatingFromBreakdown(breakdown) {
  const ratings = Array.isArray(breakdown?.ratedPlayers)
    ? breakdown.ratedPlayers
      .map(player => Number(player.rawOrdinal))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
    : [];
  return ratings.length >= 2 ? ratings[1] : Number(breakdown?.worstRating);
}

function getWeakLinkGapFromBreakdown(breakdown, mode) {
  const worstRating = Number(breakdown?.worstRating);
  if (!Number.isFinite(worstRating)) return 0;

  if (mode === 'avgGap') {
    const averageRating = Number(breakdown?.averageRating);
    return Number.isFinite(averageRating) ? Math.max(0, averageRating - worstRating) : 0;
  }

  if (mode === 'secondWorstGap') {
    const secondWorstRating = getSecondWorstRatingFromBreakdown(breakdown);
    return Number.isFinite(secondWorstRating) ? Math.max(0, secondWorstRating - worstRating) : 0;
  }

  return 0;
}

function getWeakLinkPenaltyFromBreakdown(breakdown, volleyballCfg) {
  const mode = volleyballCfg.weakLinkPenaltyMode || 'off';
  if (mode === 'off') return 0;

  const scale = Math.max(0, Number(volleyballCfg.weakLinkPenaltyScale) || 0);
  const threshold = Math.max(0, Number(volleyballCfg.weakLinkPenaltyThreshold) || 0);
  const gap = getWeakLinkGapFromBreakdown(breakdown, mode);
  return Math.max(0, gap - threshold) * scale;
}

export function scoreVolleyballCandidateSplit({
  redPlayers,
  bluePlayers,
  ratingMap,
  carryScoreMap = {},
  options = {},
  volleyballOptions = {},
  pairAdjustmentMap = null,
  ignoreSizeAdjustment = false,
  redStrengthBase: providedRedStrengthBase = null,
  blueStrengthBase: providedBlueStrengthBase = null,
} = {}) {
  const ratingCfg = mergeRatingOptions(options);
  const volleyballCfg = mergeVolleyballBalanceOptions(volleyballOptions);

  redPlayers.forEach(player => ensureRatingEntry(ratingMap, player.id, ratingCfg));
  bluePlayers.forEach(player => ensureRatingEntry(ratingMap, player.id, ratingCfg));

  const redStrengthBase = providedRedStrengthBase || getVolleyballTeamStrength({
    players: redPlayers,
    ratingMap,
    carryScoreMap,
    ratingOptions: ratingCfg,
    volleyballOptions: volleyballCfg,
  });

  const blueStrengthBase = providedBlueStrengthBase || getVolleyballTeamStrength({
    players: bluePlayers,
    ratingMap,
    carryScoreMap,
    ratingOptions: ratingCfg,
    volleyballOptions: volleyballCfg,
  });

  const redEffectiveSize = getEffectiveVolleyballSize(redPlayers);
  const blueEffectiveSize = getEffectiveVolleyballSize(bluePlayers);

  const rawSizeDiff = (Array.isArray(redPlayers) ? redPlayers.length : 0) -
    (Array.isArray(bluePlayers) ? bluePlayers.length : 0);
  const sizeDiff = ignoreSizeAdjustment ? 0 : rawSizeDiff;
  const sizeBonusPerExtraPlayer = ignoreSizeAdjustment
    ? 0
    : getVolleyballSizeBonusPerExtraPlayer(redPlayers, bluePlayers, volleyballCfg);
  const redSizeAdjustment = sizeDiff * sizeBonusPerExtraPlayer;
  const blueSizeAdjustment = -sizeDiff * sizeBonusPerExtraPlayer;

  // Conditional worst player weight: scale down when one team has a dominant star.
  // In a close matchup (matchCloseness ≈ 1) the weak link matters; in a lopsided one it doesn't.
  const redWorstContrib = volleyballCfg.worstPlayerWeight * redStrengthBase.worstRating;
  const blueWorstContrib = volleyballCfg.worstPlayerWeight * blueStrengthBase.worstRating;
  const redWithoutWorst = redStrengthBase.baseStrength - redWorstContrib + redSizeAdjustment;
  const blueWithoutWorst = blueStrengthBase.baseStrength - blueWorstContrib + blueSizeAdjustment;
  const matchCloseness = Math.max(0, 1 - Math.abs(redWithoutWorst - blueWithoutWorst) / (volleyballCfg.probabilityScale * 1.5));

  const redStrengthBeforeWeakLinkPenalty = redWithoutWorst + redWorstContrib * matchCloseness;
  const blueStrengthBeforeWeakLinkPenalty = blueWithoutWorst + blueWorstContrib * matchCloseness;
  const redWeakLinkPenalty = getWeakLinkPenaltyFromBreakdown(redStrengthBase, volleyballCfg);
  const blueWeakLinkPenalty = getWeakLinkPenaltyFromBreakdown(blueStrengthBase, volleyballCfg);
  const redPairAdjustment = getPairAdjustmentForTeam(redPlayers, pairAdjustmentMap, volleyballCfg);
  const bluePairAdjustment = getPairAdjustmentForTeam(bluePlayers, pairAdjustmentMap, volleyballCfg);
  const redStrength = redStrengthBeforeWeakLinkPenalty - redWeakLinkPenalty + redPairAdjustment.adjustment;
  const blueStrength = blueStrengthBeforeWeakLinkPenalty - blueWeakLinkPenalty + bluePairAdjustment.adjustment;

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
    sizeBonusPerExtraPlayer,

    redSizeAdjustment,
    blueSizeAdjustment,
    redWeakLinkPenalty,
    blueWeakLinkPenalty,
    redPairAdjustment: redPairAdjustment.adjustment,
    bluePairAdjustment: bluePairAdjustment.adjustment,
    pairUsableLinks: redPairAdjustment.usablePairs + bluePairAdjustment.usablePairs,

    redBreakdown: {
      ...redStrengthBase,
      strength: redStrength,
      strengthBeforeWeakLinkPenalty: redStrengthBeforeWeakLinkPenalty,
      weakLinkPenalty: redWeakLinkPenalty,
      pairAdjustment: redPairAdjustment.adjustment,
      usablePairLinks: redPairAdjustment.usablePairs,
      sizeAdjustment: redSizeAdjustment,
      sizeBonusPerExtraPlayer,
      effectiveTeamSize: redEffectiveSize,
    },

    blueBreakdown: {
      ...blueStrengthBase,
      strength: blueStrength,
      strengthBeforeWeakLinkPenalty: blueStrengthBeforeWeakLinkPenalty,
      weakLinkPenalty: blueWeakLinkPenalty,
      pairAdjustment: bluePairAdjustment.adjustment,
      usablePairLinks: bluePairAdjustment.usablePairs,
      sizeAdjustment: blueSizeAdjustment,
      sizeBonusPerExtraPlayer,
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

function getVolleyballWinnerProbability(
  game,
  ratingMap,
  options = {},
  volleyballOptions = {},
  pairAdjustmentMap = null
) {
  const redPlayers = Array.isArray(game?.redTeam) ? game.redTeam : [];
  const bluePlayers = getBluePlayersForVolleyballModel(game, options);

  const score = scoreVolleyballCandidateSplit({
    redPlayers,
    bluePlayers,
    ratingMap,
    options,
    volleyballOptions,
    pairAdjustmentMap,
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
  muMultiplier = 1,
  sigmaMultiplier = 1,
  options = {},
}) {
  const cfg = mergeRatingOptions(options);

  ids.forEach((id, index) => {
    const before = beforeEntries[index];
    const after = updatedTeam[index];

    const nextMu = before.mu + (Number(after.mu) - before.mu) * multiplier * muMultiplier;
    const nextSigma = before.sigma + (Number(after.sigma) - before.sigma) * multiplier * sigmaMultiplier;

    ratingMap[id] = rating({
      mu: nextMu,
      sigma: clamp(nextSigma, 1, cfg.sigma),
    });
  });
}

function getLeagueSeriesAggregationKey(game) {
  if (!game?.isLeagueGame) return null;
  const rosterKey = getRedTeamIds(game).map(String).sort().join('|');
  return [
    game.date || 'unknown-date',
    getLeagueContextKey(game) || getLeagueLevel(game) || 'league',
    rosterKey,
  ].join('::');
}

function aggregateLeagueSeriesGames(sortedGames = [], cfg = {}) {
  if (cfg.leagueSeriesAggregationEnabled !== true) return sortedGames;

  const groups = new Map();
  sortedGames.forEach((game, index) => {
    const key = getLeagueSeriesAggregationKey(game);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ game, index });
  });

  const aggregateByFirstIndex = new Map();
  const skipIndexes = new Set();

  groups.forEach(entries => {
    if (entries.length <= 1) return;

    const first = entries[0].game;
    let redWins = 0;
    let blueWins = 0;
    let scoreRed = 0;
    let scoreBlue = 0;
    let hasScores = false;

    entries.forEach(({ game }) => {
      if (game.winner === 'red') redWins += 1;
      if (game.winner === 'blue') blueWins += 1;
      if (typeof game.scoreRed === 'number' && typeof game.scoreBlue === 'number') {
        scoreRed += game.scoreRed;
        scoreBlue += game.scoreBlue;
        hasScores = true;
      }
    });

    let winner = redWins > blueWins ? 'red' : blueWins > redWins ? 'blue' : null;
    if (!winner && hasScores && scoreRed !== scoreBlue) {
      winner = scoreRed > scoreBlue ? 'red' : 'blue';
    }
    if (!winner) return;

    const aggregate = {
      ...first,
      id: `${first.id || first.createdAt || entries[0].index}_league_series_${entries.length}`,
      createdAt: first.createdAt ?? entries[0].index,
      winner,
      scoreRed: hasScores ? scoreRed : undefined,
      scoreBlue: hasScores ? scoreBlue : undefined,
      leagueSeriesGameCount: entries.length,
      leagueSeriesRedWins: redWins,
      leagueSeriesBlueWins: blueWins,
      leagueSeriesGames: entries.map(({ game }) => cloneSimple(game)),
    };

    aggregateByFirstIndex.set(entries[0].index, aggregate);
    entries.slice(1).forEach(entry => skipIndexes.add(entry.index));
  });

  return sortedGames
    .map((game, index) => aggregateByFirstIndex.get(index) || game)
    .filter((_, index) => !skipIndexes.has(index));
}

function getOpenSkillOutcomeScores(game, cfg = {}) {
  const mode = cfg.openSkillScoreMode || 'binary';
  if (
    mode === 'rawScore' &&
    typeof game?.scoreRed === 'number' &&
    typeof game?.scoreBlue === 'number'
  ) {
    return [game.scoreRed, game.scoreBlue];
  }

  if (
    mode === 'marginScore' &&
    typeof game?.scoreRed === 'number' &&
    typeof game?.scoreBlue === 'number'
  ) {
    const redWon = game.winner === 'red';
    const pointDiff = Math.abs(game.scoreRed - game.scoreBlue);
    const spread = Math.min(1, pointDiff / 10);
    return redWon ? [1 + spread, 0] : [0, 1 + spread];
  }

  return game?.winner === 'red'
    ? [1, 0]
    : [0, 1];
}

function getOpenSkillRateOptions(game, cfg = {}) {
  const rateOptions = {
    score: getOpenSkillOutcomeScores(game, cfg),
  };

  const betaMultiplier = Number(cfg.openSkillBetaMultiplier);
  if (Number.isFinite(betaMultiplier) && betaMultiplier > 0 && betaMultiplier !== 1) {
    rateOptions.beta = (Number(cfg.sigma) || DEFAULT_RATING_OPTIONS.sigma) / 2 * betaMultiplier;
  }

  const tau = Number(cfg.openSkillTau);
  if (Number.isFinite(tau) && tau > 0) {
    rateOptions.tau = tau;
    rateOptions.preventSigmaIncrease = Boolean(cfg.openSkillPreventSigmaIncrease);
  }

  return rateOptions;
}

function getEvidenceModeMultiplier(evidence, mode, side = 'red') {
  if (mode === 'none') return 1;
  if (mode === 'baseOnly') return evidence.baseUpdateMultiplier ?? evidence.evidenceWeight ?? 1;
  if (mode === 'seasonalOnly') return evidence.seasonalWeight ?? 1;
  return side === 'blue'
    ? evidence.blueFinalMultiplier
    : evidence.redFinalMultiplier;
}

function hashStringToSeed(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function median(values) {
  const sorted = values
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getEntryForPlayer(historyEntry, id) {
  const targetId = String(id);
  const redIndex = (historyEntry.before?.red || []).findIndex(entry => String(entry.id) === targetId);
  if (redIndex >= 0) {
    return {
      side: 'red',
      before: historyEntry.before.red[redIndex],
      after: historyEntry.after?.red?.[redIndex],
    };
  }

  const blueIndex = (historyEntry.before?.blue || []).findIndex(entry => String(entry.id) === targetId);
  if (blueIndex >= 0) {
    return {
      side: 'blue',
      before: historyEntry.before.blue[blueIndex],
      after: historyEntry.after?.blue?.[blueIndex],
    };
  }

  return null;
}

function buildRatingMapFromBeforeEntries(historyEntry, targetId, targetSkill, cfg) {
  const map = {};
  [...(historyEntry.before?.red || []), ...(historyEntry.before?.blue || [])].forEach(entry => {
    map[entry.id] = rating({
      mu: Number(entry.mu),
      sigma: clamp(Number(entry.sigma), 1, cfg.sigma),
    });
  });
  map[targetId] = rating({
    mu: Number(targetSkill.mu),
    sigma: clamp(Number(targetSkill.sigma), 1, cfg.sigma),
  });
  return map;
}

function simulatePlayerLocalWindow({
  playerId,
  entries,
  startSkill,
  cfg,
  volleyballOptions = {},
}) {
  let skill = rating({
    mu: Number(startSkill.mu),
    sigma: clamp(Number(startSkill.sigma), 1, cfg.sigma),
  });

  entries.forEach(entry => {
    const localMap = buildRatingMapFromBeforeEntries(entry, playerId, skill, cfg);
    rateSingleGame(entry.game, localMap, {
      ...cfg,
      seasonalWeight: Number(entry.seasonalWeight) || 1,
      volleyballAdjusted: Boolean(entry.volleyballAdjusted),
      volleyballOptions,
    });
    if (localMap[playerId]) {
      skill = localMap[playerId];
    }
  });

  return skill;
}

function getTrailingRunMagnitude(values) {
  if (!values.length) return 0;
  const last = Number(values[values.length - 1]) || 0;
  const direction = Math.sign(last);
  if (!direction) return 0;

  let total = 0;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = Number(values[i]) || 0;
    if (Math.sign(value) !== direction) break;
    total += value;
  }
  return Math.abs(total);
}

function getStreakDampeningMultiplier({
  beforeRaw,
  afterRaw,
  excess,
  minMultiplier,
  strength,
}) {
  const rawDelta = afterRaw - beforeRaw;
  if (!Number.isFinite(rawDelta) || Math.abs(rawDelta) <= 0.0001) return 1;

  const fullCorrectionMultiplier = clamp((Math.abs(rawDelta) - excess) / Math.abs(rawDelta), 0, 1);
  const targetMultiplier = 1 - strength * (1 - fullCorrectionMultiplier);
  return clamp(targetMultiplier, minMultiplier, 1);
}

function getPlayerReplayStreakMultiplier({
  id,
  historyEntry,
  recentEntryMap,
  cfg,
  volleyballOptions = {},
  windowSize,
  threshold,
  minMultiplier,
  strength,
}) {
  if (!recentEntryMap) return 1;

  const priorEntries = recentEntryMap.get(id) || [];
  const candidateEntries = [...priorEntries, historyEntry].slice(-windowSize);
  if (candidateEntries.length < windowSize) return 1;

  const firstEntry = getEntryForPlayer(candidateEntries[0], id);
  const currentEntry = getEntryForPlayer(historyEntry, id);
  if (!firstEntry?.before || !currentEntry?.before || !currentEntry?.after) return 1;

  const startSkill = rating({
    mu: Number(firstEntry.before.mu),
    sigma: clamp(Number(firstEntry.before.sigma), 1, cfg.sigma),
  });
  const startRaw = getRawOrdinal(startSkill, cfg);
  const actualEndRaw = Number(currentEntry.after.rating);
  const beforeCurrentRaw = Number(currentEntry.before.rating);
  const currentDelta = actualEndRaw - beforeCurrentRaw;
  const actualWindowDelta = actualEndRaw - startRaw;
  if (!Number.isFinite(actualWindowDelta) || Math.abs(currentDelta) <= 0.0001) return 1;

  const iterations = Math.max(5, Number(cfg.streakProtectionShuffleIterations) || 30);
  const seed = hashStringToSeed(`${id}:${historyEntry.game?.id ?? historyEntry.game?.createdAt ?? ''}:${candidateEntries.length}`);
  const random = seededRandom(seed);
  const shuffledDeltas = [];

  for (let i = 0; i < iterations; i += 1) {
    const shuffledEntries = shuffledCopy(candidateEntries, random);
    const shuffledSkill = simulatePlayerLocalWindow({
      playerId: id,
      entries: shuffledEntries,
      startSkill,
      cfg,
      volleyballOptions,
    });
    shuffledDeltas.push(getRawOrdinal(shuffledSkill, cfg) - startRaw);
  }

  const medianWindowDelta = median(shuffledDeltas);
  if (!Number.isFinite(medianWindowDelta)) return 1;

  const orderSensitiveDelta = actualWindowDelta - medianWindowDelta;
  if (Math.abs(orderSensitiveDelta) <= threshold) return 1;
  if (Math.sign(orderSensitiveDelta) !== Math.sign(currentDelta)) return 1;

  return getStreakDampeningMultiplier({
    beforeRaw: beforeCurrentRaw,
    afterRaw: actualEndRaw,
    excess: Math.abs(orderSensitiveDelta) - threshold,
    minMultiplier,
    strength,
  });
}

function applyStreakProtectionForEntry({
  historyEntry,
  ratingMap,
  statsMap,
  recentDeltaMap,
  recentEntryMap,
  cfg,
  volleyballOptions = {},
} = {}) {
  if (!cfg.streakProtectionEnabled || !historyEntry || !recentDeltaMap) return;
  if (historyEntry.game?.isLeagueGame) return;

  const mode = cfg.streakProtectionMode || 'net';
  const windowSize = Math.max(2, Number(cfg.streakProtectionWindow) || 10);
  const minGames = Math.max(0, Number(cfg.streakProtectionMinGames) || 0);
  const threshold = Math.max(0, Number(cfg.streakProtectionThresholdRaw) || 0);
  const minMultiplier = clamp(Number(cfg.streakProtectionMinMultiplier) || 0, 0, 1);
  const strength = clamp(Number(cfg.streakProtectionStrength) || 0, 0, 1);
  const iterations = Math.max(5, Number(cfg.streakProtectionShuffleIterations) || 30);
  const applyTo = cfg.streakProtectionApplyTo || 'skill';

  if (threshold <= 0 || strength <= 0) return;

  const pairs = [
    ...((historyEntry.before?.red || []).map((before, index) => ({
      before,
      after: historyEntry.after?.red?.[index],
    }))),
    ...((historyEntry.before?.blue || []).map((before, index) => ({
      before,
      after: historyEntry.after?.blue?.[index],
    }))),
  ];

  pairs.forEach(({ before, after }) => {
    if (!before || !after) return;
    const id = String(before.id);
    if (isSyntheticLeagueMemberId(id)) return;

    const priorDeltas = recentDeltaMap.get(id) || [];
    const rawDelta = Number(after.rating) - Number(before.rating);
    let finalDelta = Number.isFinite(rawDelta) ? rawDelta : 0;

    const preGameCount = statsMap[id]?.games ?? 0;
    const candidateWindow = [...priorDeltas, finalDelta].slice(-windowSize);
    let multiplier = 1;
    let auditValue = null;

    if (
      preGameCount >= minGames &&
      candidateWindow.length >= windowSize &&
      Math.abs(finalDelta) > 0.0001
    ) {
      if (mode === 'deltaShuffle') {
        const actualTail = getTrailingRunMagnitude(candidateWindow);
        const seed = hashStringToSeed(`${id}:${historyEntry.game?.id ?? historyEntry.game?.createdAt ?? ''}:delta`);
        const random = seededRandom(seed);
        const shuffledTailMagnitudes = [];
        for (let i = 0; i < iterations; i += 1) {
          shuffledTailMagnitudes.push(getTrailingRunMagnitude(shuffledCopy(candidateWindow, random)));
        }
        const medianTail = median(shuffledTailMagnitudes) ?? 0;
        auditValue = actualTail - medianTail;
        if (actualTail > medianTail + threshold) {
          multiplier = getStreakDampeningMultiplier({
            beforeRaw: Number(before.rating),
            afterRaw: Number(after.rating),
            excess: actualTail - medianTail - threshold,
            minMultiplier,
            strength,
          });
        }
      } else if (mode === 'playerReplay') {
        multiplier = getPlayerReplayStreakMultiplier({
          id,
          historyEntry,
          recentEntryMap,
          cfg,
          volleyballOptions,
          windowSize,
          threshold,
          minMultiplier,
          strength,
        });
      } else {
        const netWindowDelta = candidateWindow.reduce((sum, value) => sum + value, 0);
        const sameDirection = Math.sign(netWindowDelta) !== 0 && Math.sign(finalDelta) === Math.sign(netWindowDelta);
        auditValue = netWindowDelta;
        if (sameDirection && Math.abs(netWindowDelta) > threshold) {
          multiplier = getStreakDampeningMultiplier({
            beforeRaw: Number(before.rating),
            afterRaw: Number(after.rating),
            excess: Math.abs(netWindowDelta) - threshold,
            minMultiplier,
            strength,
          });
        }
      }
    }

    if (multiplier < 1) {
      const newMu = Number(before.mu) + (Number(after.mu) - Number(before.mu)) * multiplier;
      const newSigma = applyTo === 'muOnly'
        ? Number(after.sigma)
        : Number(before.sigma) + (Number(after.sigma) - Number(before.sigma)) * multiplier;
      const adjustedSkill = rating({
        mu: newMu,
        sigma: clamp(newSigma, 1, cfg.sigma),
      });
      const adjustedRaw = getRawOrdinal(adjustedSkill, cfg);

      ratingMap[id] = adjustedSkill;
      after.mu = Number(adjustedSkill.mu);
      after.sigma = Number(adjustedSkill.sigma);
      after.rating = adjustedRaw;
      after.streakProtectionMultiplier = multiplier;
      after.streakProtectionMode = mode;
      after.streakProtectionApplyTo = applyTo;
      after.streakProtectionAuditValue = auditValue;
      finalDelta = adjustedRaw - Number(before.rating);
    }

    recentDeltaMap.set(id, [...priorDeltas, finalDelta].slice(-windowSize));
    if (recentEntryMap) {
      const priorEntries = recentEntryMap.get(id) || [];
      recentEntryMap.set(id, [...priorEntries, historyEntry].slice(-windowSize));
    }
  });
}

function getSessionKeyForGame(game) {
  return String(game?.date || game?.createdAt || game?.id || 'unknown-session');
}

function applySessionProtectionForEntry({
  historyEntry,
  ratingMap,
  statsMap,
  sessionDeltaMap,
  cfg,
} = {}) {
  if (!cfg.sessionProtectionEnabled || !historyEntry || !sessionDeltaMap) return;
  if (historyEntry.game?.isLeagueGame) return;

  const minPriorGames = Math.max(0, Number(cfg.sessionProtectionMinPriorGames) || 0);
  const minSessionGames = Math.max(1, Number(cfg.sessionProtectionMinSessionGames) || 1);
  const threshold = Math.max(0, Number(cfg.sessionProtectionThresholdRaw) || 0);
  const minMultiplier = clamp(Number(cfg.sessionProtectionMinMultiplier) || 0, 0, 1);
  const strength = clamp(Number(cfg.sessionProtectionStrength) || 0, 0, 1);
  const applyTo = cfg.sessionProtectionApplyTo || 'muOnly';
  const sessionKey = getSessionKeyForGame(historyEntry.game);

  if (threshold <= 0 || strength <= 0) return;

  const pairs = [
    ...((historyEntry.before?.red || []).map((before, index) => ({
      before,
      after: historyEntry.after?.red?.[index],
    }))),
    ...((historyEntry.before?.blue || []).map((before, index) => ({
      before,
      after: historyEntry.after?.blue?.[index],
    }))),
  ];

  pairs.forEach(({ before, after }) => {
    if (!before || !after) return;
    const id = String(before.id);
    if (isSyntheticLeagueMemberId(id)) return;

    const previousState = sessionDeltaMap.get(id);
    const priorDeltas = previousState?.sessionKey === sessionKey
      ? previousState.deltas || []
      : [];

    const rawDelta = Number(after.rating) - Number(before.rating);
    let finalDelta = Number.isFinite(rawDelta) ? rawDelta : 0;
    const preGameCount = statsMap[id]?.games ?? 0;
    const candidateSession = [...priorDeltas, finalDelta];
    const netSessionDelta = candidateSession.reduce((sum, value) => sum + value, 0);
    const sameDirection = Math.sign(netSessionDelta) !== 0 && Math.sign(finalDelta) === Math.sign(netSessionDelta);

    if (
      preGameCount >= minPriorGames &&
      candidateSession.length >= minSessionGames &&
      Math.abs(finalDelta) > 0.0001 &&
      sameDirection &&
      Math.abs(netSessionDelta) > threshold
    ) {
      const multiplier = getStreakDampeningMultiplier({
        beforeRaw: Number(before.rating),
        afterRaw: Number(after.rating),
        excess: Math.abs(netSessionDelta) - threshold,
        minMultiplier,
        strength,
      });

      if (multiplier < 1) {
        const newMu = Number(before.mu) + (Number(after.mu) - Number(before.mu)) * multiplier;
        const newSigma = applyTo === 'muOnly'
          ? Number(after.sigma)
          : Number(before.sigma) + (Number(after.sigma) - Number(before.sigma)) * multiplier;
        const adjustedSkill = rating({
          mu: newMu,
          sigma: clamp(newSigma, 1, cfg.sigma),
        });
        const adjustedRaw = getRawOrdinal(adjustedSkill, cfg);

        ratingMap[id] = adjustedSkill;
        after.mu = Number(adjustedSkill.mu);
        after.sigma = Number(adjustedSkill.sigma);
        after.rating = adjustedRaw;
        after.sessionProtectionMultiplier = multiplier;
        after.sessionProtectionApplyTo = applyTo;
        after.sessionProtectionNetDelta = netSessionDelta;
        after.sessionProtectionSessionGames = candidateSession.length;
        finalDelta = adjustedRaw - Number(before.rating);
      }
    }

    sessionDeltaMap.set(id, {
      sessionKey,
      deltas: [...priorDeltas, finalDelta],
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
  volleyballScoringRatingMap = null,
  volleyballScoringPairAdjustmentMap = null,
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
    getVolleyballWinnerProbability(
      game,
      volleyballScoringRatingMap || ratingMap,
      options,
      updateVolleyballOptions,
      volleyballScoringPairAdjustmentMap
    ) ?? openSkillWinnerProbability,
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

function getMarginSensitiveFinalUpdateMax(pointDiff, volleyballCfg = {}) {
  if (!Number.isFinite(pointDiff)) {
    return volleyballCfg.finalUpdateMultiplierMax;
  }

  if (pointDiff <= 1) return 1.00;
  if (pointDiff === 2) return 1.05;
  if (pointDiff <= 3) return 1.10;
  if (pointDiff <= 5) return 1.20;
  if (pointDiff <= 8) return 1.40;
  return volleyballCfg.finalUpdateMultiplierMax;
}

function getNonNegativeOption(value, fallback = 1) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
}

export function getEvidenceWeight({
  game,
  redIds = [],
  blueIds = [],
  redTeam = [],
  blueTeam = [],
  ratingMap = {},
  options = {},
  volleyballAdjusted = false,
  volleyballOptions = {},
  volleyballScoringRatingMap = null,
  volleyballScoringPairAdjustmentMap = null,
  marginDetails = null,
  seasonalWeight = 1,
} = {}) {
  const cfg = mergeRatingOptions(options);
  const vbCfg = mergeVolleyballBalanceOptions(volleyballOptions);
  const resolvedMarginDetails = marginDetails || getScoreMarginDetails(
    game?.scoreRed,
    game?.scoreBlue,
    cfg
  );
  const marginFactor = resolvedMarginDetails.marginFactor;

  const adjustment = volleyballAdjusted
    ? getVolleyballUpdateMultiplier({
        game,
        redTeam,
        blueTeam,
        ratingMap,
        options: cfg,
        volleyballOptions,
        volleyballScoringRatingMap,
        volleyballScoringPairAdjustmentMap,
      })
    : {
        multiplier: 1,
        openSkillWinnerProbability: null,
        volleyballWinnerProbability: null,
      };

  // Cap the volatility core (margin x surprise) before applying seasonal weight,
  // so seasonal taper of old games is preserved. Normal volleyball margins are
  // noisy, so keep ordinary single-game results from receiving blowout-level movement.
  const marginSensitiveMax = getMarginSensitiveFinalUpdateMax(
    resolvedMarginDetails.pointDiff,
    vbCfg
  );
  const volleyballUpdateMultiplier = adjustment.multiplier;
  const volatilityMultiplier = marginFactor * volleyballUpdateMultiplier;
  const cappedVolatility = clamp(
    volatilityMultiplier,
    vbCfg.finalUpdateMultiplierMin,
    Math.min(vbCfg.finalUpdateMultiplierMax, marginSensitiveMax)
  );
  const isLeagueGame = Boolean(game?.isLeagueGame);
  const leagueUpdateMultiplier = isLeagueGame
    ? Math.max(1, getNonNegativeOption(cfg.leagueUpdateMultiplier, 1))
    : 1;
  const effectiveVolatility = isLeagueGame
    ? Math.max(1, cappedVolatility)
    : cappedVolatility;
  const evidenceWeight = effectiveVolatility * leagueUpdateMultiplier;

  // Per-team size damping: players on teams larger than 6 have less individual impact
  // per game (more rotations, fewer touches). Damper = 6 / teamSize for teams > 6.
  const redSizeDamper = LEAGUE_TEAM_SIZE / Math.max(LEAGUE_TEAM_SIZE, redIds.length);
  const blueSizeDamper = LEAGUE_TEAM_SIZE / Math.max(LEAGUE_TEAM_SIZE, blueIds.length);
  const redFinalMultiplier = evidenceWeight * seasonalWeight * redSizeDamper;
  const leagueOpponentUpdateMultiplier = game?.isLeagueGame
    ? getNonNegativeOption(cfg.leagueOpponentUpdateMultiplier, 1)
    : 1;
  const leagueOpponentSeasonalWeight = game?.isLeagueGame && cfg.leagueOpponentSeasonalTaperEnabled === false
    ? 1
    : seasonalWeight;
  const blueFinalMultiplier = evidenceWeight *
    leagueOpponentSeasonalWeight *
    blueSizeDamper *
    leagueOpponentUpdateMultiplier;
  // Keep finalUpdateMultiplier as the base (pre-size-damping) for display purposes.
  const finalUpdateMultiplier = evidenceWeight * seasonalWeight;

  return {
    marginFactor,
    marginSensitiveMax,
    volleyballUpdateMultiplier,
    volatilityMultiplier,
    cappedVolatility,
    effectiveVolatility,
    leagueUpdateMultiplier,
    evidenceWeight,
    baseUpdateMultiplier: evidenceWeight,
    seasonalWeight,
    redSizeDamper,
    blueSizeDamper,
    leagueOpponentUpdateMultiplier,
    leagueOpponentSeasonalWeight,
    redFinalMultiplier,
    blueFinalMultiplier,
    finalUpdateMultiplier,
    openSkillWinnerProbability: adjustment.openSkillWinnerProbability,
    volleyballWinnerProbability: adjustment.volleyballWinnerProbability,
  };
}

export function rateSingleGame(game, ratingMap, options = {}) {
  const cfg = mergeRatingOptions(options);
  const volleyballAdjusted = Boolean(options?.volleyballAdjusted);
  const volleyballOptions = options?.volleyballOptions || {};
  const volleyballScoringRatingMap = options?.volleyballScoringRatingMap || null;
  const volleyballScoringPairAdjustmentMap = options?.volleyballScoringPairAdjustmentMap || null;
  const useMatchedLeagueOpponent = Boolean(
    game?.isLeagueGame && isMatchedLeagueOpponentModel(cfg)
  );
  const matchedLeagueRawOffset = useMatchedLeagueOpponent
    ? getLeagueMatchedRawOffset(game, cfg)
    : 0;

  ensureRatingsForGame(ratingMap, game, cfg);

  const redIds = getRedTeamIds(game);
  const blueIds = getBlueTeamIds(game, cfg);

  const redBefore = redIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getRawOrdinal(ratingMap[id], cfg),
  }));

  const redTeam = buildTeamObjectsFromIds(redIds, ratingMap);
  const blueTeam = useMatchedLeagueOpponent
    ? getShiftedMatchedLeagueTeam(redTeam, matchedLeagueRawOffset, cfg)
    : buildTeamObjectsFromIds(blueIds, ratingMap);

  const blueBefore = blueIds.map((id, index) => {
    const skill = useMatchedLeagueOpponent
      ? blueTeam[index] ?? makeInitialRating(cfg)
      : ratingMap[id];
    return {
      id,
      mu: Number(skill.mu),
      sigma: Number(skill.sigma),
      rating: getRawOrdinal(skill, cfg),
    };
  });

  const marginDetails = getScoreMarginDetails(
    game?.scoreRed,
    game?.scoreBlue,
    cfg
  );

  const marginFactor = marginDetails.marginFactor;

  const seasonalWeight =
    typeof cfg.seasonalWeight === 'number' ? cfg.seasonalWeight : 1;

  const evidence = getEvidenceWeight({
    game,
    redIds,
    blueIds,
    redTeam,
    blueTeam,
    ratingMap,
    options: cfg,
    volleyballAdjusted,
    volleyballOptions,
    volleyballScoringRatingMap,
    volleyballScoringPairAdjustmentMap,
    marginDetails,
    seasonalWeight,
  });

  const [updatedRedTeam, updatedBlueTeam] = rate(
    [redTeam, blueTeam],
    getOpenSkillRateOptions(game, cfg)
  );
  const leagueMuUpdateMultiplier = game?.isLeagueGame
    ? getNonNegativeOption(cfg.leagueMuUpdateMultiplier, 1)
    : 1;
  const leagueSigmaUpdateMultiplier = game?.isLeagueGame
    ? getNonNegativeOption(cfg.leagueSigmaUpdateMultiplier, 1)
    : 1;

  applyUpdateMultiplier({
    ids: redIds,
    beforeEntries: redBefore,
    updatedTeam: updatedRedTeam,
    ratingMap,
    multiplier: getEvidenceModeMultiplier(evidence, cfg.openSkillEvidenceMultiplierMode, 'red'),
    muMultiplier: leagueMuUpdateMultiplier,
    sigmaMultiplier: leagueSigmaUpdateMultiplier,
    options: cfg,
  });

  if (!useMatchedLeagueOpponent) {
    applyUpdateMultiplier({
      ids: blueIds,
      beforeEntries: blueBefore,
      updatedTeam: updatedBlueTeam,
      ratingMap,
      multiplier: getEvidenceModeMultiplier(evidence, cfg.openSkillEvidenceMultiplierMode, 'blue'),
      muMultiplier: leagueMuUpdateMultiplier,
      sigmaMultiplier: leagueSigmaUpdateMultiplier,
      options: cfg,
    });
  }

  const redAfter = redIds.map(id => ({
    id,
    mu: Number(ratingMap[id].mu),
    sigma: Number(ratingMap[id].sigma),
    rating: getRawOrdinal(ratingMap[id], cfg),
  }));

  const blueAfter = blueIds.map((id, index) => {
    if (useMatchedLeagueOpponent) {
      const before = blueBefore[index] || {
        mu: cfg.mu,
        sigma: cfg.sigma,
        rating: getRawOrdinal(makeInitialRating(cfg), cfg),
      };
      const after = updatedBlueTeam[index] || before;
      const multiplier = getEvidenceModeMultiplier(
        evidence,
        cfg.openSkillEvidenceMultiplierMode,
        'blue'
      );
      const mu = before.mu + (Number(after.mu) - before.mu) * multiplier * leagueMuUpdateMultiplier;
      const sigma = clamp(
        before.sigma + (Number(after.sigma) - before.sigma) * multiplier * leagueSigmaUpdateMultiplier,
        1,
        cfg.sigma
      );
      const skill = rating({ mu, sigma });
      return {
        id,
        mu,
        sigma,
        rating: getRawOrdinal(skill, cfg),
      };
    }

    return {
      id,
      mu: Number(ratingMap[id].mu),
      sigma: Number(ratingMap[id].sigma),
      rating: getRawOrdinal(ratingMap[id], cfg),
    };
  });

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
    redSizeDamper: evidence.redSizeDamper,
    blueSizeDamper: evidence.blueSizeDamper,
    redFinalMultiplier: evidence.redFinalMultiplier,
    blueFinalMultiplier: evidence.blueFinalMultiplier,
    volleyballAdjusted,
    volleyballUpdateMultiplier: evidence.volleyballUpdateMultiplier,
    evidenceWeight: evidence.evidenceWeight,
    finalUpdateMultiplier: evidence.finalUpdateMultiplier,
    openSkillWinnerProbability: evidence.openSkillWinnerProbability,
    volleyballWinnerProbability: evidence.volleyballWinnerProbability,
    leagueOpponentModel: useMatchedLeagueOpponent ? cfg.leagueOpponentModel : 'synthetic',
    leagueMatchedRawOffset: matchedLeagueRawOffset,
    leagueContext: game?.isLeagueGame ? cloneSimple(getLeagueRatingContext(game, cfg)) : null,
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
  const memberIds = getLeagueTeamMemberIdsForContext(
    context,
    getLeagueTeamMemberCountForContext(context, includedGames)
  );
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
    if (gameMatchesLeagueContext(game, context)) {
      leagueTeam.games += 1;
      if (game.winner === 'blue') leagueTeam.wins += 1;
    }
  });

  leagueTeam.winrate = leagueTeam.games > 0 ? leagueTeam.wins / leagueTeam.games : 0.5;
  leagueTeam.leaderboardRawOrdinal = getLeagueLeaderboardRawOrdinal(leagueTeam.rawOrdinal);
  leagueTeam.leaderboardRating = toDisplayRating(leagueTeam.leaderboardRawOrdinal);
  leagueTeam.rating = leagueTeam.leaderboardRawOrdinal;

  return leagueTeam;
}

function hashLeagueDisplayGames(gamesList) {
  return (Array.isArray(gamesList) ? gamesList : []).reduce((hash, game, index) => {
    const id = Number(game?.id ?? game?.createdAt ?? index) || index;
    return (Math.imul(hash ^ id, 16777619) >>> 0);
  }, 2166136261);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledCopy(values, random) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function getLeagueSlotShuffleSchedule(sortedGames, seed) {
  const leagueSlots = sortedGames
    .map((game, index) => ({ game, index }))
    .filter(entry => entry.game?.isLeagueGame);

  if (leagueSlots.length <= 1) return sortedGames;

  const shuffledLeagueGames = shuffledCopy(
    leagueSlots.map(entry => entry.game),
    seededRandom(seed)
  );

  const scheduled = sortedGames.map((game, index) => ({ ...game, createdAt: index }));
  leagueSlots.forEach((slot, index) => {
    scheduled[slot.index] = {
      ...shuffledLeagueGames[index],
      date: slot.game.date,
      createdAt: slot.index,
    };
  });

  return scheduled;
}

function replayRatingMapForLeagueDisplay({
  players = [],
  sortedGames = [],
  cfg,
  seasonal = false,
  volleyballAdjusted = false,
  volleyballOptions = {},
}) {
  const ratingMap = {};
  const statsMap = {};
  const leagueOpponentStatsMap = {};
  const history = [];
  const leagueSessionFreezeMap = cfg.leagueSessionFreezeEnabled ? new Map() : null;
  const leagueBayesianPosteriorMap = cfg.leaguePregameBayesianMode === 'incrementalGrid' ? new Map() : null;
  const referenceDate = seasonal ? getMostRecentGameDate(sortedGames) : null;
  const seasonalTaperDays =
    typeof cfg.seasonalTaperDays === 'number'
      ? cfg.seasonalTaperDays
      : SEASONAL_TAPER_DAYS;

  players.forEach(player => {
    ratingMap[player.id] = makeInitialRating(cfg);
    statsMap[player.id] = { games: 0 };
  });

  sortedGames.forEach(game => {
    const seasonalWeight = seasonal
      ? getSeasonalWeight(game?.date, referenceDate, seasonalTaperDays)
      : 1;

    const pregameBayesianLeagueRaw = seedPregameBayesianLeagueOpponent(
      game,
      ratingMap,
      history,
      cfg,
      leagueBayesianPosteriorMap
    );
    applyPregameLeagueOpponentAdjustment(game, ratingMap, leagueOpponentStatsMap, cfg);
    const leagueSessionFreeze = applyLeagueSessionPregameFreeze(game, ratingMap, leagueSessionFreezeMap, cfg);
    const historyEntry = rateSingleGame(game, ratingMap, {
      ...cfg,
      seasonalWeight,
      volleyballAdjusted,
      volleyballOptions,
    });
    if (Number.isFinite(pregameBayesianLeagueRaw)) {
      historyEntry.pregameBayesianLeagueRaw = pregameBayesianLeagueRaw;
    }
    history.push(historyEntry);
    updateIncrementalBayesianLeaguePosterior(historyEntry, leagueBayesianPosteriorMap, cfg);

    const burnInGames = Number(cfg.burnInGames) || 0;
    const burnInMult = Number(cfg.burnInMultiplier) || 1;
    const leagueBurnInGames = Number(cfg.leagueOpponentBurnInGames) || 0;
    const leagueBurnInMult = Number(cfg.leagueOpponentBurnInMultiplier) || 1;

    if ((burnInGames > 0 && burnInMult > 1) || (leagueBurnInGames > 0 && leagueBurnInMult > 1)) {
      [...historyEntry.before.red, ...historyEntry.before.blue].forEach((before, index) => {
        const after = [...historyEntry.after.red, ...historyEntry.after.blue][index];
        if (!after) return;

        const id = String(before.id);
        const isLeagueOpponent = isSyntheticLeagueMemberId(id);
        const gamesLimit = isLeagueOpponent ? leagueBurnInGames : burnInGames;
        const multiplier = isLeagueOpponent ? leagueBurnInMult : burnInMult;
        const gamesPlayed = isLeagueOpponent
          ? leagueOpponentStatsMap[id]?.games ?? 0
          : statsMap[id]?.games ?? 0;

        if (gamesLimit > 0 && multiplier > 1 && gamesPlayed < gamesLimit) {
          ratingMap[before.id] = rating({
            mu: before.mu + (after.mu - before.mu) * multiplier,
            sigma: clamp(before.sigma + (after.sigma - before.sigma) * multiplier, 1, cfg.sigma),
          });
        }
      });
    }

    finalizeLeagueSessionFreeze(leagueSessionFreeze, historyEntry, ratingMap, cfg);

    (Array.isArray(game.redTeam) ? game.redTeam : []).forEach(player => {
      if (!statsMap[player.id]) statsMap[player.id] = { games: 0 };
      statsMap[player.id].games += 1;
    });

    if (!game.isLeagueGame) {
      (Array.isArray(game.blueTeam) ? game.blueTeam : []).forEach(player => {
        if (!statsMap[player.id]) statsMap[player.id] = { games: 0 };
        statsMap[player.id].games += 1;
      });
    } else {
      getBlueTeamIds(game, cfg).forEach(id => {
        if (!leagueOpponentStatsMap[id]) leagueOpponentStatsMap[id] = { games: 0 };
        leagueOpponentStatsMap[id].games += 1;
      });
    }
  });

  return ratingMap;
}

function getLeagueSkillFromRatingMap(context, ratingMap, cfg) {
  const memberIds = getLeagueTeamMemberIdsForContext(context, LEAGUE_TEAM_MEMBER_COUNT);
  const members = memberIds.map(id => ratingMap[id] ?? makeInitialRating(cfg));
  return {
    mu: members.reduce((sum, skill) => sum + Number(skill.mu), 0) / members.length,
    sigma: members.reduce((sum, skill) => sum + Number(skill.sigma), 0) / members.length,
  };
}

function applyShuffledPooledLeagueDisplay({
  leagueTeam,
  context,
  players,
  includedGames,
  cfg,
  seasonal,
  volleyballAdjusted,
  volleyballOptions,
}) {
  if (
    !leagueTeam ||
    context?.key !== POOLED_LEAGUE_CONTEXT.key ||
    cfg.leagueDisplayEstimateEnabled !== true ||
    cfg.leagueDisplayRatingMode !== 'shuffledPooled'
  ) {
    return leagueTeam;
  }

  const sortedGames = aggregateLeagueSeriesGames(
    getGamesSortedOldestFirst(includedGames),
    cfg
  );
  const leagueGameCount = sortedGames.filter(game => game?.isLeagueGame).length;
  const iterations = Math.max(1, Math.min(250, Math.round(Number(cfg.leagueDisplayShuffleIterations) || 1)));

  if (leagueGameCount <= 1 || iterations <= 1) return leagueTeam;

  const baseSeed = hashLeagueDisplayGames(sortedGames);
  let totalMu = 0;
  let totalSigma = 0;
  let samples = 0;

  for (let i = 0; i < iterations; i += 1) {
    const schedule = getLeagueSlotShuffleSchedule(sortedGames, baseSeed + i * 2654435761);
    const shuffledRatingMap = replayRatingMapForLeagueDisplay({
      players,
      sortedGames: schedule,
      cfg,
      seasonal,
      volleyballAdjusted,
      volleyballOptions,
    });
    const skill = getLeagueSkillFromRatingMap(context, shuffledRatingMap, cfg);
    totalMu += Number(skill.mu);
    totalSigma += Number(skill.sigma);
    samples += 1;
  }

  if (!samples) return leagueTeam;

  const displaySkill = {
    mu: totalMu / samples,
    sigma: totalSigma / samples,
  };
  const rawOrdinal = getRawOrdinal(displaySkill, cfg);
  const leaderboardRawOrdinal = getLeagueLeaderboardRawOrdinal(rawOrdinal);

  return {
    ...leagueTeam,
    rawOrdinal,
    displayRating: toDisplayRating(rawOrdinal),
    leaderboardRawOrdinal,
    leaderboardRating: toDisplayRating(leaderboardRawOrdinal),
    rating: leaderboardRawOrdinal,
    mu: Number(displaySkill.mu),
    sigma: Number(displaySkill.sigma),
    displayEstimateMode: 'shuffledPooled',
    displayEstimateIterations: samples,
  };
}

function getLeagueDisplaySyntheticPlayers(raw, count = LEAGUE_TEAM_SIZE) {
  const safeCount = Math.max(1, Number(count) || LEAGUE_TEAM_SIZE);
  return Array.from({ length: safeCount }, (_, index) => ({
    id: `__league_display_${index + 1}`,
    name: `League Display ${index + 1}`,
    raw,
  }));
}

function getHistoryRedWinProbabilityForLeagueRaw(entry, raw, cfg) {
  const game = entry?.game || {};
  const redPlayers = Array.isArray(game.redTeam) ? game.redTeam : [];
  const redBefore = Array.isArray(entry?.before?.red) ? entry.before.red : [];
  const leaguePlayers = getLeagueDisplaySyntheticPlayers(
    raw,
    redPlayers.length || game?.leagueOpponent?.size || LEAGUE_TEAM_SIZE
  );
  const ratingMap = {};

  redBefore.forEach(player => {
    ratingMap[player.id] = {
      mu: Number(player.mu),
      sigma: Number(player.sigma),
    };
  });

  leaguePlayers.forEach(player => {
    ratingMap[player.id] = {
      mu: Number(raw) + cfg.ordinalSigmaMultiplier,
      sigma: 1,
    };
  });

  const score = scoreVolleyballCandidateSplit({
    redPlayers,
    bluePlayers: leaguePlayers,
    ratingMap,
    options: cfg,
    ignoreSizeAdjustment: true,
  });

  return score.redWinProbability;
}

function getLogSumExp(values) {
  const max = Math.max(...values);
  if (!Number.isFinite(max)) return max;
  return max + Math.log(values.reduce((sum, value) => sum + Math.exp(value - max), 0));
}

function getLeagueBayesianGrid(cfg) {
  const step = Math.max(0.02, Math.min(1, Number(cfg.leagueBayesianGridStep) || 0.1));
  const grid = [];

  for (let raw = -12; raw <= 12.0001; raw += step) {
    grid.push(Number(raw.toFixed(4)));
  }

  return grid;
}

function getLeagueBayesianPriorLogPosterior(grid, cfg) {
  const priorSd = Math.max(0.1, Number(cfg.leagueBayesianPriorSd) || 4);
  return grid.map(raw => -0.5 * (raw / priorSd) ** 2);
}

function getLeagueBayesianPosteriorMean(grid, logPosterior) {
  const normalizer = getLogSumExp(logPosterior);
  if (!Number.isFinite(normalizer)) return null;

  return grid.reduce((sum, raw, index) =>
    sum + raw * Math.exp(logPosterior[index] - normalizer),
    0
  );
}

function getBayesianLeagueRawFromHistory({ context, history, cfg }) {
  const observations = (Array.isArray(history) ? history : [])
    .filter(entry => gameMatchesLeagueContext(entry?.game, context));

  if (!observations.length) return null;

  const grid = getLeagueBayesianGrid(cfg);
  const logPosterior = grid.map(raw => {
    let logp = getLeagueBayesianPriorLogPosterior([raw], cfg)[0];

    observations.forEach(entry => {
      const pRed = clamp(
        getHistoryRedWinProbabilityForLeagueRaw(entry, raw, cfg),
        0.001,
        0.999
      );
      const yRed = entry?.game?.winner === 'red' ? 1 : 0;
      logp += yRed ? Math.log(pRed) : Math.log(1 - pRed);
    });

    return logp;
  });

  return getLeagueBayesianPosteriorMean(grid, logPosterior);
}

function getIncrementalBayesianState(context, posteriorMap, cfg) {
  if (!posteriorMap || !context?.id) return null;
  const key = String(context.id);
  let state = posteriorMap.get(key);

  if (!state) {
    const grid = getLeagueBayesianGrid(cfg);
    state = {
      grid,
      logPosterior: getLeagueBayesianPriorLogPosterior(grid, cfg),
      observations: 0,
      rawOrdinal: null,
    };
    posteriorMap.set(key, state);
  }

  return state;
}

function getIncrementalBayesianLeagueRaw({ context, posteriorMap, cfg }) {
  const state = getIncrementalBayesianState(context, posteriorMap, cfg);
  if (!state || state.observations <= 0) return null;
  if (Number.isFinite(state.rawOrdinal)) return state.rawOrdinal;
  state.rawOrdinal = getLeagueBayesianPosteriorMean(state.grid, state.logPosterior);
  return state.rawOrdinal;
}

function updateIncrementalBayesianLeaguePosterior(entry, posteriorMap, cfg) {
  if (
    cfg.leaguePregameBayesianEnabled !== true ||
    cfg.leaguePregameBayesianMode !== 'incrementalGrid' ||
    !entry?.game?.isLeagueGame
  ) {
    return null;
  }

  const context = getLeagueRatingContext(entry.game, cfg);
  const state = getIncrementalBayesianState(context, posteriorMap, cfg);
  if (!state) return null;

  const yRed = entry.game.winner === 'red' ? 1 : 0;
  state.logPosterior = state.logPosterior.map((logp, index) => {
    const pRed = clamp(
      getHistoryRedWinProbabilityForLeagueRaw(entry, state.grid[index], cfg),
      0.001,
      0.999
    );
    return logp + (yRed ? Math.log(pRed) : Math.log(1 - pRed));
  });
  state.observations += 1;
  state.rawOrdinal = getLeagueBayesianPosteriorMean(state.grid, state.logPosterior);
  return state.rawOrdinal;
}

function applyBayesianLeagueDisplay({ leagueTeam, context, history, cfg, posteriorMap = null }) {
  if (
    !leagueTeam ||
    cfg.leagueDisplayEstimateEnabled !== true ||
    cfg.leagueDisplayRatingMode !== 'bayesian'
  ) {
    return leagueTeam;
  }

  const rawOrdinal = cfg.leaguePregameBayesianMode === 'incrementalGrid'
    ? getIncrementalBayesianLeagueRaw({ context, posteriorMap, cfg })
    : getBayesianLeagueRawFromHistory({ context, history, cfg });
  if (!Number.isFinite(rawOrdinal)) return leagueTeam;

  const leaderboardRawOrdinal = getLeagueLeaderboardRawOrdinal(rawOrdinal);

  return {
    ...leagueTeam,
    rawOrdinal,
    displayRating: toDisplayRating(rawOrdinal),
    leaderboardRawOrdinal,
    leaderboardRating: toDisplayRating(leaderboardRawOrdinal),
    rating: leaderboardRawOrdinal,
    displayEstimateMode: 'bayesian',
  };
}

export function replayRatings({
  players = [],
  games = [],
  options = {},
  seasonal = false,
  volleyballAdjusted = false,
  volleyballOptions = {},
  volleyballUpdateUsesBalancerContext = true,
  volleyballUpdateContextMode = 'pair',
  includeLeagueGames = true,
  _calibratedStarts = null,
} = {}) {
  const cfg = mergeRatingOptions(options);
  const ratingMap = {};
  const statsMap = {};
  const history = [];
  const carryMap = {};
  const includedGames = getIncludedGames(games, includeLeagueGames, cfg);
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

  const sortedGames = aggregateLeagueSeriesGames(
    getGamesSortedOldestFirst(includedGames),
    cfg
  );
  const referenceDate = seasonal ? getMostRecentGameDate(sortedGames) : null;
  const leagueOpponentStatsMap = {};
  const updateContextMode = volleyballUpdateUsesBalancerContext
    ? (volleyballUpdateContextMode || 'pair')
    : 'off';
  const updateContextUsesEnvironment = updateContextMode === 'full' || updateContextMode === 'silo';
  const updateContextUsesPair = updateContextMode === 'full' || updateContextMode === 'pair';
  const updatePairContextMap = volleyballAdjusted && updateContextUsesPair ? new Map() : null;
  const priorGamesForUpdateContext = [];
  const streakRecentDeltaMap = cfg.streakProtectionEnabled ? new Map() : null;
  const streakRecentEntryMap = cfg.streakProtectionEnabled ? new Map() : null;
  const sessionDeltaMap = cfg.sessionProtectionEnabled ? new Map() : null;
  const leagueSessionFreezeMap = cfg.leagueSessionFreezeEnabled ? new Map() : null;
  const leagueDayMatchedOffsetRawMap = cfg.leagueOpponentModel === 'dayMatchedOffset' ? new Map() : null;
  const leagueBayesianPosteriorMap = cfg.leaguePregameBayesianMode === 'incrementalGrid' ? new Map() : null;

  sortedGames.forEach(game => {
    const seasonalWeight = seasonal
      ? getSeasonalWeight(game?.date, referenceDate, seasonalTaperDays)
      : 1;

    ensureLeagueDayMatchedOffset({
      game,
      sortedGames,
      ratingMap,
      offsetMap: leagueDayMatchedOffsetRawMap,
      cfg,
    });
    const pregameBayesianLeagueRaw = seedPregameBayesianLeagueOpponent(
      game,
      ratingMap,
      history,
      cfg,
      leagueBayesianPosteriorMap
    );
    applyPregameLeagueOpponentAdjustment(game, ratingMap, leagueOpponentStatsMap, cfg);
    const leagueSessionFreeze = applyLeagueSessionPregameFreeze(game, ratingMap, leagueSessionFreezeMap, cfg);
    let volleyballScoringRatingMap = null;
    let volleyballScoringPairAdjustmentMap = null;

    if (volleyballAdjusted && updateContextUsesEnvironment) {
      const adjustedRatingMap = buildEnvironmentAdjustedRatingMap({
        players,
        games: priorGamesForUpdateContext,
        baseRatingMap: ratingMap,
        ratingOptions: cfg,
        volleyballOptions,
        teamCount: 2,
        playerCount: getScoreboardSideSize(game, 'red') + getScoreboardSideSize(game, 'blue'),
        targetSilo: getEnvironmentSiloForGame(game),
      });
      volleyballScoringRatingMap = {
        ...ratingMap,
        ...adjustedRatingMap,
      };
    }
    if (volleyballAdjusted && updateContextUsesPair) {
      volleyballScoringPairAdjustmentMap = new Map(updatePairContextMap);
      learnPairAdjustmentFromGame({
        pairMap: updatePairContextMap,
        game,
        ratingMap,
        ratingOptions: cfg,
        volleyballOptions,
      });
    }

    const historyEntry = rateSingleGame(game, ratingMap, {
      ...cfg,
      _leagueDayMatchedOffsetRawMap: leagueDayMatchedOffsetRawMap,
      seasonalWeight,
      volleyballAdjusted,
      volleyballOptions,
      volleyballScoringRatingMap,
      volleyballScoringPairAdjustmentMap,
    });
    if (Number.isFinite(pregameBayesianLeagueRaw)) {
      historyEntry.pregameBayesianLeagueRaw = pregameBayesianLeagueRaw;
    }

    history.push(historyEntry);
    updateIncrementalBayesianLeaguePosterior(historyEntry, leagueBayesianPosteriorMap, cfg);
    priorGamesForUpdateContext.push(game);

    // Burn-in: players in their first N games get a scaled-up update so they
    // reach their true rating faster. statsMap.games is the pre-game count here.
    const burnInGames = Number(cfg.burnInGames) || 0;
    const burnInMult = Number(cfg.burnInMultiplier) || 1;
    const leagueBurnInGames = Number(cfg.leagueOpponentBurnInGames) || 0;
    const leagueBurnInMult = Number(cfg.leagueOpponentBurnInMultiplier) || 1;
    if (
      _calibratedStarts === null &&
      ((burnInGames > 0 && burnInMult > 1) || (leagueBurnInGames > 0 && leagueBurnInMult > 1))
    ) {
      const applyBurnIn = (beforeEntries, afterEntries) => {
        beforeEntries.forEach((before, i) => {
          const id = String(before.id);
          const isLeagueOpponent = isSyntheticLeagueMemberId(id);
          const gamesLimit = isLeagueOpponent ? leagueBurnInGames : burnInGames;
          const multiplier = isLeagueOpponent ? leagueBurnInMult : burnInMult;
          const gamesPlayed = isLeagueOpponent
            ? leagueOpponentStatsMap[id]?.games ?? 0
            : statsMap[id]?.games ?? 0;

          if (gamesLimit > 0 && multiplier > 1 && gamesPlayed < gamesLimit) {
            const after = afterEntries[i];
            const newMu = before.mu + (after.mu - before.mu) * multiplier;
            const newSigma = clamp(
              before.sigma + (after.sigma - before.sigma) * multiplier,
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

    finalizeLeagueSessionFreeze(leagueSessionFreeze, historyEntry, ratingMap, cfg);

    // Pass 2: freeze calibrated players within their calibration window.
    // Their calibrated seed was used as input so opponents get correctly re-rated,
    // but we restore it afterward so the calibrated player doesn't accumulate
    // double credit from replaying early games on top of the corrected start.
    // Pre-game statsMap.games < calibrationGames means this is one of their
    // first calibrationGames games (the window where they were seeded incorrectly
    // in pass 1 and are now being corrected for opponents' benefit only).
    if (_calibratedStarts !== null) {
      const calibrationGamesLimit = Number(cfg.calibrationGames) || 0;
      [...getRedTeamIds(game), ...getBlueTeamIds(game, cfg)].forEach(id => {
        const cal = _calibratedStarts[id];
        if (cal && (statsMap[id]?.games ?? 0) < calibrationGamesLimit) {
          const calibratedSkill = rating({ mu: Number(cal.mu), sigma: Number(cal.sigma) });
          ratingMap[id] = calibratedSkill;
          syncRatingEntry(historyEntry.after.red, id, calibratedSkill, cfg);
          syncRatingEntry(historyEntry.after.blue, id, calibratedSkill, cfg);
        }
      });
    }

    applyStreakProtectionForEntry({
      historyEntry,
      ratingMap,
      statsMap,
      recentDeltaMap: streakRecentDeltaMap,
      recentEntryMap: streakRecentEntryMap,
      cfg,
      volleyballOptions,
    });

    applySessionProtectionForEntry({
      historyEntry,
      ratingMap,
      statsMap,
      sessionDeltaMap,
      cfg,
    });

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
    } else {
      getBlueTeamIds(game, cfg).forEach(id => {
        if (!leagueOpponentStatsMap[id]) {
          leagueOpponentStatsMap[id] = { games: 0 };
        }
        leagueOpponentStatsMap[id].games += 1;
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

        // Legacy linear display rating without leaderboard confidence correction.
        displayRating: toDisplayRating(rawOrdinal),

        // Legacy linear leaderboard display rating.
        leaderboardRawOrdinal,
        leaderboardRating: toDisplayRating(leaderboardRawOrdinal),

        // Backward-compatible alias. Keep this raw; public rating display
        // happens at UI boundaries via the public display scale.
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

  const leagueTeams = getLeagueTeamContextsForMode(cfg).map(context =>
    applyBayesianLeagueDisplay({
      leagueTeam: applyShuffledPooledLeagueDisplay({
        leagueTeam: buildLeagueTeamFromContext(context, ratingMap, cfg, includedGames),
        context,
        players,
        includedGames,
        cfg,
        seasonal,
        volleyballAdjusted,
        volleyballOptions,
      }),
      context,
      history,
      cfg,
      posteriorMap: leagueBayesianPosteriorMap,
    })
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
    evidenceWeight: result.evidenceWeight,
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
    leagueSeriesGames: Array.isArray(game.leagueSeriesGames) ? cloneSimple(game.leagueSeriesGames) : null,
  };
}

function getLeagueSeriesTimelineWeights(row) {
  const seriesGames = Array.isArray(row?.leagueSeriesGames)
    ? row.leagueSeriesGames
    : [];

  if (seriesGames.length <= 1) return [];

  const aggregateDelta = Number(row.ratingAfter) - Number(row.ratingBefore);
  const aggregateDirection = aggregateDelta < 0 ? -1 : 1;
  const relativeWeights = seriesGames.map(game => {
    const pointDiff = Number.isFinite(Number(game?.scoreRed)) && Number.isFinite(Number(game?.scoreBlue))
      ? Math.abs(Number(game.scoreRed) - Number(game.scoreBlue))
      : 0;
    const magnitude = Math.max(1, 1 + Math.min(pointDiff, 12) / 40);
    const redResultSign = game?.winner === 'blue' ? -1 : 1;
    return redResultSign * aggregateDirection * magnitude;
  });

  const positiveWeights = relativeWeights.filter(value => value > 0);
  const negativeWeights = relativeWeights.filter(value => value < 0);

  if (positiveWeights.length && negativeWeights.length) {
    const positiveTotal = positiveWeights.reduce((sum, value) => sum + value, 0);
    const negativeTotal = negativeWeights.reduce((sum, value) => sum + Math.abs(value), 0);
    const targetPositiveTotal = 1 + negativeTotal;
    return relativeWeights.map(value => {
      if (value > 0) return (value / positiveTotal) * targetPositiveTotal;
      return value;
    });
  }

  const absoluteWeights = relativeWeights.map(value => Math.abs(value));
  const total = absoluteWeights.reduce((sum, value) => sum + value, 0) || absoluteWeights.length || 1;
  return absoluteWeights.map(value => value / total);
}

function interpolateTimelineValue(before, after, fraction) {
  const start = Number(before);
  const end = Number(after);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return before;
  return start + (end - start) * fraction;
}

function interpolateLeagueSeriesTimelineRow(row, game, startFraction, endFraction, index, count, weight) {
  const ratingBefore = interpolateTimelineValue(row.ratingBefore, row.ratingAfter, startFraction);
  const ratingAfter = interpolateTimelineValue(row.ratingBefore, row.ratingAfter, endFraction);
  const muBefore = interpolateTimelineValue(row.muBefore, row.muAfter, startFraction);
  const muAfter = interpolateTimelineValue(row.muBefore, row.muAfter, endFraction);
  const sigmaBefore = interpolateTimelineValue(row.sigmaBefore, row.sigmaAfter, startFraction);
  const sigmaAfter = interpolateTimelineValue(row.sigmaBefore, row.sigmaAfter, endFraction);

  return {
    ...row,
    gameId: game.id,
    date: game.date || row.date,
    winner: game.winner,
    won: row.side === 'blue' ? game.winner === 'blue' : game.winner === 'red',
    displayWinnerColor: game.displayWinnerColor || null,
    displayLoserColor: game.displayLoserColor || null,
    scoreRed: typeof game.scoreRed === 'undefined' ? null : game.scoreRed,
    scoreBlue: typeof game.scoreBlue === 'undefined' ? null : game.scoreBlue,
    redTeam: Array.isArray(game.redTeam) ? cloneSimple(game.redTeam) : row.redTeam,
    blueTeam: Array.isArray(game.blueTeam) ? cloneSimple(game.blueTeam) : row.blueTeam,
    leagueOpponent: game.leagueOpponent ? cloneSimple(game.leagueOpponent) : row.leagueOpponent,
    ratingBefore,
    ratingAfter,
    displayRatingBefore: toDisplayRating(ratingBefore),
    displayRatingAfter: toDisplayRating(ratingAfter),
    muBefore,
    muAfter,
    sigmaBefore,
    sigmaAfter,
    leagueSeriesDisplayIndex: index + 1,
    leagueSeriesDisplayCount: count,
    leagueSeriesDisplayWeight: weight,
  };
}

function expandLeagueSeriesTimeline(timeline) {
  return (timeline || []).flatMap(row => {
    const seriesGames = Array.isArray(row?.leagueSeriesGames)
      ? row.leagueSeriesGames
      : [];

    if (!row?.isLeagueGame || seriesGames.length <= 1) return [row];

    const weights = getLeagueSeriesTimelineWeights(row);
    if (weights.length !== seriesGames.length) return [row];

    let cursor = 0;
    return seriesGames.map((game, index) => {
      const startFraction = cursor;
      cursor += weights[index];
      const endFraction = index === seriesGames.length - 1 ? 1 : cursor;
      return interpolateLeagueSeriesTimelineRow(
        row,
        game,
        startFraction,
        endFraction,
        index,
        seriesGames.length,
        weights[index]
      );
    });
  });
}

export function getPlayerRatingTimeline({
  players = [],
  games = [],
  playerId,
  options = {},
  seasonal = false,
  volleyballAdjusted = false,
  volleyballOptions = {},
  volleyballUpdateUsesBalancerContext = true,
  volleyballUpdateContextMode = 'pair',
  includeLeagueGames = true,
  _calibratedStarts = null,
} = {}) {
  const cfg = mergeRatingOptions(options);
  const ratingMap = {};
  const statsMap = {};
  const timeline = [];
  const history = [];
  const includedGames = getIncludedGames(games, includeLeagueGames, cfg);
  const seasonalTaperDays =
    typeof cfg.seasonalTaperDays === 'number'
      ? cfg.seasonalTaperDays
      : SEASONAL_TAPER_DAYS;

  const leagueContext = getLeagueContextById(playerId);

  if (leagueContext) {
    const replay = replayRatings({
      players,
      games,
      options: cfg,
      seasonal,
      volleyballAdjusted,
      volleyballOptions,
      volleyballUpdateUsesBalancerContext,
      volleyballUpdateContextMode,
      includeLeagueGames,
      _calibratedStarts,
    });

    const memberSkillById = {};
    let memberCount = 0;

    const getAggregateSkill = () => {
      const count = Math.max(1, memberCount || LEAGUE_TEAM_SIZE);
      const memberIds = getLeagueTeamMemberIdsForContext(leagueContext, count);
      const members = memberIds.map(id => memberSkillById[id] ?? makeInitialRating(cfg));
      return {
        mu: members.reduce((sum, skill) => sum + Number(skill.mu), 0) / members.length,
        sigma: members.reduce((sum, skill) => sum + Number(skill.sigma), 0) / members.length,
      };
    };

    const syncMembers = entries => {
      (Array.isArray(entries) ? entries : []).forEach(entry => {
        if (!entry?.id) return;
        memberSkillById[String(entry.id)] = rating({
          mu: Number(entry.mu),
          sigma: clamp(Number(entry.sigma), 1, cfg.sigma),
        });
      });
    };

    const timeline = [];
    replay.history.forEach((result, chronologicalIndex) => {
      const game = result?.game;
      if (!game?.isLeagueGame || !gameMatchesLeagueContext(game, leagueContext)) {
        return;
      }

      memberCount = Math.max(
        memberCount,
        result.before?.blue?.length || 0,
        result.after?.blue?.length || 0,
        1
      );

      syncMembers(result.before?.blue);
      const beforeSkill = getAggregateSkill();
      const beforeRating = getRawOrdinal(beforeSkill, cfg);

      syncMembers(result.after?.blue);
      const afterSkill = getAggregateSkill();
      const afterRating = getRawOrdinal(afterSkill, cfg);

      const entry = getLeagueContextTimelineEntry({
        game,
        context: leagueContext,
        chronologicalIndex,
        result,
      });
      if (!entry) return;

      timeline.push({
        ...entry,
        ratingBefore: beforeRating,
        ratingAfter: afterRating,
        displayRatingBefore: toDisplayRating(beforeRating),
        displayRatingAfter: toDisplayRating(afterRating),
        muBefore: beforeSkill.mu,
        muAfter: afterSkill.mu,
        sigmaBefore: beforeSkill.sigma,
        sigmaAfter: afterSkill.sigma,
      });
    });

    return expandLeagueSeriesTimeline(timeline);
  }

  players.forEach(player => {
    const calibrated = _calibratedStarts?.[player.id];
    ratingMap[player.id] = calibrated
      ? rating({ mu: Number(calibrated.mu), sigma: Number(calibrated.sigma) })
      : makeInitialRating(cfg);
    statsMap[player.id] = { id: player.id, name: player.name, games: 0 };
  });

  const sortedGames = aggregateLeagueSeriesGames(
    getGamesSortedOldestFirst(includedGames),
    cfg
  );
  const referenceDate = seasonal ? getMostRecentGameDate(sortedGames) : null;
  const leagueOpponentStatsMap = {};
  const updateContextMode = volleyballUpdateUsesBalancerContext
    ? (volleyballUpdateContextMode || 'pair')
    : 'off';
  const updateContextUsesEnvironment = updateContextMode === 'full' || updateContextMode === 'silo';
  const updateContextUsesPair = updateContextMode === 'full' || updateContextMode === 'pair';
  const updatePairContextMap = volleyballAdjusted && updateContextUsesPair ? new Map() : null;
  const priorGamesForUpdateContext = [];
  const streakRecentDeltaMap = cfg.streakProtectionEnabled ? new Map() : null;
  const streakRecentEntryMap = cfg.streakProtectionEnabled ? new Map() : null;
  const sessionDeltaMap = cfg.sessionProtectionEnabled ? new Map() : null;
  const leagueSessionFreezeMap = cfg.leagueSessionFreezeEnabled ? new Map() : null;
  const leagueBayesianPosteriorMap = cfg.leaguePregameBayesianMode === 'incrementalGrid' ? new Map() : null;

  sortedGames.forEach((game, chronologicalIndex) => {
    const seasonalWeight = seasonal
      ? getSeasonalWeight(game?.date, referenceDate, seasonalTaperDays)
      : 1;

    const pregameBayesianLeagueRaw = seedPregameBayesianLeagueOpponent(
      game,
      ratingMap,
      history,
      cfg,
      leagueBayesianPosteriorMap
    );
    applyPregameLeagueOpponentAdjustment(game, ratingMap, leagueOpponentStatsMap, cfg);
    const leagueSessionFreeze = applyLeagueSessionPregameFreeze(game, ratingMap, leagueSessionFreezeMap, cfg);
    let volleyballScoringRatingMap = null;
    let volleyballScoringPairAdjustmentMap = null;

    if (volleyballAdjusted && updateContextUsesEnvironment) {
      const adjustedRatingMap = buildEnvironmentAdjustedRatingMap({
        players,
        games: priorGamesForUpdateContext,
        baseRatingMap: ratingMap,
        ratingOptions: cfg,
        volleyballOptions,
        teamCount: 2,
        playerCount: getScoreboardSideSize(game, 'red') + getScoreboardSideSize(game, 'blue'),
        targetSilo: getEnvironmentSiloForGame(game),
      });
      volleyballScoringRatingMap = {
        ...ratingMap,
        ...adjustedRatingMap,
      };
    }
    if (volleyballAdjusted && updateContextUsesPair) {
      volleyballScoringPairAdjustmentMap = new Map(updatePairContextMap);
      learnPairAdjustmentFromGame({
        pairMap: updatePairContextMap,
        game,
        ratingMap,
        ratingOptions: cfg,
        volleyballOptions,
      });
    }

    const result = rateSingleGame(game, ratingMap, {
      ...cfg,
      seasonalWeight,
      volleyballAdjusted,
      volleyballOptions,
      volleyballScoringRatingMap,
      volleyballScoringPairAdjustmentMap,
    });
    if (Number.isFinite(pregameBayesianLeagueRaw)) {
      result.pregameBayesianLeagueRaw = pregameBayesianLeagueRaw;
    }
    history.push(result);
    updateIncrementalBayesianLeaguePosterior(result, leagueBayesianPosteriorMap, cfg);
    priorGamesForUpdateContext.push(game);

    // Burn-in: match replayRatings — amplify updates for players in their first N games.
    const burnInGames = Number(cfg.burnInGames) || 0;
    const burnInMult = Number(cfg.burnInMultiplier) || 1;
    const leagueBurnInGames = Number(cfg.leagueOpponentBurnInGames) || 0;
    const leagueBurnInMult = Number(cfg.leagueOpponentBurnInMultiplier) || 1;
    if (
      _calibratedStarts === null &&
      ((burnInGames > 0 && burnInMult > 1) || (leagueBurnInGames > 0 && leagueBurnInMult > 1))
    ) {
      const applyBurnIn = (beforeEntries, afterEntries) => {
        beforeEntries.forEach((before, i) => {
          const id = String(before.id);
          const isLeagueOpponent = isSyntheticLeagueMemberId(id);
          const gamesLimit = isLeagueOpponent ? leagueBurnInGames : burnInGames;
          const multiplier = isLeagueOpponent ? leagueBurnInMult : burnInMult;
          const gamesPlayed = isLeagueOpponent
            ? leagueOpponentStatsMap[id]?.games ?? 0
            : statsMap[id]?.games ?? 0;

          if (gamesLimit > 0 && multiplier > 1 && gamesPlayed < gamesLimit) {
            const after = afterEntries[i];
            const newMu = before.mu + (after.mu - before.mu) * multiplier;
            const newSigma = clamp(
              before.sigma + (after.sigma - before.sigma) * multiplier,
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

    finalizeLeagueSessionFreeze(leagueSessionFreeze, result, ratingMap, cfg);

    // Calibration freeze: match replayRatings — restore seeded rating within calibration window.
    if (_calibratedStarts !== null) {
      const calibrationGamesLimit = Number(cfg.calibrationGames) || 0;
      [...getRedTeamIds(game), ...getBlueTeamIds(game, cfg)].forEach(id => {
        const cal = _calibratedStarts[id];
        if (cal && (statsMap[id]?.games ?? 0) < calibrationGamesLimit) {
          const calibratedSkill = rating({ mu: Number(cal.mu), sigma: Number(cal.sigma) });
          ratingMap[id] = calibratedSkill;
          syncRatingEntry(result.after.red, id, calibratedSkill, cfg);
          syncRatingEntry(result.after.blue, id, calibratedSkill, cfg);
        }
      });
    }

    applyStreakProtectionForEntry({
      historyEntry: result,
      ratingMap,
      statsMap,
      recentDeltaMap: streakRecentDeltaMap,
      recentEntryMap: streakRecentEntryMap,
      cfg,
      volleyballOptions,
    });

    applySessionProtectionForEntry({
      historyEntry: result,
      ratingMap,
      statsMap,
      sessionDeltaMap,
      cfg,
    });

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
    } else {
      getBlueTeamIds(game, cfg).forEach(id => {
        if (!leagueOpponentStatsMap[id]) {
          leagueOpponentStatsMap[id] = { games: 0 };
        }
        leagueOpponentStatsMap[id].games += 1;
      });
    }

    const isRequestedLeagueContext =
      leagueContext &&
      game?.isLeagueGame &&
      gameMatchesLeagueContext(game, leagueContext);

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
      leagueContext: game?.isLeagueGame ? cloneSimple(getLeagueRatingContext(game, cfg)) : null,
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
      evidenceWeight: result.evidenceWeight,
      finalUpdateMultiplier: result.finalUpdateMultiplier,
      streakProtectionMultiplier: after.streakProtectionMultiplier,
      streakProtectionMode: after.streakProtectionMode,
      streakProtectionApplyTo: after.streakProtectionApplyTo,
      streakProtectionAuditValue: after.streakProtectionAuditValue,
      sessionProtectionMultiplier: after.sessionProtectionMultiplier,
      sessionProtectionApplyTo: after.sessionProtectionApplyTo,
      sessionProtectionNetDelta: after.sessionProtectionNetDelta,
      sessionProtectionSessionGames: after.sessionProtectionSessionGames,
      openSkillWinnerProbability: result.openSkillWinnerProbability,
      volleyballWinnerProbability: result.volleyballWinnerProbability,
      redTeam: Array.isArray(game.redTeam) ? cloneSimple(game.redTeam) : [],
      blueTeam: Array.isArray(game.blueTeam) ? cloneSimple(game.blueTeam) : [],
      leagueOpponent: game.leagueOpponent ? cloneSimple(game.leagueOpponent) : null,
      leagueSeriesGames: Array.isArray(game.leagueSeriesGames) ? cloneSimple(game.leagueSeriesGames) : null,
    });
  });

  return expandLeagueSeriesTimeline(timeline);
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
      // Backward-compatible alias. Keep this raw; UI code decides whether
      // it is a public rating display or a team-strength display.
      rating: rawOrdinal,
      displayRating: toDisplayRating(rawOrdinal),
      mu: Number(skill.mu),
      sigma: Number(skill.sigma),
    };
  });
}
