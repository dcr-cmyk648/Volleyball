import fs from 'node:fs';

if (process.env.VBALL_BROWSER_SMOKE !== '1') {
  console.log('Skipping dynamic history browser test; set VBALL_BROWSER_SMOKE=1 to run.');
  process.exit(0);
}

const baseUrl = process.argv[2] || 'http://127.0.0.1:5176';
const cdpUrl = process.argv[3] || 'http://127.0.0.1:9223';
const db = JSON.parse(fs.readFileSync('test/fixtures/bayesian-2026-06-20.json', 'utf8'));
const snapshotKey = 'gameDayBayesianScoreboardSnapshotV3:composite';

const targets = await fetch(`${cdpUrl}/json/list`).then(response => response.json());
const target = targets.find(candidate => candidate.type === 'page');
if (!target?.webSocketDebuggerUrl) throw new Error('No Chrome page target found.');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const result = pending.get(message.id);
  if (!result) return;
  pending.delete(message.id);
  message.error ? result.reject(new Error(message.error.message)) : result.resolve(message.result);
});
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed.');
  return result.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${baseUrl}/stats.html?tab=allTime&mode=composite` });
await new Promise(resolve => setTimeout(resolve, 400));
await evaluate(`
  localStorage.setItem('gameDayPlayers', ${JSON.stringify(JSON.stringify(db.players))});
  localStorage.setItem('gameDayGames', ${JSON.stringify(JSON.stringify(db.games))});
  localStorage.removeItem(${JSON.stringify(snapshotKey)});
  localStorage.removeItem('gameDayBayesianScoreboardSnapshotV1:bigTeam');
  localStorage.removeItem('gameDayBayesianScoreboardSnapshotV1:smallTeam');
`);
await send('Page.navigate', { url: `${baseUrl}/stats.html?tab=allTime&mode=composite` });
await new Promise(resolve => setTimeout(resolve, 400));
await evaluate(`document.getElementById('calculateBayesianButton').click()`);
const ready = await evaluate(`new Promise(resolve => {
  const started = Date.now(); const timer = setInterval(() => {
    if (localStorage.getItem(${JSON.stringify(snapshotKey)}) || Date.now() - started > 30000) {
      clearInterval(timer); resolve(Boolean(localStorage.getItem(${JSON.stringify(snapshotKey)})));
    }
  }, 100);
})`);
if (!ready) throw new Error('Dynamic Overall snapshot was not calculated.');

await evaluate(`document.querySelector('#bayesianTableBody .history-player-button')?.focus()`);
await send('Page.bringToFront');
await send('Input.dispatchKeyEvent', {
  type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
await send('Input.dispatchKeyEvent', {
  type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
});
const openState = await evaluate(`(() => {
  const button = document.querySelector('#bayesianTableBody .history-player-button');
  const league = [...document.querySelectorAll('#bayesianTableBody tr')].find(row => row.textContent.includes('League Player'));
  const svg = document.getElementById('overallHistoryChart');
  const row = button?.closest('tr'); const cells = [...(row?.querySelectorAll('td') || [])];
  const path = svg?.querySelector('.history-chart-line'); const band = svg?.querySelector('.history-chart-band');
  return {
    button: Boolean(button), leagueInteractive: Boolean(league?.querySelector('.history-player-button')),
    dialogVisible: !document.getElementById('overallHistoryOverlay').classList.contains('hidden'),
    modal: document.getElementById('overallHistoryDialog').getAttribute('aria-modal'),
    labelledBy: document.getElementById('overallHistoryDialog').getAttribute('aria-labelledby'),
    focusClose: document.activeElement?.id, line: path?.getAttribute('points') || '', band: band?.getAttribute('points') || '',
    rowRating: cells[3]?.textContent?.trim(), endpoint: svg?.dataset.historyEndpoint || '', xValues: svg?.dataset.historyXValues || '',
    dates: JSON.parse(localStorage.getItem(${JSON.stringify(snapshotKey)})).history[button?.dataset.overallHistoryPlayerId || '']?.map(knot => knot.date) || [],
  };
})()`);
if (!openState.button || openState.leagueInteractive || !openState.dialogVisible || openState.modal !== 'true' || openState.labelledBy !== 'overallHistoryTitle' || openState.focusClose !== 'closeOverallHistoryButton' || !openState.line || !openState.band || Number(openState.endpoint) !== Number(openState.rowRating)) throw new Error(`Overlay open semantics failed: ${JSON.stringify(openState)}`);
const timestamps = openState.dates.map(date => Date.parse(`${date}T00:00:00Z`));
const xValues = openState.xValues.split(',').map(Number);
if (timestamps.length > 2 && timestamps[2] - timestamps[1] !== timestamps[1] - timestamps[0] && Math.abs((xValues[2] - xValues[1]) - (xValues[1] - xValues[0])) < 0.01) {
  throw new Error(`History x coordinates ignored nonuniform timestamps: ${JSON.stringify(openState)}`);
}

await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
const focusAfterTab = await evaluate(`document.activeElement?.id || ''`);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8 });
const focusAfterShiftTab = await evaluate(`document.activeElement?.id || ''`);
if (focusAfterTab !== 'closeOverallHistoryButton' || focusAfterShiftTab !== 'closeOverallHistoryButton') throw new Error(`Dialog focus was not contained: ${focusAfterTab}, ${focusAfterShiftTab}`);

const closePaths = await evaluate(`(() => {
  const overlay = document.getElementById('overallHistoryOverlay'); const button = document.querySelector('.history-player-button');
  document.getElementById('closeOverallHistoryButton').click(); const closeButton = overlay.classList.contains('hidden') && document.activeElement === button;
  button.click(); overlay.dispatchEvent(new MouseEvent('click', { bubbles: true })); const backdrop = overlay.classList.contains('hidden');
  button.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); const escape = overlay.classList.contains('hidden');
  document.getElementById('overallBigTeamModeButton').click(); const bigPlain = !document.querySelector('#bayesianTableBody .history-player-button');
  return { closeButton, backdrop, escape, bigPlain };
})()`);
if (!closePaths.closeButton || !closePaths.backdrop || !closePaths.escape || !closePaths.bigPlain) throw new Error(`Overlay close or mode scoping failed: ${JSON.stringify(closePaths)}`);

await evaluate(`document.getElementById('overallCompositeModeButton').click()`);
const sparseState = await evaluate(`(() => {
  const snapshot = JSON.parse(localStorage.getItem(${JSON.stringify(snapshotKey)}));
  const id = Object.entries(snapshot.history).find(([, knots]) => knots.length === 1)?.[0];
  const button = id ? document.querySelector('[data-overall-history-player-id="' + CSS.escape(id) + '"]') : null;
  button?.click();
  const svg = document.getElementById('overallHistoryChart');
  const viewBox = (svg?.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number);
  return {
    available: Boolean(button),
    visible: !document.getElementById('overallHistoryOverlay').classList.contains('hidden'),
    x: svg?.dataset.historyXValues || '',
    center: Number.isFinite(viewBox[2]) ? (44 + 386) / 2 : 0,
  };
})()`);
if (sparseState.available && (!sparseState.visible || Math.abs(Number(sparseState.x) - sparseState.center) > 0.01)) throw new Error(`Sparse history did not render as a centered one-knot chart: ${JSON.stringify(sparseState)}`);

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
const mobileChart = await evaluate(`(() => {
  const overlay = document.getElementById('overallHistoryOverlay');
  if (!overlay.classList.contains('hidden')) document.getElementById('closeOverallHistoryButton').click();
  const button = document.querySelector('#bayesianTableBody .history-player-button');
  button?.click();
  const svg = document.getElementById('overallHistoryChart');
  const rowCells = [...(button?.closest('tr')?.querySelectorAll('td') || [])];
  const leagueRow = [...document.querySelectorAll('#bayesianTableBody tr')].find(row => row.textContent.includes('League Player'));
  const leagueCells = [...(leagueRow?.querySelectorAll('td') || [])];
  const yTicks = [...svg.querySelectorAll('.history-chart-y-tick')].map(label => Number(label.textContent));
  const xTicks = [...svg.querySelectorAll('.history-chart-x-tick')].map(label => label.textContent);
  const xTickBoxes = [...svg.querySelectorAll('.history-chart-x-tick')].map(label => {
    const box = label.getBoundingClientRect();
    return { left: box.left, right: box.right };
  });
  const markers = [...svg.querySelectorAll('.history-chart-point')].map(point => [Number(point.getAttribute('cx')), Number(point.getAttribute('cy'))]);
  const historyKnotCount = JSON.parse(localStorage.getItem(${JSON.stringify(snapshotKey)})).history[button?.dataset.overallHistoryPlayerId || '']?.length || 0;
  const expectedActiveWeeklyBucketCount = (() => {
    const id = String(button?.dataset.overallHistoryPlayerId || '');
    const anchor = Date.parse('2000-01-03T00:00:00Z');
    const bucket = value => {
      const instant = Date.parse(String(value || '').slice(0, 10) + 'T00:00:00Z');
      return Number.isFinite(instant)
        ? new Date(anchor + Math.floor((instant - anchor) / (7 * 86400000)) * 7 * 86400000).toISOString().slice(0, 10)
        : '';
    };
    return new Set(${JSON.stringify(db.games)}.flatMap(game => {
      const date = game?.date || game?.gameDate || game?.createdAt;
      const appeared = [...(game?.redTeam || []), ...(game?.blueTeam || [])].some(player => String(player?.id) === id);
      const key = appeared ? bucket(date) : '';
      return key ? [key] : [];
    })).size;
  })();
  const viewBox = svg.viewBox.baseVal;
  const label = svg.querySelector('.history-chart-y-tick');
  const labelStyle = getComputedStyle(label);
  const effectiveLabelSize = (Number.parseFloat(labelStyle.fontSize) || 0) * (svg.getBoundingClientRect().width / viewBox.width);
  return {
    endpoint: Number(svg.dataset.historyEndpoint),
    rowRating: Number(rowCells[3]?.textContent),
    yTicks,
    gridlines: svg.querySelectorAll('.history-chart-grid').length,
    xTicks,
    xTicksDoNotOverlap: xTickBoxes.every((box, index) => index === 0 || box.left >= xTickBoxes[index - 1].right - 0.5),
    markers,
    historyKnotCount,
    expectedActiveWeeklyBucketCount,
    effectiveLabelSize,
    leagueReference: Number(svg.dataset.historyLeagueReference),
    leagueRating: Number(leagueCells[3]?.textContent),
    leagueLabel: svg.querySelector('.history-chart-league-label')?.textContent || '',
    leagueLine: Boolean(svg.querySelector('.history-chart-league-reference')),
    yDomain: (svg.dataset.historyYDomain || '').split(',').map(Number),
  };
})()`);
if (mobileChart.endpoint !== mobileChart.rowRating || mobileChart.yTicks.length < 6 || mobileChart.gridlines < mobileChart.yTicks.length || !mobileChart.yTicks.every(Number.isFinite) || mobileChart.xTicks.length < 3 || !/^[A-Z][a-z]{2} '\d{2}$/.test(mobileChart.xTicks[0]) || !mobileChart.xTicks.every(label => /^[A-Z][a-z]{2}(?: '\d{2})?$/.test(label)) || !mobileChart.xTicksDoNotOverlap || mobileChart.effectiveLabelSize < 12 || !mobileChart.markers.length || mobileChart.historyKnotCount !== mobileChart.expectedActiveWeeklyBucketCount || mobileChart.markers.length !== mobileChart.expectedActiveWeeklyBucketCount || !mobileChart.markers.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) || !mobileChart.leagueLine || mobileChart.leagueReference !== mobileChart.leagueRating || mobileChart.leagueLabel !== `League avg ${mobileChart.leagueRating}` || mobileChart.yDomain.length !== 2 || !mobileChart.yDomain.every(Number.isFinite) || mobileChart.leagueReference < mobileChart.yDomain[0] || mobileChart.leagueReference > mobileChart.yDomain[1]) throw new Error(`Mobile history chart failed: ${JSON.stringify(mobileChart)}`);
const mobileRows = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#bayesianTableBody tr')];
  const league = rows.find(row => row.textContent.includes('League Player'));
  const leagueCells = [...(league?.querySelectorAll('td') || [])];
  const realButton = document.querySelector('#bayesianTableBody .history-player-button');
  const wrapper = document.querySelector('.bayesian-table-wrap');
  const gamesHeader = document.querySelector('.bayesian-table .games-col');
  return {
    leagueName: leagueCells[2]?.textContent?.trim(), leagueRating: leagueCells[3]?.textContent?.trim(), leagueRank: leagueCells[1]?.textContent?.trim(), leagueInteractive: Boolean(league?.querySelector('button')),
    rowHeight: realButton?.closest('tr')?.getBoundingClientRect().height || 0,
    buttonHeight: realButton?.getBoundingClientRect().height || 0,
    buttonOneLine: getComputedStyle(realButton).whiteSpace === 'nowrap' && realButton.scrollHeight <= realButton.clientHeight + 1,
    buttonColor: getComputedStyle(realButton).color,
    restingBorderBottomWidth: getComputedStyle(realButton).borderBottomWidth,
    restingBorderBottomStyle: getComputedStyle(realButton).borderBottomStyle,
    restingTextDecoration: getComputedStyle(realButton).textDecorationLine,
    gamesHeader: gamesHeader?.textContent?.trim(), gamesHeaderFits: gamesHeader?.scrollWidth <= gamesHeader?.clientWidth,
    constrainedWrapper: wrapper?.classList.contains('standings-wrap') && getComputedStyle(wrapper).overflowX === 'auto',
    expected: (() => {
      const snapshot = JSON.parse(localStorage.getItem(${JSON.stringify(snapshotKey)}));
      const pooled = snapshot.ratings.find(row => row.isLeagueContext);
      const sizes = ${JSON.stringify(db.games.filter(game => game.isLeagueGame).map(game => game.redTeam.length))};
      const nEff = sizes.length / sizes.reduce((sum, size) => sum + 1 / size, 0);
      const ordinal = pooled.mu - 3 * pooled.sigma * Math.sqrt(nEff);
      return { rating: Math.round(1500 + 50 * ordinal), nEff };
    })(),
  };
})()`);
await evaluate(`document.querySelector('#bayesianTableBody .history-player-button')?.focus({ focusVisible: true })`);
const focusedButton = await evaluate(`(() => {
  const button = document.querySelector('#bayesianTableBody .history-player-button');
  const style = getComputedStyle(button);
  return {
    isFocused: document.activeElement === button,
    focusVisible: button?.matches(':focus-visible') || false,
    outlineStyle: style.outlineStyle,
    outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
  };
})()`);
// The fixed 2026-06-20 fixture deterministically places the derived row 14th.
if (mobileRows.leagueName !== 'League Player' || Number(mobileRows.leagueRating) !== mobileRows.expected.rating || Number(mobileRows.leagueRank) !== 14 || mobileRows.leagueInteractive || !mobileRows.buttonOneLine || mobileRows.buttonHeight > 24 || mobileRows.restingBorderBottomWidth !== '0px' || mobileRows.restingBorderBottomStyle !== 'none' || mobileRows.restingTextDecoration !== 'none' || !mobileRows.gamesHeaderFits || mobileRows.gamesHeader !== 'Games' || !mobileRows.constrainedWrapper || !focusedButton.isFocused || !focusedButton.focusVisible || focusedButton.outlineStyle === 'none' || focusedButton.outlineWidth <= 0) throw new Error(`Mobile dynamic table failed: ${JSON.stringify({ mobileRows, focusedButton })}`);
await send('Page.navigate', { url: `${baseUrl}/stats.html?tab=season` });
await new Promise(resolve => setTimeout(resolve, 500));
const normalRowHeight = await evaluate(`document.querySelector('#statsTableBody tr')?.getBoundingClientRect().height || 0`);
if (!(normalRowHeight > 0) || Math.abs(mobileRows.rowHeight - normalRowHeight) > 1) throw new Error(`Mobile All-Time row is not aligned with Season Ranking: ${mobileRows.rowHeight} vs ${normalRowHeight}`);
await send('Page.navigate', { url: `${baseUrl}/stats.html?tab=allTime&mode=composite` });
await new Promise(resolve => setTimeout(resolve, 400));
await evaluate(`document.getElementById('overallBigTeamModeButton').click()`);
const staticMode = await evaluate(`({ buttons: document.querySelectorAll('#bayesianTableBody .history-player-button').length, leaguePlayer: [...document.querySelectorAll('#bayesianTableBody tr')].some(row => row.textContent.includes('League Player')) })`);
if (staticMode.buttons || staticMode.leaguePlayer) throw new Error(`Big Team changed unexpectedly: ${JSON.stringify(staticMode)}`);

console.log('Dynamic Overall history overlay browser test passed.');
ws.close();
