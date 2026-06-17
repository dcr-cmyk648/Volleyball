// Counterfactual: does adding a provisional-player-balance penalty to the
// balancer reduce new-player imbalance without meaningfully hurting fairness?
//
// For each historical scored non-league 2-team game, we know who was present
// (redTeam + blueTeam). We simulate ATTEMPTS random splits, pick the best by
// (a) fairness only (current balancer) and (b) fairness - w * provImbalance
// for several values of w (proposed). We report avg provisional imbalance and
// avg predicted gap for each weight so we can choose w for the live balancer.
//
// "Provisional" = < 5 career games at game time (matches blowout_imbalance.mjs).
//
// Run: node --import ./register.mjs counterfactual_newplayer.mjs

import { loadDatabase } from './database.mjs';
import {
  replayRatings,
  scoreVolleyballCandidateSplit,
  calibrateMarginModel,
  predictExpectedMargin,
  getGamesSortedOldestFirst,
} from '../ratings.js';

const { db, players, games, sourceLabel } = await loadDatabase();

const replay = replayRatings({
  players, games,
  seasonal: true,
  volleyballAdjusted: true,
  includeLeagueGames: true,
  options: { seasonalTaperDays: Math.round(6 * 30.4375) },
});
const ratingMap  = replay.ratingMap;
const carryMap   = replay.carryMap  || {};

const marginModel = calibrateMarginModel({ games, ratingMap, carryScoreMap: carryMap });

// Penalty weights to sweep. w=0 is the current balancer (fairness only).
const WEIGHTS   = [0, 0.03, 0.06, 0.10, 0.20];
const ATTEMPTS  = 800;
const PROV_THRESHOLD = 5; // < N career games at game time = provisional

// ── helpers ──────────────────────────────────────────────────────────────────

function fairness(redWinProb) {
  // 0 = perfectly one-sided, 1 = 50/50.
  return 2 * Math.min(redWinProb, 1 - redWinProb);
}

function evalSplit(red, blue) {
  const s = scoreVolleyballCandidateSplit({
    redPlayers: red, bluePlayers: blue, ratingMap, carryScoreMap: carryMap,
  });
  return {
    fairness: fairness(s.redWinProbability),
    predictedGap: predictExpectedMargin(s.strengthDiff, marginModel),
  };
}

function provCount(team, gamesBefore) {
  return team.filter(p => (gamesBefore[p.id] ?? 0) < PROV_THRESHOLD).length;
}

// Fisher-Yates shuffle in-place.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── main loop ────────────────────────────────────────────────────────────────

const sortedGames = getGamesSortedOldestFirst(games);
const gamesBefore = {}; // id → career games played before this game

// Accumulators: one per weight.
const totPI  = Object.fromEntries(WEIGHTS.map(w => [w, 0])); // provisional imbalance
const totGap = Object.fromEntries(WEIGHTS.map(w => [w, 0])); // predicted gap
let n = 0;

for (const game of sortedGames) {
  const red  = game?.redTeam  || [];
  const blue = game?.blueTeam || [];

  if (
    game?.isLeagueGame ||
    !red.length || !blue.length ||
    typeof game?.scoreRed  !== 'number' ||
    typeof game?.scoreBlue !== 'number' ||
    (game?.winner !== 'red' && game?.winner !== 'blue')
  ) {
    // Still count games-before for all players even in excluded games.
    [...red, ...blue].forEach(p => { gamesBefore[p.id] = (gamesBefore[p.id] ?? 0) + 1; });
    continue;
  }

  const present = [...red, ...blue];
  if (present.length < 4) {
    [...red, ...blue].forEach(p => { gamesBefore[p.id] = (gamesBefore[p.id] ?? 0) + 1; });
    continue;
  }

  // Snapshot gamesBefore at this point in time for provisional counting.
  const gbSnap = { ...gamesBefore };

  // best[w] tracks the highest combined score seen so far for each weight.
  const best = Object.fromEntries(
    WEIGHTS.map(w => [w, { score: -Infinity, pi: 0, gap: 0 }])
  );

  const buf = [...present]; // reusable buffer for shuffle
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    shuffle(buf);
    const half = Math.round(buf.length / 2);
    const r    = buf.slice(0, half);
    const b    = buf.slice(half);

    const ev = evalSplit(r, b);
    const pi = Math.abs(provCount(r, gbSnap) - provCount(b, gbSnap));

    for (const w of WEIGHTS) {
      const combined = ev.fairness - w * pi;
      if (combined > best[w].score) {
        best[w] = { score: combined, pi, gap: ev.predictedGap };
      }
    }
  }

  for (const w of WEIGHTS) {
    totPI[w]  += best[w].pi;
    totGap[w] += best[w].gap;
  }
  n += 1;

  // Advance game count for all players in this game.
  [...red, ...blue].forEach(p => { gamesBefore[p.id] = (gamesBefore[p.id] ?? 0) + 1; });
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\nCounterfactual: fairness-only vs fairness + provisional-balance penalty`);
console.log(`Games: ${n}  |  Provisional threshold: < ${PROV_THRESHOLD} career games at game time`);
console.log(`Simulated ${ATTEMPTS} random splits per game\n`);

const hdr = ['weight', 'avg prov imbalance', 'avg predicted gap', 'prov imb vs w=0', 'gap vs w=0'].map(s => s.padStart(20));
console.log(hdr.join(''));
console.log('-'.repeat(102));

const basePI  = totPI[0]  / n;
const baseGap = totGap[0] / n;

for (const w of WEIGHTS) {
  const pi  = totPI[w]  / n;
  const gap = totGap[w] / n;
  const row = [
    String(w).padStart(20),
    pi.toFixed(4).padStart(20),
    gap.toFixed(4).padStart(20),
    (pi  - basePI ).toFixed(4).padStart(20),
    (gap - baseGap).toFixed(4).padStart(20),
  ];
  console.log(row.join(''));
}

console.log(`\nNote: gap is predicted by the margin model, not actual scores.`);
console.log(`Positive delta = worse; negative delta = improvement vs w=0 (fairness-only).`);
