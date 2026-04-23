// ratings.js
// Shared rating engine for the Volleyball app.
//
// Goals:
// - One source of truth for all rating calculations
// - Replay games oldest -> newest
// - Support visible Rating = mu - 3*sigma
// - Support team balancing / candidate split scoring
// - Support a persistent synthetic Blue league team
// - Keep score margin bounded so 25-10 matters more than 26-24,
//   but does not dominate the model
//
// This draft is intentionally defensive about input shape so it can be
// adapted to the app's existing localStorage/database structure with
// minimal pain.

import {
  rating,
  rate,
  ordinal,
  predictWin,
  predictDraw,
  models,
} from './vendor/openskill.js';

const DEFAULTS = {
  // Visible label should be "Rating", but internally these are the
  // usual skill parameters.
  mu: 25,
  sigma: 25 / 3,

  // OpenSkill/TrueSkill-style model config.
  // Thurstone-Mosteller is the closest conceptual fit to classic TrueSkill.
  model: 'thurstone-mosteller',

  // Margin settings.
  useScoreMargin: true,
  maxMarginBonus: 0.25, // caps multiplier at 1.25x
  marginScale: 20,      // 20-point diff reaches the cap

  // Conservative displayed rating.
  ordinalSigmaMultiplier: 3,

  // Synthetic persistent league opponent key.
  leagueTeamKey: '__blue_league_team__',
};

function getModel(modelName = DEFAULTS.model) {
  switch (modelName) {
    case 'plackett-luce':
      return models.PlackettLuce;
    case 'bradley-terry':
      return models.BradleyTerryFull;
    case 'thurstone-mosteller':
    default:
      return models.ThurstoneMostellerFull;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function mergeOptions(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

export function makeInitialRating(options = {}) {
  const cfg = mergeOptions(options);
  return rating({ mu: cfg.mu, sigma: cfg.sigma });
}

export function displayRating(skill, options = {}) {
  const cfg = mergeOptions(options);
  // ordinal() is already mu - 3*sigma in openskill-style libraries,
  // but we keep a fallback for plain objects.
  if (skill && typeof ordinal === 'function') {
    try {
      return ordinal(skill, { z: cfg.ordinalSigmaMultiplier });
    } catch (_) {
      // fall through to manual computation
    }
  }
  const mu = Number(skill?.mu ?? cfg.mu);
  const sigma = Number(skill?.sigma ?? cfg.sigma);
  return mu - cfg.ordinalSigmaMultiplier * sigma;
}

export function marginFactor(winnerScore, loserScore, options = {}) {
  const cfg = mergeOptions(options);
  if (!cfg.useScoreMargin) return 1;

  const w = toNumberOrNull(winnerScore);
  const l = toNumberOrNull(loserScore);
  if (w === null || l === null) return 1;

  const diff = Math.max(0, Math.abs(w - l));
  const bonus = clamp(diff / cfg.marginScale, 0, cfg.maxMarginBonus);
  return 1 + bonus;
}

// Bounded score encoding for the underlying model.
//
// We keep the winner above the loser, but only modestly separate them.
// This allows score margin to influence updates without letting blowouts
// completely overwhelm the base result.
export function boundedScorePair(winnerScore, loserScore, options = {}) {
  const factor = marginFactor(winnerScore, loserScore, options);
  return {
    winnerModelScore: factor,
    loserModelScore: 1,
    marginMultiplier: factor,
  };
}

function normalizePlayerRef(player) {
  if (typeof player === 'string') return player;
  if (player && typeof player === 'object') {
    return (
      player.id ??
      player.name ??
      player.playerId ??
      player.playerName ??
      null
    );
  }
  return null;
}

export function normalizePlayerKey(player) {
  const key = normalizePlayerRef(player);
  if (!key) throw new Error(`Could not normalize player reference: ${JSON.stringify(player)}`);
  return String(key);
}

export function getGameTeams(game, options = {}) {
  const cfg = mergeOptions(options);

  const redRaw = game.redTeam ?? game.red ?? game.teamRed ?? [];
  let blueRaw = game.blueTeam ?? game.blue ?? game.teamBlue ?? [];

  const isLeagueGame = Boolean(
    game.isLeagueGame ?? game.leagueGame ?? game.isLeague ?? false
  );

  const redPlayers = Array.isArray(redRaw) ? redRaw.map(normalizePlayerKey) : [];

  let bluePlayers;
  if (isLeagueGame) {
    bluePlayers = [cfg.leagueTeamKey];
  } else {
    bluePlayers = Array.isArray(blueRaw) ? blueRaw.map(normalizePlayerKey) : [];
  }

  return {
    redPlayers,
    bluePlayers,
    isLeagueGame,
  };
}

export function getWinnerSide(game) {
  const explicit = game.winner ?? game.winningTeam ?? game.result ?? null;
  if (explicit === 'red' || explicit === 'blue') return explicit;

  const redScore = toNumberOrNull(game.redScore);
  const blueScore = toNumberOrNull(game.blueScore);

  if (redScore !== null && blueScore !== null) {
    if (redScore > blueScore) return 'red';
    if (blueScore > redScore) return 'blue';
  }

  throw new Error(`Game is missing a usable winner: ${JSON.stringify(game)}`);
}

export function ensureRatingsForPlayers(ratingMap, playerKeys, options = {}) {
  for (const key of playerKeys) {
    if (!ratingMap[key]) {
      ratingMap[key] = makeInitialRating(options);
    }
  }
  return ratingMap;
}

function buildTeamRatings(playerKeys, ratingMap) {
  return playerKeys.map((key) => ratingMap[key]);
}

function updateTeamRatings(playerKeys, ratingMap, newRatings) {
  if (playerKeys.length !== newRatings.length) {
    throw new Error('Player count and updated rating count do not match.');
  }
  for (let i = 0; i < playerKeys.length; i += 1) {
    ratingMap[playerKeys[i]] = newRatings[i];
  }
}

export function rateGame(game, ratingMap, options = {}) {
  const cfg = mergeOptions(options);
  const model = getModel(cfg.model);

  const { redPlayers, bluePlayers, isLeagueGame } = getGameTeams(game, cfg);
  const allPlayers = [...redPlayers, ...bluePlayers];
  ensureRatingsForPlayers(ratingMap, allPlayers, cfg);

  const winnerSide = getWinnerSide(game);
  const redScore = toNumberOrNull(game.redScore);
  const blueScore = toNumberOrNull(game.blueScore);

  const redTeam = buildTeamRatings(redPlayers, ratingMap);
  const blueTeam = buildTeamRatings(bluePlayers, ratingMap);

  const before = {
    red: redPlayers.map((key) => ({ key, ...deepClone(ratingMap[key]) })),
    blue: bluePlayers.map((key) => ({ key, ...deepClone(ratingMap[key]) })),
  };

  let rated;
  let marginInfo = { winnerModelScore: 1, loserModelScore: 1, marginMultiplier: 1 };

  if (winnerSide === 'red') {
    marginInfo = boundedScorePair(redScore, blueScore, cfg);
    rated = rate(
      [redTeam, blueTeam],
      {
        model,
        score: [marginInfo.winnerModelScore, marginInfo.loserModelScore],
      }
    );
  } else {
    marginInfo = boundedScorePair(blueScore, redScore, cfg);
    rated = rate(
      [blueTeam, redTeam],
      {
        model,
        score: [marginInfo.winnerModelScore, marginInfo.loserModelScore],
      }
    );
    // Reorder result back into [red, blue] form.
    rated = [rated[1], rated[0]];
  }

  updateTeamRatings(redPlayers, ratingMap, rated[0]);
  updateTeamRatings(bluePlayers, ratingMap, rated[1]);

  const after = {
    red: redPlayers.map((key) => ({ key, ...deepClone(ratingMap[key]) })),
    blue: bluePlayers.map((key) => ({ key, ...deepClone(ratingMap[key]) })),
  };

  return {
    winnerSide,
    isLeagueGame,
    redPlayers,
    bluePlayers,
    redScore,
    blueScore,
    marginInfo,
    before,
    after,
  };
}

export function replayRatings({ players = [], games = [], options = {} } = {}) {
  const cfg = mergeOptions(options);
  const ratingMap = {};
  const statsMap = {};
  const history = [];

  const playerKeys = players.map(normalizePlayerKey);
  ensureRatingsForPlayers(ratingMap, playerKeys, cfg);

  for (const key of playerKeys) {
    statsMap[key] = {
      key,
      wins: 0,
      games: 0,
    };
  }

  // Always initialize the synthetic league team lazily when first used.
  for (const game of games) {
    const snapshot = rateGame(game, ratingMap, cfg);
    history.push({ game: deepClone(game), snapshot });

    for (const key of snapshot.redPlayers) {
      if (!statsMap[key]) statsMap[key] = { key, wins: 0, games: 0 };
      statsMap[key].games += 1;
    }
    for (const key of snapshot.bluePlayers) {
      if (key === cfg.leagueTeamKey) continue;
      if (!statsMap[key]) statsMap[key] = { key, wins: 0, games: 0 };
      statsMap[key].games += 1;
    }

    const winningKeys = snapshot.winnerSide === 'red' ? snapshot.redPlayers : snapshot.bluePlayers;
    for (const key of winningKeys) {
      if (key === cfg.leagueTeamKey) continue;
      if (!statsMap[key]) statsMap[key] = { key, wins: 0, games: 0 };
      statsMap[key].wins += 1;
    }
  }

  const standings = Object.keys(statsMap)
    .filter((key) => key !== cfg.leagueTeamKey)
    .map((key) => {
      const skill = ratingMap[key] ?? makeInitialRating(cfg);
      const gamesPlayed = statsMap[key]?.games ?? 0;
      const wins = statsMap[key]?.wins ?? 0;
      return {
        key,
        rating: displayRating(skill, cfg),
        mu: Number(skill.mu),
        sigma: Number(skill.sigma),
        wins,
        games: gamesPlayed,
        winrate: gamesPlayed > 0 ? wins / gamesPlayed : 0,
      };
    })
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.games !== a.games) return b.games - a.games;
      return String(a.key).localeCompare(String(b.key));
    });

  const leagueSkill = ratingMap[cfg.leagueTeamKey] ?? null;

  return {
    config: cfg,
    ratingMap,
    statsMap,
    standings,
    history,
    leagueTeam: leagueSkill
      ? {
          key: cfg.leagueTeamKey,
          rating: displayRating(leagueSkill, cfg),
          mu: Number(leagueSkill.mu),
          sigma: Number(leagueSkill.sigma),
        }
      : null,
  };
}

export function scoreCandidateSplit({ redPlayers, bluePlayers, ratingMap, options = {} }) {
  const cfg = mergeOptions(options);
  const model = getModel(cfg.model);

  const redKeys = redPlayers.map(normalizePlayerKey);
  const blueKeys = bluePlayers.map(normalizePlayerKey);
  ensureRatingsForPlayers(ratingMap, [...redKeys, ...blueKeys], cfg);

  const redTeam = buildTeamRatings(redKeys, ratingMap);
  const blueTeam = buildTeamRatings(blueKeys, ratingMap);

  const redWinProbability = predictWin([redTeam, blueTeam], { model })?.[0] ?? 0.5;
  const blueWinProbability = 1 - redWinProbability;
  const drawProxy = predictDraw([redTeam, blueTeam], { model }) ?? 0;

  // A simple fairness score where bigger is better.
  // 1.0 is perfectly balanced in the red-win sense.
  const fairness = 1 - Math.abs(redWinProbability - 0.5) * 2;

  return {
    redPlayers: redKeys,
    bluePlayers: blueKeys,
    redWinProbability,
    blueWinProbability,
    drawProxy,
    fairness,
  };
}

export function attachRatingsToPlayers(players, ratingMap, options = {}) {
  const cfg = mergeOptions(options);
  return players.map((player) => {
    const key = normalizePlayerKey(player);
    const skill = ratingMap[key] ?? makeInitialRating(cfg);
    return {
      ...player,
      rating: displayRating(skill, cfg),
      mu: Number(skill.mu),
      sigma: Number(skill.sigma),
    };
  });
}

export const Ratings = {
  DEFAULTS,
  mergeOptions,
  makeInitialRating,
  displayRating,
  marginFactor,
  boundedScorePair,
  normalizePlayerKey,
  getGameTeams,
  getWinnerSide,
  ensureRatingsForPlayers,
  rateGame,
  replayRatings,
  scoreCandidateSplit,
  attachRatingsToPlayers,
};
