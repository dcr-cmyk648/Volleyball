import fs from 'node:fs';

if (process.env.VBALL_BROWSER_SMOKE !== '1') {
  console.log('Skipping dynamic history browser test; set VBALL_BROWSER_SMOKE=1 to run.');
  process.exit(0);
}

const baseUrl = process.argv[2] || 'http://127.0.0.1:5176';
const cdpUrl = process.argv[3] || 'http://127.0.0.1:9223';
const db = JSON.parse(fs.readFileSync('test/fixtures/bayesian-2026-06-20.json', 'utf8'));
const snapshotKey = 'gameDayBayesianScoreboardSnapshotV2:composite';

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
  const league = [...document.querySelectorAll('#bayesianTableBody tr')].find(row => row.textContent.includes('League Team'));
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
  return { available: Boolean(button), visible: !document.getElementById('overallHistoryOverlay').classList.contains('hidden'), x: svg?.dataset.historyXValues || '' };
})()`);
if (sparseState.available && (!sparseState.visible || sparseState.x !== '316.00')) throw new Error(`Sparse history did not render as a centered one-knot chart: ${JSON.stringify(sparseState)}`);

console.log('Dynamic Overall history overlay browser test passed.');
ws.close();
