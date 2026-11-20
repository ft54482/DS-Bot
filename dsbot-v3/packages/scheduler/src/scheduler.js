/**
 * L23 dispatch scheduler.
 *
 * `createScheduler` owns one decision loop, `tick()`, over an injected runtime
 * port, an injected executor and an injected clock. It is pure logic: it opens
 * no database, starts no timer, performs no network call and never reads the
 * ambient clock on its own.
 *
 * The loop follows the PRD reliability design (`docs/prd/04-reliability-ops.md`
 * §1.4 and §B.1):
 *
 *  1. read the queued runs from the runtime;
 *  2. skip tasks that are stopping, terminal or missing;
 *  3. honour the per-run failure backoff (1s, 2s, 4s, then 4s cap);
 *  4. stop when `maxWorkers` active runs are already occupying the pool;
 *  5. hand the run to the executor, mark it dispatched and append one
 *     `dispatch_run` outbox record for the attempt.
 *
 * Idempotence comes from three independent guards: the runtime only returns
 * `queued` runs, a run is remembered once it has been dispatched, and
 * overlapping `tick()` calls share the same in-flight pass.
 */

/** PRD 04 §1.4 default per-BOT/worker concurrency. */
export const DEFAULT_MAX_WORKERS = 4;

/** First retry delay after a failed dispatch. */
export const DEFAULT_BASE_BACKOFF_MS = 1000;

/** Backoff ceiling: 1s, 2s, 4s, 4s, ... */
export const DEFAULT_MAX_BACKOFF_MS = 4000;

/** Run states that occupy a worker slot. `queued` is the waiting pool. */
export const ACTIVE_RUN_STATES = Object.freeze([
  'dispatched',
  'dispatch_unknown',
  'running',
]);

/**
 * `dispatchTask` (L2) only accepts planned/queued/reworking tasks. A task in
 * one of these states is frozen, stopped or already finished, so its queued run
 * must not be sent to an executor.
 */
const NON_DISPATCHABLE_TASK_STATES = new Set([
  'stopping',
  'blocked',
  'paused',
  'completed',
  'cancelled',
]);

const PORT_METHODS = Object.freeze([
  'listQueuedRuns',
  'getTask',
  'activeRunCount',
  'markDispatched',
  'recordOutbox',
]);

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`createScheduler ${name} must be a function`);
  }
  return value;
}

function requirePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`createScheduler ${name} must be a positive number`);
  }
  return value;
}

/**
 * A caller may pass a small port object directly. This is the contract the
 * tests exercise and the one a later recovery/outbox layer should implement.
 */
function hasPortMethods(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    PORT_METHODS.every((method) => typeof value[method] === 'function')
  );
}

/**
 * Adapt the L9 runtime facade (`runtime.runs`, `runtime.tasks`,
 * `runtime.service`, `runtime.store`) to the scheduler port. Marking a run
 * dispatched reuses the service state machine; recording an outbox attempt
 * reuses the L1 `dispatch_outbox` table. The facade is detected by shape so
 * this module keeps no import-time dependency on the other packages.
 */
function facadePort(runtime) {
  const listRuns = runtime?.runs?.list;
  const getTask = runtime?.tasks?.get;
  const transitionRun = runtime?.service?.transitionRun;
  const enqueueOutbox = runtime?.store?.enqueueOutbox;
  if (
    typeof listRuns !== 'function' ||
    typeof getTask !== 'function' ||
    typeof transitionRun !== 'function' ||
    typeof enqueueOutbox !== 'function'
  ) {
    return null;
  }

  return {
    listQueuedRuns() {
      return runtime.runs.list({ state: 'queued' });
    },

    getTask(taskId) {
      return runtime.tasks.get(taskId);
    },

    activeRunCount() {
      const runs = runtime.runs.list({}) ?? [];
      return runs.filter((run) => ACTIVE_RUN_STATES.includes(run.state)).length;
    },

    markDispatched(run) {
      const current = runtime.runs.get(run.id);
      if (current && (current.state === 'dispatched' || current.state === 'running')) {
        return current;
      }
      return transitionRun({
        runId: run.id,
        to: 'dispatched',
        actor: 'scheduler',
        idempotencyKey: `scheduler:dispatch:${run.id}`,
      });
    },

    recordOutbox(entry) {
      return runtime.store.enqueueOutbox({
        id: entry.id,
        task_id: entry.taskId,
        run_id: entry.runId,
        principal_ref: 'scheduler',
        intent: entry.intent,
        payload_json: JSON.stringify(entry.payload ?? {}),
        state: entry.state,
        idempotency_key: entry.idempotencyKey,
        attempts: entry.attempt,
        next_retry_at: entry.nextRetryAt ?? null,
        last_error: entry.lastError ?? null,
        created_at: entry.createdAt,
        sent_at: entry.sentAt ?? null,
      });
    },
  };
}

function resolveRuntime(runtime) {
  if (hasPortMethods(runtime)) return runtime;
  const port = facadePort(runtime);
  if (port) return port;
  throw new TypeError(
    'createScheduler runtime must implement ' +
      `${PORT_METHODS.join('/')} or be a runtime facade with runs/tasks/service/store`,
  );
}

function resolveDispatch(executor) {
  if (typeof executor === 'function') return executor;
  if (executor && typeof executor.dispatch === 'function') {
    return executor.dispatch.bind(executor);
  }
  throw new TypeError(
    'createScheduler executor must be a dispatch function or an object with dispatch()',
  );
}

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('runtime.listQueuedRuns() returned an invalid run');
  }
  const id = raw.id;
  if (typeof id !== 'string' || id === '') {
    throw new TypeError('runtime.listQueuedRuns() returned a run without an id');
  }
  const taskId = raw.taskId ?? raw.task_id;
  if (typeof taskId !== 'string' || taskId === '') {
    throw new TypeError(`run ${id} has no taskId`);
  }
  return {
    ...raw,
    id,
    taskId,
    task_id: taskId,
    state: raw.state ?? 'queued',
    priority: Number.isFinite(raw.priority) ? raw.priority : 50,
    createdAt: toMillis(raw.createdAt ?? raw.created_at),
  };
}

function compareRuns(left, right) {
  // PRD 04 §B.1: priority descending, then oldest first, then id.
  return (
    right.priority - left.priority ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

function runGuard(run) {
  if (run.state !== 'queued') return 'run_not_queued';
  if (run.cancelRequestedAt ?? run.cancel_requested_at) return 'run_stopping';
  return null;
}

function taskGuard(task) {
  if (!task) return 'task_missing';
  if (NON_DISPATCHABLE_TASK_STATES.has(task.state)) return `task_${task.state}`;
  if (task.stopRequestedAt ?? task.stop_requested_at) return 'task_stopping';
  return null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An executor may report a refusal instead of throwing (the adapter contract in
 * `packages/adapters` returns `{ ok, accepted, code, message }`).
 */
function rejectionOf(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.ok === false) return result;
  if (result.accepted === false) return result;
  return null;
}

function requestFor({ run, task, attempt, idempotencyKey, workspacePath, tracking }) {
  const executorKind = run.executorKind ?? run.executor_kind ?? 'dsh_session';
  const acceptance = (
    task?.acceptanceProfile?.items ??
    task?.acceptance_profile?.items ??
    []
  ).map((item) => item.key);
  const goal = task?.subject?.goal ?? task?.goal ?? task?.title ?? '';
  const budget =
    task?.budget?.capCny === undefined || task?.budget?.capCny === null
      ? {}
      : { cny_cap: task.budget.capCny };

  // Same envelope as `runtime.runs.dispatchToExecutor` (02 §2.4) plus the
  // scheduler's own attempt metadata, so a real adapter can be injected
  // without an adapter-specific shim.
  return {
    run: { id: run.id, executor_kind: executorKind, executorKind },
    run_id: run.id,
    task_id: task?.id ?? run.taskId,
    attempt,
    idempotency_key: idempotencyKey,
    task,
    taskPack: { goal, constraints: [], acceptance, context_refs: [] },
    workspace: { path: workspacePath },
    budget,
    tracking: { status: true, follow: true, ...(tracking ?? {}) },
  };
}

function outboxRecord({
  run,
  taskId,
  attempt,
  state,
  now,
  idempotencyKey,
  nextRetryAt = null,
  lastError = null,
}) {
  return {
    id: `outbox-${run.id}-a${attempt}`,
    runId: run.id,
    taskId,
    intent: 'dispatch_run',
    state,
    attempt,
    idempotencyKey,
    payload: {
      run_id: run.id,
      task_id: taskId,
      executor_kind: run.executorKind ?? run.executor_kind ?? null,
      attempt,
      idempotency_key: idempotencyKey,
    },
    createdAt: now,
    updatedAt: now,
    sentAt: state === 'sent' ? now : null,
    nextRetryAt,
    lastError,
  };
}

/**
 * @param {object} options
 * @param {object} options.runtime runtime port (or L9 runtime facade)
 * @param {object|Function} options.executor `dispatch(request)` function/object
 * @param {() => number} [options.clock] injectable epoch-millisecond clock
 * @param {number} [options.maxWorkers=4] concurrent dispatch slots
 * @param {number} [options.baseBackoffMs=1000] first retry delay
 * @param {number} [options.maxBackoffMs=4000] retry delay ceiling
 * @param {string|null} [options.workspacePath] workspace hint passed to the executor
 * @param {object|null} [options.tracking] tracker hint passed to the executor
 * @param {Function|null} [options.buildRequest] override the dispatch envelope
 */
export function createScheduler({
  runtime,
  executor,
  clock = () => Date.now(),
  maxWorkers = DEFAULT_MAX_WORKERS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  workspacePath = null,
  tracking = null,
  buildRequest = null,
} = {}) {
  const port = resolveRuntime(runtime);
  const dispatch = resolveDispatch(executor);
  requireFunction(clock, 'clock');
  if (!Number.isInteger(maxWorkers) || maxWorkers <= 0) {
    throw new TypeError('createScheduler maxWorkers must be a positive integer');
  }
  requirePositiveNumber(baseBackoffMs, 'baseBackoffMs');
  requirePositiveNumber(maxBackoffMs, 'maxBackoffMs');
  if (maxBackoffMs < baseBackoffMs) {
    throw new TypeError('createScheduler maxBackoffMs must be >= baseBackoffMs');
  }
  if (buildRequest !== null && typeof buildRequest !== 'function') {
    throw new TypeError('createScheduler buildRequest must be a function when supplied');
  }

  const retries = new Map();
  const dispatched = new Set();
  let inFlightTick = null;

  function backoffFor(failures) {
    // 1st failure: base; 2nd: 2x base; 3rd+: capped.
    return Math.min(baseBackoffMs * 2 ** (failures - 1), maxBackoffMs);
  }

  function makeRequest(run, task, attempt, idempotencyKey, now) {
    if (typeof buildRequest === 'function') {
      return buildRequest({ run, task, attempt, idempotencyKey, now });
    }
    return requestFor({
      run,
      task,
      attempt,
      idempotencyKey,
      workspacePath,
      tracking,
    });
  }

  async function recordFailure(run, taskId, attempt, now, error, rejection) {
    const nextRetryAt = now + backoffFor(attempt);
    const message = errorMessage(error);
    retries.set(run.id, { failures: attempt, nextRetryAt, lastError: message });

    const entry = outboxRecord({
      run,
      taskId,
      attempt,
      state: 'pending',
      now,
      idempotencyKey: `scheduler:${run.id}:dispatch:${attempt}`,
      nextRetryAt,
      lastError: message,
    });
    let outboxError = null;
    try {
      await port.recordOutbox(entry);
    } catch (recordError) {
      outboxError = errorMessage(recordError);
    }

    return {
      ok: false,
      runId: run.id,
      taskId,
      attempt,
      error: message,
      code: rejection?.code ?? null,
      nextRetryAt,
      outboxId: entry.id,
      ...(outboxError === null ? {} : { outboxError }),
    };
  }

  async function dispatchOne(run, task, now) {
    const previous = retries.get(run.id);
    const attempt = (previous?.failures ?? 0) + 1;
    const idempotencyKey = `scheduler:${run.id}:dispatch:${attempt}`;
    const taskId = task?.id ?? run.taskId;

    let request;
    try {
      request = makeRequest(run, task, attempt, idempotencyKey, now);
    } catch (error) {
      return recordFailure(run, taskId, attempt, now, error, null);
    }

    let result;
    try {
      result = await dispatch(request);
    } catch (error) {
      return recordFailure(run, taskId, attempt, now, error, null);
    }

    const rejection = rejectionOf(result);
    if (rejection) {
      const error = new Error(
        rejection.message ??
          rejection.error?.message ??
          `executor rejected dispatch (${rejection.code ?? 'rejected'})`,
      );
      if (rejection.code !== undefined) error.code = rejection.code;
      return recordFailure(run, taskId, attempt, now, error, rejection);
    }

    // The executor accepted. Persist the run transition and the outbox record.
    // A failure here must not trigger an automatic redispatch: the external
    // side effect already happened, so the run is remembered as dispatched.
    const entry = outboxRecord({
      run,
      taskId,
      attempt,
      state: 'sent',
      now,
      idempotencyKey,
    });
    try {
      await port.markDispatched(run, { attempt, request, result });
      await port.recordOutbox(entry);
    } catch (error) {
      dispatched.add(run.id);
      retries.delete(run.id);
      return {
        ok: false,
        unrecorded: true,
        runId: run.id,
        taskId,
        attempt,
        error: errorMessage(error),
        outboxId: entry.id,
      };
    }

    dispatched.add(run.id);
    retries.delete(run.id);
    return {
      ok: true,
      runId: run.id,
      taskId,
      attempt,
      outboxId: entry.id,
      result,
    };
  }

  async function runTick() {
    const now = clock();
    if (!Number.isFinite(now)) {
      throw new TypeError('createScheduler clock() must return epoch milliseconds');
    }

    const result = {
      at: now,
      dispatched: [],
      failed: [],
      waiting: [],
      skipped: [],
      unrecorded: [],
      active: 0,
      available: 0,
    };

    const queued = await port.listQueuedRuns();
    if (!Array.isArray(queued)) {
      throw new TypeError('runtime.listQueuedRuns() must return an array');
    }
    const runs = queued.map(normalizeRun).sort(compareRuns);

    let active = Number(await port.activeRunCount());
    if (!Number.isFinite(active) || active < 0) {
      throw new TypeError('runtime.activeRunCount() must return a non-negative number');
    }

    for (const run of runs) {
      const base = { runId: run.id, taskId: run.taskId };

      const blocked = runGuard(run);
      if (blocked) {
        result.skipped.push({ ...base, reason: blocked });
        continue;
      }

      if (dispatched.has(run.id)) {
        result.skipped.push({ ...base, reason: 'already_dispatched' });
        continue;
      }

      const retry = retries.get(run.id);
      if (retry && now < retry.nextRetryAt) {
        result.waiting.push({ ...base, reason: 'backoff', nextRetryAt: retry.nextRetryAt });
        continue;
      }

      if (active >= maxWorkers) {
        result.waiting.push({ ...base, reason: 'concurrency_limit' });
        continue;
      }

      let task;
      try {
        task = await port.getTask(run.taskId);
      } catch {
        result.skipped.push({ ...base, reason: 'task_unavailable' });
        continue;
      }
      const taskBlocked = taskGuard(task);
      if (taskBlocked) {
        result.skipped.push({ ...base, reason: taskBlocked });
        continue;
      }

      const outcome = await dispatchOne(run, task, now);
      if (outcome.ok) {
        active += 1;
        result.dispatched.push({
          runId: outcome.runId,
          taskId: outcome.taskId,
          attempt: outcome.attempt,
          outboxId: outcome.outboxId,
          result: outcome.result,
        });
      } else if (outcome.unrecorded) {
        active += 1;
        result.unrecorded.push(outcome);
      } else {
        result.failed.push(outcome);
      }
    }

    result.active = active;
    result.available = Math.max(0, maxWorkers - active);
    return result;
  }

  return Object.freeze({
    /**
     * Run one scheduling pass. Overlapping calls share one in-flight pass, so a
     * slow executor cannot cause the same run to be dispatched twice.
     *
     * @returns {Promise<object>} pass summary (see README)
     */
    tick() {
      if (inFlightTick) return inFlightTick;
      inFlightTick = runTick().finally(() => {
        inFlightTick = null;
      });
      return inFlightTick;
    },

    /** Current per-run retry state, or null when the run has no failures. */
    getRetryState(runId) {
      const retry = retries.get(runId);
      return retry ? { ...retry } : null;
    },

    /** Whether this scheduler instance has already dispatched the run. */
    hasDispatched(runId) {
      return dispatched.has(runId);
    },

    config: Object.freeze({
      maxWorkers,
      baseBackoffMs,
      maxBackoffMs,
      workspacePath,
    }),
  });
}
