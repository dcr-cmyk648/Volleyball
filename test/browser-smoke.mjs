import fs from 'node:fs';

if (process.env.VBALL_BROWSER_SMOKE !== '1') {
  console.log('Skipping browser smoke; set VBALL_BROWSER_SMOKE=1 to run.');
  process.exit(0);
}

const baseUrl = process.argv[2] || 'http://127.0.0.1:5176';
const cdpUrl = process.argv[3] || 'http://127.0.0.1:9223';
const db = JSON.parse(fs.readFileSync('test/fixtures/bayesian-2026-06-20.json', 'utf8'));
const isValidDateString = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const getGameDateValue = game => typeof game?.date === 'string' ? game.date : '';
const getLatestGameDate = games => [...games]
  .map(getGameDateValue)
  .filter(Boolean)
  .sort()
  .at(-1) || '';
const getSeasonRankingWindowCutoffDate = games => {
  const latestGameDate = getLatestGameDate(Array.isArray(games) ? games : []);
  const anchor = isValidDateString(latestGameDate) ? latestGameDate : new Date().toISOString().slice(0, 10);
  const date = new Date(`${anchor}T00:00:00`);
  date.setMonth(date.getMonth() - 1);
  return date.toISOString().slice(0, 10);
};
const seasonRankingWindowGames = db.games.filter(game => {
  const date = getGameDateValue(game);
  return isValidDateString(date) && date >= getSeasonRankingWindowCutoffDate(db.games);
});
const snapshotKey = 'gameDayBayesianScoreboardSnapshotV1:composite';
const bigTeamSnapshotKey = 'gameDayBayesianScoreboardSnapshotV1:bigTeam';
const smallTeamSnapshotKey = 'gameDayBayesianScoreboardSnapshotV1:smallTeam';

async function getPageWebSocketUrl() {
  const targets = await fetch(`${cdpUrl}/json/list`).then(response => response.json());
  const page = targets.find(target => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page target found.');
  return page.webSocketDebuggerUrl;
}

function createClient(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    const callbacks = listeners.get(message.method) || [];
    callbacks.forEach(callback => callback(message.params));
  });

  return {
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, callback) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(callback);
    },
    close() {
      ws.close();
    },
  };
}

async function waitForLoad(client) {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 6000);
    client.on('Page.loadEventFired', () => {
      clearTimeout(timeout);
      setTimeout(resolve, 250);
    });
  });
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed.');
  }
  return result.result?.value;
}

const client = createClient(await getPageWebSocketUrl());
await client.ready;
await client.send('Page.enable');
await client.send('Runtime.enable');

let load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/stats.html` });
await load;

await evaluate(client, `
  localStorage.setItem('gameDayPlayers', ${JSON.stringify(JSON.stringify(db.players))});
  localStorage.setItem('gameDayGames', ${JSON.stringify(JSON.stringify(db.games))});
  localStorage.removeItem('gameDayBayesianScoreboardSnapshotV1');
  localStorage.removeItem(${JSON.stringify(snapshotKey)});
  localStorage.removeItem(${JSON.stringify(bigTeamSnapshotKey)});
  localStorage.removeItem(${JSON.stringify(smallTeamSnapshotKey)});
  sessionStorage.removeItem('statsActiveTab');
  sessionStorage.removeItem('seasonStatsActiveTab');
`);

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/stats.html` });
await load;

const defaultTab = await evaluate(client, `({
  seasonActive: document.getElementById('seasonStatsTabButton')?.classList.contains('active'),
  seasonRankingActive: document.getElementById('seasonRankingSubTabButton')?.classList.contains('active'),
  sessionHidden: document.getElementById('sessionStatsPanel')?.classList.contains('hidden'),
  seasonHidden: document.getElementById('seasonStatsPanel')?.classList.contains('hidden'),
  rankingRows: document.querySelectorAll('#statsTableBody tr').length,
})`);
if (!defaultTab.seasonActive || !defaultTab.seasonRankingActive || defaultTab.seasonHidden || !defaultTab.sessionHidden || defaultTab.rankingRows < 1) {
  throw new Error(`Stats did not default to Season Ranking: ${JSON.stringify(defaultTab)}`);
}

const historyLoaded = await evaluate(client, `
  new Promise(resolve => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const started = Date.now();
    const timer = setInterval(() => {
      const cards = document.querySelectorAll('#historyList .game-card').length;
      if (cards > 0 || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({
          cards,
          firstDate: document.querySelector('#historyList .game-card strong')?.textContent || '',
          html: document.getElementById('historyList')?.innerHTML.slice(0, 120) || ''
        });
      }
    }, 100);
  })
`, true);

if (historyLoaded.cards !== seasonRankingWindowGames.length) {
  throw new Error(`Game History did not render the Season Ranking window: ${JSON.stringify(historyLoaded)}`);
}

const firstSeasonRankingRow = await evaluate(client, `(() => {
  const row = document.querySelector('#statsTableBody tr');
  const cells = row ? [...row.querySelectorAll('td')] : [];
  const link = row?.querySelector('a[href*="trend.html"]');
  return {
    name: link?.textContent?.trim() || '',
    rating: cells[3]?.textContent?.trim() || '',
    href: link ? new URL(link.getAttribute('href'), window.location.href).href : ''
  };
})()`);

if (!firstSeasonRankingRow.href || !firstSeasonRankingRow.rating) {
  throw new Error(`Could not read first Season Ranking row: ${JSON.stringify(firstSeasonRankingRow)}`);
}

load = waitForLoad(client);
await client.send('Page.navigate', { url: firstSeasonRankingRow.href });
await load;

const trendAlignment = await evaluate(client, `
  new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const text = document.getElementById('statusMessage')?.textContent || '';
      const match = text.match(/^Rating:\\s*(\\d+)/m);
      if (match) {
        clearInterval(timer);
        resolve({
          seasonName: ${JSON.stringify(firstSeasonRankingRow.name)},
          seasonRating: ${JSON.stringify(firstSeasonRankingRow.rating)},
          trendRating: match[1],
          status: text
        });
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({
          seasonName: ${JSON.stringify(firstSeasonRankingRow.name)},
          seasonRating: ${JSON.stringify(firstSeasonRankingRow.rating)},
          trendRating: '',
          status: text
        });
      }
    }, 100);
  })
`, true);

if (trendAlignment.trendRating !== firstSeasonRankingRow.rating) {
  throw new Error(`Trend rating does not match Season Ranking: ${JSON.stringify(trendAlignment)}`);
}

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/stats.html?tab=bayesian` });
await load;

const beforeClick = await evaluate(client, `({
  button: document.getElementById('calculateBayesianButton')?.textContent,
  rows: document.querySelectorAll('#bayesianTableBody tr').length,
  snapshot: localStorage.getItem(${JSON.stringify(snapshotKey)}),
  bigTeamSnapshot: localStorage.getItem(${JSON.stringify(bigTeamSnapshotKey)}),
  smallTeamSnapshot: localStorage.getItem(${JSON.stringify(smallTeamSnapshotKey)}),
})`);

if (beforeClick.snapshot !== null || beforeClick.bigTeamSnapshot !== null || beforeClick.smallTeamSnapshot !== null) {
  throw new Error('Bayesian snapshot was created before click.');
}
if (beforeClick.button !== 'Calculate Bayesian ratings for all scoreboards — 126 new games') {
  throw new Error(`Unexpected button before click: ${beforeClick.button}`);
}

await evaluate(client, `document.getElementById('calculateBayesianButton').click()`);

const completed = await evaluate(client, `
  new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const raw = localStorage.getItem(${JSON.stringify(snapshotKey)});
      const bigTeamRaw = localStorage.getItem(${JSON.stringify(bigTeamSnapshotKey)});
      const smallTeamRaw = localStorage.getItem(${JSON.stringify(smallTeamSnapshotKey)});
      if (raw && bigTeamRaw && smallTeamRaw) {
        clearInterval(timer);
        const snapshot = JSON.parse(raw);
        const bigTeamSnapshot = JSON.parse(bigTeamRaw);
        const smallTeamSnapshot = JSON.parse(smallTeamRaw);
        const matt = snapshot.ratings.find(row => row.name === 'MattA');
        resolve({
          saved: true,
          savedModes: {
            composite: Boolean(raw),
            bigTeam: Boolean(bigTeamRaw),
            smallTeam: Boolean(smallTeamRaw)
          },
          buttonDisabled: document.getElementById('calculateBayesianButton').disabled,
          games: snapshot.gamesConsidered,
          bigTeamGames: bigTeamSnapshot.gamesConsidered,
          smallTeamGames: smallTeamSnapshot.gamesConsidered,
          scored: snapshot.scoredGames,
          winnerOnly: snapshot.winnerOnlyGames,
          mattOrdinal: matt?.ordinal,
          jitter: snapshot.diagnostics?.posterior?.jitter,
          rowCount: document.querySelectorAll('#bayesianTableBody tr').length
        });
      } else if (Date.now() - started > 30000) {
        clearInterval(timer);
        resolve({ saved: false });
      }
    }, 100);
  })
`, true);

client.close();

if (!completed.saved) throw new Error('Bayesian worker did not persist a snapshot.');
if (completed.games !== 126 || completed.scored !== 123 || completed.winnerOnly !== 3) {
  throw new Error(`Unexpected snapshot counts: ${JSON.stringify(completed)}`);
}

console.log(JSON.stringify({ defaultTab, trendAlignment, beforeClick, completed }, null, 2));
