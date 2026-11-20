import {
  createApiServer,
  createSqliteServiceStore,
} from '../../api/src/index.js';
import { createExecutorRouter } from '../../adapters/src/index.js';
import { EXECUTOR_KINDS as STORE_EXECUTOR_KINDS, openStore } from '../../store/src/index.js';
import {
  ACTORS,
  DEFAULT_STOP_QUIESCENCE_MS,
  canonicalize,
  createTaskService,
  isTaskTerminal,
} from '../../service/src/index.js';
import { serviceError } from '../../service/src/errors.js';
import { createCostLedger } from './cost.js';
import { createStopControls } from './stop.js';

/**
 * L9 runtime composition root.
 *
 * Wires the merged layers together and owns exactly one instance of each:
 *
 *   packages/store     durable SQLite store and cost_ledger
 *   packages/service   task/run/acceptance state machine (never reimplemented)
 *   packages/api       /v1 HTTP handler over the same service/store
 *   packages/adapters  executor contract + kind router
 *
 * The returned facade is what CLI and monitoring call; the raw `service` and
 * `store` remain reachable for read-only diagnostics.
 */

const STORE_EXECUTOR_SET = new Set(STORE_EXECUTOR_KINDS);

/**
 * `run.executor_kind` has a narrower enum in the L1 schema than the adapter
 * contract (a test double such as `mock` is not a production executor). Store
 * the column value the schema accepts while keeping the real adapter kind in
 * the service's JSON sidecar, so dispatch routing and cost capture still see
 * `mock`.
 */
function storeExecutorKind(kind) {
  return STORE_EXECUTOR_SET.has(kind) ? kind : 'manual';
}

function wrapServiceStore(raw) {
  return {
    ...raw,
    createRun(run) {
      const projected = storeExecutorKind(run?.executorKind);
      if (projected === run?.executorKind) return raw.createRun(run);
      const created = raw.createRun({ ...run, executorKind: projected });
      return raw.updateRun(
        created.id,
        { executorKind: run.executorKind },
        { expectedStateVersion: created.stateVersion },
      );
    },
  };
}

function normalizeAdapters(adapters) {
  const registry = new Map();
  for (const [kind, adapter] of Object.entries(adapters ?? {})) {
    if (
      !adapter ||
      typeof adapter.dispatch !== 'function' ||
      typeof adapter.status !== 'function' ||
      typeof adapter.cancel !== 'function' ||
      typeof adapter.usage !== 'function'
    ) {
      throw serviceError(
        'validation_error',
        `adapter ${kind} does not implement the executor contract (dispatch/status/cancel/usage)`,
        { kind },
      );
    }
    if (typeof adapter.kind === 'string' && adapter.kind !== kind) {
      throw serviceError(
        'validation_error',
        `adapter registered as ${kind} reports kind=${adapter.kind}`,
        { registration: kind, adapterKind: adapter.kind },
      );
    }
    registry.set(kind, adapter);
  }
  return registry;
}

function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Create a runnable runtime.
 *
 * @param {object} options
 * @param {string} options.dbPath SQLite path (`':memory:'` for tests)
 * @param {object} [options.adapters] executor adapters keyed by kind
 * @param {() => number} [options.clock] injectable clock
 * @param {(prefix: string) => string} [options.idFactory] injectable id generator
 * @param {string|null} [options.token] optional local API token
 * @param {string|null} [options.workspacePath] default workspace used by stop verification
 * @param {number} [options.quiescenceMs] stop quiescence window
 */
export function createRuntime({
  dbPath,
  adapters = {},
  clock = () => Date.now(),
  idFactory,
  token = null,
  workspacePath = null,
  quiescenceMs = DEFAULT_STOP_QUIESCENCE_MS,
} = {}) {
  if (typeof dbPath !== 'string' || dbPath === '') {
    throw new TypeError('createRuntime requires { dbPath } (use ":memory:" for tests)');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createRuntime clock must be a function');
  }
  if (!Number.isFinite(quiescenceMs) || quiescenceMs < 0) {
    throw new TypeError('createRuntime quiescenceMs must be a non-negative number');
  }

  const store = openStore({ path: dbPath });
  const registry = normalizeAdapters(adapters);
  const serviceStore = wrapServiceStore(createSqliteServiceStore(store));

  const service = createTaskService({
    store: serviceStore,
    clock,
    ...(typeof idFactory === 'function' ? { idFactory } : {}),
  });
  const router = createExecutorRouter({ adapters: Object.fromEntries(registry) });
  const ledger = createCostLedger({
    store,
    clock,
    resolveRun: (runId) => service.getRun(runId),
    resolveAdapter: (kind) => registry.get(kind) ?? null,
  });
  const stopControls = createStopControls({
    service,
    adapterRegistry: registry,
    clock,
    defaultWorkspacePath: workspacePath,
    defaultQuiescenceMs: quiescenceMs,
  });

  const apiBuilt = createApiServer({
    sqliteStore: store,
    store: serviceStore,
    service,
    clock,
    token,
  });

  function defaultDispatchKey(task) {
    return `dispatch:${task.id}:rev${task.revision}:cycle${task.cycleNo}`;
  }

  /**
   * Persist the dispatch intent before the caller can send it anywhere (PRD 04
   * §2.1.2 T1). The row id is derived from the run, so a replay or a restart
   * cannot create a second intent for the same run.
   */
  function enqueueDispatchIntent(dispatched, idempotencyKey) {
    const outboxId = `outbox-${dispatched.run.id}`;
    const existing = store.getOutbox(outboxId);
    if (existing) return existing;
    const payload = {
      run_id: dispatched.run.id,
      task_id: dispatched.task.id,
      executor_kind: dispatched.run.executorKind,
      idempotency_key: idempotencyKey,
    };
    return store.enqueueOutbox({
      id: outboxId,
      task_id: dispatched.task.id,
      run_id: dispatched.run.id,
      principal_ref: ACTORS.SCHEDULER,
      intent: 'dispatch_run',
      payload_json: canonicalize(payload),
      idempotency_key: `outbox:${idempotencyKey}`,
      state: 'pending',
      created_at: clock(),
    });
  }

  /**
   * Run a dispatch atomically without losing the service's typed failure.
   * `Store.transaction` normalises every thrown value into a `StoreError`; a
   * service guard such as "already has an active run" must stay a 409 with its
   * own code, so unwrap the original `ServiceError`.
   */
  function dispatchTransaction(fn) {
    try {
      return store.transaction(fn);
    } catch (error) {
      if (error?.name === 'StoreError' && error.cause?.name === 'ServiceError') {
        throw error.cause;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Task facade
  // ---------------------------------------------------------------------------
  const tasks = {
    create(options = {}) {
      return service.createTask(options);
    },

    /** Create the next delegation level under a parent (goal→business→execution). */
    delegate({ parentTaskId, level, title, ...rest } = {}) {
      const parent = service.getTask(parentTaskId);
      const expected = parent.level === 'goal' ? 'business' : parent.level === 'business' ? 'execution' : null;
      if (!expected) {
        throw serviceError(
          'hierarchy_violation',
          `task level ${parent.level} cannot own a delegated child`,
          { parentTaskId, parentLevel: parent.level, guard: 'G26' },
        );
      }
      const actual = level ?? expected;
      if (actual !== expected) {
        throw serviceError(
          'hierarchy_violation',
          `${parent.level} task must delegate a ${expected} child, got ${actual}`,
          { parentTaskId, parentLevel: parent.level, level: actual, expected, guard: 'G26' },
        );
      }
      return service.createTask({ level: actual, parentTaskId, title, ...rest });
    },

    get(taskId) {
      return service.getTask(taskId);
    },

    list(filter = {}) {
      return service.store.listTasks(filter);
    },

    queue(options = {}) {
      return service.queueTask(options);
    },

    /**
     * Dispatch an execution task. Without an explicit idempotency key the key
     * is derived from the task revision/cycle, so repeating the same dispatch
     * replays the first result instead of creating a second run. A dispatch on
     * a terminal task is rejected even if a stale idempotency record exists, so
     * a stopped task can never look freshly dispatched.
     *
     * The service creates and transitions the run; the runtime adds the durable
     * `dispatch_outbox` intent in the same SQLite transaction, so the pair is
     * committed together (PRD 04 §2.1.2 T1).
     */
    dispatch({ taskId, idempotencyKey, ...rest } = {}) {
      if (typeof taskId !== 'string' || taskId === '') {
        throw serviceError('validation_error', 'tasks.dispatch requires taskId');
      }
      const task = service.getTask(taskId);
      if (isTaskTerminal(task.state)) {
        throw serviceError(
          'invalid_state_transition',
          `task ${taskId} is ${task.state}; dispatch is refused`,
          { taskId, state: task.state, guard: 'G04', reason: 'dispatch_requires_schedulable_task' },
        );
      }
      const key = idempotencyKey ?? defaultDispatchKey(task);
      return dispatchTransaction(() => {
        const dispatched = service.dispatchTask({ taskId, idempotencyKey: key, ...rest });
        if (dispatched.replayed !== true) enqueueDispatchIntent(dispatched, key);
        return dispatched;
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Run facade
  // ---------------------------------------------------------------------------
  const runs = {
    get(runId) {
      return service.getRun(runId);
    },

    list(filter = {}) {
      return service.listRuns(filter);
    },

    ack({ runId, ack = {}, actor, idempotencyKey } = {}) {
      if (typeof runId !== 'string' || runId === '') {
        throw serviceError('validation_error', 'runs.ack requires runId');
      }
      return service.ackRun({
        runId,
        ack,
        actor,
        idempotencyKey: idempotencyKey ?? `ack:${runId}`,
      });
    },

    /**
     * Record the executor claim, which opens acceptance. The runtime then
     * projects the adapter's usage into the cost ledger; cost capture never
     * blocks or alters the state transition.
     */
    async claim({ runId, claim = {}, acceptanceItems, actor, idempotencyKey } = {}) {
      if (typeof runId !== 'string' || runId === '') {
        throw serviceError('validation_error', 'runs.claim requires runId');
      }
      const claimed = service.claimRun({
        runId,
        claim,
        acceptanceItems,
        actor,
        idempotencyKey: idempotencyKey ?? `claim:${runId}`,
      });
      let cost = null;
      if (claimed.replayed !== true) {
        try {
          cost = await ledger.captureRunUsage(runId);
        } catch (error) {
          cost = {
            recorded: false,
            reason: 'capture_failed',
            runId,
            message: error?.message ?? String(error),
            cost: null,
          };
        }
      }
      return { ...claimed, cost };
    },

    /** Send a dispatched run to the adapter named by its executor kind. */
    async dispatchToExecutor({ runId, taskPack, workspace, budget, tracking } = {}) {
      if (typeof runId !== 'string' || runId === '') {
        throw serviceError('validation_error', 'runs.dispatchToExecutor requires runId');
      }
      const run = service.getRun(runId);
      const task = service.getTask(run.taskId);
      const defaultPack = {
        goal: task.subject?.goal ?? task.title,
        constraints: [],
        acceptance: (task.acceptanceProfile?.items ?? []).map((item) => item.key),
        context_refs: [],
      };
      const defaultBudget =
        task.budget?.capCny === undefined || task.budget?.capCny === null
          ? {}
          : { cny_cap: task.budget.capCny };
      return router.dispatch({
        run: {
          id: run.id,
          executor_kind: run.executorKind,
          executorKind: run.executorKind,
        },
        taskPack: { ...defaultPack, ...(taskPack ?? {}) },
        workspace: workspace ?? { path: workspacePath },
        budget: budget ?? defaultBudget,
        tracking: tracking ?? { status: true, follow: true },
      });
    },

    async usage({ runId } = {}) {
      if (typeof runId !== 'string' || runId === '') {
        throw serviceError('validation_error', 'runs.usage requires runId');
      }
      const run = service.getRun(runId);
      const adapter = registry.get(run.executorKind) ?? null;
      if (!adapter) {
        return {
          ok: false,
          code: 'executor_unavailable',
          run_id: runId,
          source: 'unavailable',
          message: `no adapter registered for executor_kind=${run.executorKind}`,
        };
      }
      return adapter.usage({ run_id: runId });
    },
  };

  // ---------------------------------------------------------------------------
  // Acceptance facade
  // ---------------------------------------------------------------------------
  const acceptances = {
    get(acceptanceId) {
      return service.getAcceptance(acceptanceId);
    },

    list(filter = {}) {
      return service.listAcceptances(filter);
    },

    decide({
      acceptanceId,
      verdict,
      itemStates,
      actor,
      idempotencyKey,
      reviewer = null,
      reason = null,
    } = {}) {
      if (typeof acceptanceId !== 'string' || acceptanceId === '') {
        throw serviceError('validation_error', 'acceptances.decide requires acceptanceId');
      }
      return service.decideAcceptance({
        acceptanceId,
        verdict,
        itemStates,
        actor,
        reviewer,
        reason,
        idempotencyKey:
          idempotencyKey ?? `acceptance:${acceptanceId}:${String(verdict ?? '').toLowerCase()}`,
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Cost facade
  // ---------------------------------------------------------------------------
  const cost = {
    record: ledger.record,
    list: ledger.list,
    total: ledger.total,
    forRun: ledger.forRun,
    captureRunUsage: ledger.captureRunUsage,
  };

  // ---------------------------------------------------------------------------
  // Stop facade
  // ---------------------------------------------------------------------------
  const stop = {
    request: stopControls.request,
    verify: stopControls.verify,
    stop: stopControls.stop,
  };

  // ---------------------------------------------------------------------------
  // HTTP API over the same service/store
  // ---------------------------------------------------------------------------
  const api = {
    server: apiBuilt.server,

    url() {
      const address = apiBuilt.server.address();
      if (!address || typeof address === 'string') return null;
      const host = address.address === '::' ? '127.0.0.1' : address.address;
      return `http://${host}:${address.port}`;
    },

    async start({ host = '127.0.0.1', port = 0 } = {}) {
      if (!apiBuilt.server.listening) await listen(apiBuilt.server, { host, port });
      return api.url();
    },

    async close() {
      if (!apiBuilt.server.listening) return;
      apiBuilt.server.closeAllConnections?.();
      await new Promise((resolve) => apiBuilt.server.close(() => resolve()));
    },
  };

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await api.close();
    store.close();
  }

  return {
    tasks,
    runs,
    acceptances,
    cost,
    stop,
    api,
    service,
    serviceStore,
    store,
    router,
    adapters: Object.freeze(Object.fromEntries(registry)),
    config: Object.freeze({
      dbPath,
      adapters: Object.freeze([...registry.keys()]),
      workspacePath,
      quiescenceMs,
      tokenProtected: Boolean(token),
    }),
    close,
  };
}
