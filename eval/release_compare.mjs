// Fast release-gate comparison for rating model changes.
//
// Defaults:
//   - compares current working tree against DEPLOY_REF (default: origin/main)
//   - uses play-forward + back/explanatory quality on non-league games
//   - disables expensive Bayesian league features
//   - scores actual historical splits only; no exhaustive balancer search
//
// Run from eval/:
//   npm run release:compare
//
// Optional:
//   DEPLOY_REF=72323ec npm run release:compare
//   RELEASE_COMPARE_SCORING=balancer npm run release:compare

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadDatabase } from './database.mjs';
import { computeAccIQ, computeSinglePassAccIQ } from './metrics.mjs';
import * as currentRatings from '../ratings.js';

const deployRef = process.env.DEPLOY_REF || 'origin/main';
const scoringMode = process.env.RELEASE_COMPARE_SCORING || 'plain';
const seasonalTaperDays = Math.round(6 * 30.4375);

const PRIOR_SHARP_WEIGHTS = {
  topPlayerWeight: 0.30,
  secondPlayerWeight: 0.24,
  averageWeight: 0.02,
  depthWeight: 0.10,
  worstPlayerWeight: 0.34,
};

function loadDeployRatingsModule(ref) {
  const source = execFileSync('git', ['show', `${ref}:ratings.js`], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 5,
  });
  const dir = mkdtempSync(join(tmpdir(), 'vball-release-compare-'));
  const path = join(dir, 'ratings.js');
  writeFileSync(path, source, 'utf8');
  return import(`${pathToFileURL(path).href}?ref=${encodeURIComponent(ref)}&t=${Date.now()}`);
}

function isQualityGame(game) {
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

function isScored(game) {
  return typeof game?.scoreRed === 'number' && typeof game?.scoreBlue === 'number';
}

function createStats() {
  return {
    n: 0,
    correct: 0,
    brierSum: 0,
    scored: 0,
    marginErrSum: 0,
  };
}

function summarize(stats) {
  return {
    n: stats.n,
    accuracy: stats.n > 0 ? stats.correct / stats.n : null,
    brier: stats.n > 0 ? stats.brierSum / stats.n : null,
    marginMAE: stats.scored > 0 ? stats.marginErrSum / stats.scored : null,
  };
}

function getTargetSilo(game) {
  const largest = Math.max(game.redTeam?.length || 0, game.blueTeam?.length || 0);
  if (largest >= 5) return 'big';
  if (largest >= 3) return 'small';
  return 'overall';
}

function createScoringContext({ mod, players, modelGames, replay, ratingOptions, volleyballOptions }) {
  const pairAdjustmentMap =
    scoringMode === 'balancer' && typeof mod.buildPairAdjustmentMap === 'function'
      ? mod.buildPairAdjustmentMap({
          players,
          games: modelGames,
          ratingOptions,
          volleyballOptions,
          seasonal: true,
        })
      : null;

  return {
    pairAdjustmentMap,
    environmentMapCache: new Map(),
  };
}

function getScoringRatingMap({
  mod,
  players,
  modelGames,
  replay,
  game,
  ratingOptions,
  volleyballOptions,
  scoringContext,
}) {
  if (scoringMode !== 'balancer' || typeof mod.buildEnvironmentAdjustedRatingMap !== 'function') {
    return replay.ratingMap;
  }

  const targetSilo = getTargetSilo(game);
  const playerCount = (game.redTeam?.length || 0) + (game.blueTeam?.length || 0);
  const cacheKey = `${targetSilo}:${playerCount}`;
  if (scoringContext?.environmentMapCache?.has(cacheKey)) {
    return scoringContext.environmentMapCache.get(cacheKey);
  }

  const adjustedMap = mod.buildEnvironmentAdjustedRatingMap({
    players,
    games: modelGames,
    baseRatingMap: replay.ratingMap,
    ratingOptions,
    volleyballOptions,
    teamCount: 2,
    playerCount,
    targetSilo,
  });
  const ratingMap = { ...replay.ratingMap, ...adjustedMap };
  scoringContext?.environmentMapCache?.set(cacheKey, ratingMap);

  return ratingMap;
}

function scoreGame({
  mod,
  players,
  modelGames,
  replay,
  game,
  ratingOptions,
  volleyballOptions,
  scoringContext,
}) {
  return mod.scoreVolleyballCandidateSplit({
    redPlayers: game.redTeam,
    bluePlayers: game.blueTeam,
    ratingMap: getScoringRatingMap({
      mod,
      players,
      modelGames,
      replay,
      game,
      ratingOptions,
      volleyballOptions,
      scoringContext,
    }),
    carryScoreMap: replay.carryMap || {},
    options: ratingOptions,
    volleyballOptions,
    pairAdjustmentMap: scoringContext?.pairAdjustmentMap || null,
  });
}

function calibrateModel({
  mod,
  players,
  modelGames,
  replay,
  ratingOptions,
  volleyballOptions,
  scoringContext,
}) {
  if (scoringMode !== 'balancer') {
    return mod.calibrateMarginModel({
      games: modelGames,
      ratingMap: replay.ratingMap,
      carryScoreMap: replay.carryMap || {},
      options: ratingOptions,
      volleyballOptions,
    });
  }

  const xs = [];
  const ys = [];
  mod.getGamesSortedOldestFirst(modelGames).forEach(game => {
    if (!isQualityGame(game) || !isScored(game)) return;
    const score = scoreGame({
      mod,
      players,
      modelGames,
      replay,
      game,
      ratingOptions,
      volleyballOptions,
      scoringContext,
    });
    xs.push(Math.abs(score.strengthDiff));
    ys.push(Math.abs(game.scoreRed - game.scoreBlue));
  });

  const sampleSize = xs.length;
  if (sampleSize === 0) return { baseMargin: 0, slope: 0, sampleSize: 0 };

  const meanX = xs.reduce((sum, value) => sum + value, 0) / sampleSize;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / sampleSize;
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    sxy += (xs[index] - meanX) * (ys[index] - meanY);
    sxx += (xs[index] - meanX) ** 2;
  }

  const slope = sxx > 0 ? sxy / sxx : 0;
  return {
    baseMargin: meanY - slope * meanX,
    slope,
    sampleSize,
  };
}

function recordPrediction(stats, game, score, marginModel, mod) {
  const yRed = game.winner === 'red' ? 1 : 0;
  const predictedWinner = score.redWinProbability >= 0.5 ? 'red' : 'blue';

  stats.n += 1;
  if (predictedWinner === game.winner) stats.correct += 1;
  stats.brierSum += (score.redWinProbability - yRed) ** 2;

  if (isScored(game) && marginModel?.sampleSize > 0) {
    const actualGap = Math.abs(game.scoreRed - game.scoreBlue);
    const expectedGap = mod.predictExpectedMargin(score.strengthDiff, marginModel);
    stats.scored += 1;
    stats.marginErrSum += Math.abs(expectedGap - actualGap);
  }
}

function buildReplay({ mod, players, games, variant }) {
  const ratingOptions = {
    seasonalTaperDays,
    leagueDisplayEstimateEnabled: false,
    leaguePregameBayesianEnabled: false,
    ...(variant.ratingOptions || {}),
  };

  return {
    ratingOptions,
    volleyballOptions: variant.volleyballOptions || {},
    replay: mod.replayRatings({
      players,
      games,
      seasonal: true,
      volleyballAdjusted: true,
      volleyballUpdateUsesBalancerContext: variant.updateContext !== false,
      volleyballUpdateContextMode: variant.updateMode || 'pair',
      includeLeagueGames: variant.includeLeagueGames !== false,
      options: ratingOptions,
      volleyballOptions: variant.volleyballOptions || {},
    }),
  };
}

function evaluateVariant({ mod, players, games, variant }) {
  const sortedGames = mod.getGamesSortedOldestFirst(games);
  const forwardStats = createStats();
  const priorGames = [];

  sortedGames.forEach(game => {
    if (isQualityGame(game)) {
      const { ratingOptions, volleyballOptions, replay } = buildReplay({
        mod,
        players,
        games: priorGames,
        variant,
      });
      const scoringContext = createScoringContext({
        mod,
        players,
        modelGames: priorGames,
        replay,
        ratingOptions,
        volleyballOptions,
      });
      const marginModel = calibrateModel({
        mod,
        players,
        modelGames: priorGames,
        replay,
        ratingOptions,
        volleyballOptions,
        scoringContext,
      });
      const score = scoreGame({
        mod,
        players,
        modelGames: priorGames,
        replay,
        game,
        ratingOptions,
        volleyballOptions,
        scoringContext,
      });
      recordPrediction(forwardStats, game, score, marginModel, mod);
    }

    priorGames.push(game);
  });

  const { ratingOptions, volleyballOptions, replay } = buildReplay({
    mod,
    players,
    games,
    variant,
  });
  const backScoringContext = createScoringContext({
    mod,
    players,
    modelGames: games,
    replay,
    ratingOptions,
    volleyballOptions,
  });
  const backMarginModel = calibrateModel({
    mod,
    players,
    modelGames: games,
    replay,
    ratingOptions,
    volleyballOptions,
    scoringContext: backScoringContext,
  });
  const backStats = createStats();

  sortedGames.forEach(game => {
    if (!isQualityGame(game)) return;
    const score = scoreGame({
      mod,
      players,
      modelGames: games,
      replay,
      game,
      ratingOptions,
      volleyballOptions,
      scoringContext: backScoringContext,
    });
    recordPrediction(backStats, game, score, backMarginModel, mod);
  });

  const forward = summarize(forwardStats);
  const back = summarize(backStats);
  return {
    label: variant.label,
    version: mod.VERSION || 'unknown',
    forward,
    back,
    forwardIQ: computeSinglePassAccIQ(forward),
    backIQ: computeSinglePassAccIQ(back),
    accIQ: computeAccIQ({ forward, back }),
  };
}

function fmt(value, digits = 2) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : Number(value).toFixed(digits);
}

function pct(value) {
  return value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${(Number(value) * 100).toFixed(1)}%`;
}

function delta(current, baseline, selector) {
  return Number(selector(current)) - Number(selector(baseline));
}

function printRows(rows) {
  console.log([
    'label'.padEnd(28),
    'version'.padEnd(17),
    'fAcc'.padStart(6),
    'fBrier'.padStart(7),
    'fMAE'.padStart(6),
    'fIQ'.padStart(6),
    'bAcc'.padStart(6),
    'bBrier'.padStart(7),
    'bMAE'.padStart(6),
    'bIQ'.padStart(6),
    'AccIQ'.padStart(7),
  ].join(' '));
  console.log('-'.repeat(111));
  rows.forEach(row => {
    console.log([
      row.label.slice(0, 28).padEnd(28),
      row.version.slice(0, 17).padEnd(17),
      pct(row.forward.accuracy).padStart(6),
      fmt(row.forward.brier, 3).padStart(7),
      fmt(row.forward.marginMAE, 2).padStart(6),
      fmt(row.forwardIQ, 2).padStart(6),
      pct(row.back.accuracy).padStart(6),
      fmt(row.back.brier, 3).padStart(7),
      fmt(row.back.marginMAE, 2).padStart(6),
      fmt(row.backIQ, 2).padStart(6),
      fmt(row.accIQ, 2).padStart(7),
    ].join(' '));
  });
}

function printGate({ current, deploy }) {
  const forwardIQDelta = delta(current, deploy, row => row.forwardIQ);
  const forwardAccDelta = delta(current, deploy, row => row.forward.accuracy) * 100;
  const accIQDelta = delta(current, deploy, row => row.accIQ);
  const forwardBrierDelta = delta(current, deploy, row => row.forward.brier);
  const passes = accIQDelta >= 0 && forwardIQDelta >= -0.5 && forwardAccDelta >= -1.0 && forwardBrierDelta <= 0.005;

  console.log('');
  console.log('AccIQ Guardrail');
  console.log(`Current vs ${deployRef}: ${passes ? 'PASS' : 'FAIL'}`);
  console.log(`Combined AccIQ: ${fmt(accIQDelta, 2)}`);
  console.log(`Forward AccIQ:  ${fmt(forwardIQDelta, 2)}`);
  console.log(`Forward acc:    ${fmt(forwardAccDelta, 1)} pts`);
  console.log(`Forward Brier:  ${fmt(forwardBrierDelta, 4)}`);
}

const deployRatings = await loadDeployRatingsModule(deployRef);
const { players, games, sourceLabel } = await loadDatabase();
const qualityGames = games.filter(isQualityGame);
const scoredQualityGames = qualityGames.filter(isScored);

const deployVariant = { label: `deploy ${deployRef}` };
const currentVariants = [
  { label: 'current' },
  { label: 'current exclude league', includeLeagueGames: false },
  { label: 'prior sharp weights', volleyballOptions: PRIOR_SHARP_WEIGHTS },
  { label: 'context off', updateContext: false },
  { label: 'league x0.80', ratingOptions: { leagueUpdateMultiplier: 0.8 } },
  { label: 'league x0.25', ratingOptions: { leagueUpdateMultiplier: 0.25 } },
  { label: 'league level split', ratingOptions: { leagueTeamRatingMode: 'level' } },
  {
    label: 'level opp x4 burn3x2',
    ratingOptions: {
      leagueTeamRatingMode: 'level',
      leagueOpponentUpdateMultiplier: 4,
      leagueOpponentBurnInGames: 3,
      leagueOpponentBurnInMultiplier: 2,
    },
  },
  {
    label: 'level opp x4 burn3x1.5',
    ratingOptions: {
      leagueTeamRatingMode: 'level',
      leagueOpponentUpdateMultiplier: 4,
      leagueOpponentBurnInGames: 3,
      leagueOpponentBurnInMultiplier: 1.5,
    },
  },
  {
    label: 'level opp x2 no burn',
    ratingOptions: {
      leagueTeamRatingMode: 'level',
      leagueOpponentUpdateMultiplier: 2,
      leagueOpponentBurnInGames: 0,
      leagueOpponentBurnInMultiplier: 1,
    },
  },
  {
    label: 'BalanceIQ carry-only: carry18 conf6',
    volleyballOptions: { carryScale: 18, carryConfidenceGames: 6 },
  },
  {
    label: 'BalanceIQ top: league x2.25 carry18 conf6',
    ratingOptions: { leagueUpdateMultiplier: 2.25 },
    volleyballOptions: { carryScale: 18, carryConfidenceGames: 6 },
  },
  {
    label: 'BalanceIQ near: league x2.125 carry16 conf6',
    ratingOptions: { leagueUpdateMultiplier: 2.125 },
    volleyballOptions: { carryScale: 16, carryConfidenceGames: 6 },
  },
  {
    label: 'BalanceIQ simple: league x2 carry16 conf8',
    ratingOptions: { leagueUpdateMultiplier: 2.0 },
    volleyballOptions: { carryScale: 16, carryConfidenceGames: 8 },
  },
];

console.log(`DB: ${sourceLabel}`);
console.log(`players=${players.length} games=${games.length} qualityGames=${qualityGames.length} scoredQualityGames=${scoredQualityGames.length}`);
console.log(`scoring=${scoringMode}`);
console.log('');

const deployRow = evaluateVariant({
  mod: deployRatings,
  players,
  games,
  variant: deployVariant,
});

const currentRows = currentVariants.map(variant =>
  evaluateVariant({
    mod: currentRatings,
    players,
    games,
    variant,
  })
);

const rows = [deployRow, ...currentRows].sort((a, b) => Number(b.accIQ) - Number(a.accIQ));
printRows(rows);
printGate({
  current: currentRows.find(row => row.label === 'current'),
  deploy: deployRow,
});
