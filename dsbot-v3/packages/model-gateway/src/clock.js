/**
 * Clock injection.
 *
 * `clock` may be a function (a `now` source for tests) or an object with
 * `now` / `setTimeout` / `clearTimeout` / `sleep`. Nothing in the gateway reads
 * the ambient clock directly, so latency and backoff are deterministic in tests.
 */
export function normalizeClock(clock) {
  const source = typeof clock === 'function' ? { now: clock } : clock ?? {};
  const now = typeof source.now === 'function' ? () => source.now() : () => Date.now();
  const setTimeoutFn =
    typeof source.setTimeout === 'function'
      ? (fn, ms) => source.setTimeout(fn, ms)
      : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn =
    typeof source.clearTimeout === 'function'
      ? (handle) => source.clearTimeout(handle)
      : (handle) => clearTimeout(handle);
  const sleep =
    typeof source.sleep === 'function'
      ? (ms) => source.sleep(ms)
      : (ms) => new Promise((resolve) => setTimeoutFn(resolve, ms));
  return { now, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, sleep };
}

/** Race a promise against the injected clock; clears its timer either way. */
export async function withTimeout(promise, ms, clock, makeError) {
  let handle;
  const timer = new Promise((_, reject) => {
    handle = clock.setTimeout(() => reject(makeError()), ms);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    clock.clearTimeout(handle);
  }
}
