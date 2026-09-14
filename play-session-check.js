// Session-scoped first-balance check. Never persist failures across app sessions.
export const SESSION_CHECK_KEY = 'gameDayBalanceSessionCheckV1';
export const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;

export function createPlaySessionCheck({
  storage, fetchDatabase, offerSync, notifyUnavailable,
  now = Date.now, timeoutMs = 10000,
}) {
  let completedAt = null;
  let pending = null;
  try {
    const saved = JSON.parse(storage.getItem(SESSION_CHECK_KEY) || 'null');
    if (Number.isFinite(saved?.lastBalanceAt)) completedAt = saved.lastBalanceAt;
  } catch { /* In-memory state still works when storage is unavailable. */ }

  function finish() {
    completedAt = now();
    try {
      storage.setItem(SESSION_CHECK_KEY, JSON.stringify({ lastBalanceAt: completedAt }));
    } catch { /* Keep the in-memory session. */ }
  }

  return function checkBeforeBalance() {
    if (pending) return pending;
    const age = now() - completedAt;
    if (completedAt !== null && age >= 0 && age < SESSION_IDLE_MS) {
      finish();
      return Promise.resolve();
    }
    pending = (async () => {
      const controller = new AbortController();
      let timeout;
      let meta;
      try {
        meta = await Promise.race([
          Promise.resolve().then(() => fetchDatabase(controller.signal)),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error('Server check timed out.'));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        notifyUnavailable(error);
      } finally {
        clearTimeout(timeout);
      }
      if (meta) await offerSync(meta);
      finish();
    })().finally(() => { pending = null; });
    return pending;
  };
}
