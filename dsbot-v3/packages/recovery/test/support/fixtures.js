export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
export const STALE_MS = 11 * 60 * 1000;
export const FRESH_MS = 30 * 1000;

/** A run whose heartbeat is older than the default 10 minute stall window. */
export function staleRun(overrides = {}) {
  return {
    id: 'run-1',
    task_id: 'task-1',
    state: 'dispatched',
    heartbeat_at: NOW - STALE_MS,
    ...overrides,
  };
}

export function freshRun(overrides = {}) {
  return staleRun({ heartbeat_at: NOW - FRESH_MS, ...overrides });
}

export function runtime(overrides = {}) {
  return {
    runs: [],
    outbox: [],
    worktrees: [],
    tickets: [],
    now: NOW,
    ...overrides,
  };
}

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

export function probeSpy(result) {
  const calls = [];
  const probe = (run) => {
    calls.push(run);
    return result;
  };
  probe.calls = calls;
  return probe;
}
