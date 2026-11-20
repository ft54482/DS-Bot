/**
 * Pure operator CLI entry point.
 *
 * `runCli(argv, deps)` never touches the process, the filesystem, a database or
 * the network. It parses argv, delegates every state decision to the injected
 * deps (the runtime facade adapter) and returns `{ exitCode, stdout, stderr }`.
 */
import { exitCodeForStatus, internalError, notFoundError, toErrorPayload } from './errors.js';
import {
  asRecord,
  formatHuman,
  stableStringify,
  toAcceptanceView,
  toCostView,
  toRunView,
  toTaskView,
} from './output.js';
import { parseArgv, usageText, wantsJson } from './parse.js';

export const CLI_VERSION = '0.1.0';

function requireDependencies(deps) {
  if (!asRecord(deps)) {
    throw internalError('runCli requires a deps object', { deps: typeof deps });
  }
  return deps;
}

function requireDependency(deps, name) {
  if (typeof deps[name] !== 'function') {
    throw internalError(`deps.${name} is required`, { dependency: name });
  }
  return deps[name];
}

function requireTask(value, what = 'task') {
  const record = asRecord(value);
  const task = asRecord(record?.task) ?? record;
  if (!task || typeof task.id !== 'string' || task.id === '') {
    throw internalError(`runtime returned no ${what}`, { what });
  }
  return task;
}

function optionalTask(value) {
  const record = asRecord(value);
  const task = asRecord(record?.task) ?? record;
  return task && typeof task.id === 'string' ? task : null;
}

function listFrom(value, key) {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record) {
    if (Array.isArray(record[key])) return record[key];
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.tasks)) return record.tasks;
    if (Array.isArray(record.runs)) return record.runs;
    if (Array.isArray(record.acceptances)) return record.acceptances;
  }
  return [];
}

function success(parsed, data) {
  if (parsed.json) {
    return {
      exitCode: 0,
      stdout: `${stableStringify({ ok: true, command: parsed.command, data })}\n`,
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: formatHuman(parsed.command, data), stderr: '' };
}

function failure(command, error, json) {
  const payload = toErrorPayload(error);
  const exitCode = exitCodeForStatus(payload.status);
  if (json) {
    return {
      exitCode,
      stdout: '',
      stderr: `${stableStringify({ ok: false, command: command ?? null, error: payload })}\n`,
    };
  }
  return {
    exitCode,
    stdout: '',
    stderr: `error ${payload.status} ${payload.code}: ${payload.message}\n`,
  };
}

async function execute(parsed, depsInput) {
  const deps = requireDependencies(depsInput);
  const { command, options, positional } = parsed;

  if (command === 'task.create') {
    const createTask = requireDependency(deps, 'createTask');
    const input = { level: options.level, title: options.title };
    if (options.parent !== null && options.parent !== undefined) input.parentTaskId = options.parent;
    if (options.actor !== undefined) input.actor = options.actor;
    const result = await createTask(input);
    return { task: toTaskView(requireTask(result)) };
  }

  if (command === 'task.list') {
    const listTasks = requireDependency(deps, 'listTasks');
    const filter = {};
    if (options.level !== undefined) filter.level = options.level;
    if (options.state !== undefined) filter.state = options.state;
    if (options.limit !== undefined) filter.limit = options.limit;
    const result = await listTasks(filter);
    const tasks = listFrom(result, 'tasks').map(toTaskView).filter(Boolean);
    return { tasks, count: tasks.length };
  }

  if (command === 'task.get') {
    const getTask = requireDependency(deps, 'getTask');
    const result = await getTask(positional[0]);
    if (result === null || result === undefined) {
      throw notFoundError(`task ${positional[0]} does not exist`, { taskId: positional[0] });
    }
    const task = requireTask(result);
    const detail = asRecord(result);
    const runs = listFrom(detail?.runs ?? asRecord(detail?.task)?.runs, 'runs')
      .map(toRunView)
      .filter(Boolean);
    const acceptances = listFrom(
      detail?.acceptances ?? asRecord(detail?.task)?.acceptances,
      'acceptances',
    )
      .map(toAcceptanceView)
      .filter(Boolean);
    const openRaw =
      detail?.open_acceptance ??
      detail?.openAcceptance ??
      asRecord(detail?.task)?.open_acceptance ??
      null;
    return {
      task: toTaskView(task),
      runs,
      acceptances,
      open_acceptance: toAcceptanceView(openRaw),
    };
  }

  if (command === 'dispatch') {
    const dispatchTask = requireDependency(deps, 'dispatchTask');
    const dispatchOptions = {};
    if (options.executorKind !== undefined) {
      dispatchOptions.executorKind = options.executorKind;
    }
    if (options.idempotencyKey !== undefined) {
      dispatchOptions.idempotencyKey = options.idempotencyKey;
    }
    const result = await dispatchTask(positional[0], dispatchOptions);
    const record = asRecord(result);
    const task = optionalTask(record?.task ?? record);
    const run = asRecord(record?.run ?? record?.current_run ?? record?.currentRun);
    if (!run || typeof run.id !== 'string') {
      throw internalError('runtime returned no run for dispatch', { taskId: positional[0] });
    }
    return { task: toTaskView(task), run: toRunView(run) };
  }

  if (command === 'accept') {
    const acceptRun = requireDependency(deps, 'acceptRun');
    const verdict = options.verdict === 'pass' ? 'pass' : 'fail';
    const acceptOptions = { verdict };
    if (options.reason !== undefined) acceptOptions.reason = options.reason;
    if (options.itemStates !== undefined) acceptOptions.itemStates = options.itemStates;
    const result = await acceptRun(positional[0], acceptOptions);
    const record = asRecord(result);
    const acceptanceRaw =
      asRecord(record?.acceptance) ??
      (typeof record?.id === 'string' && typeof record?.state === 'string' ? record : null);
    if (!acceptanceRaw) {
      throw internalError('runtime returned no acceptance for accept', {
        runId: positional[0],
      });
    }
    const task = optionalTask(record?.task);
    const run = asRecord(record?.run);
    return {
      task: toTaskView(task),
      acceptance: toAcceptanceView(acceptanceRaw),
      run: toRunView(run),
      verdict: options.verdict,
    };
  }

  if (command === 'stop') {
    const stopTask = requireDependency(deps, 'stopTask');
    const stopOptions = {};
    if (options.reason !== undefined) stopOptions.reason = options.reason;
    if (options.requestedBy !== undefined) stopOptions.requestedBy = options.requestedBy;
    const result = await stopTask(positional[0], stopOptions);
    const record = asRecord(result);
    const task = requireTask(record?.task ?? result);
    const tasks = listFrom(record?.tasks, 'tasks')
      .map(toTaskView)
      .filter(Boolean);
    const stopState =
      record?.stopState ?? record?.stop_state ?? task.stopState ?? task.stop_state ?? null;
    const verified =
      record?.verified === true ||
      (task.state === 'cancelled' &&
        (task.stopState === 'verified' || task.stop_state === 'verified'));
    return {
      task: toTaskView(task),
      tasks: tasks.length > 0 ? tasks : [toTaskView(task)],
      stop_state: stopState,
      verified,
    };
  }

  if (command === 'cost') {
    const getCost = requireDependency(deps, 'getCost');
    const result = await getCost(positional[0]);
    return toCostView(result, positional[0]);
  }

  throw internalError(`unsupported command: ${command}`, { command });
}

/**
 * Run one CLI invocation.
 *
 * @param {string[]} argv arguments excluding the node/script prefix
 * @param {object} deps injected capabilities:
 *   `createTask(input)`, `listTasks(filter)`, `getTask(id)`,
 *   `dispatchTask(id, options)`, `acceptRun(runId, options)`,
 *   `stopTask(id, options)`, `getCost(taskId)`
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export async function runCli(argv, deps) {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    return failure(null, error, wantsJson(argv));
  }

  if (parsed.version) {
    return { exitCode: 0, stdout: `superagent ${CLI_VERSION}\n`, stderr: '' };
  }
  if (parsed.help) {
    return { exitCode: 0, stdout: usageText(parsed.command), stderr: '' };
  }

  try {
    const data = await execute(parsed, deps);
    return success(parsed, data);
  } catch (error) {
    return failure(parsed.command, error, parsed.json);
  }
}
