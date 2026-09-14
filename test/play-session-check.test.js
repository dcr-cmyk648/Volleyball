import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPlaySessionCheck, SESSION_CHECK_KEY, SESSION_IDLE_MS } from '../play-session-check.js';

function setup(overrides = {}) {
  const values = new Map();
  const calls = { fetch: 0, offer: 0, notice: 0 };
  const options = {
    storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    fetchDatabase: async () => { calls.fetch++; return { games: [] }; },
    offerSync: async () => { calls.offer++; },
    notifyUnavailable: () => { calls.notice++; },
    ...overrides,
  };
  return { options, calls, values, check: createPlaySessionCheck(options) };
}

test('first balance awaits the live check and sync/ignore choice; repeated clicks share it', async () => {
  let releaseFetch, releaseChoice;
  const s = setup({
    fetchDatabase: () => new Promise(resolve => { releaseFetch = resolve; }),
    offerSync: () => new Promise(resolve => { releaseChoice = resolve; }),
  });
  let finished = false;
  const first = s.check();
  first.then(() => { finished = true; });
  assert.equal(s.check(), first);
  await Promise.resolve();
  assert.equal(finished, false);
  releaseFetch({ games: ['new-game'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  releaseChoice();
  await first;
  assert.equal(finished, true);
  assert.ok(s.values.has(SESSION_CHECK_KEY));
  await s.check();
});

test('completed check survives page navigation but a new app session checks again', async () => {
  const s = setup();
  await s.check();
  await s.check();
  await createPlaySessionCheck(s.options)();
  assert.equal(s.calls.fetch, 1);
  s.values.clear();
  await createPlaySessionCheck(s.options)();
  assert.equal(s.calls.fetch, 2);
});

test('unreachable server gives one notice, allows play, and does not repeat', async () => {
  const s = setup({ fetchDatabase: async () => { throw new Error('offline'); } });
  await s.check();
  await s.check();
  await createPlaySessionCheck(s.options)();
  assert.equal(s.calls.notice, 1);
  assert.equal(s.calls.offer, 0);
});

test('hung request times out and aborts; late data cannot prompt or sync', async () => {
  let release, signal;
  const s = setup({ timeoutMs: 10, fetchDatabase: abortSignal => {
    signal = abortSignal;
    return new Promise(resolve => { release = resolve; });
  } });
  await s.check();
  assert.equal(signal.aborted, true);
  assert.equal(s.calls.notice, 1);
  release({ games: ['late'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.offer, 0);
  await s.check();
  assert.equal(s.calls.notice, 1);
});

test('active balancing extends session; four idle hours requires a fresh check', async () => {
  let clock = 1000;
  const s = setup({ now: () => clock });
  await s.check();
  clock += SESSION_IDLE_MS - 1;
  await s.check();
  assert.equal(s.calls.fetch, 1);
  clock += SESSION_IDLE_MS;
  await s.check();
  assert.equal(s.calls.fetch, 2);
});

test('storage failures still allow one check per page', async () => {
  const s = setup({ storage: null });
  await s.check();
  await s.check();
  assert.equal(s.calls.fetch, 1);
});

const pageSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function pageFunction(start, end) {
  return pageSource.slice(pageSource.indexOf(start), pageSource.indexOf(end, pageSource.indexOf(start)));
}

test('Assign Teams waits for the check/choice and prevents concurrent assignments', async () => {
  let release;
  const calls = [];
  const context = vm.createContext({
    assigningTeams: false,
    clearError() {},
    confirmReassignWithOutstandingScores: () => true,
    checkServerBeforeFirstBalance: () => new Promise(resolve => { release = resolve; }),
    runWithBusy: async (_, action) => action({}),
    assignBalancedTeams: async () => { calls.push('balance'); },
  });
  vm.runInContext(pageFunction('  async function handleAssignTeamsClick()', '  async function assignBalancedTeams('), context);
  const first = context.handleAssignTeamsClick();
  await context.handleAssignTeamsClick();
  assert.equal(calls.length, 0);
  release();
  await first;
  assert.deepEqual(calls, ['balance']);
  assert.equal(context.assigningTeams, false);
});

test('sync before balancing updates games while preserving selected players and team settings', async () => {
  const saved = new Map();
  const presence = { p1: { present: true, team: 'red', group: 1 } };
  const context = vm.createContext({
    defaultDatabaseMeta: null,
    PLAYER_STORAGE_KEY: 'players', GAME_STORAGE_KEY: 'games', SEASON_START_DATE_STORAGE_KEY: 'season',
    localStorage: { setItem: (key, value) => saved.set(key, value) },
    saveTournamentPairs() {},
    isValidSeasonStartDate: () => true,
    loadPlayers: () => JSON.parse(saved.get('players')),
    loadGames: () => JSON.parse(saved.get('games')),
    players: [], games: [], presenceState: presence,
    syncPresenceState() {}, savePageState() {}, renderPlayers() {}, updateBalanceStatus() {},
    teamCountSliderEl: { value: '3' }, groupingCheckboxEl: { checked: true },
  });
  vm.runInContext(pageFunction('  async function loadDefaultDatabaseIntoStorage(', '  balanceSliderEl.addEventListener'), context);
  await context.loadDefaultDatabaseIntoStorage({ players: [{ id: 'p1' }], games: [{ id: 'new' }], seasonStartDate: '2026-09-01' }, { preservePlayState: true });
  assert.equal(context.games[0].id, 'new');
  assert.equal(context.presenceState, presence);
  assert.equal(context.teamCountSliderEl.value, '3');
  assert.equal(context.groupingCheckboxEl.checked, true);
});
