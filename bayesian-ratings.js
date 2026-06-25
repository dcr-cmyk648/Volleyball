export const BAYESIAN_MODEL_VERSION = 'bayesian-scoreboard-v1';
export const BAYESIAN_SNAPSHOT_SCHEMA_VERSION = 1;
export const BAYESIAN_SNAPSHOT_STORAGE_KEY = 'gameDayBayesianScoreboardSnapshotV1';

export const BAYESIAN_PRIOR_MU = 0;
export const BAYESIAN_PRIOR_SD = 1;
export const BAYESIAN_SCORE_CONCENTRATION = 25;
export const BAYESIAN_DISPLAY_BASE = 25;
export const BAYESIAN_DISPLAY_SCALE = 25 / 3;
export const BAYESIAN_DEFAULT_SIGMA = 25 / 3;

const BAYESIAN_LEAGUE_ENTITY_PREFIX = 'league:';
const MAX_EXP_ARG = 35;
const EPSILON = 1e-12;

/**
 * @typedef {Object} BayesianScoreboardSnapshot
 * @property {number} schemaVersion
 * @property {string} modelVersion
 * @property {string} calculatedAt
 * @property {string} playerEntityFingerprint
 * @property {Object.<string,string>} gameFingerprints
 * @property {number} gamesConsidered
 * @property {number} scoredGames
 * @property {number} winnerOnlyGames
 * @property {number} skippedGames
 * @property {string[]} warnings
 * @property {Object} diagnostics
 * @property {Array<Object>} ratings
 * @property {Object} constants
 */

/**
 * Fit the retrospective Bayesian scoreboard and return a persisted snapshot.
 * @param {Object} input
 * @param {Array<Object>} input.players
 * @param {Array<Object>} input.games
 * @param {boolean} [input.includeLeagueRatings]
 * @param {(progress: Object) => void} [input.onProgress]
 * @returns {BayesianScoreboardSnapshot}
 */
export function calculateBayesianScoreboard({
  players = [],
  games = [],
  includeLeagueRatings = false,
  onProgress = null
} = {}) {
  const progress = createProgressReporter(onProgress);
  progress(1, 'validate', 'Validating games and indexing players');

  const indexed = buildModelIndex(players, games);
  progress(
    10,
    'validate',
    `Validating ${games.length} games and indexing ${indexed.playerIds.length} players`,
    { warnings: indexed.warnings.length }
  );

  progress(14, 'build', 'Building the batch skill model');
  const observations = buildObservations(games, indexed);
  progress(
    20,
    'build',
    `Building the batch skill model from ${observations.validObservations.length} observations`,
    {
      scoredGames: observations.scoredGames,
      winnerOnlyGames: observations.winnerOnlyGames,
      skippedGames: observations.skippedGames,
    }
  );

  const dimension = indexed.entityIds.length;
  const initial = new Array(dimension).fill(0);
  let optimized;

  if (dimension === 0 || observations.validObservations.length === 0) {
    optimized = {
      x: initial,
      objective: 0,
      gradientNorm: 0,
      iterations: 0,
      converged: true,
      reason: dimension === 0 ? 'no-entities' : 'no-valid-observations',
    };
    progress(75, 'optimize', 'Optimizing player skills - no valid observations');
  } else {
    optimized = optimizeBfgs(initial, vector => objectiveAndGradient(vector, observations.validObservations, dimension), {
      maxIterations: 260,
      tolerance: 1e-7,
      onIteration: info => {
        const percent = Math.min(74, 20 + Math.floor((info.iteration / 260) * 55));
        progress(
          percent,
          'optimize',
          `Optimizing player skills - iteration ${info.iteration}`,
          {
            iteration: info.iteration,
            objective: info.objective,
            gradientNorm: info.gradientNorm,
          }
        );
      },
    });
  }

  if (!optimized.converged) {
    throw new Error(`Bayesian optimization failed to converge: ${optimized.reason}`);
  }
  assertFiniteArray(optimized.x, 'optimized skills');
  progress(75, 'posterior', 'Estimating posterior uncertainty');

  const posterior = estimatePosteriorCovariance(
    optimized.x,
    vector => objectiveAndGradient(vector, observations.validObservations, dimension).gradient
  );
  progress(94, 'posterior', 'Estimating posterior uncertainty', posterior.diagnostics);

  const entityStats = countEntityGameStats(indexed, observations.validObservations);
  const ratings = formatPlayerRatings(
    players,
    indexed,
    optimized.x,
    posterior.covariance,
    entityStats,
    { includeLeagueRatings }
  );
  validateBayesianRatings(ratings);

  progress(96, 'save', 'Saving the Bayesian scoreboard');
  const snapshot = {
    schemaVersion: BAYESIAN_SNAPSHOT_SCHEMA_VERSION,
    modelVersion: BAYESIAN_MODEL_VERSION,
    calculatedAt: new Date().toISOString(),
    playerEntityFingerprint: createPlayerEntityFingerprint(players),
    gameFingerprints: createGameFingerprintMap(games),
    gamesConsidered: observations.validObservations.length,
    scoredGames: observations.scoredGames,
    winnerOnlyGames: observations.winnerOnlyGames,
    skippedGames: observations.skippedGames,
    warnings: [...indexed.warnings, ...observations.warnings],
    diagnostics: {
      optimizer: {
        converged: optimized.converged,
        iterations: optimized.iterations,
        objective: optimized.objective,
        gradientNorm: optimized.gradientNorm,
        reason: optimized.reason,
      },
      posterior: posterior.diagnostics,
      latentEntityCount: dimension,
      playerCount: indexed.playerIds.length,
      leagueOpponentCount: indexed.leagueOpponentIds.length,
    },
    constants: {
      priorMu: BAYESIAN_PRIOR_MU,
      priorSd: BAYESIAN_PRIOR_SD,
      scoreConcentration: BAYESIAN_SCORE_CONCENTRATION,
      displayBase: BAYESIAN_DISPLAY_BASE,
      displayScale: BAYESIAN_DISPLAY_SCALE,
    },
    ratings,
  };

  validateBayesianSnapshot(snapshot);
  progress(100, 'complete', 'Bayesian scoreboard saved', {
    gamesConsidered: snapshot.gamesConsidered,
    hessianJitter: posterior.diagnostics.jitter,
  });
  return snapshot;
}

export function validateBayesianSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Missing Bayesian snapshot.');
  if (snapshot.schemaVersion !== BAYESIAN_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('Unsupported Bayesian snapshot schema.');
  }
  if (snapshot.modelVersion !== BAYESIAN_MODEL_VERSION) {
    throw new Error('Unsupported Bayesian model version.');
  }
  validateBayesianRatings(snapshot.ratings);
  return true;
}

export function validateBayesianRatings(ratings) {
  if (!Array.isArray(ratings)) throw new Error('Bayesian ratings must be an array.');
  ratings.forEach(rating => {
    for (const field of ['mu', 'sigma', 'ordinal', 'games', 'wins', 'winrate']) {
      if (!Number.isFinite(Number(rating[field]))) {
        throw new Error(`Invalid Bayesian rating field: ${field}`);
      }
    }
    if (rating.sigma <= 0) throw new Error('Bayesian sigma must be positive.');
  });
  return true;
}

export function saveBayesianSnapshot(storage, snapshot) {
  validateBayesianSnapshot(snapshot);
  storage.setItem(BAYESIAN_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
}

export function loadBayesianSnapshot(storage) {
  try {
    const raw = storage.getItem(BAYESIAN_SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    validateBayesianSnapshot(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function createBayesianUiState({ players = [], games = [], snapshot = null, running = false } = {}) {
  const comparison = compareBayesianSnapshotToCurrentData(snapshot, players, games);
  const hasSnapshot = Boolean(snapshot);
  const buttonVerb = !hasSnapshot
    ? 'Calculate'
    : comparison.addedGameCount > 0
      ? 'Update'
      : 'Recalculate';
  return {
    ...comparison,
    hasSnapshot,
    running,
    isStale: comparison.isStale,
    buttonText: `${buttonVerb} Bayesian ratings — ${comparison.addedGameCount} new game${comparison.addedGameCount === 1 ? '' : 's'}`,
    staleMessage: getBayesianStaleMessage(comparison),
  };
}

export function getBayesianStaleMessage(comparison) {
  if (!comparison?.isStale) return '';
  const pieces = [];
  if (comparison.modifiedGameCount > 0 || comparison.deletedGameCount > 0) {
    pieces.push('Game data changed; a full recalculation is needed.');
  }
  if (comparison.addedGameCount > 0) {
    pieces.push(`${comparison.addedGameCount} new game${comparison.addedGameCount === 1 ? '' : 's'} since the last calculation.`);
  }
  if (comparison.playerEntityChanged) {
    pieces.push('Registered player IDs changed; a full recalculation is needed.');
  }
  return pieces.join(' ');
}

export function compareBayesianSnapshotToCurrentData(snapshot, players = [], games = []) {
  const currentGameFingerprints = createGameFingerprintMap(games);
  const currentPlayerFingerprint = createPlayerEntityFingerprint(players);

  if (!snapshot) {
    return {
      addedGameCount: Object.keys(currentGameFingerprints).length,
      modifiedGameCount: 0,
      deletedGameCount: 0,
      playerEntityChanged: false,
      isStale: Object.keys(currentGameFingerprints).length > 0 || players.length > 0,
    };
  }

  const previousGameFingerprints = snapshot.gameFingerprints || {};
  let addedGameCount = 0;
  let modifiedGameCount = 0;
  let deletedGameCount = 0;

  Object.entries(currentGameFingerprints).forEach(([identity, fingerprint]) => {
    if (!(identity in previousGameFingerprints)) {
      addedGameCount += 1;
    } else if (previousGameFingerprints[identity] !== fingerprint) {
      modifiedGameCount += 1;
    }
  });

  Object.keys(previousGameFingerprints).forEach(identity => {
    if (!(identity in currentGameFingerprints)) deletedGameCount += 1;
  });

  const playerEntityChanged = snapshot.playerEntityFingerprint !== currentPlayerFingerprint;

  return {
    addedGameCount,
    modifiedGameCount,
    deletedGameCount,
    playerEntityChanged,
    isStale: addedGameCount > 0 || modifiedGameCount > 0 || deletedGameCount > 0 || playerEntityChanged,
  };
}

export function createPlayerEntityFingerprint(players = []) {
  const ids = normalizePlayers(players).map(player => String(player.id)).sort(compareStrings);
  return hashStableJson(ids);
}

export function createGameFingerprintMap(games = []) {
  const map = {};
  (Array.isArray(games) ? games : []).forEach((game, index) => {
    if (!game || typeof game !== 'object') return;
    const identity = getStableGameIdentity(game, index);
    if (!identity) return;
    map[identity] = createGameFingerprint(game, identity);
  });
  return map;
}

export function getStableGameIdentity(game, index = 0) {
  if (game?.id !== null && typeof game?.id !== 'undefined' && String(game.id) !== '') {
    return `id:${String(game.id)}`;
  }
  if (game?.createdAt !== null && typeof game?.createdAt !== 'undefined' && String(game.createdAt) !== '') {
    return `createdAt:${String(game.createdAt)}`;
  }
  return `content:${hashStableJson({
    index,
    winner: game?.winner ?? '',
    scoreRed: normalizeScoreValue(game?.scoreRed),
    scoreBlue: normalizeScoreValue(game?.scoreBlue),
    isLeagueGame: Boolean(game?.isLeagueGame),
    redTeam: getSortedTeamIds(game?.redTeam),
    blueTeam: getSortedTeamIds(game?.blueTeam),
    leagueOpponentId: String(game?.leagueOpponent?.id ?? ''),
    leagueOpponentSize: normalizeScoreValue(game?.leagueOpponent?.size),
  })}`;
}

export function createGameFingerprint(game, identity = getStableGameIdentity(game)) {
  return hashStableJson({
    identity,
    winner: game?.winner === 'red' || game?.winner === 'blue' ? game.winner : '',
    scoreRed: normalizeScoreValue(game?.scoreRed),
    scoreBlue: normalizeScoreValue(game?.scoreBlue),
    isLeagueGame: Boolean(game?.isLeagueGame),
    redTeam: getSortedTeamIds(game?.redTeam),
    blueTeam: getSortedTeamIds(game?.blueTeam),
    leagueOpponentId: String(game?.leagueOpponent?.id ?? ''),
    leagueOpponentSize: normalizeScoreValue(game?.leagueOpponent?.size),
  });
}

export function sortBayesianRatings(ratings = []) {
  return [...ratings].sort((a, b) => {
    if (b.ordinal !== a.ordinal) return b.ordinal - a.ordinal;
    if (b.mu !== a.mu) return b.mu - a.mu;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.games !== a.games) return b.games - a.games;
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  }).map((rating, index) => ({ ...rating, rank: index + 1 }));
}

function buildModelIndex(players, games) {
  const warnings = [];
  const normalizedPlayers = normalizePlayers(players);
  const playerIds = normalizedPlayers.map(player => String(player.id));
  const playerIdSet = new Set(playerIds);
  const leagueOpponentIds = [];
  const leagueOpponentSet = new Set();
  const leagueOpponentNames = new Map();

  (Array.isArray(games) ? games : []).forEach(game => {
    if (!game?.isLeagueGame) return;
    const id = String(game?.leagueOpponent?.id ?? '').trim();
    if (!id) return;
    const name = String(game?.leagueOpponent?.name ?? game?.leagueOpponent?.label ?? '').trim();
    if (name && !leagueOpponentNames.has(id)) leagueOpponentNames.set(id, name);
    if (!leagueOpponentSet.has(id)) {
      leagueOpponentSet.add(id);
      leagueOpponentIds.push(id);
    }
  });

  leagueOpponentIds.sort(compareStrings);
  const entityIds = [...playerIds.map(id => `player:${id}`), ...leagueOpponentIds.map(id => `league:${id}`)];
  const entityIndex = new Map(entityIds.map((id, index) => [id, index]));
  return {
    players: normalizedPlayers,
    playerIds,
    playerIdSet,
    leagueOpponentIds,
    leagueOpponentNames,
    entityIds,
    entityIndex,
    warnings,
  };
}

function buildObservations(games, indexed) {
  const validObservations = [];
  const warnings = [];
  let scoredGames = 0;
  let winnerOnlyGames = 0;
  let skippedGames = 0;

  (Array.isArray(games) ? games : []).forEach((game, index) => {
    const identity = getStableGameIdentity(game, index);
    const redPlayerIds = getTeamPlayerIds(game?.redTeam, indexed.playerIdSet);
    const bluePlayerIds = getTeamPlayerIds(game?.blueTeam, indexed.playerIdSet);
    const hasUsableScores = hasUsableScore(game);
    const winner = game?.winner === 'red' || game?.winner === 'blue' ? game.winner : '';

    if (hasUsableScores && winner) {
      const scoreWinner = Number(game.scoreRed) > Number(game.scoreBlue) ? 'red' : 'blue';
      if (Number(game.scoreRed) !== Number(game.scoreBlue) && scoreWinner !== winner) {
        warnings.push(`Game ${identity} has winner ${winner} but scores imply ${scoreWinner}.`);
      }
    }

    if (game?.isLeagueGame) {
      const opponentId = String(game?.leagueOpponent?.id ?? '').trim();
      if (redPlayerIds.length === 0 || !opponentId || (!hasUsableScores && !winner)) {
        skippedGames += 1;
        warnings.push(`Skipped malformed league game ${identity}.`);
        return;
      }
      const observation = createObservation({
        identity,
        redIndexes: redPlayerIds.map(id => indexed.entityIndex.get(`player:${id}`)),
        blueIndexes: [indexed.entityIndex.get(`${BAYESIAN_LEAGUE_ENTITY_PREFIX}${opponentId}`)],
        game,
        winner,
        hasUsableScores,
      });
      validObservations.push(observation);
    } else {
      if (redPlayerIds.length === 0 || bluePlayerIds.length === 0 || (!hasUsableScores && !winner)) {
        skippedGames += 1;
        warnings.push(`Skipped malformed game ${identity}.`);
        return;
      }
      validObservations.push(createObservation({
        identity,
        redIndexes: redPlayerIds.map(id => indexed.entityIndex.get(`player:${id}`)),
        blueIndexes: bluePlayerIds.map(id => indexed.entityIndex.get(`player:${id}`)),
        game,
        winner,
        hasUsableScores,
      }));
    }

    if (hasUsableScores) scoredGames += 1;
    else winnerOnlyGames += 1;
  });

  return { validObservations, warnings, scoredGames, winnerOnlyGames, skippedGames };
}

function createObservation({ identity, redIndexes, blueIndexes, game, winner, hasUsableScores }) {
  const redWeights = redIndexes.map(index => ({ index, weight: 1 / redIndexes.length }));
  const blueWeights = blueIndexes.map(index => ({ index, weight: 1 / blueIndexes.length }));
  const derivativeWeights = new Map();
  redWeights.forEach(({ index, weight }) => derivativeWeights.set(index, (derivativeWeights.get(index) || 0) + weight));
  blueWeights.forEach(({ index, weight }) => derivativeWeights.set(index, (derivativeWeights.get(index) || 0) - weight));

  if (hasUsableScores) {
    const scoreRed = Number(game.scoreRed);
    const scoreBlue = Number(game.scoreBlue);
    return {
      identity,
      kind: 'scored',
      redWeights,
      blueWeights,
      derivativeWeights: [...derivativeWeights.entries()],
      q: (scoreRed + 0.5) / (scoreRed + scoreBlue + 1),
      redIndexes,
      blueIndexes,
      redPlayerIndexes: redIndexes,
      bluePlayerIndexes: game?.isLeagueGame ? [] : blueIndexes,
      winner,
    };
  }

  return {
    identity,
    kind: 'winner',
    redWeights,
    blueWeights,
    derivativeWeights: [...derivativeWeights.entries()],
    y: winner === 'red' ? 1 : 0,
    redIndexes,
    blueIndexes,
    redPlayerIndexes: redIndexes,
    bluePlayerIndexes: game?.isLeagueGame ? [] : blueIndexes,
    winner,
  };
}

function objectiveAndGradient(theta, observations, dimension) {
  let objective = 0.5 * dot(theta, theta);
  const gradient = theta.slice();

  for (const obs of observations) {
    const eta = weightedSum(theta, obs.redWeights) - weightedSum(theta, obs.blueWeights);
    const p = sigmoid(eta);
    let logLikelihood;
    let dLogLikelihoodDeta;

    if (obs.kind === 'scored') {
      const phi = BAYESIAN_SCORE_CONCENTRATION;
      const a = clampProbability(p) * phi;
      const b = (1 - clampProbability(p)) * phi;
      const q = clampProbability(obs.q);
      logLikelihood =
        logGamma(phi) -
        logGamma(a) -
        logGamma(b) +
        (a - 1) * Math.log(q) +
        (b - 1) * Math.log(1 - q);
      dLogLikelihoodDeta =
        phi * p * (1 - p) *
        (-digamma(a) + digamma(b) + Math.log(q) - Math.log(1 - q));
    } else {
      const y = obs.y;
      logLikelihood = y ? Math.log(clampProbability(p)) : Math.log(clampProbability(1 - p));
      dLogLikelihoodDeta = y - p;
    }

    if (!Number.isFinite(logLikelihood) || !Number.isFinite(dLogLikelihoodDeta)) {
      throw new Error(`Non-finite likelihood for game ${obs.identity}.`);
    }

    objective -= logLikelihood;
    for (const [index, weight] of obs.derivativeWeights) {
      if (index >= 0 && index < dimension) gradient[index] -= dLogLikelihoodDeta * weight;
    }
  }

  assertFiniteArray(gradient, 'gradient');
  if (!Number.isFinite(objective)) throw new Error('Non-finite objective.');
  return { objective, gradient };
}

function optimizeBfgs(initial, evaluate, { maxIterations, tolerance, onIteration }) {
  const n = initial.length;
  let x = initial.slice();
  let { objective, gradient } = evaluate(x);
  let inverseHessian = identityMatrix(n);
  let gradientNorm = vectorNorm(gradient);

  if (gradientNorm <= tolerance) {
    return { x, objective, gradientNorm, iterations: 0, converged: true, reason: 'initial-gradient' };
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    let direction = matrixVectorProduct(inverseHessian, gradient).map(value => -value);
    if (dot(direction, gradient) >= 0 || !direction.every(Number.isFinite)) {
      direction = gradient.map(value => -value);
      inverseHessian = identityMatrix(n);
    }

    const line = lineSearch(x, objective, gradient, direction, evaluate);
    if (!line.ok) {
      return { x, objective, gradientNorm, iterations: iteration - 1, converged: false, reason: line.reason };
    }

    const nextX = line.x;
    const nextObjective = line.objective;
    const nextGradient = line.gradient;
    const s = subtractVectors(nextX, x);
    const y = subtractVectors(nextGradient, gradient);
    const ys = dot(y, s);

    if (ys > 1e-12 && Number.isFinite(ys)) {
      inverseHessian = bfgsInverseUpdate(inverseHessian, s, y, ys);
    } else {
      inverseHessian = identityMatrix(n);
    }

    x = nextX;
    objective = nextObjective;
    gradient = nextGradient;
    gradientNorm = vectorNorm(gradient);
    onIteration?.({ iteration, objective, gradientNorm });

    if (gradientNorm <= tolerance) {
      return { x, objective, gradientNorm, iterations: iteration, converged: true, reason: 'gradient' };
    }
    if (Math.abs(line.previousObjective - objective) <= 1e-10 * Math.max(1, Math.abs(objective))) {
      return { x, objective, gradientNorm, iterations: iteration, converged: true, reason: 'objective' };
    }
  }

  return { x, objective, gradientNorm, iterations: maxIterations, converged: false, reason: 'max-iterations' };
}

function lineSearch(x, objective, gradient, direction, evaluate) {
  const directionalDerivative = dot(gradient, direction);
  if (!(directionalDerivative < 0)) return { ok: false, reason: 'not-descent' };

  let step = 1;
  const c1 = 1e-4;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = addScaledVector(x, direction, step);
    try {
      const evaluated = evaluate(candidate);
      if (
        Number.isFinite(evaluated.objective) &&
        evaluated.objective <= objective + c1 * step * directionalDerivative
      ) {
        return {
          ok: true,
          x: candidate,
          objective: evaluated.objective,
          gradient: evaluated.gradient,
          previousObjective: objective,
          step,
        };
      }
    } catch {
      // Try a smaller step.
    }
    step *= 0.5;
  }
  return { ok: false, reason: 'line-search' };
}

function bfgsInverseUpdate(hessian, s, y, ys) {
  const n = s.length;
  const rho = 1 / ys;
  const hy = matrixVectorProduct(hessian, y);
  const yhy = dot(y, hy);
  const updated = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      updated[i][j] =
        hessian[i][j] +
        (1 + yhy * rho) * rho * s[i] * s[j] -
        rho * (s[i] * hy[j] + hy[i] * s[j]);
    }
  }
  return updated;
}

function estimatePosteriorCovariance(theta, gradientFn) {
  const n = theta.length;
  const hessian = Array.from({ length: n }, () => new Array(n).fill(0));

  if (n === 0) {
    return { covariance: [], diagnostics: { method: 'empty', jitter: 0, choleskyAttempts: 0 } };
  }

  for (let j = 0; j < n; j += 1) {
    const step = Math.max(1e-4, Math.abs(theta[j]) * 1e-4);
    const plus = theta.slice();
    const minus = theta.slice();
    plus[j] += step;
    minus[j] -= step;
    const gradPlus = gradientFn(plus);
    const gradMinus = gradientFn(minus);
    for (let i = 0; i < n; i += 1) {
      hessian[i][j] = (gradPlus[i] - gradMinus[i]) / (2 * step);
    }
  }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const sym = 0.5 * (hessian[i][j] + hessian[j][i]);
      hessian[i][j] = sym;
      hessian[j][i] = sym;
    }
  }

  let jitter = 0;
  let cholesky = null;
  let attempts = 0;
  for (const candidateJitter of [0, 1e-10, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4]) {
    attempts += 1;
    const candidate = hessian.map((row, i) => row.map((value, j) => value + (i === j ? candidateJitter : 0)));
    cholesky = choleskyDecompose(candidate);
    if (cholesky) {
      jitter = candidateJitter;
      break;
    }
  }

  if (!cholesky) throw new Error('Bayesian posterior Hessian is not positive definite.');

  const covariance = invertFromCholesky(cholesky);
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(covariance[i][i]) || covariance[i][i] < -1e-9) {
      throw new Error('Invalid Bayesian posterior covariance diagonal.');
    }
  }

  return {
    covariance,
    diagnostics: {
      method: 'central-finite-difference-gradient-cholesky',
      jitter,
      choleskyAttempts: attempts,
    },
  };
}

function formatBayesianEntityRating({ id, name, latentIndex, theta, covariance, stats, extra = {} }) {
  const latentMu = Number.isFinite(theta[latentIndex]) ? theta[latentIndex] : 0;
  const variance = Math.max(0, covariance?.[latentIndex]?.[latentIndex] ?? 1);
  const sigma = BAYESIAN_DISPLAY_SCALE * Math.sqrt(variance);
  const mu = BAYESIAN_DISPLAY_BASE + BAYESIAN_DISPLAY_SCALE * latentMu;
  return {
    id,
    name,
    mu,
    sigma,
    ordinal: mu - 3 * sigma,
    games: stats.games,
    wins: stats.wins,
    winrate: stats.games > 0 ? stats.wins / stats.games : 0,
    ...extra,
  };
}

function formatPlayerRatings(players, indexed, theta, covariance, entityStats, options = {}) {
  const rows = indexed.players.map(player => {
    const latentIndex = indexed.entityIndex.get(`player:${String(player.id)}`);
    return formatBayesianEntityRating({
      id: player.id,
      name: player.name,
      latentIndex,
      theta,
      covariance,
      stats: entityStats.get(`player:${String(player.id)}`) || { games: 0, wins: 0 },
    });
  });

  if (options.includeLeagueRatings === true) {
    indexed.leagueOpponentIds.forEach(id => {
      const entityId = `${BAYESIAN_LEAGUE_ENTITY_PREFIX}${id}`;
      const latentIndex = indexed.entityIndex.get(entityId);
      if (!Number.isInteger(latentIndex)) return;
      rows.push(formatBayesianEntityRating({
        id,
        name: indexed.leagueOpponentNames.get(id) || id,
        latentIndex,
        theta,
        covariance,
        stats: entityStats.get(entityId) || { games: 0, wins: 0 },
        extra: { isLeagueContext: true },
      }));
    });
  }

  return sortBayesianRatings(rows);
}

function countEntityGameStats(indexed, observations) {
  const entityIdByIndex = new Map(indexed.entityIds.map((id, index) => [index, id]));
  const map = new Map(indexed.entityIds.map(id => [id, { games: 0, wins: 0 }]));
  const addResult = (index, won) => {
    const entityId = entityIdByIndex.get(index);
    const stats = map.get(entityId);
    if (!stats) return;
    stats.games += 1;
    if (won) stats.wins += 1;
  };

  observations.forEach(obs => {
    obs.redIndexes.forEach(index => addResult(index, obs.winner === 'red'));
    obs.blueIndexes.forEach(index => addResult(index, obs.winner === 'blue'));
  });
  return map;
}

function normalizePlayers(players) {
  return (Array.isArray(players) ? players : [])
    .filter(player => player && typeof player.name === 'string' && player.id !== null && typeof player.id !== 'undefined')
    .map(player => ({ id: player.id, name: player.name.trim() }))
    .filter(player => player.name.length > 0)
    .sort((a, b) => compareStrings(String(a.id), String(b.id)));
}

function getTeamPlayerIds(team, playerIdSet) {
  return (Array.isArray(team) ? team : [])
    .map(player => String(player?.id ?? ''))
    .filter(id => id && playerIdSet.has(id));
}

function getSortedTeamIds(team) {
  return (Array.isArray(team) ? team : [])
    .map(player => String(player?.id ?? ''))
    .filter(Boolean)
    .sort(compareStrings);
}

function hasUsableScore(game) {
  const red = Number(game?.scoreRed);
  const blue = Number(game?.scoreBlue);
  return Number.isFinite(red) && Number.isFinite(blue) && red >= 0 && blue >= 0 && red + blue > 0;
}

function normalizeScoreValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function weightedSum(theta, weights) {
  return weights.reduce((sum, { index, weight }) => sum + theta[index] * weight, 0);
}

function sigmoid(value) {
  if (value >= MAX_EXP_ARG) return 1 - EPSILON;
  if (value <= -MAX_EXP_ARG) return EPSILON;
  return 1 / (1 + Math.exp(-value));
}

function clampProbability(value) {
  return Math.min(1 - EPSILON, Math.max(EPSILON, value));
}

function logGamma(z) {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  }

  let x = 0.99999999999980993;
  const shifted = z - 1;
  for (let i = 0; i < coefficients.length; i += 1) {
    x += coefficients[i] / (shifted + i + 1);
  }
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function digamma(x) {
  let value = x;
  let result = 0;
  while (value < 8) {
    result -= 1 / value;
    value += 1;
  }
  const inv = 1 / value;
  const inv2 = inv * inv;
  return result + Math.log(value) - 0.5 * inv - inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 / 252));
}

function choleskyDecompose(matrix) {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i][j];
      for (let k = 0; k < j; k += 1) sum -= lower[i][k] * lower[j][k];
      if (i === j) {
        if (!(sum > 0) || !Number.isFinite(sum)) return null;
        lower[i][j] = Math.sqrt(sum);
      } else {
        lower[i][j] = sum / lower[j][j];
      }
    }
  }
  return lower;
}

function invertFromCholesky(lower) {
  const n = lower.length;
  const inverse = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let col = 0; col < n; col += 1) {
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let sum = i === col ? 1 : 0;
      for (let k = 0; k < i; k += 1) sum -= lower[i][k] * y[k];
      y[i] = sum / lower[i][i];
    }

    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i -= 1) {
      let sum = y[i];
      for (let k = i + 1; k < n; k += 1) sum -= lower[k][i] * x[k];
      x[i] = sum / lower[i][i];
    }

    for (let row = 0; row < n; row += 1) inverse[row][col] = x[row];
  }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const sym = 0.5 * (inverse[i][j] + inverse[j][i]);
      inverse[i][j] = sym;
      inverse[j][i] = sym;
    }
  }
  return inverse;
}

function identityMatrix(n) {
  return Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0);
    row[i] = 1;
    return row;
  });
}

function matrixVectorProduct(matrix, vector) {
  return matrix.map(row => dot(row, vector));
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function vectorNorm(vector) {
  return Math.sqrt(dot(vector, vector));
}

function subtractVectors(a, b) {
  return a.map((value, index) => value - b[index]);
}

function addScaledVector(a, b, scale) {
  return a.map((value, index) => value + b[index] * scale);
}

function assertFiniteArray(values, label) {
  if (!values.every(Number.isFinite)) throw new Error(`Non-finite ${label}.`);
}

function hashStableJson(value) {
  const json = stableStringify(value);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort(compareStrings).map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function compareStrings(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function createProgressReporter(onProgress) {
  let lastPercent = 0;
  return (percent, stage, message, diagnostics = {}) => {
    const nextPercent = Math.max(lastPercent, Math.min(100, Math.floor(percent)));
    lastPercent = nextPercent;
    onProgress?.({
      type: 'progress',
      stage,
      percent: nextPercent,
      message,
      diagnostics,
    });
  };
}
