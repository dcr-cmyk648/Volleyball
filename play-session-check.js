// Fetch early; balancing only waits for a sync/ignore decision, never the network.
export const SESSION_CHECK_KEY = 'gameDayBalanceSessionCheckV2';
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;

export function createPlaySessionCheck({
  storage, fetchDatabase, offerSync, notifyUnavailable,
  notifyChecking = () => {}, notifyReady = () => {},
  now = Date.now, timeoutMs = 60000,
}) {
  let state = { status: 'unchecked', lastBalanceAt: now(), meta: null };
  let request = null;
  let decision = null;
  try {
    const saved = JSON.parse(storage.getItem(SESSION_CHECK_KEY) || 'null');
    const age = now() - saved?.lastBalanceAt;
    if (Number.isFinite(saved?.lastBalanceAt) && age >= 0 && age < SESSION_IDLE_MS &&
        (saved.status === 'done' || (saved.status === 'ready' && saved.meta &&
          Array.isArray(saved.meta.players) && Array.isArray(saved.meta.games)))) state = saved;
  } catch { /* In-memory state remains available without browser storage. */ }

  function save() {
    try { storage.setItem(SESSION_CHECK_KEY, JSON.stringify(state)); } catch {}
  }
  function expire() {
    const age = now() - state.lastBalanceAt;
    if (!request && !decision && (age < 0 || age >= SESSION_IDLE_MS)) {
      state = { status: 'unchecked', lastBalanceAt: now(), meta: null };
    }
  }
  function warm() {
    expire();
    if (request) return request;
    if (state.status !== 'unchecked') return Promise.resolve();
    state.status = 'checking';
    notifyChecking();
    request = (async () => {
      const controller = new AbortController();
      let timeout;
      try {
        const meta = await Promise.race([
          Promise.resolve().then(() => fetchDatabase(controller.signal)),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error('Server check timed out.'));
            }, timeoutMs);
          }),
        ]);
        state.status = 'ready';
        state.meta = meta;
        notifyReady(meta);
      } catch (error) {
        state.status = 'done';
        state.meta = null;
        notifyUnavailable(error);
      } finally {
        clearTimeout(timeout);
        save();
      }
    })().finally(() => { request = null; });
    return request;
  }

  function checkBeforeBalance() {
    if (decision) return decision;
    warm();
    state.lastBalanceAt = now();
    if (state.status !== 'ready') {
      save();
      return Promise.resolve();
    }
    decision = Promise.resolve().then(() => offerSync(state.meta)).then(() => {
      state = { status: 'done', lastBalanceAt: now(), meta: null };
      save();
    }).finally(() => { decision = null; });
    return decision;
  }
  checkBeforeBalance.warm = warm;
  return checkBeforeBalance;
}
