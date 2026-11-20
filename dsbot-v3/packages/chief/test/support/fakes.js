/**
 * Test doubles for the Chief coordination layer.
 *
 * The Chief's tests use fakes for runtime, agents, acceptance and metrics so
 * each test proves the coordination logic rather than re-testing the packages
 * it composes. One separate integration suite uses the real packages.
 */

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function serviceError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function budgetCap(budget) {
  if (!budget || typeof budget !== 'object') return null;
  for (const key of ['capCny', 'cny_cap', 'cap_cny']) {
    if (typeof budget[key] === 'number' && Number.isFinite(budget[key])) return budget[key];
  }
  return null;
}

function round6(value) {
  return Number(value.toFixed(6));
}

export function createFakeRuntime(seed = {}) {
  const tasks = new Map();
  const acceptances = new Map();
  const costs = new Map();
  const runs = [];
  const calls = {
    createTask: [],
    delegateTask: [],
    dispatchTask: [],
    listTasks: [],
    acceptancesList: [],
    costTotal: [],
    costList: [],
  };
  let taskSeq = 0;
  let acceptanceSeq = 0;

  function storeTask(options = {}) {
    const level = options.level ?? 'execution';
    const task = {
      id: options.id ?? `task-${++taskSeq}`,
      level,
      parentTaskId: options.parentTaskId ?? null,
      title: options.title ?? 'untitled',
      owner: options.owner ?? null,
      state: options.state ?? 'planned',
      stateVersion: 1,
      revision: 0,
      cycleNo: 1,
      subject: options.subject ?? null,
      budget: options.budget ?? null,
      authScope: options.authScope ?? null,
      acceptanceProfile: options.acceptanceProfile ?? { id: `profile-${level}`, version: 1 },
      openAcceptanceId: options.openAcceptanceId ?? null,
      blockedReason: options.blockedReason ?? null,
      pausedReason: options.pausedReason ?? null,
      createdAt: options.createdAt ?? 1_700_000_000_000,
      updatedAt: options.updatedAt ?? 1_700_000_000_000,
    };
    tasks.set(task.id, task);
    return task;
  }

  const runtime = {
    tasks: {
      create(options = {}) {
        calls.createTask.push(clone(options));
        return clone(storeTask(options));
      },
      delegate(options = {}) {
        calls.delegateTask.push(clone(options));
        const parent = tasks.get(options.parentTaskId);
        if (!parent) throw serviceError('not_found', `task ${options.parentTaskId} does not exist`);
        const expected = parent.level === 'goal' ? 'business' : parent.level === 'business' ? 'execution' : null;
        if (!expected) {
          throw serviceError('hierarchy_violation', `task level ${parent.level} cannot own a child`, {
            parentTaskId: parent.id,
            parentLevel: parent.level,
          });
        }
        if (options.level != null && options.level !== expected) {
          throw serviceError(
            'hierarchy_violation',
            `${parent.level} must delegate ${expected}, got ${options.level}`,
            { parentTaskId: parent.id, level: options.level, expected },
          );
        }
        return clone(storeTask({ ...options, level: expected, parentTaskId: parent.id }));
      },
      get(taskId) {
        const task = tasks.get(taskId);
        if (!task) throw serviceError('not_found', `task ${taskId} does not exist`, { taskId });
        return clone(task);
      },
      list(filter = {}) {
        calls.listTasks.push(clone(filter));
        return [...tasks.values()]
          .filter((task) => filter.parentTaskId == null || task.parentTaskId === filter.parentTaskId)
          .filter((task) => filter.level == null || task.level === filter.level)
          .map(clone);
      },
      dispatch() {
        calls.dispatchTask.push('dispatch');
        throw serviceError('not_allowed', 'execution dispatch belongs to a business BOT');
      },
    },
    runs: {
      list(filter = {}) {
        return runs
          .filter((run) => filter.taskId == null || run.taskId === filter.taskId)
          .map(clone);
      },
      get(runId) {
        const run = runs.find((entry) => entry.id === runId);
        if (!run) throw serviceError('not_found', `run ${runId} does not exist`, { runId });
        return clone(run);
      },
    },
    acceptances: {
      list(filter = {}) {
        calls.acceptancesList.push(clone(filter));
        return [...acceptances.values()]
          .filter((acceptance) => filter.taskId == null || acceptance.taskId === filter.taskId)
          .filter((acceptance) => filter.stage == null || acceptance.stage === filter.stage)
          .filter((acceptance) => filter.state == null || acceptance.state === filter.state)
          .map(clone);
      },
      get(acceptanceId) {
        const acceptance = acceptances.get(acceptanceId);
        if (!acceptance) {
          throw serviceError('not_found', `acceptance ${acceptanceId} does not exist`, {
            acceptanceId,
          });
        }
        return clone(acceptance);
      },
    },
    cost: {
      total(taskId) {
        calls.costTotal.push(taskId);
        const rows = costs.get(taskId) ?? [];
        return {
          taskId,
          entries: rows.length,
          tokensIn: rows.reduce((sum, row) => sum + (row.tokensIn ?? 0), 0),
          tokensOut: rows.reduce((sum, row) => sum + (row.tokensOut ?? 0), 0),
          tokensCached: rows.reduce((sum, row) => sum + (row.tokensCached ?? 0), 0),
          costCny: round6(rows.reduce((sum, row) => sum + (row.costCny ?? 0), 0)),
        };
      },
      list(taskId) {
        calls.costList.push(taskId);
        return (costs.get(taskId) ?? []).map(clone);
      },
      record({ taskId, costCny = 0, kind = 'llm', runId = null, tokensIn, tokensOut } = {}) {
        if (!costs.has(taskId)) costs.set(taskId, []);
        const row = {
          id: `cost-${costs.get(taskId).length + 1}`,
          taskId,
          runId,
          kind,
          costCny,
          tokensIn: tokensIn ?? 0,
          tokensOut: tokensOut ?? 0,
          tokensCached: 0,
          at: 1_700_000_000_000,
          detail: null,
        };
        costs.get(taskId).push(row);
        return clone(row);
      },
    },
    stop: {
      stop() {
        throw serviceError('not_allowed', 'stop is not part of the Chief coordination layer');
      },
    },
  };

  function seedGoal(options = {}) {
    const task = storeTask({ level: 'goal', owner: 'chief', ...options });
    return clone(task);
  }

  function seedBusiness(goalId, options = {}) {
    const parent = tasks.get(goalId);
    if (!parent || parent.level !== 'goal') {
      throw new Error(`seedBusiness needs a goal parent, got ${goalId}`);
    }
    const task = storeTask({
      level: 'business',
      parentTaskId: goalId,
      ...options,
    });
    return clone(task);
  }

  function seedAcceptance(options = {}) {
    if (!options.taskId) throw new Error('seedAcceptance requires taskId');
    const task = tasks.get(options.taskId);
    if (!task) throw new Error(`seedAcceptance cannot find task ${options.taskId}`);
    const acceptance = {
      id: options.id ?? `acc-${++acceptanceSeq}`,
      taskId: options.taskId,
      stage: options.stage ?? task.level,
      state: options.state ?? 'passed',
      roundNo: options.roundNo ?? 1,
      items: options.items ?? [],
      evidence: options.evidence ?? [],
      deliverables: options.deliverables ?? [],
      decidedAt: options.decidedAt ?? 1_700_000_000_100,
      openedAt: options.openedAt ?? 1_700_000_000_000,
      supersededAt: options.supersededAt ?? null,
    };
    acceptances.set(acceptance.id, acceptance);
    return clone(acceptance);
  }

  function setCost(taskId, costCny, { entries = 1 } = {}) {
    costs.set(taskId, []);
    for (let index = 0; index < entries; index += 1) {
      runtime.cost.record({ taskId, costCny: costCny / entries });
    }
    return runtime.cost.total(taskId);
  }

  function addRun(run = {}) {
    const entry = {
      id: run.id ?? `run-${runs.length + 1}`,
      taskId: run.taskId,
      state: run.state ?? 'accepted',
      ...run,
    };
    runs.push(entry);
    return clone(entry);
  }

  for (const task of seed.tasks ?? []) storeTask(task);
  for (const acceptance of seed.acceptances ?? []) {
    acceptances.set(acceptance.id, acceptance);
  }
  for (const run of seed.runs ?? []) runs.push(run);
  for (const [taskId, rows] of Object.entries(seed.costs ?? {})) {
    costs.set(taskId, rows.map(clone));
  }

  return {
    runtime,
    tasks,
    acceptances,
    costs,
    runs,
    calls,
    seedGoal,
    seedBusiness,
    seedAcceptance,
    setCost,
    addRun,
  };
}

export function createFakeChief({ runtime }) {
  const calls = { delegate: [] };
  return {
    role: 'chief',
    toolNames: ['delegate', 'status', 'accept', 'stop', 'cost'],
    calls,
    delegate(input = {}) {
      calls.delegate.push(clone(input));
      const goal = runtime.tasks.get(input.goalTaskId);
      if (goal.level !== 'goal') {
        return {
          ok: false,
          code: 'not_allowed',
          message: 'delegate requires a goal parent',
        };
      }
      const cap = budgetCap(goal.budget);
      const requested = budgetCap(input.budget) ?? input.budgetCny ?? null;
      if (cap !== null && requested !== null && requested > cap) {
        return {
          ok: false,
          code: 'budget_exceeded',
          message: 'delegation exceeds the goal budget',
          details: { cap, requested },
        };
      }
      const task = runtime.tasks.delegate({
        parentTaskId: goal.id,
        level: 'business',
        title: input.title,
        owner: input.toBot ? `bot:${input.toBot}` : null,
        subject: input.subject ?? null,
        budget: input.budget ?? null,
        acceptanceProfile: input.acceptanceProfile ?? null,
        authScope: input.scope ?? null,
      });
      return { ok: true, tool: 'delegate', task };
    },
  };
}

export function createFakeAcceptance({ impl = null } = {}) {
  const calls = [];
  return {
    calls,
    evaluate(input) {
      calls.push(clone(input));
      if (typeof impl === 'function') return impl(input);
      const items = Array.isArray(input?.rubric?.items) ? input.rubric.items : [];
      if (items.some((item) => item.verdict === 'fail')) {
        return { result: 'rework', items: [] };
      }
      if (items.some((item) => !['pass', 'waived'].includes(item.verdict))) {
        return { result: 'blocked', items: [] };
      }
      return { result: 'pass', items: [] };
    },
  };
}

export function createFakeMetrics({ impl = null } = {}) {
  const calls = [];
  return {
    calls,
    computeMetrics(input) {
      calls.push(clone(input));
      if (typeof impl === 'function') return impl(input);
      return {
        cost_per_accepted_task: 12.5,
        lead_time: { median_hours: 1.5, p90_hours: 2, samples: 1, missing: 0 },
        rework_rounds: 0,
        interventions: 0,
        totals: { accepted_tasks: 1 },
      };
    },
  };
}

export { budgetCap, serviceError };
