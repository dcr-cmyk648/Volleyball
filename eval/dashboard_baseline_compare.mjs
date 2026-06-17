// Compare dashboard baseline-gap definitions between current code and deploy.
//
// Run from eval/:
//   node --no-deprecation --import ./register.mjs dashboard_baseline_compare.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadDatabase } from './database.mjs';
import * as current from '../ratings.js';

const deployRef = process.env.DEPLOY_REF || 'origin/main';
const seasonalTaperDays = Math.round(6 * 30.4375);

function loadDeployRatingsModule(ref) {
  const source = execFileSync('git', ['show', `${ref}:ratings.js`], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 5,
  });
  const dir = mkdtempSync(join(tmpdir(), 'vball-baseline-compare-'));
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

function fit(xs, ys) {
  const sampleSize = xs.length;
  if (sampleSize === 0) return { baseMargin: 0, slope: 0, sampleSize: 0 };

  const meanX = xs.reduce((sum, value) => sum + value, 0) / sampleSize;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / sampleSize;
  let sxy = 0;
  let sxx = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    sxy += (xs[index] - meanX) * (ys[index] - meanY);
    sxx += (xs[index] - meanX) * (xs[index] - meanX);
  }

  const slope = sxx > 0 ? sxy / sxx : 0;
  return { baseMargin: meanY - slope * meanX, slope, sampleSize };
}

function scoreGame(mod, game, replay, volleyballOptions = {}) {
  return mod.scoreVolleyballCandidateSplit({
    redPlayers: game.redTeam,
    bluePlayers: game.blueTeam,
    ratingMap: replay.ratingMap,
    carryScoreMap: replay.carryMap || {},
    volleyballOptions,
  });
}

function finalModel({ mod, players, games, volleyballOptions = {} }) {
  const replay = mod.replayRatings({
    players,
    games,
    seasonal: true,
    volleyballAdjusted: true,
    includeLeagueGames: true,
    options: {
      seasonalTaperDays,
      leagueDisplayEstimateEnabled: false,
      leaguePregameBayesianEnabled: false,
    },
    volleyballOptions,
  });
  const xs = [];
  const ys = [];

  mod.getGamesSortedOldestFirst(games).forEach(game => {
    if (!isQualityGame(game) || !isScored(game)) return;
    const score = scoreGame(mod, game, replay, volleyballOptions);
    xs.push(Math.abs(score.strengthDiff));
    ys.push(Math.abs(game.scoreRed - game.scoreBlue));
  });

  return fit(xs, ys);
}

function forwardLatestModel({ mod, players, games, volleyballOptions = {} }) {
  const sorted = mod.getGamesSortedOldestFirst(games);
  const priorGames = [];
  let latest = { baseMargin: 0, slope: 0, sampleSize: 0 };

  sorted.forEach(game => {
    if (isQualityGame(game)) {
      const replay = mod.replayRatings({
        players,
        games: priorGames,
        seasonal: true,
        volleyballAdjusted: true,
        includeLeagueGames: true,
        options: {
          seasonalTaperDays,
          leagueDisplayEstimateEnabled: false,
          leaguePregameBayesianEnabled: false,
        },
        volleyballOptions,
      });
      const xs = [];
      const ys = [];

      mod.getGamesSortedOldestFirst(priorGames).forEach(priorGame => {
        if (!isQualityGame(priorGame) || !isScored(priorGame)) return;
        const score = scoreGame(mod, priorGame, replay, volleyballOptions);
        xs.push(Math.abs(score.strengthDiff));
        ys.push(Math.abs(priorGame.scoreRed - priorGame.scoreBlue));
      });

      latest = fit(xs, ys);
    }

    priorGames.push(game);
  });

  return latest;
}

function meanGap(games) {
  const scored = games.filter(game => isQualityGame(game) && isScored(game));
  return {
    sampleSize: scored.length,
    mean: scored.reduce((sum, game) => sum + Math.abs(game.scoreRed - game.scoreBlue), 0) / scored.length,
  };
}

function fmt(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a';
}

function printRow(label, model) {
  console.log([
    label.padEnd(34),
    fmt(model.baseMargin).padStart(8),
    fmt(model.slope).padStart(8),
    String(model.sampleSize).padStart(6),
  ].join(' '));
}

const deploy = await loadDeployRatingsModule(deployRef);
const { players, games, sourceLabel } = await loadDatabase();
const currentCarryOff = {
  carryScale: 0,
  carryConfidenceGames: 10,
};

console.log(`DB: ${sourceLabel}`);
console.log(`current=${current.VERSION} deploy=${deploy.VERSION || deployRef}`);
const gap = meanGap(games);
console.log(`quality scored mean actual gap: ${fmt(gap.mean)} (${gap.sampleSize} games)`);
console.log('');
console.log(['model'.padEnd(34), 'base'.padStart(8), 'slope'.padStart(8), 'n'.padStart(6)].join(' '));
console.log('-'.repeat(60));
printRow('deploy final/back', finalModel({ mod: deploy, players, games }));
printRow('current final/back', finalModel({ mod: current, players, games }));
printRow('current final/back carry off', finalModel({ mod: current, players, games, volleyballOptions: currentCarryOff }));
printRow('deploy forward latest', forwardLatestModel({ mod: deploy, players, games }));
printRow('current forward latest', forwardLatestModel({ mod: current, players, games }));
printRow('current forward latest carry off', forwardLatestModel({ mod: current, players, games, volleyballOptions: currentCarryOff }));
