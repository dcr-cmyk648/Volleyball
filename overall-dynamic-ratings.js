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
} from './bayesian-ratings.js';

export const OVERALL_DYNAMIC_MODEL_VERSION = 'overall-dynamic-weekly-v3';
export const OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION = 2;
export const OVERALL_DYNAMIC_SNAPSHOT_STORAGE_KEY = 'gameDayBayesianScoreboardSnapshotV3:composite';
export const OVERALL_DYNAMIC_N_EFF = 10;
export const OVERALL_DYNAMIC_MONTHLY_SD_DISPLAY = 10;
// The public Overall rating is 1500 + 50 * raw ordinal. One latent unit is
// BAYESIAN_DISPLAY_SCALE raw units, so it spans 416.666... public points.
export const OVERALL_DYNAMIC_PUBLIC_POINTS_PER_RAW_ORDINAL = 50;
export const OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT =
  BAYESIAN_DISPLAY_SCALE * OVERALL_DYNAMIC_PUBLIC_POINTS_PER_RAW_ORDINAL;
export const OVERALL_DYNAMIC_MONTHLY_SD_LATENT =
  OVERALL_DYNAMIC_MONTHLY_SD_DISPLAY / OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT;
export const OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR = '2000-01-03';
export const OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS = 365.2425 / 12;

const EPS = 1e-9;

/** Display-only conversion from a pooled team-average posterior to one player. */
export function getDynamicLeagueIndividualEffectiveSize(games = [], gameFingerprints = {}) {
  const fingerprints = gameFingerprints && typeof gameFingerprints === 'object' ? gameFingerprints : {};
  const sizes = (Array.isArray(games) ? games : []).flatMap((game, index) => {
    if (!game?.isLeagueGame) return [];
    const identity = getStableGameIdentity(game, index);
    if (!identity || fingerprints[identity] !== createGameFingerprint(game, identity)) return [];
    const size = Array.isArray(game.redTeam) ? game.redTeam.length : 0;
    return Number.isFinite(size) && size > 0 ? [size] : [];
  });
  return sizes.length / sizes.reduce((sum, size) => sum + 1 / size, 0) || 1;
}

export function formatDynamicLeagueIndividualRating(pooledRating, games = [], gameFingerprints = {}) {
  const nEff = getDynamicLeagueIndividualEffectiveSize(games, gameFingerprints);
  const mu = Number(pooledRating?.mu) || BAYESIAN_DISPLAY_BASE;
  const sigma = Math.max(1e-6, (Number(pooledRating?.sigma) || 0) * Math.sqrt(nEff));
  return {
    ...pooledRating,
    name: 'League Player',
    mu,
    sigma,
    ordinal: mu - 3 * sigma,
    leagueIndividualEffectiveSize: nEff,
    isLeagueContext: true,
    isSynthetic: true,
  };
}

export function calculateOverallDynamicScoreboard({ players = [], games = [], onProgress = null } = {}) {
  const progress = (percent, stage, message, diagnostics = {}) => onProgress?.({ type: 'progress', percent, stage, message, diagnostics });
  progress(2, 'validate', 'Validating Overall games and building weekly states');
  const indexed = indexInput(players, games);
  progress(15, 'build', `Building dynamic model from ${indexed.observations.length} games`, indexed.counts);
  const solved = solveNewton(indexed, progress);
  progress(82, 'posterior', 'Estimating current-state uncertainty');
  const posterior = marginalVariances(solved.hessian, indexed.allStateIndexes);
  const bridge = chooseBridge(indexed);
  const shift = bridge.ids.length
    ? -bridge.ids.reduce((sum, id) => sum + solved.x[indexed.latestIndexes.get(id)], 0) / bridge.ids.length
    : 0;
  const ratings = formatRatings(indexed, solved.x, posterior, shift);
  const history = formatHistory(indexed, solved.x, posterior, shift);
  const snapshot = {
    schemaVersion: OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION,
    modelVersion: OVERALL_DYNAMIC_MODEL_VERSION,
    calculatedAt: new Date().toISOString(),
    playerEntityFingerprint: createPlayerEntityFingerprint(players),
    gameFingerprints: createGameFingerprintMap(games),
    fingerprint: fingerprint(players, games),
    gamesConsidered: indexed.observations.length,
    scoredGames: indexed.counts.scoredGames,
    winnerOnlyGames: indexed.counts.winnerOnlyGames,
    skippedGames: indexed.counts.skippedGames,
    warnings: indexed.warnings,
    ratings: sortBayesianRatings(ratings),
    history,
    diagnostics: {
      version: OVERALL_DYNAMIC_MODEL_VERSION,
      nEff: OVERALL_DYNAMIC_N_EFF,
      monthlyTransitionSdPublic: OVERALL_DYNAMIC_MONTHLY_SD_DISPLAY,
      weeklyBucketAnchor: OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR,
      monthlyBrownianDays: OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS,
      publicPointsPerLatent: OVERALL_DYNAMIC_PUBLIC_POINTS_PER_LATENT,
      leagueGamesIncluded: indexed.counts.leagueGames,
      bridgeCohort: bridge,
      affineShiftLatent: shift,
      optimizer: solved.diagnostics,
      posterior,
      dimensions: { states: indexed.dimension, playerWeeklyStates: indexed.dimension - 1, fixedLeagueOpponent: 1 },
    },
    constants: {
      displayBase: BAYESIAN_DISPLAY_BASE,
      displayScale: BAYESIAN_DISPLAY_SCALE,
      publicPointsPerRawOrdinal: OVERALL_DYNAMIC_PUBLIC_POINTS_PER_RAW_ORDINAL,
    },
  };
  validateOverallDynamicSnapshot(snapshot);
  progress(100, 'complete', 'Dynamic Overall scoreboard saved', snapshot.diagnostics);
  return snapshot;
}

export function validateOverallDynamicSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== OVERALL_DYNAMIC_SNAPSHOT_SCHEMA_VERSION || snapshot.modelVersion !== OVERALL_DYNAMIC_MODEL_VERSION) throw new Error('Unsupported dynamic Overall snapshot schema.');
  if (!Array.isArray(snapshot.ratings) || !snapshot.history || typeof snapshot.history !== 'object') throw new Error('Invalid dynamic Overall snapshot.');
  if (snapshot.diagnostics?.optimizer?.converged !== true) throw new Error('Dynamic Overall snapshot was not converged.');
  for (const row of snapshot.ratings) {
    for (const key of ['mu', 'sigma', 'ordinal', 'games', 'wins', 'winrate']) if (!Number.isFinite(Number(row[key]))) throw new Error(`Invalid dynamic Overall rating field: ${key}`);
    if (!(row.sigma > 0)) throw new Error('Invalid dynamic Overall sigma.');
    if (Math.abs(row.ordinal - (row.mu - 3 * row.sigma)) > 1e-9) throw new Error('Invalid dynamic Overall confidence transform.');
  }
  for (const [id, knots] of Object.entries(snapshot.history)) {
    if (!Array.isArray(knots) || !knots.length || id === BAYESIAN_POOLED_LEAGUE_OPPONENT_ID) throw new Error('Invalid dynamic Overall history.');
    let previous = '';
    knots.forEach(knot => {
      if (String(knot.date) < previous || !['central', 'mu', 'sigma', 'ordinal', 'variance', 'games'].every(key => Number.isFinite(Number(knot[key])))) throw new Error('Invalid dynamic Overall history knot.');
      if (Number(knot.games) < 0) throw new Error('Invalid dynamic Overall history game count.');
      previous = String(knot.date);
    });
  }
  return true;
}

function indexInput(players, games) {
  const normalized = (Array.isArray(players) ? players : []).filter(p => p && p.id != null && String(p.name || '').trim()).map(p => ({ id: String(p.id), name: String(p.name).trim() })).sort((a,b) => a.id.localeCompare(b.id));
  const known = new Set(normalized.map(p => p.id)); const raw = []; const warnings = [];
  const counts = { scoredGames: 0, winnerOnlyGames: 0, skippedGames: 0, leagueGames: 0 };
  (Array.isArray(games) ? games : []).forEach((game, i) => {
    const ids = (team) => (Array.isArray(team) ? team : []).map(p => String(p?.id ?? '')).filter(id => known.has(id));
    const red = ids(game?.redTeam), blue = ids(game?.blueTeam); const league = Boolean(game?.isLeagueGame);
    const date = gameDate(game); const validWinner = game?.winner === 'red' || game?.winner === 'blue';
    const sr = Number(game?.scoreRed), sb = Number(game?.scoreBlue); const scored = Number.isFinite(sr) && Number.isFinite(sb) && sr >= 0 && sb >= 0 && sr + sb > 0;
    if (!date || !red.length || (!league && !blue.length) || (!scored && !validWinner)) { counts.skippedGames++; warnings.push(`Skipped malformed game ${getStableGameIdentity(game, i)}.`); return; }
    const q = scored ? Math.min(1 - EPS, Math.max(EPS, (sr + .5) / (sr + sb + 1))) : (game.winner === 'red' ? 1 - EPS : EPS);
    raw.push({ red, blue: league ? [] : blue, league, q, date, identity: getStableGameIdentity(game, i), winner: game.winner });
    if (scored) counts.scoredGames++; else counts.winnerOnlyGames++; if (league) counts.leagueGames++;
  });
  const bucketsByPlayer = new Map(normalized.map(p => [p.id, new Set()])); const appearances = new Map(normalized.map(p => [p.id, []]));
  raw.forEach(o => [...o.red, ...o.blue].forEach(id => { bucketsByPlayer.get(id).add(weeklyBucketKey(o.date)); appearances.get(id).push(o.date); }));
  const stateIndex = new Map(); const playerStates = new Map(); let dimension = 0;
  for (const p of normalized) { const buckets = [...bucketsByPlayer.get(p.id)].sort(); const active = buckets.length ? buckets : [weeklyBucketKey(latestDate(raw) || '1970-01-01')]; const states = active.map(date => ({ date, index: dimension++ })); playerStates.set(p.id, states); states.forEach(s => stateIndex.set(`${p.id}:${s.date}`, s.index)); }
  const leagueIndex = dimension++; const observations = raw.map(o => ({
    ...o,
    redTerms: o.red.flatMap(id => stateAt(id, o.date, playerStates).map(term => ({ ...term, weight: term.weight / o.red.length }))),
    blueTerms: o.league
      ? [{ index: leagueIndex, weight: 1 }]
      : o.blue.flatMap(id => stateAt(id, o.date, playerStates).map(term => ({ ...term, weight: term.weight / o.blue.length }))),
  }));
  const latestIndexes = new Map(normalized.map(p => [p.id, playerStates.get(p.id).at(-1).index]));
  const allStateIndexes = new Set([...playerStates.values()].flatMap(states => states.map(state => state.index)));
  allStateIndexes.add(leagueIndex);
  return { players: normalized, observations, warnings, counts, playerStates, latestIndexes, allStateIndexes, leagueIndex, dimension, appearances };
}

function stateAt(id, date, states) {
  const list = states.get(id); const instant = new Date(`${date}T00:00:00Z`).getTime();
  let previous = list[0]; let next = null;
  for (const state of list) {
    if (state.date <= date) previous = state;
    if (state.date > date) { next = state; break; }
  }
  if (!next) return [{ index: previous.index, weight: 1 }];
  const t = getOverallDynamicWeeklyInterpolation(previous.date, next.date, new Date(instant).toISOString().slice(0, 10));
  return [{ index: previous.index, weight: 1 - t }, { index: next.index, weight: t }];
}
function gameDate(game) { const candidate = String(game?.date || game?.gameDate || game?.createdAt || ''); const d = new Date(candidate); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ''; }
export function getOverallDynamicWeeklyBucketKey(date) { return weeklyBucketKey(date); }
function weeklyBucketKey(date) { const instant = new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getTime(); const anchor = new Date(`${OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR}T00:00:00Z`).getTime(); if (!Number.isFinite(instant)) return OVERALL_DYNAMIC_WEEKLY_BUCKET_ANCHOR; return new Date(anchor + Math.floor((instant - anchor) / (7 * 86400000)) * 7 * 86400000).toISOString().slice(0, 10); }
export function getOverallDynamicWeeklyInterpolation(previousDate, nextDate, date) { const start = new Date(`${previousDate}T00:00:00Z`).getTime(); const end = new Date(`${nextDate}T00:00:00Z`).getTime(); const instant = new Date(`${date}T00:00:00Z`).getTime(); return Math.max(0, Math.min(1, (instant - start) / Math.max(1, end - start))); }
export function getOverallDynamicWeeklyTransitionVariance(previousDate, nextDate) { const start = new Date(`${previousDate}T00:00:00Z`).getTime(); const end = new Date(`${nextDate}T00:00:00Z`).getTime(); const elapsedDays = Math.max(1, (end - start) / 86400000); return OVERALL_DYNAMIC_MONTHLY_SD_LATENT * OVERALL_DYNAMIC_MONTHLY_SD_LATENT * elapsedDays / OVERALL_DYNAMIC_MONTHLY_BROWNIAN_DAYS; }
function latestDate(raw) { return raw.reduce((latest, item) => item.date > latest ? item.date : latest, ''); }

function solveNewton(indexed, progress) {
  let x = new Array(indexed.dimension).fill(0); let evaluated = objectiveGradientHessian(x, indexed); let converged = false; let termination = 'max-iterations'; let iteration = 0;
  for (iteration = 0; iteration < 60; iteration++) {
    const factor = factorize(evaluated.hessian); const step = solveCholesky(factor.lower, evaluated.gradient).map(v => -v);
    const norm = Math.sqrt(evaluated.gradient.reduce((s,v) => s + v*v, 0)); if (norm < 1e-6) { converged = true; termination = 'gradient'; break; }
    let scale = 1; let next = null;
    while (scale > 1e-7) { const candidate = x.map((v,i) => v + scale * step[i]); const probe = objectiveGradientHessian(candidate, indexed); if (probe.objective <= evaluated.objective + 1e-10) { next = { x: candidate, evaluated: probe }; break; } scale /= 2; }
    if (!next) { termination = 'line-search'; break; }
    x = next.x; evaluated = next.evaluated; progress(20 + Math.min(55, iteration), 'optimize', `Optimizing dynamic Overall skills — iteration ${iteration + 1}`, { iteration: iteration + 1, objective: evaluated.objective, gradientNorm: norm });
  }
  const final = objectiveGradientHessian(x, indexed); const factor = factorize(final.hessian);
  const gradientNorm = Math.sqrt(final.gradient.reduce((sum, value) => sum + value * value, 0));
  if (!converged) throw new Error(`Dynamic Overall optimization did not converge: ${termination} (gradient ${gradientNorm}).`);
  return { x, hessian: final.hessian, diagnostics: { method: 'analytic-newton-hessian-cholesky', converged: true, termination, iterations: iteration, objective: final.objective, gradientNorm, jitter: factor.jitter } };
}

function objectiveGradientHessian(x, indexed) {
  const n = indexed.dimension, gradient = new Array(n).fill(0), hessian = Array.from({ length:n }, () => new Array(n).fill(0)); let objective = 0;
  const addPrior = index => { objective += 0.5 * x[index] * x[index]; gradient[index] += x[index]; hessian[index][index] += 1; };
  indexed.playerStates.forEach(states => addPrior(states[0].index));
  addPrior(indexed.leagueIndex);
  const add = (terms, multiplier) => { for (const a of terms) for (const b of terms) hessian[a.index][b.index] += multiplier * a.weight * b.weight; };
  indexed.observations.forEach(o => { const terms = [...o.redTerms, ...o.blueTerms.map(t => ({ ...t, weight: -t.weight }))]; const eta = terms.reduce((s,t) => s + x[t.index] * t.weight, 0); const p = sigmoid(eta); objective += OVERALL_DYNAMIC_N_EFF * (softplus(eta) - o.q * eta); const d = OVERALL_DYNAMIC_N_EFF * (p - o.q), w = OVERALL_DYNAMIC_N_EFF * p * (1-p); terms.forEach(t => gradient[t.index] += d*t.weight); add(terms,w); });
  indexed.playerStates.forEach(states => { for (let i=1;i<states.length;i++) { const a=states[i-1].index,b=states[i].index; const precision = 1 / getOverallDynamicWeeklyTransitionVariance(states[i-1].date, states[i].date); const delta=x[b]-x[a]; objective += .5*precision*delta*delta; gradient[a]-=precision*delta; gradient[b]+=precision*delta; hessian[a][a]+=precision; hessian[b][b]+=precision; hessian[a][b]-=precision; hessian[b][a]-=precision; } });
  return { objective, gradient, hessian };
}
function sigmoid(x) { return x > 35 ? 1-EPS : x < -35 ? EPS : 1/(1+Math.exp(-x)); }
function softplus(x) { return x > 35 ? x : Math.log1p(Math.exp(x)); }

function factorize(matrix) { for (const jitter of [0,1e-10,1e-8,1e-6,1e-4]) { const lower = cholesky(matrix.map((r,i) => r.map((v,j) => v + (i===j ? jitter : 0)))); if (lower) return { lower, jitter }; } throw new Error('Dynamic Overall Hessian is ill-conditioned.'); }
function cholesky(a) { const n=a.length,l=Array.from({length:n},()=>new Array(n).fill(0)); for(let i=0;i<n;i++) for(let j=0;j<=i;j++){let s=a[i][j];for(let k=0;k<j;k++)s-=l[i][k]*l[j][k];if(i===j){if(!(s>0)||!Number.isFinite(s))return null;l[i][j]=Math.sqrt(s)}else l[i][j]=s/l[j][j]} return l; }
function solveCholesky(l,b) { const n=l.length,y=new Array(n);for(let i=0;i<n;i++){let s=b[i];for(let k=0;k<i;k++)s-=l[i][k]*y[k];y[i]=s/l[i][i]}const x=new Array(n);for(let i=n-1;i>=0;i--){let s=y[i];for(let k=i+1;k<n;k++)s-=l[k][i]*x[k];x[i]=s/l[i][i]}return x; }
function marginalVariances(hessian, indexes) { const factor=factorize(hessian); const variances={}; for(const index of indexes){const unit=new Array(hessian.length).fill(0);unit[index]=1;variances[index]=Math.max(0,solveCholesky(factor.lower,unit)[index]);} return { method:'analytic-hessian-cholesky-marginals', jitter:factor.jitter, variances }; }

function chooseBridge(indexed) { const candidates=indexed.players.filter(p=>{const dates=indexed.appearances.get(p.id)||[];return dates.length>=8 && spanDays(dates)>=45;}).map(p=>p.id).sort(); const fallback=indexed.players.filter(p=>(indexed.appearances.get(p.id)||[]).length>=5).map(p=>p.id).sort(); return { ids: candidates.length>=6 ? candidates : fallback, rule:candidates.length>=6?'appearances>=8-span>=45':'deterministic-appearances>=5-fallback' }; }
function spanDays(dates) { const parsed=dates.map(value => new Date(value).getTime()).filter(Number.isFinite); return parsed.length ? (Math.max(...parsed)-Math.min(...parsed))/86400000 : 0; }
function formatRatings(indexed,x,posterior,shift) { const stats=new Map(indexed.players.map(p=>[p.id,{games:0,wins:0}]));let league={games:0,wins:0};indexed.observations.forEach(o=>{[...o.red,...o.blue].forEach(id=>{const s=stats.get(id);s.games++;if(o.winner==='red'&&o.red.includes(id)||o.winner==='blue'&&o.blue.includes(id))s.wins++;});if(o.league){league.games++;if(o.winner==='blue')league.wins++;}});const rows=indexed.players.map(p=>rating(p.id,p.name,x[indexed.latestIndexes.get(p.id)]+shift,posterior.variances[indexed.latestIndexes.get(p.id)]??1,stats.get(p.id)));rows.push(rating(BAYESIAN_POOLED_LEAGUE_OPPONENT_ID,BAYESIAN_POOLED_LEAGUE_OPPONENT_NAME,x[indexed.leagueIndex]+shift,posterior.variances[indexed.leagueIndex]??1,league,{isLeagueContext:true,isSynthetic:true}));return rows; }
function rating(id,name,latent,variance,stats,extra={}) { const mu=BAYESIAN_DISPLAY_BASE+BAYESIAN_DISPLAY_SCALE*latent,sigma=Math.max(1e-6,BAYESIAN_DISPLAY_SCALE*Math.sqrt(Math.max(0,variance)));return {id,name,mu,sigma,ordinal:mu-3*sigma,games:stats.games,wins:stats.wins,winrate:stats.games?stats.wins/stats.games:0,...extra}; }
function formatHistory(indexed,x,posterior,shift) { const output={}; indexed.players.forEach(p=>{const states=indexed.playerStates.get(p.id);output[p.id]=states.map(state=>{const variance=posterior.variances[state.index]??1;const central=BAYESIAN_DISPLAY_BASE+BAYESIAN_DISPLAY_SCALE*(x[state.index]+shift),sigma=BAYESIAN_DISPLAY_SCALE*Math.sqrt(Math.max(0,variance));const games=indexed.observations.reduce((count, observation) => count + (weeklyBucketKey(observation.date) <= state.date && (observation.red.includes(p.id) || observation.blue.includes(p.id)) ? 1 : 0), 0);return {date:state.date,central,mu:central,sigma,variance,ordinal:central-3*sigma,games};});});return output; }
function fingerprint(players,games) { return JSON.stringify({p:createPlayerEntityFingerprint(players),g:createGameFingerprintMap(games)}); }
