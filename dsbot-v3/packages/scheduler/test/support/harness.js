import { ACTIVE_RUN_STATES } from '../../src/index.js';

/**
 * Deterministic manually advanced clock. No timers, no sleeps: every test moves
 * time explicitly, so backoff assertions are exact.
 */
export function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(value) {
      current = value;
      return current;
    },
  };
}

export function makeTask(id, state = 'queued', extra = {}) {
  return {
    id,
    level: 'execution',
    state,
    title: `task ${id}`,
    subject: { goal: `goal ${id}` },
    acceptanceProfile: {
      items: [{ key: 'auto.contract', class: 'auto', required: true }],
    },
    budget: { capCny: 1 },
    ...extra,
  };
}

export function makeRun({
  id,
  taskId,
  state = 'queued',
  createdAt = 0,
  priority = 50,
  ...extra
}) {
  return {
    id,
    taskId,
    task_id: taskId,
    state,
    executorKind: 'mock',
    priority,
    createdAt,
    ...extra,
  };
}

/**
 * In-memory runtime port. It implements exactly the five methods the scheduler
 * requires; no database, no filesystem, no network.
 */
export function createFakeRuntime({ clock, tasks = [], runs = [], stickyQueue = false } = {}) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const runList = runs;
  const outbox = [];
  const calls = [];
  const markCalls = [];
  let sticky = stickyQueue;
  let activeOverride = null;

  function findRun(runId) {
    const run = runList.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }

  return {
    outbox,
    calls,
    markCalls,
    runs: runList,

    listQueuedRuns() {
      return runList
        .filter((run) => run.state === 'queued')
        .map((run) => ({ ...run }));
    },

    getTask(taskId) {
      const task = taskById.get(taskId);
      return task ? { ...task } : null;
    },

    activeRunCount() {
      if (activeOverride !== null) return activeOverride;
      return runList.filter((run) => ACTIVE_RUN_STATES.includes(run.state)).length;
    },

    markDispatched(run, meta) {
      markCalls.push({ runId: run.id, attempt: meta?.attempt ?? null, at: clock.now() });
      const stored = findRun(run.id);
      if (!sticky && stored.state === 'queued') stored.state = 'dispatched';
      return { ...stored };
    },

    recordOutbox(entry) {
      const record = { ...entry };
      outbox.push(record);
      calls.push({ type: 'outbox', entry: record, at: clock.now() });
      return { ...record };
    },

    // Test controls.
    complete(runId) {
      findRun(runId).state = 'accepted';
    },
    start(runId) {
      findRun(runId).state = 'running';
    },
    fail(runId) {
      findRun(runId).state = 'failed';
    },
    freezeQueue(value = true) {
      sticky = value;
    },
    setActiveCount(value) {
      activeOverride = value;
    },
    findRun,
  };
}

/**
 * Recording executor. `handler(request, callNumber)` may return a result or
 * throw; the default accepts the dispatch.
 */
export function createExecutor({ clock = null, handler = null } = {}) {
  const calls = [];
  return {
    calls,
    dispatch(request) {
      calls.push({ request, at: clock ? clock.now() : null });
      if (handler) return handler(request, calls.length);
      return { ok: true, accepted: true, run_id: request.run_id };
    },
  };
}
