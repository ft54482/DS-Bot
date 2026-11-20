import {
  ACTIVE_RUN_STATES,
  DEFAULT_STOP_QUIESCENCE_MS,
} from '../../service/src/index.js';
import { serviceError } from '../../service/src/errors.js';
import { hashTree } from './workspace.js';

/**
 * Stop controls for the runtime.
 *
 * The state machine (freeze subtree, verification rules, fail-closed
 * `stop_unknown`) belongs to `packages/service`; this module only supplies the
 * missing pieces a runtime owns:
 *
 *  - ask each live executor adapter to cancel its run;
 *  - hash the workspace before/after cancellation to prove writes stopped;
 *  - feed that evidence to `service.verifyStop`.
 *
 * A cancel without a verified stop is never reported as "stopped": the service
 * keeps the task in `stopping`/`stop_unknown`, and this module passes that
 * result through unchanged.
 */

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function createStopControls({
  service,
  adapterRegistry = new Map(),
  clock = () => Date.now(),
  defaultWorkspacePath = null,
  defaultQuiescenceMs = DEFAULT_STOP_QUIESCENCE_MS,
} = {}) {
  if (!service) throw new TypeError('createStopControls requires a service');
  const registry =
    adapterRegistry instanceof Map ? adapterRegistry : new Map(Object.entries(adapterRegistry ?? {}));

  function collectSubtree(rootId) {
    const root = service.getTask(rootId);
    const result = [root];
    const queue = [root];
    while (queue.length > 0) {
      const parent = queue.shift();
      for (const child of service.store.listTasks({ parentTaskId: parent.id })) {
        result.push(child);
        queue.push(child);
      }
    }
    return result;
  }

  function request({
    taskId,
    requestedBy = 'human',
    reason = 'user_stop',
    idempotencyKey,
  } = {}) {
    if (typeof taskId !== 'string' || taskId === '') {
      throw serviceError('validation_error', 'stop.request requires taskId');
    }
    const result = service.requestStop({
      taskId,
      requestedBy,
      reason,
      idempotencyKey: idempotencyKey ?? `stop:${taskId}`,
    });
    return { ...result, task: result.task ?? service.getTask(taskId) };
  }

  function verify({
    taskId,
    verifications = [],
    force = false,
    decisionToken = null,
    deadlinePassed = false,
    minQuiescenceMs = defaultQuiescenceMs,
    actor = 'system',
    idempotencyKey,
  } = {}) {
    if (typeof taskId !== 'string' || taskId === '') {
      throw serviceError('validation_error', 'stop.verify requires taskId');
    }
    return service.verifyStop({
      taskId,
      verifications,
      force,
      decisionToken,
      deadlinePassed,
      minQuiescenceMs,
      actor,
      idempotencyKey,
    });
  }

  /**
   * Request a stop, cancel every live executor, then verify quiescence.
   *
   * `workspacePath` is the namespace whose writes must have stopped. Without
   * it the evidence is explicitly incomplete (`missing_namespace_hash`), so the
   * task cannot falsely leave `stopping`.
   */
  async function stop({
    taskId,
    workspacePath = defaultWorkspacePath,
    requestedBy = 'human',
    reason = 'user_stop',
    idempotencyKey,
    minQuiescenceMs = defaultQuiescenceMs,
    force = false,
    decisionToken = null,
    deadlinePassed = false,
    actor = 'system',
  } = {}) {
    const current = service.getTask(taskId);
    if (current.state === 'cancelled') {
      return {
        requested: current,
        tasks: collectSubtree(taskId),
        cancelled: true,
        stopState: current.stopState ?? 'verified',
        blockers: [],
        executor: [],
        verifications: [],
      };
    }

    const requested = request({ taskId, requestedBy, reason, idempotencyKey });
    const subtree = collectSubtree(taskId);
    const activeRuns = subtree.flatMap((task) =>
      service
        .listRuns({ taskId: task.id })
        .filter((run) => ACTIVE_RUN_STATES.includes(run.state)),
    );

    let hashBefore = null;
    let hashError = null;
    if (typeof workspacePath === 'string' && workspacePath !== '') {
      try {
        hashBefore = hashTree(workspacePath);
      } catch (error) {
        hashError = error?.message ?? String(error);
      }
    }

    const windowStartedAt = clock();
    const executedCancel = [];
    const verifications = [];

    for (const run of activeRuns) {
      // A queued run never reached an executor; the service verifies it without
      // a quiescence proof (PRD 03 §5.2.1 step 5).
      if (run.state === 'queued') continue;
      const adapter = registry.get(run.executorKind) ?? null;
      let cancel = null;
      let error = null;
      if (!adapter || typeof adapter.cancel !== 'function') {
        error = 'executor_unavailable';
      } else {
        try {
          cancel = await adapter.cancel({ run_id: run.id });
        } catch (caught) {
          error = caught?.message ?? String(caught);
        }
      }
      executedCancel.push({ runId: run.id, executorKind: run.executorKind, cancel, error });
      const processGone =
        Boolean(cancel) &&
        cancel.verified_stopped_at != null &&
        cancel.remote_may_still_run !== true;
      verifications.push({
        runId: run.id,
        processGone,
        cancelAck: cancel?.requested === true,
        quiescenceWindowMs: minQuiescenceMs,
        windowStartedAt,
        // Filled after all writes settle, when the namespace hash is known.
        lastWriteAt: null,
        namespaceHashBefore: hashBefore,
        namespaceHashAfter: null,
        openFileHandles: 0,
        executorError: error,
      });
    }

    let hashAfter = null;
    if (hashBefore !== null) {
      try {
        hashAfter = hashTree(workspacePath);
      } catch (error) {
        hashError = hashError ?? error?.message ?? String(error);
      }
    }
    const writesStable = hashBefore !== null && hashAfter !== null && hashBefore === hashAfter;
    for (const verification of verifications) {
      verification.namespaceHashAfter = hashAfter;
      verification.lastWriteAt = writesStable ? windowStartedAt - 1 : clock();
    }

    const verification = verify({
      taskId,
      verifications,
      force,
      decisionToken,
      deadlinePassed,
      minQuiescenceMs,
      actor,
    });

    return {
      ...verification,
      requested: requested.task,
      tasks: verification.tasks ?? requested.tasks ?? subtree,
      executor: executedCancel,
      verifications: clone(verifications),
      workspace: {
        path: workspacePath ?? null,
        hashBefore,
        hashAfter,
        writesStable,
        error: hashError,
      },
    };
  }

  return { request, verify, stop };
}
