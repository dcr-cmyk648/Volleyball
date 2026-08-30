import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateOverallDynamicScoreboard,
  formatDynamicLeagueIndividualRating,
  getDynamicLeagueIndividualEffectiveSize,
  getOverallDynamicCumulativeExposureTransform,
  getOverallDynamicSessionExposure,
  getOverallDynamicWeeklyBucketKey,
  getOverallDynamicWeeklyInterpolation,
  getOverallDynamicWeeklyTransitionVariance,
  OVERALL_DYNAMIC_BRACKET_DATES,
  OVERALL_DYNAMIC_LEAGUE_INDIVIDUAL_SIGMA_FLOOR,
  OVERALL_DYNAMIC_MODEL_VERSION,
  OVERALL_DYNAMIC_N_EFF,
  OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS,
  OVERALL_DYNAMIC_MONTHLY_SD_LATENT,
  OVERALL_DYNAMIC_PLAYER_DEVIATION_SD_PUBLIC,
  OVERALL_DYNAMIC_POPULATION_RATE_CENTER_PUBLIC,
  OVERALL_DYNAMIC_POPULATION_RATE_SD_PUBLIC,
  OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
  OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION,
  OVERALL_DYNAMIC_SNAPSHOT_STORAGE_KEY,
  validateOverallDynamicSnapshot,
} from "../overall-dynamic-ratings.js";
import { BAYESIAN_POOLED_LEAGUE_OPPONENT_ID } from "../bayesian-ratings.js";

const player = (id, name = id) => ({ id, name });
const league = (
  id,
  date,
  redTeam,
  winner = "red",
  scoreRed = winner === "red" ? 25 : 18,
  scoreBlue = winner === "red" ? 18 : 25,
  extra = {},
) => ({
  id,
  createdAt: date,
  redTeam,
  blueTeam: [],
  winner,
  scoreRed,
  scoreBlue,
  isLeagueGame: true,
  ...extra,
});
const internal = (
  id,
  date,
  redTeam,
  blueTeam,
  winner = "red",
  scoreRed = 25,
  scoreBlue = 18,
) => ({ id, createdAt: date, redTeam, blueTeam, winner, scoreRed, scoreBlue });
const row = (snapshot, id) =>
  snapshot.ratings.find((candidate) => candidate.id === id);
const rate = (snapshot, id) =>
  snapshot.playerRates.players.find((candidate) => candidate.id === id);

test("exposure math and public/latent conversions are exact", () => {
  assert.equal(getOverallDynamicSessionExposure(1), 1);
  assert.equal(getOverallDynamicSessionExposure(5), 2);
  assert.equal(getOverallDynamicCumulativeExposureTransform(0), 0);
  assert.equal(
    getOverallDynamicCumulativeExposureTransform(75),
    75 * Math.log(2),
  );
  assert.equal(
    OVERALL_DYNAMIC_POPULATION_RATE_CENTER_PUBLIC /
      OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
    1 / OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
  );
  assert.equal(
    OVERALL_DYNAMIC_POPULATION_RATE_SD_PUBLIC /
      OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
    2 / OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
  );
  assert.equal(
    OVERALL_DYNAMIC_PLAYER_DEVIATION_SD_PUBLIC /
      OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
    3 / OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
  );
});

test("same-day games share an entry state and only alter their outgoing exposure", () => {
  const a = player("a"),
    b = player("b");
  const base = [
    league("1", "2026-01-01", [a]),
    league("2", "2026-01-02", [a]),
    league("3", "2026-02-01", [a]),
    league("4", "2026-01-01", [b]),
    league("5", "2026-02-01", [b]),
  ];
  const extraSameDay = [...base, league("same-day-extra", "2026-01-02", [a])];
  const first = calculateOverallDynamicScoreboard({
    players: [a, b],
    games: base,
  });
  const second = calculateOverallDynamicScoreboard({
    players: [a, b],
    games: extraSameDay,
  });
  assert.deepEqual(
    first.history.a.map((k) => k.date),
    ["2026-01-01", "2026-01-02", "2026-02-01"],
  );
  assert.equal(first.history.a[1].exposureBefore, 1);
  assert.equal(first.history.a[1].exposureAfter, 2);
  assert.equal(second.history.a[1].exposureAfter, 2.25);
  assert.equal(
    second.history.a.length,
    first.history.a.length,
    "additional same-day games do not create another entry state",
  );
  assert.notEqual(
    first.history.a[2].exposureBefore,
    second.history.a[2].exposureBefore,
    "completed session affects only later transition exposure",
  );
});

test("all league contexts retain N=10/full likelihood and bracket dates are in-model", () => {
  const a = player("a");
  const games = [
    league("normal", "2026-08-18", [a], "red", 25, 20, {
      leagueOpponent: { id: "stable-outside" },
    }),
    league("bracket", OVERALL_DYNAMIC_BRACKET_DATES[0], [a], "blue", 20, 25, {
      leagueOpponent: { id: "stable-outside" },
    }),
    league("source-bracket", "2026-09-01", [a], "red", 25, 20, {
      leagueOpponent: { id: "stable-outside" },
      leaguePhase: "bracket",
    }),
    league("other", "2026-08-21", [a], "red", 25, 19, {
      leagueOpponent: { id: "other-outside" },
    }),
  ];
  const snapshot = calculateOverallDynamicScoreboard({ players: [a], games });
  assert.equal(snapshot.diagnostics.nEff, OVERALL_DYNAMIC_N_EFF);
  assert.equal(snapshot.diagnostics.leagueGamesIncluded, 4);
  assert.equal(snapshot.diagnostics.bracketLeagueGamesIncluded, 2);
  assert.deepEqual(snapshot.diagnostics.leagueContexts, [
    "other-outside",
    "stable-outside",
  ]);
  assert.equal(row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID).games, 4);
});

test("partially pooled player rates are deterministic, finite, and sparse players inherit population", () => {
  const a = player("a"),
    b = player("b"),
    sparse = player("sparse");
  const games = [
    league("1", "2026-01-01", [a], "blue"),
    league("2", "2026-02-01", [a], "red"),
    league("3", "2026-03-01", [a], "red"),
    league("4", "2026-01-01", [b], "red"),
    league("5", "2026-02-01", [b], "blue"),
    league("6", "2026-03-01", [b], "blue"),
    league("7", "2026-01-01", [sparse], "red"),
  ];
  const one = calculateOverallDynamicScoreboard({
    players: [a, b, sparse],
    games,
  });
  const two = calculateOverallDynamicScoreboard({
    players: [a, b, sparse],
    games,
  });
  assert.deepEqual(one.ratings, two.ratings);
  assert.deepEqual(one.playerRates, two.playerRates);
  assert.equal(rate(one, "sparse").independentlyEstimated, false);
  assert.equal(rate(one, "sparse").rate, one.playerRates.population.rate);
  for (const entry of one.playerRates.players)
    assert.ok(
      Number.isFinite(entry.rate) &&
        Number.isFinite(entry.sigma) &&
        entry.sigma > 0,
    );
});

test("constructed improving, stable, and declining fixtures recover different-rate ordering", () => {
  const up = player("up"),
    flat = player("flat"),
    down = player("down");
  const dates = Array.from(
    { length: 10 },
    (_, index) => `2026-${String(index + 1).padStart(2, "0")}-01`,
  );
  const games = dates.flatMap((date, index) =>
    Array.from({ length: 10 }, (_, gameIndex) => [
      league(`u${index}-${gameIndex}`, date, [up], index < 5 ? "blue" : "red"),
      league(
        `f${index}-${gameIndex}`,
        date,
        [flat],
        index % 2 ? "blue" : "red",
      ),
      league(
        `d${index}-${gameIndex}`,
        date,
        [down],
        index < 5 ? "red" : "blue",
      ),
    ]).flat(),
  );
  const snapshot = calculateOverallDynamicScoreboard({
    players: [up, flat, down],
    games,
  });
  assert.ok(rate(snapshot, "up").rate > rate(snapshot, "flat").rate);
  assert.ok(rate(snapshot, "flat").rate > rate(snapshot, "down").rate);
  assert.ok(snapshot.history.up.at(-1).mu > snapshot.history.up[0].mu);
  assert.ok(
    snapshot.history.down.at(-1).mu < snapshot.history.down[0].mu,
    "no downside constraint permits genuine decline",
  );
});

test("snapshot has a new Overall-only identity, rejects weekly-v3, and round-trips", () => {
  const a = player("a"),
    snapshot = calculateOverallDynamicScoreboard({
      players: [a],
      games: [league("1", "2026-01-01", [a])],
    });
  assert.equal(snapshot.schemaVersion, OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.modelVersion, OVERALL_DYNAMIC_MODEL_VERSION);
  assert.equal(
    OVERALL_DYNAMIC_SNAPSHOT_STORAGE_KEY,
    "gameDayBayesianScoreboardSnapshotV4:overall-session-exposure",
  );
  assert.equal(
    validateOverallDynamicSnapshot(JSON.parse(JSON.stringify(snapshot))),
    true,
  );
  assert.throws(() =>
    validateOverallDynamicSnapshot({ ...snapshot, schemaVersion: 2 }),
  );
  assert.throws(() =>
    validateOverallDynamicSnapshot({
      ...snapshot,
      modelVersion: "overall-dynamic-weekly-v3",
    }),
  );
});

test("league individual interpretation remains roster-size scoped and static games remain normal observations", () => {
  const a = player("a"),
    b = player("b");
  const games = [
    league("l", "2026-01-01", [a, a, a, a, a]),
    internal("i", "2026-01-02", [a], [b]),
  ];
  const snapshot = calculateOverallDynamicScoreboard({
    players: [a, b],
    games,
  });
  const pooled = row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID),
    individual = formatDynamicLeagueIndividualRating(
      pooled,
      games,
      snapshot.gameFingerprints,
    );
  assert.equal(
    getDynamicLeagueIndividualEffectiveSize(games, snapshot.gameFingerprints),
    5,
  );
  assert.equal(individual.sigma, Math.hypot(pooled.sigma, 3.75));
  assert.equal(individual.mu, pooled.mu);
  assert.ok(individual.sigma >= OVERALL_DYNAMIC_LEAGUE_INDIVIDUAL_SIGMA_FLOOR);
  assert.deepEqual(
    formatDynamicLeagueIndividualRating(
      individual,
      games,
      snapshot.gameFingerprints,
    ),
    individual,
  );
  assert.equal(individual.leagueRatingIsIndividual, true);
  assert.equal(row(snapshot, "b").games, 1);
});

test("League Player uncertainty is fingerprint-scoped across mixed roster sizes", () => {
  const games = [5, 6, 7, 8].map((size, index) =>
    league(
      `league-${size}`,
      `2026-01-0${index + 1}`,
      Array.from({ length: size }, (_, playerIndex) =>
        player(`${index}-${playerIndex}`),
      ),
    ),
  );
  const players = games.flatMap((game) => game.redTeam);
  const snapshot = calculateOverallDynamicScoreboard({ players, games });
  const pooled = row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID);
  const nEff = 4 / (1 / 5 + 1 / 6 + 1 / 7 + 1 / 8);
  const individual = formatDynamicLeagueIndividualRating(
    pooled,
    games,
    snapshot.gameFingerprints,
  );
  assert.equal(
    getDynamicLeagueIndividualEffectiveSize(games, snapshot.gameFingerprints),
    nEff,
  );
  assert.equal(individual.sigma, Math.hypot(pooled.sigma, 3.75));
  assert.equal(individual.leagueRatingIsIndividual, true);
  assert.equal(
    getDynamicLeagueIndividualEffectiveSize(
      [{ ...games[0], scoreRed: 24 }],
      snapshot.gameFingerprints,
    ),
    1,
  );
});

test("League Player irreducible variance is idempotent for cached individual rows", () => {
  const a = player("a"),
    b = player("b");
  const games = [
    league("l", "2026-01-01", [a, a, a, a, a]),
    internal("i", "2026-01-02", [a], [b]),
  ];
  const snapshot = calculateOverallDynamicScoreboard({ players: [a, b], games });
  const stored = row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID);
  const first = formatDynamicLeagueIndividualRating(
    stored,
    games,
    snapshot.gameFingerprints,
  );
  const cached = {
    ...first,
    leagueRatingIsIndividual: false,
    leagueRatingHasIrreducibleVariance: true,
  };
  const restored = formatDynamicLeagueIndividualRating(
    cached,
    games,
    snapshot.gameFingerprints,
  );

  assert.equal(first.mu, stored.mu);
  assert.equal(
    first.sigma,
    Math.hypot(stored.sigma, OVERALL_DYNAMIC_LEAGUE_INDIVIDUAL_SIGMA_FLOOR),
  );
  assert.ok(first.sigma >= OVERALL_DYNAMIC_LEAGUE_INDIVIDUAL_SIGMA_FLOOR);
  assert.equal(restored.mu, first.mu);
  assert.equal(restored.sigma, first.sigma);
  assert.equal(restored.ordinal, first.ordinal);
});

test("history endpoints, posterior uncertainty, order, and sparse/no-league behavior remain valid", () => {
  const a = player("a"),
    b = player("b"),
    unused = player("unused");
  const games = [
    internal("i1", "2026-01-01", [a], [b]),
    league("l1", "2026-02-01", [a]),
    league("l2", "2026-03-01", [a], "blue"),
  ];
  const snapshot = calculateOverallDynamicScoreboard({
    players: [a, b, unused],
    games,
  });
  const reordered = calculateOverallDynamicScoreboard({
    players: [a, b, unused],
    games: [...games].reverse(),
  });
  for (const id of ["a", "b"]) {
    const latest = snapshot.history[id].at(-1);
    const rating = row(snapshot, id);
    for (const key of ["mu", "sigma", "ordinal"])
      assert.equal(latest[key], rating[key]);
  }
  assert.deepEqual(snapshot.ratings, reordered.ratings);
  assert.equal(snapshot.history.unused, undefined);
  assert.equal(row(snapshot, "unused").games, 0);
  assert.equal(
    row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID).isSynthetic,
    true,
  );
  const fewer = calculateOverallDynamicScoreboard({
    players: [a, b],
    games: games.slice(0, 2),
  });
  assert.ok(
    row(snapshot, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID).sigma <
      row(fewer, BAYESIAN_POOLED_LEAGUE_OPPONENT_ID).sigma,
  );
  for (const knot of Object.values(snapshot.history).flat())
    assert.ok(Number.isFinite(knot.variance) && knot.variance > 0);
});

test("weekly integration helpers retain their anchor and transition math", () => {
  assert.equal(getOverallDynamicWeeklyBucketKey("2026-01-04"), "2025-12-29");
  assert.equal(getOverallDynamicWeeklyBucketKey("2026-01-05"), "2026-01-05");
  assert.equal(
    getOverallDynamicWeeklyInterpolation(
      "2026-01-05",
      "2026-01-19",
      "2026-01-12",
    ),
    0.5,
  );
  assert.equal(
    getOverallDynamicWeeklyTransitionVariance("2026-01-05", "2026-02-04"),
    OVERALL_DYNAMIC_MONTHLY_SD_LATENT ** 2,
  );
  assert.equal(OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS, 30);
});

test("snapshot validation rejects invalid history", () => {
  const a = player("a");
  const snapshot = calculateOverallDynamicScoreboard({
    players: [a],
    games: [league("1", "2026-01-01", [a])],
  });
  assert.throws(
    () =>
      validateOverallDynamicSnapshot({
        ...snapshot,
        history: {
          ...snapshot.history,
          a: [{ ...snapshot.history.a[0], games: -1 }],
        },
      }),
    /history exposure/,
  );
});
