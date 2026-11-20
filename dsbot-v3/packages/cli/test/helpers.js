/** Shared test doubles: no real network, file or database is used. */

export function spy(implementation) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return implementation ? implementation(...args) : undefined;
  };
  fn.calls = calls;
  return fn;
}

export function createDeps(overrides = {}) {
  const deps = {
    createTask: spy((input) => ({
      id: 'task-1',
      level: input.level,
      state: 'planned',
      title: input.title,
      parentTaskId: input.parentTaskId ?? null,
    })),
    listTasks: spy(() => []),
    getTask: spy((taskId) => ({
      task: { id: taskId, level: 'goal', state: 'planned', title: 'demo' },
      runs: [],
      acceptances: [],
    })),
    dispatchTask: spy((taskId) => ({
      task: { id: taskId, level: 'execution', state: 'queued', title: 'demo' },
      run: { id: 'run-1', taskId, state: 'dispatched', executorKind: 'dsh_session' },
    })),
    acceptRun: spy((runId) => ({
      task: { id: 'task-1', level: 'execution', state: 'completed', title: 'demo' },
      acceptance: {
        id: 'acc-1',
        taskId: 'task-1',
        runId,
        state: 'passed',
        roundNo: 1,
      },
    })),
    stopTask: spy((taskId) => ({
      task: {
        id: taskId,
        level: 'goal',
        state: 'cancelled',
        title: 'demo',
        stopState: 'verified',
      },
      tasks: [],
      stopState: 'verified',
      verified: true,
    })),
    getCost: spy((taskId) => ({
      taskId,
      total: { tokens_in: 10, tokens_out: 20, tokens_cached: 5, cost_cny: 0.25 },
      entries: [],
    })),
  };
  return Object.assign(deps, overrides);
}

export function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

export function jsonOutput(result) {
  return JSON.parse(result.stdout);
}

export function jsonError(result) {
  return JSON.parse(result.stderr);
}
