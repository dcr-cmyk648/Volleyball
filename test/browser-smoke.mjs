import fs from 'node:fs';

if (process.env.VBALL_BROWSER_SMOKE !== '1') {
  console.log('Skipping browser smoke; set VBALL_BROWSER_SMOKE=1 to run.');
  process.exit(0);
}

const baseUrl = process.argv[2] || 'http://127.0.0.1:5176';
const cdpUrl = process.argv[3] || 'http://127.0.0.1:9223';
const db = JSON.parse(fs.readFileSync('test/fixtures/bayesian-2026-06-20.json', 'utf8'));
const leagueGameCount = db.games.filter(game => game?.isLeagueGame).length;
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
const nonLeagueGames = db.games.filter(game => !game?.isLeagueGame);
const nonLeagueSeasonRankingWindowGames = nonLeagueGames.filter(game => {
  const date = getGameDateValue(game);
  return isValidDateString(date) && date >= getSeasonRankingWindowCutoffDate(nonLeagueGames);
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
  localStorage.setItem('gameDayAllTimeBayesianScoreboardMode', 'smallTeam');
  sessionStorage.removeItem('statsActiveTab');
  sessionStorage.removeItem('seasonStatsActiveTab');
`);

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/stats.html` });
await load;

const defaultTab = await evaluate(client, `
  new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const state = {
        seasonActive: document.getElementById('seasonStatsTabButton')?.classList.contains('active'),
        seasonRankingActive: document.getElementById('seasonRankingSubTabButton')?.classList.contains('active'),
        sessionHidden: document.getElementById('sessionStatsPanel')?.classList.contains('hidden'),
        seasonHidden: document.getElementById('seasonStatsPanel')?.classList.contains('hidden'),
        rankingRows: document.querySelectorAll('#statsTableBody tr').length,
      };

      if (state.rankingRows > 0 || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve(state);
      }
    }, 100);
  })
`, true);
if (!defaultTab.seasonActive || !defaultTab.seasonRankingActive || defaultTab.seasonHidden || !defaultTab.sessionHidden || defaultTab.rankingRows < 1) {
  throw new Error(`Stats did not default to Season Ranking: ${JSON.stringify(defaultTab)}`);
}

const makeTeamPlayer = player => ({ id: player.id, name: player.name });
const sessionArrowBoundaryGame = {
  id: 9900000000001,
  createdAt: 9900000000001,
  date: '2026-05-18',
  redTeam: db.players.slice(0, 2).map(makeTeamPlayer),
  blueTeam: db.players.slice(2, 4).map(makeTeamPlayer),
  scoreRed: 25,
  scoreBlue: 17,
  winner: 'red',
  isLeagueGame: false,
  courtType: 'indoor',
};
const sessionArrowLatestGame = {
  id: 9900000000002,
  createdAt: 9900000000002,
  date: '2026-06-19',
  redTeam: db.players.slice(2, 4).map(makeTeamPlayer),
  blueTeam: db.players.slice(0, 2).map(makeTeamPlayer),
  scoreRed: 25,
  scoreBlue: 19,
  winner: 'red',
  isLeagueGame: false,
  courtType: 'indoor',
};
const sessionArrowPriorGames = [...db.games, sessionArrowBoundaryGame];
const sessionArrowCurrentGames = [...sessionArrowPriorGames, sessionArrowLatestGame];

async function loadSeasonRankingRows(games) {
  await evaluate(client, `
    localStorage.setItem('gameDayGames', ${JSON.stringify(JSON.stringify(games))});
    sessionStorage.clear();
  `);
  const pageLoad = waitForLoad(client);
  await client.send('Page.navigate', { url: `${baseUrl}/stats.html` });
  await pageLoad;
  return evaluate(client, `
    new Promise(resolve => {
      const started = Date.now();
      const timer = setInterval(() => {
        const rows = [...document.querySelectorAll('#statsTableBody tr')].map(row => {
          const cells = [...row.querySelectorAll('td')];
          return {
            trend: cells[0]?.textContent?.trim() || '',
            rank: Number(cells[1]?.textContent?.trim()) || 0,
            name: row.querySelector('a[href*="trend.html"]')?.textContent?.trim() || '',
          };
        }).filter(row => row.name);
        if (rows.length > 0 || Date.now() - started > 10000) {
          clearInterval(timer);
          resolve(rows);
        }
      }, 100);
    })
  `, true);
}

const sessionArrowPriorRows = await loadSeasonRankingRows(sessionArrowPriorGames);
const sessionArrowCurrentRows = await loadSeasonRankingRows(sessionArrowCurrentGames);
const sessionArrowPriorRankMap = new Map(
  sessionArrowPriorRows.map(row => [row.name, row.rank])
);
const sessionArrowMismatches = sessionArrowCurrentRows.map(row => {
  const priorRank = sessionArrowPriorRankMap.get(row.name);
  const expected = typeof priorRank === 'number'
    ? priorRank > row.rank
      ? `▲ ${priorRank - row.rank}`
      : priorRank < row.rank
        ? `▼ ${row.rank - priorRank}`
        : '—'
    : 'NEW';
  return row.trend === expected ? null : { ...row, priorRank, expected };
}).filter(Boolean);

const sessionArrowSessionTab = await evaluate(client, `
  new Promise(resolve => {
    document.getElementById('sessionStatsTabButton').click();
    const started = Date.now();
    const timer = setInterval(() => {
      const summary = document.getElementById('sessionStatsSummary')?.textContent || '';
      const rows = document.querySelectorAll('#sessionStatsTableBody tr').length;
      if ((summary.includes('2026-06-19') && rows > 0) || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({ summary, rows });
      }
    }, 100);
  })
`, true);

if (
  sessionArrowMismatches.length > 0 ||
  !sessionArrowSessionTab.summary.includes('2026-06-19')
) {
  throw new Error(`Season Ranking arrows did not match the exact Session tab play date: ${JSON.stringify({ sessionArrowMismatches, sessionArrowSessionTab })}`);
}

await loadSeasonRankingRows(db.games);

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

const winnerDisplayDrops = await evaluate(client, `(() => {
  const drops = [];
  for (const card of document.querySelectorAll('#historyList .game-card')) {
    const badge = card.querySelector('.winner-badge');
    const winnerColor = [...(badge?.classList || [])]
      .find(name => name !== 'winner-badge');
    const winnerBox = winnerColor
      ? card.querySelector('.' + winnerColor + '-team')
      : null;
    const pattern = /([A-Za-z0-9]+) \\((\\d+) → (\\d+)\\)/g;
    for (const match of (winnerBox?.textContent || '').matchAll(pattern)) {
      if (Number(match[3]) < Number(match[2])) {
        drops.push({
          date: card.querySelector('.history-card-meta strong')?.textContent || '',
          player: match[1],
          before: Number(match[2]),
          after: Number(match[3]),
        });
      }
    }
  }
  return drops;
})()`);

if (winnerDisplayDrops.length) {
  throw new Error(`A winning player lost displayed Season Ranking points: ${JSON.stringify(winnerDisplayDrops)}`);
}

const firstSeasonRankingRow = await evaluate(client, `(() => {
  const row = document.querySelector('#statsTableBody tr');
  const cells = row ? [...row.querySelectorAll('td')] : [];
  const link = row?.querySelector('a[href*="trend.html"]');
  return {
    name: link?.textContent?.trim() || '',
    rank: cells[1]?.textContent?.trim() || '',
    rating: cells[3]?.textContent?.trim() || '',
    games: cells[4]?.textContent?.trim() || '',
    href: link ? new URL(link.getAttribute('href'), window.location.href).href : '',
    mode: link ? new URL(link.getAttribute('href'), window.location.href).searchParams.get('mode') : ''
  };
})()`);

if (!firstSeasonRankingRow.href || !firstSeasonRankingRow.rating || firstSeasonRankingRow.mode !== 'composite') {
  throw new Error(`Could not read first Season Ranking row: ${JSON.stringify(firstSeasonRankingRow)}`);
}

const historyAlignment = await evaluate(client, `(() => {
  const name = ${JSON.stringify(firstSeasonRankingRow.name)};
  const marker = name + ' (';

  for (const card of document.querySelectorAll('#historyList .game-card')) {
    const text = card.textContent || '';
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const ratingText = text.slice(start + marker.length);
    const match = ratingText.match(/^(\\d+)\\s*→\\s*(\\d+)\\)/);
    if (!match) continue;
    return {
      name,
      seasonRating: ${JSON.stringify(firstSeasonRankingRow.rating)},
      historyRating: match[2],
      cardDate: card.querySelector('strong')?.textContent || '',
    };
  }

  return {
    name,
    seasonRating: ${JSON.stringify(firstSeasonRankingRow.rating)},
    historyRating: '',
    cardDate: '',
  };
})()`);

if (historyAlignment.historyRating !== firstSeasonRankingRow.rating) {
  throw new Error(`Game History rating does not match Season Ranking: ${JSON.stringify(historyAlignment)}`);
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
      const gamesMatch = text.match(/^Games included:\\s*(\\d+)/m);
      if (match) {
        clearInterval(timer);
        resolve({
          seasonName: ${JSON.stringify(firstSeasonRankingRow.name)},
          seasonRating: ${JSON.stringify(firstSeasonRankingRow.rating)},
          trendRating: match[1],
          seasonGames: ${JSON.stringify(firstSeasonRankingRow.games)},
          trendGames: gamesMatch?.[1] || '',
          status: text
        });
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({
          seasonName: ${JSON.stringify(firstSeasonRankingRow.name)},
          seasonRating: ${JSON.stringify(firstSeasonRankingRow.rating)},
          trendRating: '',
          seasonGames: ${JSON.stringify(firstSeasonRankingRow.games)},
          trendGames: gamesMatch?.[1] || '',
          status: text
        });
      }
    }, 100);
  })
`, true);

if (
  trendAlignment.trendRating !== firstSeasonRankingRow.rating ||
  trendAlignment.trendGames !== firstSeasonRankingRow.games
) {
  throw new Error(`Trend rating does not match Season Ranking: ${JSON.stringify(trendAlignment)}`);
}

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/stats.html` });
await load;

const advancedDefaults = await evaluate(client, `
  new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const rows = document.querySelectorAll('#statsTableBody tr').length;
      if (rows > 0 || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({
          rows,
          showChecked: Boolean(document.getElementById('showSeasonRankingAdvancedSettings')?.checked),
          optionsHidden: document.getElementById('seasonRankingAdvancedOptions')?.classList.contains('hidden'),
          hideLeagueChecked: Boolean(document.getElementById('hideSeasonRankingLeagueGames')?.checked),
          removeWindowChecked: Boolean(document.getElementById('removeSeasonRankingWindow')?.checked),
          removePenaltyChecked: Boolean(document.getElementById('removeSeasonRankingConfidencePenalty')?.checked),
        });
      }
    }, 100);
  })
`, true);

if (
  advancedDefaults.rows < 1 ||
  advancedDefaults.showChecked ||
  !advancedDefaults.optionsHidden ||
  advancedDefaults.hideLeagueChecked ||
  advancedDefaults.removeWindowChecked ||
  advancedDefaults.removePenaltyChecked
) {
  throw new Error(`Season Ranking advanced settings did not default off: ${JSON.stringify(advancedDefaults)}`);
}

const advancedExpanded = await evaluate(client, `(() => {
  document.getElementById('showSeasonRankingAdvancedSettings').click();
  return {
    showChecked: document.getElementById('showSeasonRankingAdvancedSettings').checked,
    optionsHidden: document.getElementById('seasonRankingAdvancedOptions').classList.contains('hidden'),
    switches: [...document.querySelectorAll('#seasonRankingAdvancedOptions input[type="checkbox"]')]
      .map(input => ({ id: input.id, checked: input.checked })),
  };
})()`);

if (
  !advancedExpanded.showChecked ||
  advancedExpanded.optionsHidden ||
  advancedExpanded.switches.length !== 3 ||
  advancedExpanded.switches.some(input => input.checked)
) {
  throw new Error(`Season Ranking advanced settings did not expand with switches off: ${JSON.stringify(advancedExpanded)}`);
}

const leagueHidden = await evaluate(client, `
  new Promise(resolve => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    document.getElementById('hideSeasonRankingLeagueGames').click();
    const started = Date.now();
    const timer = setInterval(() => {
      const description = document.getElementById('rankingModeDescription')?.textContent || '';
      const cards = document.querySelectorAll('#historyList .game-card').length;
      const busy = !document.getElementById('busyOverlay')?.classList.contains('hidden');
      if ((!busy && description.includes('League games are excluded') &&
          cards === ${nonLeagueSeasonRankingWindowGames.length}) || Date.now() - started > 15000) {
        clearInterval(timer);
        resolve({
          cards,
          busy,
          description,
          hideLeagueChecked: document.getElementById('hideSeasonRankingLeagueGames')?.checked,
          historyContainsLeague: [...document.querySelectorAll('#historyList .game-card')]
            .some(card => (card.textContent || '').includes(' League ')),
        });
      }
    }, 100);
  })
`, true);

if (
  !leagueHidden.hideLeagueChecked ||
  leagueHidden.cards !== nonLeagueSeasonRankingWindowGames.length ||
  leagueHidden.historyContainsLeague ||
  !leagueHidden.description.includes('League games are excluded')
) {
  throw new Error(`Hide league games did not update Season Ranking and Game History: ${JSON.stringify(leagueHidden)}`);
}

const seasonWindowRemoved = await evaluate(client, `
  new Promise(resolve => {
    document.getElementById('removeSeasonRankingWindow').click();
    const started = Date.now();
    const timer = setInterval(() => {
      const description = document.getElementById('rankingModeDescription')?.textContent || '';
      const cards = document.querySelectorAll('#historyList .game-card').length;
      const busy = !document.getElementById('busyOverlay')?.classList.contains('hidden');
      if ((!busy && description.includes('season window is removed') &&
          cards === ${nonLeagueGames.length}) || Date.now() - started > 15000) {
        clearInterval(timer);
        const ratings = Object.fromEntries([...document.querySelectorAll('#statsTableBody tr')]
          .map(row => {
            const cells = [...row.querySelectorAll('td')];
            const name = row.querySelector('a[href*="trend.html"]')?.textContent?.trim() || '';
            return name ? [name, Number(cells[3]?.textContent?.trim())] : null;
          })
          .filter(Boolean));
        resolve({
          cards,
          busy,
          description,
          removeWindowChecked: document.getElementById('removeSeasonRankingWindow')?.checked,
          ratings,
        });
      }
    }, 100);
  })
`, true);

if (
  !seasonWindowRemoved.removeWindowChecked ||
  seasonWindowRemoved.cards !== nonLeagueGames.length ||
  !seasonWindowRemoved.description.includes('season window is removed')
) {
  throw new Error(`Remove season window did not include all non-league history: ${JSON.stringify(seasonWindowRemoved)}`);
}

const confidencePenaltyRemoved = await evaluate(client, `
  new Promise(resolve => {
    document.getElementById('removeSeasonRankingConfidencePenalty').click();
    const started = Date.now();
    const timer = setInterval(() => {
      const description = document.getElementById('rankingModeDescription')?.textContent || '';
      const busy = !document.getElementById('busyOverlay')?.classList.contains('hidden');
      if ((!busy && description.includes('penalties are removed')) || Date.now() - started > 15000) {
        clearInterval(timer);
        const rows = [...document.querySelectorAll('#statsTableBody tr')].map(row => {
          const cells = [...row.querySelectorAll('td')];
          const link = row.querySelector('a[href*="trend.html"]');
          return {
            name: link?.textContent?.trim() || '',
            rating: Number(cells[3]?.textContent?.trim()),
            games: cells[4]?.textContent?.trim() || '',
            href: link ? new URL(link.getAttribute('href'), window.location.href).href : '',
          };
        }).filter(row => row.name);
        resolve({
          busy,
          description,
          removePenaltyChecked: document.getElementById('removeSeasonRankingConfidencePenalty')?.checked,
          rows,
        });
      }
    }, 100);
  })
`, true);

const confidenceIncreases = confidencePenaltyRemoved.rows.filter(row =>
  Number.isFinite(seasonWindowRemoved.ratings[row.name]) &&
  row.rating > seasonWindowRemoved.ratings[row.name]
);
const under1500Rows = confidencePenaltyRemoved.rows.filter(row => row.rating < 1500);
const under1500PenaltyChanges = under1500Rows.filter(row =>
  Number.isFinite(seasonWindowRemoved.ratings[row.name]) &&
  row.rating !== seasonWindowRemoved.ratings[row.name]
);
const advancedSeasonRankingRow = confidencePenaltyRemoved.rows[0];
const advancedRowUrl = new URL(advancedSeasonRankingRow?.href || baseUrl);
if (
  !confidencePenaltyRemoved.removePenaltyChecked ||
  !confidencePenaltyRemoved.description.includes('penalties are removed') ||
  confidenceIncreases.length < 1 ||
  under1500Rows.length < 1 ||
  under1500PenaltyChanges.length > 0 ||
  advancedRowUrl.searchParams.get('hideLeagueGames') !== '1' ||
  advancedRowUrl.searchParams.get('removeSeasonWindow') !== '1' ||
  advancedRowUrl.searchParams.get('removeConfidencePenalty') !== '1'
) {
  throw new Error(`Remove confidence penalty did not update or propagate advanced ratings: ${JSON.stringify({ confidencePenaltyRemoved, confidenceIncreases, under1500Rows, under1500PenaltyChanges })}`);
}

const advancedHistoryAlignment = await evaluate(client, `(() => {
  const name = ${JSON.stringify(advancedSeasonRankingRow?.name || '')};
  const marker = name + ' (';
  for (const card of document.querySelectorAll('#historyList .game-card')) {
    const text = card.textContent || '';
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const match = text.slice(start + marker.length).match(/^(\\d+)\\s*→\\s*(\\d+)\\)/);
    if (!match) continue;
    return { historyRating: match[2], cardDate: card.querySelector('strong')?.textContent || '' };
  }
  return { historyRating: '', cardDate: '' };
})()`);

if (advancedHistoryAlignment.historyRating !== String(advancedSeasonRankingRow.rating)) {
  throw new Error(`Advanced Game History rating does not match Season Ranking: ${JSON.stringify({ advancedSeasonRankingRow, advancedHistoryAlignment })}`);
}

load = waitForLoad(client);
await client.send('Page.navigate', { url: advancedSeasonRankingRow.href });
await load;

const advancedTrendAlignment = await evaluate(client, `
  new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const text = document.getElementById('statusMessage')?.textContent || '';
      const ratingMatch = text.match(/^Rating:\\s*(\\d+)/m);
      const gamesMatch = text.match(/^Games included:\\s*(\\d+)/m);
      if (ratingMatch || Date.now() - started > 15000) {
        clearInterval(timer);
        resolve({
          rating: ratingMatch?.[1] || '',
          games: gamesMatch?.[1] || '',
          status: text,
          rangeButton: document.getElementById('trendMonthRangeButton')?.textContent || '',
        });
      }
    }, 100);
  })
`, true);

if (
  advancedTrendAlignment.rating !== String(advancedSeasonRankingRow.rating) ||
  advancedTrendAlignment.games !== advancedSeasonRankingRow.games ||
  !advancedTrendAlignment.status.includes('League games excluded') ||
  !advancedTrendAlignment.status.includes('Low-game penalties removed') ||
  advancedTrendAlignment.rangeButton !== 'Season Ranking'
) {
  throw new Error(`Advanced Trend does not match Season Ranking: ${JSON.stringify({ advancedSeasonRankingRow, advancedTrendAlignment })}`);
}

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/stats.html?tab=bayesian&mode=composite` });
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
          leagueOpponentCount: snapshot.diagnostics?.leagueOpponentCount,
          bigTeamLeagueOpponentCount: bigTeamSnapshot.diagnostics?.leagueOpponentCount,
          smallTeamLeagueOpponentCount: smallTeamSnapshot.diagnostics?.leagueOpponentCount,
          leagueRows: snapshot.ratings
            .filter(row => row.isLeagueContext)
            .map(row => ({ id: row.id, name: row.name, games: row.games })),
          rowCount: document.querySelectorAll('#bayesianTableBody tr').length
        });
      } else if (Date.now() - started > 30000) {
        clearInterval(timer);
        resolve({ saved: false });
      }
    }, 100);
  })
`, true);

const serverOnlyPlayer = { id: 'server-only-player', name: 'Existing Server Player' };
const serverOnlyGame = {
  id: 9999999999999,
  createdAt: 9999999999999,
  date: '2026-06-21',
  redTeam: [serverOnlyPlayer],
  blueTeam: [db.players[0]],
  scoreRed: 25,
  scoreBlue: 20,
  winner: 'red',
  isLeagueGame: false,
  courtType: 'indoor',
};
const playServerDb = {
  ...db,
  players: [...db.players, serverOnlyPlayer],
  games: [...db.games, serverOnlyGame],
};

await client.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      const serverDatabaseJson = ${JSON.stringify(JSON.stringify(playServerDb))};
      const originalFetch = window.fetch.bind(window);
      window.__playSafetyServerFetchCount = 0;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (url.includes('/api/google-stats') || url.includes('script.google.com/macros')) {
          window.__playSafetyServerFetchCount += 1;
          return Promise.resolve(new Response(serverDatabaseJson, {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return originalFetch(input, init);
      };
    })();
  `,
});

await evaluate(client, `
  localStorage.setItem('gameDayPlayers', ${JSON.stringify(JSON.stringify(db.players))});
  localStorage.setItem('gameDayGames', ${JSON.stringify(JSON.stringify(db.games))});
  localStorage.setItem('gameDayDefaultDatabasePromptChoice', 'declined');
  localStorage.removeItem('gameDayMainPageState');
`);

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/index.html` });
await load;

const registrationBlocked = await evaluate(client, `
  new Promise(resolve => {
    const search = document.getElementById('playerSearchInput');
    search.value = 'Existing Server Player';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('openAddPlayerDialog').click();

    const started = Date.now();
    const timer = setInterval(() => {
      const syncDialog = document.getElementById('defaultDatabaseDialog');
      if (syncDialog?.open || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({
          syncDialogOpen: Boolean(syncDialog?.open),
          addPlayerDialogOpen: Boolean(document.getElementById('addPlayerDialog')?.open),
          title: document.getElementById('defaultDatabaseDialogTitle')?.textContent || '',
          message: document.getElementById('defaultDatabaseText')?.textContent || '',
          syncButton: document.getElementById('confirmLoadDefaultDatabaseButton')?.textContent || '',
          serverFetches: window.__playSafetyServerFetchCount,
        });
      }
    }, 50);
  })
`, true);

if (
  !registrationBlocked.syncDialogOpen ||
  registrationBlocked.addPlayerDialogOpen ||
  registrationBlocked.title !== 'Sync Required Before Playing' ||
  !registrationBlocked.message.includes('missing 1 game') ||
  registrationBlocked.syncButton !== 'Sync Newest Stats' ||
  registrationBlocked.serverFetches !== 1
) {
  throw new Error(`Player registration was not blocked by stale server data: ${JSON.stringify(registrationBlocked)}`);
}

const balanceBlocked = await evaluate(client, `
  new Promise(resolve => {
    document.getElementById('declineLoadDefaultDatabaseButton').click();
    const balanceStatusBefore = document.getElementById('balanceStatus')?.textContent || '';
    document.getElementById('assignTeamsButton').click();

    const started = Date.now();
    const timer = setInterval(() => {
      const syncDialog = document.getElementById('defaultDatabaseDialog');
      if (syncDialog?.open || Date.now() - started > 3000) {
        clearInterval(timer);
        resolve({
          syncDialogOpen: Boolean(syncDialog?.open),
          title: document.getElementById('defaultDatabaseDialogTitle')?.textContent || '',
          serverFetches: window.__playSafetyServerFetchCount,
          balanceStatusBefore,
          balanceStatus: document.getElementById('balanceStatus')?.textContent || '',
        });
      }
    }, 50);
  })
`, true);

if (
  !balanceBlocked.syncDialogOpen ||
  balanceBlocked.title !== 'Sync Required Before Playing' ||
  balanceBlocked.serverFetches !== 1 ||
  balanceBlocked.balanceStatus !== balanceBlocked.balanceStatusBefore
) {
  throw new Error(`Team balancing was not blocked by stale server data: ${JSON.stringify(balanceBlocked)}`);
}

const afterSafetySync = await evaluate(client, `
  new Promise(resolve => {
    window.alert = () => {};
    document.getElementById('confirmLoadDefaultDatabaseButton').click();

    const started = Date.now();
    const timer = setInterval(() => {
      const localPlayers = JSON.parse(localStorage.getItem('gameDayPlayers') || '[]');
      const localGames = JSON.parse(localStorage.getItem('gameDayGames') || '[]');
      const syncedPlayer = localPlayers.some(player => player.id === 'server-only-player');
      const syncedGame = localGames.some(game => String(game.id) === '9999999999999');
      const syncDialogOpen = Boolean(document.getElementById('defaultDatabaseDialog')?.open);

      if ((syncedPlayer && syncedGame && !syncDialogOpen) || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({
          syncedPlayer,
          syncedGame,
          syncDialogOpen,
          localPlayerCount: localPlayers.length,
          localGameCount: localGames.length,
          serverFetches: window.__playSafetyServerFetchCount,
        });
      }
    }, 50);
  })
`, true);

if (
  !afterSafetySync.syncedPlayer ||
  !afterSafetySync.syncedGame ||
  afterSafetySync.syncDialogOpen ||
  afterSafetySync.serverFetches !== 1
) {
  throw new Error(`Safety-dialog sync did not update local data: ${JSON.stringify(afterSafetySync)}`);
}

const registrationAfterSync = await evaluate(client, `(() => {
  const search = document.getElementById('playerSearchInput');
  search.value = 'Truly New Player';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('openAddPlayerDialog').click();
  return new Promise(resolve => setTimeout(() => resolve({
    addPlayerDialogOpen: Boolean(document.getElementById('addPlayerDialog')?.open),
    syncDialogOpen: Boolean(document.getElementById('defaultDatabaseDialog')?.open),
    serverFetches: window.__playSafetyServerFetchCount,
  }), 100));
})()`, true);

if (
  !registrationAfterSync.addPlayerDialogOpen ||
  registrationAfterSync.syncDialogOpen ||
  registrationAfterSync.serverFetches !== 1
) {
  throw new Error(`Player registration did not resume after sync: ${JSON.stringify(registrationAfterSync)}`);
}

const balanceAfterSync = await evaluate(client, `
  new Promise(resolve => {
    document.getElementById('cancelPlayerButton').click();
    const search = document.getElementById('playerSearchInput');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    for (let index = 0; index < 2; index += 1) {
      const nextCheckbox = [...document.querySelectorAll('.player-row input[type="checkbox"]')]
        .find(checkbox => !checkbox.checked);
      nextCheckbox?.click();
    }

    document.getElementById('assignTeamsButton').click();
    const started = Date.now();
    const timer = setInterval(() => {
      const balanceStatus = document.getElementById('balanceStatus')?.textContent || '';
      const busy = !document.getElementById('busyOverlay')?.classList.contains('hidden');
      const assigned = !balanceStatus.startsWith('No team assignment yet.');

      if ((!busy && assigned) || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({
          assigned,
          balanceStatus,
          selectedCount: document.getElementById('selectedCount')?.textContent || '',
          error: document.getElementById('errorMessage')?.textContent || '',
          syncDialogOpen: Boolean(document.getElementById('defaultDatabaseDialog')?.open),
          serverFetches: window.__playSafetyServerFetchCount,
        });
      }
    }, 50);
  })
`, true);

if (
  !balanceAfterSync.assigned ||
  balanceAfterSync.syncDialogOpen ||
  balanceAfterSync.serverFetches !== 1
) {
  throw new Error(`Team balancing did not resume after sync: ${JSON.stringify(balanceAfterSync)}`);
}

const unevenManualPlayers = playServerDb.players.slice(0, 14);
const unevenManualPresenceState = Object.fromEntries(
  unevenManualPlayers.map((player, index) => [String(player.id), {
    present: true,
    team: index < 8 ? 'red' : 'blue',
    group: null,
    lockedTeam: '',
  }])
);
const unevenManualPageState = {
  presenceState: unevenManualPresenceState,
  redScore: '25',
  blueScore: '20',
  hideUnselectedPlayers: false,
  balanceAttempts: 100,
  teamCount: 2,
  forceTwoChanges: false,
  forceChangeCount: 1,
  forceChangeCountManual: false,
  groupingEnabled: false,
  groupCount: 1,
  playerSearchQuery: '',
  currentAssignmentId: '',
  currentAssignmentDate: '',
  leagueLevel: '',
  courtType: 'grass',
};

await evaluate(client, `
  localStorage.setItem('gameDayPlayers', ${JSON.stringify(JSON.stringify(playServerDb.players))});
  localStorage.setItem('gameDayGames', ${JSON.stringify(JSON.stringify(playServerDb.games))});
  localStorage.setItem('gameDayMainPageState', ${JSON.stringify(JSON.stringify(unevenManualPageState))});
  localStorage.setItem('gameDayDefaultDatabasePromptChoice', 'declined');
`);

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/index.html` });
await load;

const unevenManualScoreEntry = await evaluate(client, `
  new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const selectedCount = document.getElementById('selectedCount')?.textContent || '';
      const button = document.querySelector('#recordButtons .red-button');
      if ((button && selectedCount.includes('Red: 8 | Blue: 6')) || Date.now() - started > 10000) {
        clearInterval(timer);
        button?.click();
        setTimeout(() => resolve({
          confirmationOpen: Boolean(document.getElementById('confirmGameDialog')?.open),
          error: document.getElementById('errorMessage')?.textContent || '',
          selectedCount,
          summary: document.getElementById('confirmGameSummary')?.textContent || '',
        }), 100);
      }
    }, 50);
  })
`, true);

if (
  !unevenManualScoreEntry.confirmationOpen ||
  unevenManualScoreEntry.error ||
  !unevenManualScoreEntry.selectedCount.includes('Red: 8 | Blue: 6') ||
  !unevenManualScoreEntry.summary.includes('Court type: Grass')
) {
  throw new Error(`Manual 8-vs-6 score entry was blocked: ${JSON.stringify(unevenManualScoreEntry)}`);
}

await evaluate(client, `document.getElementById('cancelConfirmGameButton').click()`);

await evaluate(client, `(() => {
  const games = JSON.parse(localStorage.getItem('gameDayGames') || '[]');
  if (games[0]) delete games[0].isTournamentGame;
  localStorage.setItem('gameDayGames', JSON.stringify(games));
})()`);

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/stats.html` });
await load;

const statsSemanticCorrectionCheck = await evaluate(client, `
  new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const buttonText = document.getElementById('loadDefaultDatabaseButton')?.textContent || '';
      if (buttonText === 'you are up to date' || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({ buttonText, serverFetches: window.__playSafetyServerFetchCount });
      }
    }, 100);
  })
`, true);

if (statsSemanticCorrectionCheck.buttonText !== 'you are up to date') {
  throw new Error(`Stats reported a correction for an omitted false default: ${JSON.stringify(statsSemanticCorrectionCheck)}`);
}

await evaluate(client, `(() => {
  const games = JSON.parse(localStorage.getItem('gameDayGames') || '[]');
  if (games[0]) games[0].scoreRed = Number(games[0].scoreRed || 0) + 1;
  localStorage.setItem('gameDayGames', JSON.stringify(games));
})()`);

load = waitForLoad(client);
await client.send('Page.navigate', { url: `${baseUrl}/stats.html` });
await load;

const genuineCorrectionCheck = await evaluate(client, `
  new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const buttonText = document.getElementById('loadDefaultDatabaseButton')?.textContent || '';
      if (buttonText === 'server corrections available' || Date.now() - started > 10000) {
        clearInterval(timer);
        resolve({ buttonText, serverFetches: window.__playSafetyServerFetchCount });
      }
    }, 100);
  })
`, true);

if (genuineCorrectionCheck.buttonText !== 'server corrections available') {
  throw new Error(`Stats did not detect a genuine score correction: ${JSON.stringify(genuineCorrectionCheck)}`);
}

client.close();

if (!completed.saved) throw new Error('Bayesian worker did not persist a snapshot.');
if (completed.games !== 126 || completed.scored !== 123 || completed.winnerOnly !== 3) {
  throw new Error(`Unexpected snapshot counts: ${JSON.stringify(completed)}`);
}
if (
  completed.leagueOpponentCount !== 1 ||
  completed.bigTeamLeagueOpponentCount !== 1 ||
  completed.smallTeamLeagueOpponentCount !== 0 ||
  completed.leagueRows.length !== 1 ||
  completed.leagueRows[0].name !== 'League Team' ||
  completed.leagueRows[0].games !== leagueGameCount
) {
  throw new Error(`Bayesian league teams were not pooled into one row: ${JSON.stringify(completed)}`);
}

console.log(JSON.stringify({
  defaultTab,
  winnerDisplayDrops,
  historyAlignment,
  trendAlignment,
  advancedDefaults,
  advancedExpanded,
  leagueHidden,
  seasonWindowRemoved: {
    cards: seasonWindowRemoved.cards,
    description: seasonWindowRemoved.description,
  },
  confidencePenaltyRemoved: {
    description: confidencePenaltyRemoved.description,
    increasedPlayers: confidenceIncreases.length,
    unchangedUnder1500Players: under1500Rows.length,
  },
  advancedHistoryAlignment,
  advancedTrendAlignment,
  beforeClick,
  completed,
  registrationBlocked,
  balanceBlocked,
  afterSafetySync,
  registrationAfterSync,
  balanceAfterSync,
  unevenManualScoreEntry,
  statsSemanticCorrectionCheck,
  genuineCorrectionCheck,
}, null, 2));
