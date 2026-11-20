/**
 * Executor router (16 §4): picks the adapter named by `run.executor_kind`.
 *
 * Failure policy: an unavailable executor is `blocked` and the router stops.
 * There is deliberately no fallback branch — a silently swapped executor would
 * turn path B work into path A work (T-PATH-04/T-PATH-07).
 */

import {
  ERROR_CODES,
  dispatchRejected,
  readDispatchRequest,
} from './contract.js';

export function createExecutorRouter({ adapters = {} } = {}) {
  const registered = new Map(
    Object.entries(adapters).filter(
      ([, adapter]) => adapter && typeof adapter.dispatch === 'function' && typeof adapter.status === 'function',
    ),
  );

  function adapterFor(kind) {
    return typeof kind === 'string' ? registered.get(kind) ?? null : null;
  }

  return {
    adapters: Object.freeze(Object.fromEntries(registered)),

    async dispatch(request) {
      const parsed = readDispatchRequest(request);
      const kind = request?.run?.executor_kind ?? null;
      const adapter = adapterFor(kind);
      if (!adapter) {
        return {
          ...dispatchRejected({
            kind: typeof kind === 'string' ? kind : 'unknown',
            run_id: parsed.ok ? parsed.value.run.id : null,
            code: ERROR_CODES.executorNotRegistered,
            message: `no executor adapter registered for executor_kind=${String(kind)}`,
          }),
          routing: { path: kind, degraded: false, fallback: 'none', why: ['no adapter registered'] },
        };
      }
      const result = await adapter.dispatch(request);
      return {
        ...result,
        routing: {
          path: adapter.kind,
          degraded: result.ok === false && result.degraded === true,
          fallback: result.fallback ?? 'none',
          why:
            result.ok === false
              ? [`${adapter.kind}:${result.code}`, 'no automatic executor fallback']
              : [`${adapter.kind} dispatch accepted`],
        },
      };
    },

    async capabilities() {
      const result = {};
      for (const [kind, adapter] of registered) {
        if (typeof adapter.probe !== 'function') {
          result[kind] = { available: true, kind };
          continue;
        }
        try {
          result[kind] = await adapter.probe();
        } catch (error) {
          result[kind] = { available: false, kind, reason: ERROR_CODES.notConfigured, message: error?.message ?? String(error) };
        }
      }
      return result;
    },
  };
}
