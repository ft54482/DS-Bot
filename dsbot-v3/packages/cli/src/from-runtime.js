/**
 * Adapter from the L9 runtime facade to the flat deps consumed by `runCli`.
 *
 * This file is glue only: it looks up the facade operation, assembles read-only
 * detail views and forwards the call. It contains no task/run/acceptance
 * decisions, cost aggregation or stop verification logic.
 *
 * The facade is the one exported by `packages/runtime` (`createRuntime`):
 *   runtime.tasks        create/get/list/dispatch
 *   runtime.runs         get/list
 *   runtime.acceptances  get/list/decide
 *   runtime.stop         request/verify/stop
 *   runtime.cost         record/list/total/forRun/captureRunUsage
 * Common `createTask`/`getTask`/`requestStop` aliases are also accepted.
 */
import { internalError, notFoundError } from './errors.js';

function namespace(runtime, name) {
  const value = runtime?.[name];
  if (!value || typeof value !== 'object') {
    throw internalError(`runtime facade is missing the "${name}" namespace`, { namespace: name });
  }
  return value;
}

function findMethod(target, names) {
  for (const name of names) {
    if (typeof target?.[name] === 'function') return target[name].bind(target);
  }
  return null;
}

function requireMethod(target, names, label) {
  const method = findMethod(target, names);
  if (!method) {
    throw internalError(`runtime facade is missing ${label}()`, { expected: names, label });
  }
  return method;
}

function taskIdOf(run) {
  return run?.taskId ?? run?.task_id ?? null;
}

function selectOpenAcceptance(list) {
  const entries = Array.isArray(list)
    ? list
    : Array.isArray(list?.acceptances)
      ? list.acceptances
      : Array.isArray(list?.items)
        ? list.items
        : [];
  return entries.find((entry) => entry?.state === 'open') ?? entries[0] ?? null;
}

/**
 * @param {object} runtime facade created by `createRuntime`
 * @returns {object} deps for `runCli`
 */
export function createDepsFromRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    throw internalError('a runtime facade is required to build CLI deps', {
      runtime: typeof runtime,
    });
  }

  async function getTask(taskId) {
    const tasks = namespace(runtime, 'tasks');
    const get = requireMethod(tasks, ['get', 'getTask'], 'runtime.tasks.get');
    const task = await get(taskId);
    if (!task) return null;

    // `tasks.get` returns the task projection; the CLI detail view also wants
    // the run/acceptance lists. These are read-only facade calls, not decisions.
    const detail = { task };
    const runs = findMethod(namespace(runtime, 'runs'), ['list', 'listRuns']);
    if (runs) detail.runs = await runs({ taskId });

    const acceptances = namespace(runtime, 'acceptances');
    const listAcceptances = findMethod(acceptances, ['list', 'listAcceptances']);
    if (listAcceptances) detail.acceptances = await listAcceptances({ taskId });

    const openId = task.openAcceptanceId ?? task.open_acceptance_id ?? null;
    const getAcceptance = findMethod(acceptances, ['get', 'getAcceptance']);
    if (openId && getAcceptance) {
      detail.open_acceptance = await getAcceptance(openId);
    } else if (Array.isArray(detail.acceptances)) {
      detail.open_acceptance = detail.acceptances.find((entry) => entry?.state === 'open') ?? null;
    }
    return detail;
  }

  async function acceptRun(runId, options = {}) {
    const acceptances = namespace(runtime, 'acceptances');

    const decideByRun = findMethod(acceptances, ['decideByRun', 'decideForRun']);
    if (decideByRun) return decideByRun(runId, options);

    const runs = namespace(runtime, 'runs');
    const runsGet = requireMethod(runs, ['get', 'getRun'], 'runtime.runs.get');
    const run = await runsGet(runId);
    const taskId = taskIdOf(run);
    if (!taskId) {
      throw notFoundError(`run ${runId} has no task`, { runId });
    }

    const tasks = namespace(runtime, 'tasks');
    const getTaskProjection = requireMethod(tasks, ['get', 'getTask'], 'runtime.tasks.get');
    const task = await getTaskProjection(taskId);

    let acceptance = null;
    const openId = task?.openAcceptanceId ?? task?.open_acceptance_id ?? null;
    const getAcceptance = findMethod(acceptances, ['get', 'getAcceptance']);
    if (openId && getAcceptance) acceptance = await getAcceptance(openId);

    if (!acceptance) {
      const listAcceptances = findMethod(acceptances, ['list', 'listAcceptances']);
      if (listAcceptances) {
        acceptance = selectOpenAcceptance(await listAcceptances({ runId, state: 'open' }));
        if (!acceptance && taskId) {
          acceptance = selectOpenAcceptance(await listAcceptances({ taskId, state: 'open' }));
        }
      }
    }

    if (!acceptance || typeof acceptance.id !== 'string') {
      throw notFoundError(`run ${runId} has no open acceptance`, { runId, taskId });
    }

    const decide = requireMethod(
      acceptances,
      ['decide', 'decideAcceptance'],
      'runtime.acceptances.decide',
    );
    // The L9 facade takes a single options object:
    //   decide({ acceptanceId, verdict, itemStates, reviewer, reason })
    const result = await decide({ acceptanceId: acceptance.id, ...options });
    return {
      ...(result && typeof result === 'object' ? result : {}),
      acceptance: result?.acceptance ?? acceptance,
      run: result?.run ?? run,
    };
  }

  async function stopTask(taskId, options = {}) {
    const stop = namespace(runtime, 'stop');
    // The full `stop.stop` path also cancels live executors and verifies
    // quiescence; `request` is the fallback for a facade that only freezes work.
    const stopMethod = findMethod(stop, ['stop', 'request', 'requestStop']);
    if (!stopMethod) {
      throw internalError('runtime facade is missing runtime.stop.stop()', {
        expected: ['stop', 'request'],
      });
    }
    const result = await stopMethod({ taskId, ...options });
    const updatedTasks = Array.isArray(result?.tasks) ? result.tasks : [];
    return {
      ...(result && typeof result === 'object' ? result : {}),
      task:
        updatedTasks.find((entry) => entry?.id === taskId) ??
        result?.task ??
        result?.requested ??
        (result && typeof result.id === 'string' ? result : null),
      stopState: result?.stopState ?? result?.stop_state ?? result?.task?.stopState ?? null,
    };
  }

  async function getCost(taskId) {
    const cost = namespace(runtime, 'cost');
    return requireMethod(
      cost,
      ['total', 'totalForTask', 'summary', 'getTotal', 'totals'],
      'runtime.cost.total',
    )(taskId);
  }

  return {
    async createTask(input) {
      const tasks = namespace(runtime, 'tasks');
      return requireMethod(tasks, ['create', 'createTask'], 'runtime.tasks.create')(input);
    },
    async listTasks(filter) {
      const tasks = namespace(runtime, 'tasks');
      return requireMethod(tasks, ['list', 'listTasks'], 'runtime.tasks.list')(filter);
    },
    getTask,
    async dispatchTask(taskId, options = {}) {
      const tasks = namespace(runtime, 'tasks');
      const dispatch = requireMethod(tasks, ['dispatch', 'dispatchTask'], 'runtime.tasks.dispatch');
      // The L9 facade takes a single options object: dispatch({ taskId, ... }).
      return dispatch({ taskId, ...options });
    },
    acceptRun,
    stopTask,
    getCost,
  };
}
