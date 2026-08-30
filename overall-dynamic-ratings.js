import {
  BAYESIAN_DISPLAY_BASE,
  BAYESIAN_DISPLAY_SCALE,
  BAYESIAN_POOLED_LEAGUE_OPPONENT_ID,
  BAYESIAN_POOLED_LEAGUE_OPPONENT_NAME,
  createGameFingerprintMap,
  createGameFingerprint,
  createPlayerEntityFingerprint,
  getStableGameIdentity,
  sortBayesianRatings,
} from "./bayesian-ratings.js";

export const OVERALL_DYNAMIC_MODEL_VERSION =
  "overall-session-exposure-hierarchical-v1";
export const OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION = 3;
export const OVERALL_DYNAMIC_SNAPSHOT_STORAGE_KEY =
  "gameDayBayesianScoreboardSnapshotV4:overall-session-exposure";
export const OVERALL_DYNAMIC_N_EFF = 10;
export const OVERALL_DYNAMIC_SESSION_EXPOSURE_INCREMENT = 0.25;
export const OVERALL_DYNAMIC_EXPOSURE_CURVE_SCALE = 75;
export const OVERALL_DYNAMIC_POPULATION_RATE_CENTER_PUBLIC = 1;
export const OVERALL_DYNAMIC_POPULATION_RATE_SD_PUBLIC = 2;
export const OVERALL_DYNAMIC_PLAYER_DEVIATION_SD_PUBLIC = 3;
export const OVERALL_DYNAMIC_PROCESS_SD_PUBLIC = 20;
export const OVERALL_DYNAMIC_INITIAL_SD_PUBLIC = 45;
export const OVERALL_DYNAMIC_CONTEXT_SD_PUBLIC = 25;
export const OVERALL_DYNAMIC_BRACKET_DATES = ["2026-08-19", "2026-08-20"];
export const OVERALL_DYNAMIC_PUBLIC_POINTS_PER_RAW_ORDINAL = 50;
export const OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT =
  BAYESIAN_DISPLAY_SCALE * OVERALL_DYNAMIC_PUBLIC_POINTS_PER_RAW_ORDINAL;
export const OVERALL_DYNAMIC_MONTHLY_SD_DISPLAY =
  OVERALL_DYNAMIC_PROCESS_SD_PUBLIC;
export const OVERALL_DYNAMIC_MONTHLY_SD_LATENT =
  OVERALL_DYNAMIC_PROCESS_SD_PUBLIC / OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT;
export const OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS = 30;
export const OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR = "2000-01-03";
const EPS = 1e-9;

export function getDynamicLeagueIndividualEffectiveSize(
  games = [],
  gameFingerprints = {},
) {
  const sizes = (Array.isArray(games) ? games : []).flatMap((game, index) => {
    const id = getStableGameIdentity(game, index);
    if (
      !game?.isLeagueGame ||
      !id ||
      gameFingerprints?.[id] !== createGameFingerprint(game, id)
    )
      return [];
    const n = game.redTeam?.length || 0;
    return n > 0 ? [n] : [];
  });
  return sizes.length / sizes.reduce((sum, n) => sum + 1 / n, 0) || 1;
}
export function formatDynamicLeagueIndividualRating(
  pooledRating,
  games = [],
  gameFingerprints = {},
) {
  if (pooledRating?.leagueRatingIsIndividual) {
    return {
      ...pooledRating,
      name: "League Player",
      isLeagueContext: true,
      isSynthetic: true,
    };
  }
  const n = getDynamicLeagueIndividualEffectiveSize(games, gameFingerprints),
    mu = Number(pooledRating?.mu) || BAYESIAN_DISPLAY_BASE,
    sigma = Math.max(1e-6, (Number(pooledRating?.sigma) || 0) * Math.sqrt(n));
  return {
    ...pooledRating,
    name: "League Player",
    mu,
    sigma,
    ordinal: mu - 3 * sigma,
    leagueIndividualEffectiveSize: n,
    isLeagueContext: true,
    isSynthetic: true,
  };
}
export function getOverallDynamicWeeklyBucketKey(date) {
  const t = dayMs(date),
    anchor = dayMs(OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR);
  return Number.isFinite(t)
    ? new Date(anchor + Math.floor((t - anchor) / 604800000) * 604800000)
        .toISOString()
        .slice(0, 10)
    : OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR;
}
export function getOverallDynamicWeeklyInterpolation(a, b, date) {
  return Math.max(
    0,
    Math.min(1, (dayMs(date) - dayMs(a)) / Math.max(1, dayMs(b) - dayMs(a))),
  );
}
export function getOverallDynamicWeeklyTransitionVariance(a, b) {
  return transitionVariance(a, b);
}
export function getOverallDynamicSessionExposure(gamesOnDate) {
  return (
    1 +
    OVERALL_DYNAMIC_SESSION_EXPOSURE_INCREMENT *
      Math.max(0, Number(gamesOnDate || 0) - 1)
  );
}
export function getOverallDynamicCumulativeExposureTransform(exposure) {
  return (
    OVERALL_DYNAMIC_EXPOSURE_CURVE_SCALE *
    Math.log1p(
      Math.max(0, Number(exposure) || 0) / OVERALL_DYNAMIC_EXPOSURE_CURVE_SCALE,
    )
  );
}

export function calculateOverallDynamicScoreboard({
  players = [],
  games = [],
  onProgress = null,
} = {}) {
  const progress = (percent, stage, message, diagnostics = {}) =>
    onProgress?.({ type: "progress", percent, stage, message, diagnostics });
  progress(
    2,
    "validate",
    "Validating Overall games and building appearance-date states",
  );
  const z = indexInput(players, games);
  progress(
    15,
    "build",
    `Building session-weighted Overall model from ${z.observations.length} games`,
    z.counts,
  );
  const solved = solveNewton(z, progress);
  progress(82, "posterior", "Estimating state and player-rate uncertainty");
  const posteriorFactor = factorize(solved.hessian);
  const posterior = marginalVariances(posteriorFactor, z.allIndexes);
  const snapshot = {
    schemaVersion: OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION,
    modelVersion: OVERALL_DYNAMIC_MODEL_VERSION,
    calculatedAt: new Date().toISOString(),
    playerEntityFingerprint: createPlayerEntityFingerprint(players),
    gameFingerprints: createGameFingerprintMap(games),
    fingerprint: JSON.stringify({
      p: createPlayerEntityFingerprint(players),
      g: createGameFingerprintMap(games),
    }),
    gamesConsidered: z.observations.length,
    scoredGames: z.counts.scoredGames,
    winnerOnlyGames: z.counts.winnerOnlyGames,
    skippedGames: z.counts.skippedGames,
    warnings: z.warnings,
    ratings: sortBayesianRatings(
      formatRatings(z, solved.x, posterior, posteriorFactor),
    ),
    history: formatHistory(z, solved.x, posterior),
    playerRates: formatPlayerRates(z, solved.x, posteriorFactor),
    diagnostics: {
      version: OVERALL_DYNAMIC_MODEL_VERSION,
      nEff: OVERALL_DYNAMIC_N_EFF,
      sessionExposureIncrement: OVERALL_DYNAMIC_SESSION_EXPOSURE_INCREMENT,
      exposureCurveScale: OVERALL_DYNAMIC_EXPOSURE_CURVE_SCALE,
      processSdPublic: OVERALL_DYNAMIC_PROCESS_SD_PUBLIC,
      publicPointsPerLatent: OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
      leagueGamesIncluded: z.counts.leagueGames,
      bracketLeagueGamesIncluded: z.counts.bracketLeagueGames,
      leagueContexts: z.contextKeys,
      fittedLeagueContexts: Object.fromEntries(
        [...z.contextIndexes].map(([key, index]) => [
          key,
          solved.x[index] * OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
        ]),
      ),
      bracketPublic:
        solved.x[z.bracketIndex] * OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
      optimizer: solved.diagnostics,
      posterior,
      dimensions: {
        total: z.dimension,
        appearanceStates: z.stateCount,
        leagueContexts: z.contextIndexes.size,
        bracket: 1,
        populationRate: 1,
        playerDeviations: z.deviationIndexes.size,
      },
    },
    constants: {
      displayBase: BAYESIAN_DISPLAY_BASE,
      displayScale: BAYESIAN_DISPLAY_SCALE,
      publicPointsPerRawOrdinal: OVERALL_DYNAMIC_PUBLIC_POINTS_PER_RAW_ORDINAL,
    },
  };
  validateOverallDynamicSnapshot(snapshot);
  progress(
    100,
    "complete",
    "Session-weighted Overall scoreboard saved",
    snapshot.diagnostics,
  );
  return snapshot;
}

export function validateOverallDynamicSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.schemaVersion !== OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION ||
    snapshot.modelVersion !== OVERALL_DYNAMIC_MODEL_VERSION
  )
    throw new Error("Unsupported dynamic Overall snapshot schema.");
  if (
    !Array.isArray(snapshot.ratings) ||
    !snapshot.history ||
    typeof snapshot.history !== "object" ||
    !snapshot.playerRates
  )
    throw new Error("Invalid dynamic Overall snapshot.");
  if (snapshot.diagnostics?.optimizer?.converged !== true)
    throw new Error("Dynamic Overall snapshot was not converged.");
  for (const row of snapshot.ratings) {
    for (const key of ["mu", "sigma", "ordinal", "games", "wins", "winrate"])
      if (!Number.isFinite(Number(row[key])))
        throw new Error(`Invalid dynamic Overall rating field: ${key}`);
    if (
      !(row.sigma > 0) ||
      Math.abs(row.ordinal - (row.mu - 3 * row.sigma)) > 1e-9
    )
      throw new Error("Invalid dynamic Overall confidence transform.");
  }
  for (const [id, knots] of Object.entries(snapshot.history)) {
    if (
      !Array.isArray(knots) ||
      !knots.length ||
      id === BAYESIAN_POOLED_LEAGUE_OPPONENT_ID
    )
      throw new Error("Invalid dynamic Overall history.");
    let previous = "";
    for (const knot of knots) {
      if (
        String(knot.date) <= previous ||
        ![
          "central",
          "mu",
          "sigma",
          "ordinal",
          "variance",
          "games",
          "exposureBefore",
          "exposureAfter",
          "deltaH",
        ].every((key) => Number.isFinite(Number(knot[key])))
      )
        throw new Error("Invalid dynamic Overall history knot.");
      if (
        knot.games < 0 ||
        knot.exposureAfter < knot.exposureBefore ||
        knot.deltaH < 0
      )
        throw new Error("Invalid dynamic Overall history exposure.");
      previous = String(knot.date);
    }
  }
  if (
    !Array.isArray(snapshot.playerRates.players) ||
    !Number.isFinite(snapshot.playerRates.population?.rate) ||
    !Number.isFinite(snapshot.playerRates.population?.sigma)
  )
    throw new Error("Invalid dynamic Overall rate posterior.");
  for (const rate of snapshot.playerRates.players)
    for (const key of [
      "rate",
      "sigma",
      "deviation",
      "appearanceDates",
      "transitionCount",
    ])
      if (!Number.isFinite(Number(rate[key])))
        throw new Error(`Invalid dynamic Overall player rate: ${key}`);
  return true;
}

function indexInput(players, games) {
  const ps = (Array.isArray(players) ? players : [])
      .filter((p) => p?.id != null && String(p.name || "").trim())
      .map((p) => ({ id: String(p.id), name: String(p.name).trim() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    known = new Set(ps.map((p) => p.id)),
    raw = [],
    warnings = [],
    counts = {
      scoredGames: 0,
      winnerOnlyGames: 0,
      skippedGames: 0,
      leagueGames: 0,
      bracketLeagueGames: 0,
    };
  (Array.isArray(games) ? games : []).forEach((game, i) => {
    const ids = (team) =>
        (Array.isArray(team) ? team : [])
          .map((p) => String(p?.id ?? ""))
          .filter((id) => known.has(id)),
      red = ids(game?.redTeam),
      blue = ids(game?.blueTeam),
      league = !!game?.isLeagueGame,
      date = gameDate(game),
      winner = game?.winner,
      sr = Number(game?.scoreRed),
      sb = Number(game?.scoreBlue),
      scored =
        Number.isFinite(sr) &&
        Number.isFinite(sb) &&
        sr >= 0 &&
        sb >= 0 &&
        sr + sb > 0;
    if (
      !date ||
      !red.length ||
      (!league && !blue.length) ||
      (!scored && winner !== "red" && winner !== "blue")
    ) {
      counts.skippedGames++;
      warnings.push(
        `Skipped malformed game ${getStableGameIdentity(game, i)}.`,
      );
      return;
    }
    const bracket =
      league &&
      (game?.leaguePhase === "bracket" ||
        OVERALL_DYNAMIC_BRACKET_DATES.includes(date));
    raw.push({
      red,
      blue,
      league,
      bracket,
      contextKey: league
        ? String(game?.leagueOpponent?.id || "league-date-context")
        : null,
      q: scored
        ? Math.min(1 - EPS, Math.max(EPS, (sr + 0.5) / (sr + sb + 1)))
        : winner === "red"
          ? 1 - EPS
          : EPS,
      date,
      identity: getStableGameIdentity(game, i),
      winner,
    });
    if (scored) counts.scoredGames++;
    else counts.winnerOnlyGames++;
    if (league) {
      counts.leagueGames++;
      if (bracket) counts.bracketLeagueGames++;
    }
  });
  raw.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      String(a.identity).localeCompare(String(b.identity)),
  );
  const dates = new Map(ps.map((p) => [p.id, new Set()])),
    sessionGames = new Map();
  raw.forEach((o) =>
    [...o.red, ...o.blue].forEach((id) => {
      dates.get(id).add(o.date);
      const key = `${id}|${o.date}`;
      sessionGames.set(key, (sessionGames.get(key) || 0) + 1);
    }),
  );
  const stateIndexes = new Map(),
    playerStates = new Map();
  let dimension = 0;
  for (const p of ps) {
    const ds = [...dates.get(p.id)].sort();
    const states = ds.map((date) => ({
      date,
      index: dimension++,
      gamesOnDate: sessionGames.get(`${p.id}|${date}`) || 0,
    }));
    playerStates.set(p.id, states);
    states.forEach((s) => stateIndexes.set(`${p.id}|${s.date}`, s.index));
  }
  const contextKeys = [
      ...new Set(raw.filter((o) => o.league).map((o) => o.contextKey)),
    ].sort(),
    contextIndexes = new Map(contextKeys.map((k) => [k, dimension++])),
    bracketIndex = dimension++,
    populationIndex = dimension++,
    deviationIndexes = new Map(
      ps
        .filter((p) => playerStates.get(p.id).length > 1)
        .map((p) => [p.id, dimension++]),
    ),
    sessionMeta = new Map(),
    transitions = [];
  for (const p of ps) {
    let exposure = 0;
    const states = playerStates.get(p.id);
    states.forEach((state, i) => {
      const before = exposure,
        increment = getOverallDynamicSessionExposure(state.gamesOnDate),
        after = before + increment,
        deltaH =
          getOverallDynamicCumulativeExposureTransform(after) -
          getOverallDynamicCumulativeExposureTransform(before);
      sessionMeta.set(`${p.id}|${state.date}`, {
        ...state,
        exposureBefore: before,
        exposureAfter: after,
        exposureIncrement: increment,
        deltaH,
      });
      if (i + 1 < states.length)
        transitions.push({
          id: p.id,
          date: state.date,
          nextDate: states[i + 1].date,
          from: state.index,
          to: states[i + 1].index,
          deltaH,
        });
      exposure = after;
    });
  }
  const observations = raw.map((o) => ({
    ...o,
    redTerms: o.red.map((id) => ({
      index: stateIndexes.get(`${id}|${o.date}`),
      weight: 1 / o.red.length,
    })),
    blueTerms: o.league
      ? [
          { index: contextIndexes.get(o.contextKey), weight: 1 },
          ...(o.bracket ? [{ index: bracketIndex, weight: 1 }] : []),
        ]
      : o.blue.map((id) => ({
          index: stateIndexes.get(`${id}|${o.date}`),
          weight: 1 / o.blue.length,
        })),
  }));
  return {
    players: ps,
    observations,
    warnings,
    counts,
    playerStates,
    sessionMeta,
    transitions,
    latestIndexes: new Map(
      ps
        .filter((p) => playerStates.get(p.id).length)
        .map((p) => [p.id, playerStates.get(p.id).at(-1).index]),
    ),
    contextKeys,
    contextIndexes,
    bracketIndex,
    populationIndex,
    deviationIndexes,
    allIndexes: new Set([
      ...stateIndexes.values(),
      ...contextIndexes.values(),
      bracketIndex,
      populationIndex,
      ...deviationIndexes.values(),
    ]),
    stateCount: stateIndexes.size,
    dimension,
  };
}

function solveNewton(z, progress) {
  let x = new Array(z.dimension).fill(0),
    e = objectiveGradientHessian(x, z);
  for (let iteration = 0; iteration < 60; iteration++) {
    const norm = Math.hypot(...e.gradient);
    if (norm < 1e-6) {
      const f = factorize(e.hessian);
      return {
        x,
        hessian: e.hessian,
        diagnostics: {
          method: "analytic-newton-hessian-cholesky",
          converged: true,
          termination: "gradient",
          iterations: iteration,
          objective: e.objective,
          gradientNorm: norm,
          jitter: f.jitter,
        },
      };
    }
    const step = solveCholesky(factorize(e.hessian).lower, e.gradient).map(
      (v) => -v,
    );
    let scale = 1,
      next;
    while (scale > 1e-7) {
      const candidate = x.map((v, i) => v + scale * step[i]),
        probe = objectiveGradientHessian(candidate, z);
      if (probe.objective <= e.objective + 1e-10) {
        next = { x: candidate, e: probe };
        break;
      }
      scale /= 2;
    }
    if (!next)
      throw new Error(
        `Dynamic Overall optimization did not converge: line-search (gradient ${norm}).`,
      );
    x = next.x;
    e = next.e;
    progress(
      20 + Math.min(55, iteration),
      "optimize",
      `Optimizing session-weighted Overall skills — iteration ${iteration + 1}`,
      { iteration: iteration + 1, objective: e.objective, gradientNorm: norm },
    );
  }
  throw new Error(
    `Dynamic Overall optimization did not converge: max-iterations (gradient ${Math.hypot(...e.gradient)}).`,
  );
}
function objectiveGradientHessian(x, z) {
  const gradient = new Array(z.dimension).fill(0),
    hessian = Array.from({ length: z.dimension }, () =>
      new Array(z.dimension).fill(0),
    );
  let objective = 0;
  const prior = (terms, mean, sd) => {
    const precision = 1 / (sd * sd),
      delta = terms.reduce((s, t) => s + x[t.index] * t.weight, 0) - mean;
    objective += 0.5 * precision * delta * delta;
    for (const a of terms) {
      gradient[a.index] += precision * delta * a.weight;
      for (const b of terms)
        hessian[a.index][b.index] += precision * a.weight * b.weight;
    }
  };
  z.playerStates.forEach((states) => {
    if (states.length)
      prior(
        [{ index: states[0].index, weight: 1 }],
        0,
        OVERALL_DYNAMIC_INITIAL_SD_PUBLIC /
          OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
      );
  });
  z.contextIndexes.forEach((index) =>
    prior(
      [{ index, weight: 1 }],
      0,
      OVERALL_DYNAMIC_CONTEXT_SD_PUBLIC /
        OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
    ),
  );
  prior(
    [{ index: z.bracketIndex, weight: 1 }],
    0,
    OVERALL_DYNAMIC_CONTEXT_SD_PUBLIC /
      OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
  );
  prior(
    [{ index: z.populationIndex, weight: 1 }],
    OVERALL_DYNAMIC_POPULATION_RATE_CENTER_PUBLIC /
      OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
    OVERALL_DYNAMIC_POPULATION_RATE_SD_PUBLIC /
      OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
  );
  z.deviationIndexes.forEach((index) =>
    prior(
      [{ index, weight: 1 }],
      0,
      OVERALL_DYNAMIC_PLAYER_DEVIATION_SD_PUBLIC /
        OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
    ),
  );
  z.transitions.forEach((t) => {
    const terms = [
        { index: t.to, weight: 1 },
        { index: t.from, weight: -1 },
        { index: z.populationIndex, weight: -t.deltaH },
      ],
      d = z.deviationIndexes.get(t.id);
    if (d != null) terms.push({ index: d, weight: -t.deltaH });
    prior(terms, 0, Math.sqrt(transitionVariance(t.date, t.nextDate)));
  });
  z.observations.forEach((o) => {
    const terms = [
        ...o.redTerms,
        ...o.blueTerms.map((t) => ({ ...t, weight: -t.weight })),
      ],
      eta = terms.reduce((s, t) => s + x[t.index] * t.weight, 0),
      p = sigmoid(eta),
      g = OVERALL_DYNAMIC_N_EFF * (p - o.q),
      w = OVERALL_DYNAMIC_N_EFF * p * (1 - p);
    objective += OVERALL_DYNAMIC_N_EFF * (softplus(eta) - o.q * eta);
    for (const a of terms) {
      gradient[a.index] += g * a.weight;
      for (const b of terms)
        hessian[a.index][b.index] += w * a.weight * b.weight;
    }
  });
  return { objective, gradient, hessian };
}
function formatRatings(z, x, posterior, factor) {
  const stats = new Map(z.players.map((p) => [p.id, { games: 0, wins: 0 }]));
  let league = { games: 0, wins: 0 };
  z.observations.forEach((o) => {
    [...o.red, ...o.blue].forEach((id) => {
      const s = stats.get(id);
      s.games++;
      if (
        (o.winner === "red" && o.red.includes(id)) ||
        (o.winner === "blue" && o.blue.includes(id))
      )
        s.wins++;
    });
    if (o.league) {
      league.games++;
      if (o.winner === "blue") league.wins++;
    }
  });
  const rows = z.players.map((p) => {
    const index = z.latestIndexes.get(p.id);
    return asRating(
      p.id,
      p.name,
      index == null ? 0 : x[index],
      index == null
        ? (OVERALL_DYNAMIC_INITIAL_SD_PUBLIC /
            OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT) **
            2
        : (posterior.variances[index] ?? 1),
      stats.get(p.id),
    );
  });
  const leagueObservations = z.observations.filter((o) => o.league);
  const individualLeagueRows = leagueObservations.map((observation) => {
    const latent = observation.blueTerms.reduce(
      (sum, term) => sum + x[term.index] * term.weight,
      0,
    );
    const variance = marginalVariance(factor, observation.blueTerms);
    const rosterSize = Math.max(1, observation.red.length);
    return {
      latent,
      sigma: BAYESIAN_DISPLAY_SCALE * Math.sqrt(variance * rosterSize),
    };
  });
  const leagueLatent = individualLeagueRows.reduce(
    (sum, item) => sum + item.latent,
    0,
  ) / Math.max(1, individualLeagueRows.length);
  const leagueSigma = individualLeagueRows.reduce(
    (sum, item) => sum + item.sigma,
    0,
  ) / Math.max(1, individualLeagueRows.length);
  rows.push(
    asRating(
      BAYESIAN_POOLED_LEAGUE_OPPONENT_ID,
      BAYESIAN_POOLED_LEAGUE_OPPONENT_NAME,
      leagueLatent,
      (leagueSigma / BAYESIAN_DISPLAY_SCALE) ** 2,
      league,
      {
        isLeagueContext: true,
        isSynthetic: true,
        leagueRatingIsIndividual: true,
      },
    ),
  );
  return rows;
}
function asRating(id, name, latent, variance, stats, extra = {}) {
  const mu = BAYESIAN_DISPLAY_BASE + BAYESIAN_DISPLAY_SCALE * latent,
    sigma = Math.max(
      1e-6,
      BAYESIAN_DISPLAY_SCALE * Math.sqrt(Math.max(0, variance)),
    );
  return {
    id,
    name,
    mu,
    sigma,
    ordinal: mu - 3 * sigma,
    games: stats.games,
    wins: stats.wins,
    winrate: stats.games ? stats.wins / stats.games : 0,
    ...extra,
  };
}
function formatHistory(z, x, posterior) {
  const out = {};
  z.players.forEach((p) => {
    const states = z.playerStates.get(p.id);
    if (!states.length) return;
    out[p.id] = states.map((state) => {
      const meta = z.sessionMeta.get(`${p.id}|${state.date}`),
        variance = posterior.variances[state.index] ?? 1,
        mu = BAYESIAN_DISPLAY_BASE + BAYESIAN_DISPLAY_SCALE * x[state.index],
        sigma = BAYESIAN_DISPLAY_SCALE * Math.sqrt(Math.max(0, variance)),
        games = z.observations.reduce(
          (n, o) =>
            n +
            (o.date <= state.date &&
            (o.red.includes(p.id) || o.blue.includes(p.id))
              ? 1
              : 0),
          0,
        );
      return {
        date: state.date,
        central: mu,
        mu,
        sigma,
        variance,
        ordinal: mu - 3 * sigma,
        games,
        exposureBefore: meta.exposureBefore,
        exposureAfter: meta.exposureAfter,
        deltaH: meta.deltaH,
      };
    });
  });
  return out;
}
function formatPlayerRates(z, x, factor) {
  const populationTerms = [{ index: z.populationIndex, weight: 1 }],
    populationVariance = marginalVariance(factor, populationTerms);
  return {
    population: {
      rate: x[z.populationIndex] * OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
      sigma:
        Math.sqrt(populationVariance) *
        OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
    },
    players: z.players.map((p) => {
      const d = z.deviationIndexes.get(p.id),
        terms = [
          ...populationTerms,
          ...(d == null ? [] : [{ index: d, weight: 1 }]),
        ],
        variance = marginalVariance(factor, terms),
        states = z.playerStates.get(p.id);
      return {
        id: p.id,
        name: p.name,
        rate:
          terms.reduce((s, t) => s + x[t.index] * t.weight, 0) *
          OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
        sigma: Math.sqrt(variance) * OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
        deviation:
          d == null ? 0 : x[d] * OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
        appearanceDates: states.length,
        transitionCount: Math.max(0, states.length - 1),
        independentlyEstimated: d != null,
      };
    }),
  };
}
function transitionVariance(a, b) {
  const days = Math.max(1, (dayMs(b) - dayMs(a)) / 86400000),
    sd =
      (OVERALL_DYNAMIC_PROCESS_SD_PUBLIC /
        OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT) *
      Math.sqrt(days / OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS);
  return sd * sd;
}
function dayMs(date) {
  return new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getTime();
}
function gameDate(game) {
  const d = new Date(
    String(game?.date || game?.gameDate || game?.createdAt || ""),
  );
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}
function latestDate(raw) {
  return raw.reduce(
    (latest, item) => (item.date > latest ? item.date : latest),
    "",
  );
}
function sigmoid(x) {
  return x > 35 ? 1 - EPS : x < -35 ? EPS : 1 / (1 + Math.exp(-x));
}
function softplus(x) {
  return x > 35 ? x : Math.log1p(Math.exp(x));
}
function factorize(matrix) {
  for (const jitter of [0, 1e-10, 1e-8, 1e-6, 1e-4]) {
    const lower = cholesky(
      matrix.map((row, i) => row.map((v, j) => v + (i === j ? jitter : 0))),
    );
    if (lower) return { lower, jitter };
  }
  throw new Error("Dynamic Overall Hessian is ill-conditioned.");
}
function cholesky(a) {
  const n = a.length,
    l = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = a[i][j];
      for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return null;
        l[i][j] = Math.sqrt(s);
      } else l[i][j] = s / l[j][j];
    }
  return l;
}
function solveCholesky(l, b) {
  const n = l.length,
    y = new Array(n),
    x = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= l[i][k] * y[k];
    y[i] = s / l[i][i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= l[k][i] * x[k];
    x[i] = s / l[i][i];
  }
  return x;
}
function marginalVariances(factor, indexes) {
  const variances = {};
  for (const index of indexes) {
    const unit = new Array(factor.lower.length).fill(0);
    unit[index] = 1;
    variances[index] = Math.max(0, solveCholesky(factor.lower, unit)[index]);
  }
  return {
    method: "analytic-hessian-cholesky-marginals",
    jitter: factor.jitter,
    variances,
  };
}
function marginalVariance(factor, terms) {
  const rhs = new Array(factor.lower.length).fill(0);
  terms.forEach((t) => {
    rhs[t.index] += t.weight;
  });
  const solution = solveCholesky(factor.lower, rhs);
  return Math.max(
    0,
    terms.reduce((sum, t) => sum + t.weight * solution[t.index], 0),
  );
}
