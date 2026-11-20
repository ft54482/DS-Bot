import { randomUUID } from 'node:crypto';
import { ServiceError, serviceError } from './errors.js';
import {
  ACCEPTANCE_ITEM_CLASSES,
  ACTIVE_RUN_STATES,
  isTaskTerminal,
  RUN_RETRYABLE_STATES,
  TASK_STOPPABLE_STATES,
} from './states.js';
import {
  checkAcceptanceTransition,
  checkRunTransition,
  checkTaskTransition,
} from './transitions.js';
import { createMemoryStore } from './memory-store.js';
import { hashValue } from './canonical.js';

/** Default stop-verification quiescence window (PRD 03 §5.2.1: max(2x heartbeat, 5s)). */
export const DEFAULT_STOP_QUIESCENCE_MS = 5000;
export const DEFAULT_LEASE_MS = 60_000;

/** Role names used by the guards. */
export const ACTORS = Object.freeze({
  HUMAN: 'human',
  CLIENT: 'client',
  SYSTEM: 'system',
  SCHEDULER: 'scheduler',
  EXECUTOR: 'executor',
  ADAPTER: 'adapter',
  ACCEPTANCE: 'acceptance_service',
  REVIEWER: 'reviewer',
  BOT: 'bot',
  CHIEF: 'chief',
});

const EXECUTOR_ACTORS = new Set(['executor', 'exec', 'adapter', 'adaptor', 'reviewer', 'rev']);
const COMPLETION_ACTORS = new Set([
  'acceptance_service',
  'acc',
  'system',
  'sys',
  'scheduler',
  'human',
  'human_owner',
  'client',
]);
const HUMAN_ACTORS = new Set(['human', 'human_owner', 'client']);
const ACCEPTANCE_DECISION_ACTORS = new Set(['acceptance_service', 'acc']);

const TASK_STATE_EVENTS = Object.freeze({
  planned: 'task.planned',
  queued: 'task.queued',
  running: 'task.running',
  accepting: 'task.accepting',
  reworking: 'task.reworking',
  stopping: 'task.stopping',
  completed: 'task.completed',
  blocked: 'task.blocked',
  paused: 'task.paused',
  cancelled: 'task.cancelled',
});

const RUN_STATE_EVENTS = Object.freeze({
  queued: 'run.created',
  dispatched: 'run.dispatch_sent',
  dispatch_unknown: 'run.dispatch_unknown',
  running: 'run.started',
  reported: 'run.reported',
  accepted: 'run.accepted',
  rejected: 'run.rejected',
  failed: 'run.failed',
  cancelled: 'run.cancelled',
  lost: 'run.lost',
  timed_out: 'run.timed_out',
  invalidated: 'run.invalidated',
  superseded: 'run.superseded',
});

const ACCEPTANCE_STATE_EVENTS = Object.freeze({
  passed: 'acceptance.passed',
  revise: 'acceptance.revise',
  failed: 'acceptance.failed',
  blocked: 'acceptance.blocked',
  void: 'acceptance.voided',
  superseded: 'acceptance.superseded',
});

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const normalizeActor = (actor) => String(actor ?? ACTORS.SYSTEM).trim().toLowerCase();
const isHex = (value, length) =>
  typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value);

/**
 * Create the L2 task service.
 *
 * All state lives in the injected store; this module only contains pure
 * transition/guard logic plus event and idempotency bookkeeping. There is no
 * database, filesystem or network dependency.
 *
 * @param {object} [options]
 * @param {object} [options.store] state store (defaults to a fresh in-memory store)
 * @param {() => number} [options.clock] injectable clock
 * @param {(prefix: string) => string} [options.idFactory] injectable id generator
 */
export function createTaskService({
  store = createMemoryStore(),
  clock = () => Date.now(),
  idFactory = (prefix) => `${prefix}-${randomUUID()}`,
} = {}) {
  const now = () => clock();
  const newId = (prefix) => idFactory(prefix);

  // ---------------------------------------------------------------------------
  // Event ledger
  // ---------------------------------------------------------------------------

  function recordEvent(type, options = {}) {
    const body = {
      eventId: newId('evt'),
      type,
      taskId: options.taskId ?? null,
      runId: options.runId ?? null,
      acceptanceId: options.acceptanceId ?? null,
      actor: normalizeActor(options.actor),
      cause: options.cause ?? null,
      createdAt: now(),
      payload: clone(options.payload ?? {}),
    };
    const prevHash = store.lastEventHash();
    const hash = hashValue({ ...body, prevHash });
    return store.appendEvent({ ...body, prevHash, hash });
  }

  function rejectTransition(kind, from, to, options = {}) {
    recordEvent('transition.rejected', {
      taskId: options.taskId,
      runId: options.runId,
      acceptanceId: options.acceptanceId,
      actor: options.actor,
      payload: {
        entity: kind,
        from_state: from,
        to_state: to,
        actor: normalizeActor(options.actor),
        guard_failed: options.guard ?? 'transition_table',
        reason: options.reason ?? null,
        request_id: options.requestId ?? null,
        idempotency_key: options.idempotencyKey ?? null,
      },
    });
    throw serviceError(
      'invalid_state_transition',
      `illegal ${kind} transition: ${from} -> ${to}`,
      {
        entity: kind,
        from,
        to,
        guard: options.guard ?? 'transition_table',
        reason: options.reason ?? null,
      },
    );
  }

  function idempotent(scope, key, payload, execute) {
    if (!key) return execute();
    const payloadHash = hashValue({ scope, payload });
    const existing = store.getIdempotency(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        recordEvent('transition.rejected', {
          payload: {
            entity: scope,
            guard_failed: 'G18',
            reason: 'idempotency_conflict',
            request_id: null,
            idempotency_key: key,
          },
        });
        const code = scope === 'dispatch' ? 'duplicate_dispatch' : 'idempotency_conflict';
        throw serviceError(code, `idempotency key ${key} was already used with a different payload`, {
          key,
          scope,
        });
      }
      recordEvent('transition.replayed', {
        payload: { scope, idempotency_key: key, request_id: null },
      });
      return { ...clone(existing.result), replayed: true };
    }
    const result = execute();
    store.putIdempotency(key, {
      key,
      scope,
      payloadHash,
      result: clone(result),
      at: now(),
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  function requireTask(taskId) {
    const task = store.getTask(taskId);
    if (!task) throw serviceError('not_found', `task ${taskId} does not exist`, { taskId });
    return task;
  }

  function requireRun(runId) {
    const run = store.getRun(runId);
    if (!run) throw serviceError('not_found', `run ${runId} does not exist`, { runId });
    return run;
  }

  function requireAcceptance(acceptanceId) {
    const acceptance = store.getAcceptance(acceptanceId);
    if (!acceptance) {
      throw serviceError('not_found', `acceptance ${acceptanceId} does not exist`, { acceptanceId });
    }
    return acceptance;
  }

  function requireOpenAcceptance(task) {
    if (!task.openAcceptanceId) return null;
    const acceptance = store.getAcceptance(task.openAcceptanceId);
    if (!acceptance || acceptance.state !== 'open') return null;
    return acceptance;
  }

  // ---------------------------------------------------------------------------
  // Guard helpers
  // ---------------------------------------------------------------------------

  function assertTaskActor(actor, from, to, taskId) {
    const normalized = normalizeActor(actor);
    if (EXECUTOR_ACTORS.has(normalized)) {
      recordEvent('security.forbidden_transition', {
        taskId,
        actor: normalized,
        payload: {
          actor: normalized,
          from,
          to,
          guard: 'G03',
          request_id: null,
        },
      });
      throw serviceError(
        'forbidden_transition',
        `actor ${normalized} may not move a task state`,
        { actor: normalized, from, to },
        403,
      );
    }
    if (to === 'completed' && !COMPLETION_ACTORS.has(normalized)) {
      recordEvent('security.forbidden_transition', {
        taskId,
        actor: normalized,
        payload: { actor: normalized, from, to, guard: 'G30', request_id: null },
      });
      throw serviceError(
        'forbidden_transition',
        `actor ${normalized} may not complete a task`,
        { actor: normalized, from, to },
        403,
      );
    }
    if (from === 'completed' && to === 'queued' && !HUMAN_ACTORS.has(normalized)) {
      throw serviceError(
        'forbidden_transition',
        'only a human may reopen a completed task',
        { actor: normalized, from, to },
        403,
      );
    }
  }

  function findPassedAcceptance(task) {
    if (!task.subjectFingerprint) return null;
    const passed = store
      .listAcceptances({ taskId: task.id, state: 'passed' })
      .filter(
        (acceptance) =>
          acceptance.stage === task.level &&
          !acceptance.supersededAt &&
          acceptance.subjectFingerprint === task.subjectFingerprint,
      )
      .sort((left, right) => right.roundNo - left.roundNo);
    return passed[0] ?? null;
  }

  function hasHumanGoalSignoff(acceptance) {
    return (acceptance.items ?? []).some(
      (item) =>
        item.key === 'human.goal_signoff' &&
        item.state === 'pass' &&
        isHumanSigned(item),
    );
  }

  function isHumanSigned(item) {
    return Boolean(
      item.signedBy ||
        (typeof item.producer === 'string' && item.producer.toLowerCase().startsWith('human')),
    );
  }

  function assertCompletionGuards(task, acceptance, actor) {
    if (!acceptance) {
      throw serviceError(
        'missing_acceptance',
        `task ${task.id} has no passed acceptance at level ${task.level}; completion is refused`,
        {
          taskId: task.id,
          level: task.level,
          state: task.state,
          guard: 'G30',
          subjectFingerprint: task.subjectFingerprint,
        },
      );
    }
    if (task.level === 'goal' && !hasHumanGoalSignoff(acceptance)) {
      throw serviceError(
        'missing_acceptance',
        'goal completion requires a passed human.goal_signoff item',
        { taskId: task.id, level: task.level, reason: 'human_signoff_missing', guard: 'G31' },
      );
    }
    if (acceptance.state !== 'passed') {
      throw serviceError('missing_acceptance', 'acceptance is not passed', {
        taskId: task.id,
        acceptanceId: acceptance.id,
        acceptanceState: acceptance.state,
      });
    }
    void actor;
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------

  function applyTaskTransition(taskInput, to, options = {}) {
    const current = requireTask(taskInput.id);
    if (
      options.expectedStateVersion !== undefined &&
      options.expectedStateVersion !== null &&
      current.stateVersion !== options.expectedStateVersion
    ) {
      throw serviceError(
        'state_conflict',
        `task ${current.id} state version mismatch (expected ${options.expectedStateVersion}, actual ${current.stateVersion})`,
        {
          taskId: current.id,
          expectedStateVersion: options.expectedStateVersion,
          actualStateVersion: current.stateVersion,
          guard: 'G02',
        },
      );
    }

    const actor = normalizeActor(options.actor);
    assertTaskActor(actor, current.state, to, current.id);

    const check = checkTaskTransition(current.state, to);
    if (!check.allowed) {
      rejectTransition('task', current.state, to, {
        taskId: current.id,
        actor,
        reason: check.reason,
        guard: options.guard,
        requestId: options.requestId,
        idempotencyKey: options.idempotencyKey,
      });
    }

    if (
      current.state === 'blocked' &&
      current.blockedReason === 'stop_unverified' &&
      (to === 'queued' || to === 'planned')
    ) {
      // PRD 03 §5.2.1 step 7: a stop that could not be verified may only be
      // resolved by manual investigation or an explicit forced cancel.
      throw serviceError(
        'invalid_state_transition',
        'blocked(stop_unverified) cannot resume work; investigate or force-cancel',
        {
          taskId: current.id,
          from: current.state,
          to,
          guard: 'G32',
          reason: 'stop_unverified_requires_manual_force',
        },
      );
    }

    if (to === 'completed') {
      const passed = findPassedAcceptance(current);
      assertCompletionGuards(current, passed, actor);
    }

    if (to === 'cancelled') {
      if (current.state === 'stopping') {
        if (!options.verifiedStop && current.stopState !== 'verified' && current.stopState !== 'forced') {
          throw serviceError(
            'stop_unverified',
            `task ${current.id} cannot be cancelled before stop verification`,
            {
              taskId: current.id,
              stopState: current.stopState ?? 'requested',
              stopUnknown: true,
              guard: 'G32',
            },
          );
        }
      } else if (store.listActiveRuns(current.id).length > 0) {
        rejectTransition('task', current.state, 'cancelled', {
          taskId: current.id,
          actor,
          reason: 'active_run_requires_stop_verification',
          guard: 'G32',
        });
      }
    }

    const isReopen = current.state === 'completed' && to === 'queued';
    if (isReopen) {
      // T-31: previous passes stay as history but stop counting for completion.
      const at = now();
      for (const passed of store.listAcceptances({
        taskId: current.id,
        stage: current.level,
        state: 'passed',
      })) {
        if (passed.supersededAt) continue;
        store.updateAcceptance(
          passed.id,
          { supersededAt: at, updatedAt: at },
          { expectedStateVersion: passed.stateVersion },
        );
        recordEvent('acceptance.superseded', {
          acceptanceId: passed.id,
          taskId: current.id,
          actor,
          payload: { reason: 'task_reopened', cycle_no: current.cycleNo + 1 },
        });
      }
    }

    const patch = { ...(options.patch ?? {}), state: to, updatedAt: now() };
    if (isReopen) {
      patch.cycleNo = current.cycleNo + 1;
      patch.revision = current.revision + 1;
      patch.subject = null;
      patch.subjectFingerprint = null;
      patch.openAcceptanceId = null;
      patch.terminalAt = null;
    }
    if (to === 'stopping') {
      if (patch.stopState === undefined) patch.stopState = 'requested';
      if (patch.stopRequestedAt === undefined) patch.stopRequestedAt = now();
      patch.stopUnknown = false;
    }
    const updated = store.updateTask(current.id, patch, {
      expectedStateVersion: current.stateVersion,
    });
    recordEvent(TASK_STATE_EVENTS[to], {
      taskId: current.id,
      actor,
      cause: options.cause,
      payload: { from_state: current.state, to_state: to },
    });
    if (to === 'completed' && current.parentTaskId) {
      recordEvent('child.completed', {
        taskId: current.id,
        actor,
        payload: { parent_task_id: current.parentTaskId, level: current.level },
      });
    }
    return updated;
  }

  function applyRunTransition(runInput, to, options = {}) {
    const current = requireRun(runInput.id);
    const actor = normalizeActor(options.actor);
    const check = checkRunTransition(current.state, to);
    if (!check.allowed) {
      rejectTransition('run', current.state, to, {
        runId: current.id,
        actor,
        reason: check.reason,
        guard: options.guard,
        requestId: options.requestId,
        idempotencyKey: options.idempotencyKey,
      });
    }
    if (
      to === 'cancelled' &&
      ACTIVE_RUN_STATES.includes(current.state) &&
      current.state !== 'queued' &&
      !options.verifiedStop
    ) {
      throw serviceError(
        'stop_unverified',
        `run ${current.id} cannot be cancelled before stop verification`,
        { runId: current.id, stopUnknown: true, guard: 'G32' },
      );
    }
    const patch = { ...(options.patch ?? {}), state: to, updatedAt: now() };
    const updated = store.updateRun(current.id, patch, {
      expectedStateVersion: current.stateVersion,
    });
    recordEvent(options.eventType ?? RUN_STATE_EVENTS[to], {
      runId: current.id,
      taskId: current.taskId,
      actor,
      cause: options.cause,
      payload: { from_state: current.state, to_state: to },
    });
    return updated;
  }

  function applyAcceptanceTransition(acceptanceInput, to, options = {}) {
    const current = requireAcceptance(acceptanceInput.id);
    const actor = normalizeActor(options.actor);
    const check = checkAcceptanceTransition(current.state, to);
    if (!check.allowed) {
      rejectTransition('acceptance', current.state, to, {
        acceptanceId: current.id,
        actor,
        reason: check.reason,
        guard: options.guard,
      });
    }
    const updated = store.updateAcceptance(
      current.id,
      { ...(options.patch ?? {}), state: to, updatedAt: now() },
      { expectedStateVersion: current.stateVersion },
    );
    recordEvent(ACCEPTANCE_STATE_EVENTS[to], {
      acceptanceId: current.id,
      taskId: current.taskId,
      runId: current.runId,
      actor,
      cause: options.cause,
      payload: { from_state: current.state, to_state: to, reason: options.reason ?? null },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Task creation / queueing
  // ---------------------------------------------------------------------------

  function createTask(options = {}) {
    const {
      level = 'execution',
      parentTaskId = null,
      title,
      owner = null,
      acceptanceProfile = null,
      subject = null,
      budget = null,
      authScope = null,
    } = options;

    if (!['goal', 'business', 'execution'].includes(level)) {
      throw serviceError('validation_error', `unknown task level: ${level}`, { level });
    }
    if (typeof title !== 'string' || title.trim() === '') {
      throw serviceError('validation_error', 'task title must be a non-empty string', { title });
    }
    if (parentTaskId) {
      const parent = requireTask(parentTaskId);
      const expectedParentLevel = { business: 'goal', execution: 'business' }[level];
      if (parent.level !== expectedParentLevel) {
        throw serviceError(
          'hierarchy_violation',
          `${level} task must have a ${expectedParentLevel} parent, got ${parent.level}`,
          { level, parentTaskId, parentLevel: parent.level, guard: 'G26' },
        );
      }
    }

    const at = now();
    const task = {
      id: newId('task'),
      level,
      parentTaskId,
      title,
      owner,
      state: 'planned',
      stateVersion: 1,
      revision: 0,
      cycleNo: 1,
      subject: subject ? clone(subject) : null,
      subjectFingerprint: null,
      acceptanceProfile: acceptanceProfile
        ? clone(acceptanceProfile)
        : { id: `profile-${level}`, version: 1 },
      budget: budget ? clone(budget) : null,
      authScope: authScope ? clone(authScope) : null,
      currentRunId: null,
      openAcceptanceId: null,
      blockedReason: null,
      pausedReason: null,
      stopState: null,
      stopUnknown: false,
      stopRequestedAt: null,
      stopRequestedBy: null,
      stopReason: null,
      stopVerifiedAt: null,
      unsafeStop: false,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      queuedAt: null,
      terminalAt: null,
    };
    store.createTask(task);
    recordEvent('task.created', {
      taskId: task.id,
      actor: options.actor ?? ACTORS.SYSTEM,
      payload: {
        level,
        parent_task_id: parentTaskId,
        acceptance_profile: task.acceptanceProfile,
      },
    });
    if (parentTaskId) {
      recordEvent('delegation.created', {
        taskId: task.id,
        actor: options.actor ?? ACTORS.SYSTEM,
        payload: { parent_task_id: parentTaskId, level },
      });
    }
    return task;
  }

  function queueTask({ taskId, actor = ACTORS.SYSTEM, idempotencyKey } = {}) {
    return idempotent('queue', idempotencyKey, { taskId }, () => {
      const task = requireTask(taskId);
      if (task.state === 'queued') return { task };
      const queued = applyTaskTransition(task, 'queued', {
        actor,
        patch: { queuedAt: now() },
      });
      return { task: queued };
    });
  }

  // ---------------------------------------------------------------------------
  // Execution: dispatch, ack, claim
  // ---------------------------------------------------------------------------

  function dispatchTask({
    taskId,
    idempotencyKey,
    executorKind = 'dsh_session',
    payload = {},
    actor = ACTORS.SCHEDULER,
    ackDeadlineMs = 30_000,
  } = {}) {
    return idempotent(
      'dispatch',
      idempotencyKey,
      { taskId, executorKind, payload },
      () => {
        const task = requireTask(taskId);
        if (task.level !== 'execution') {
          throw serviceError(
            'validation_error',
            'only execution tasks own runs (goal/business aggregate children)',
            { taskId, level: task.level },
          );
        }
        if (!['planned', 'queued', 'reworking'].includes(task.state)) {
          rejectTransition('task', task.state, 'queued', {
            taskId,
            actor,
            reason: 'dispatch_requires_schedulable_task',
            guard: 'G04',
            idempotencyKey,
          });
        }
        const queuedRun = store.listRuns({ taskId, state: 'queued' })[0] ?? null;
        const blockingRuns = store
          .listActiveRuns(taskId)
          .filter((activeRun) => activeRun.id !== queuedRun?.id);
        if (blockingRuns.length > 0) {
          throw serviceError(
            'invalid_state_transition',
            `task ${taskId} already has an active run`,
            {
              taskId,
              runId: blockingRuns[0].id,
              guard: 'G04',
              reason: 'one_active_run',
            },
          );
        }

        const at = now();
        let run = queuedRun;
        if (!run) {
          const attemptNo = store.listRuns({ taskId }).length + 1;
          run = store.createRun({
            id: newId('run'),
            taskId,
            state: 'queued',
            stateVersion: 1,
            attemptNo,
            kind: task.state === 'reworking' ? 'rework' : 'initial',
            executorKind,
            fencingToken: 1,
            idempotencyKey: idempotencyKey ?? null,
            dispatch: null,
            lease: null,
            claimId: null,
            subjectFingerprint: null,
            sealedAt: null,
            endedAt: null,
            failureReason: null,
            supersededBy: null,
            cancelRequestedAt: null,
            stopUnknown: false,
            startedAt: null,
            createdAt: at,
            updatedAt: at,
          });
          recordEvent('run.created', {
            runId: run.id,
            taskId,
            actor,
            payload: { attempt_no: run.attemptNo, kind: run.kind, executor_kind: executorKind },
          });
        }

        let updatedTask = task;
        if (task.state === 'planned') {
          updatedTask = applyTaskTransition(task, 'queued', {
            actor,
            patch: { queuedAt: at },
          });
        } else if (task.state === 'reworking') {
          updatedTask = applyTaskTransition(task, 'queued', { actor });
        }

        run = applyRunTransition(run, 'dispatched', {
          actor,
          patch: {
            dispatch: {
              sentAt: at,
              ackDeadline: at + ackDeadlineMs,
              idempotencyKey: idempotencyKey ?? null,
              executorKind,
              payload: clone(payload),
            },
            idempotencyKey: idempotencyKey ?? null,
          },
        });
        updatedTask = store.updateTask(
          updatedTask.id,
          { currentRunId: run.id, updatedAt: at },
          { expectedStateVersion: updatedTask.stateVersion },
        );
        return { task: updatedTask, run };
      },
    );
  }

  function ackRun({ runId, actor = ACTORS.EXECUTOR, idempotencyKey, ack = {} } = {}) {
    return idempotent('ack', idempotencyKey, { runId, ack }, () => {
      const run = requireRun(runId);
      const task = requireTask(run.taskId);
      if (run.state === 'running') {
        return { task, run };
      }
      if (!['dispatched', 'dispatch_unknown', 'queued'].includes(run.state)) {
        rejectTransition('run', run.state, 'running', {
          runId,
          actor,
          reason: 'ack_requires_dispatched_run',
          guard: 'G07',
        });
      }
      const at = now();
      const updatedRun = applyRunTransition(run, 'running', {
        actor,
        eventType: 'run.dispatch_ack',
        patch: {
          startedAt: at,
          lease: {
            expiresAt: at + (ack.leaseMs ?? DEFAULT_LEASE_MS),
            instanceId: ack.instanceId ?? null,
          },
        },
      });
      recordEvent('run.started', {
        runId,
        taskId: task.id,
        actor,
        payload: { instance_id: ack.instanceId ?? null },
      });
      let updatedTask = task;
      if (task.state === 'queued') {
        // T-07: the executor ack is the cause, but the service applies the task
        // projection (EXEC/REV may never write a task state, PRD G03).
        updatedTask = applyTaskTransition(task, 'running', {
          actor: ACTORS.SYSTEM,
          cause: `executor_ack:${normalizeActor(actor)}`,
          patch: { startedAt: at },
        });
      }
      return { task: updatedTask, run: updatedRun };
    });
  }

  function buildSubject(claim) {
    if (claim.subject && typeof claim.subject === 'object') return clone(claim.subject);
    const manifest = [...(claim.manifest ?? [])]
      .map((entry) => ({ path: entry.path, sha256: entry.sha256.toLowerCase() }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return { commit: claim.commit.toLowerCase(), manifest };
  }

  function validateExecutionClaim(claim, task) {
    const reasons = [];
    if (!claim || typeof claim !== 'object') {
      throw serviceError('claim_invalid', 'claim payload is required', { guard: 'G09' });
    }
    if (!isHex(claim.commit, 40)) reasons.push('commit_must_be_40_hex');
    if (claim.dirty !== false) reasons.push('dirty_worktree');
    if (!Array.isArray(claim.manifest) || claim.manifest.length === 0) {
      reasons.push('manifest_required');
    } else {
      for (const entry of claim.manifest) {
        if (!entry || typeof entry.path !== 'string' || entry.path === '') {
          reasons.push('manifest_path_required');
          break;
        }
        if (!isHex(entry.sha256, 64)) {
          reasons.push('manifest_sha256_invalid');
          break;
        }
      }
    }
    if (typeof claim.nonce !== 'string' || claim.nonce === '') reasons.push('nonce_required');
    if (claim.revision !== undefined && claim.revision !== task.revision) {
      reasons.push('revision_mismatch');
    }
    if (claim.stage !== undefined && claim.stage !== task.level) {
      reasons.push('stage_mismatch');
    }
    if (reasons.length > 0) {
      throw serviceError('claim_invalid', 'claim failed validation', {
        taskId: task.id,
        reasons,
        guard: 'G09',
      });
    }
  }

  function normalizeItems(items, { level }) {
    const source =
      Array.isArray(items) && items.length > 0
        ? items
        : [
            { key: 'auto.checks', class: 'auto', required: true },
            ...(level === 'goal'
              ? [{ key: 'human.goal_signoff', class: 'human', required: true }]
              : []),
          ];
    return source.map((item, index) => {
      const itemClass = item.class ?? 'auto';
      if (!ACCEPTANCE_ITEM_CLASSES.includes(itemClass)) {
        throw serviceError('validation_error', `unknown acceptance item class: ${itemClass}`, {
          itemClass,
        });
      }
      return {
        key: item.key ?? `item.${index}`,
        class: itemClass,
        required: item.required !== false,
        // A claim can declare which items are required, never their outcome:
        // every new round starts pending and only ACC may fill it (PRD §4.2).
        state: 'pending',
        producer: null,
        evidenceRefs: [],
        signedBy: null,
      };
    });
  }

  function openAcceptance({ task, runId = null, subjectFingerprint, items, actor, source }) {
    const roundNo =
      store.listAcceptances({ taskId: task.id, stage: task.level }).length + 1;
    const at = now();
    const acceptance = store.createAcceptance({
      id: newId('acc'),
      taskId: task.id,
      runId,
      stage: task.level,
      state: 'open',
      stateVersion: 1,
      roundNo,
      revision: task.revision,
      subjectFingerprint,
      items: normalizeItems(items, { level: task.level }),
      source,
      openedAt: at,
      decidedAt: null,
      decidedBy: null,
      reason: null,
      supersededAt: null,
      updatedAt: at,
    });
    recordEvent('acceptance.opened', {
      acceptanceId: acceptance.id,
      taskId: task.id,
      runId,
      actor,
      payload: {
        stage: task.level,
        round_no: roundNo,
        subject_fingerprint: subjectFingerprint,
        required_items: acceptance.items.filter((item) => item.required).map((item) => item.key),
      },
    });
    return acceptance;
  }

  function claimRun({
    runId,
    claim = {},
    idempotencyKey,
    actor = ACTORS.EXECUTOR,
    acceptanceItems,
  } = {}) {
    return idempotent(
      'claim',
      idempotencyKey,
      { runId, claim, acceptanceItems },
      () => {
        const run = requireRun(runId);
        const task = requireTask(run.taskId);
        if (task.level !== 'execution') {
          throw serviceError('validation_error', 'claim applies only to execution tasks', {
            taskId: task.id,
            level: task.level,
          });
        }

        if (run.state === 'reported') {
          const existing = store.listClaims({ runId })[0];
          if (existing && existing.nonce === claim.nonce) {
            return {
              task,
              run,
              acceptance: requireOpenAcceptance(task),
              claim: existing,
            };
          }
          recordEvent('completion.duplicate_rejected', {
            runId,
            taskId: task.id,
            actor,
            payload: {
              run_id: runId,
              claim_nonce: claim.nonce ?? null,
              existing_claim_id: existing?.id ?? null,
            },
          });
          throw serviceError(
            'run_already_reported',
            `run ${runId} already has a reported claim`,
            { runId, existingClaimId: existing?.id ?? null },
          );
        }

        if (run.state !== 'running') {
          rejectTransition('run', run.state, 'reported', {
            runId,
            actor,
            reason: 'claim_requires_running_run',
            guard: 'G09',
            idempotencyKey,
          });
        }
        if (task.state !== 'running') {
          rejectTransition('task', task.state, 'accepting', {
            taskId: task.id,
            actor,
            reason: 'claim_requires_running_task',
            guard: 'G09',
            idempotencyKey,
          });
        }

        validateExecutionClaim(claim, task);
        const at = now();
        const subject = buildSubject(claim);
        const subjectFingerprint = hashValue(subject);
        const claimRecord = store.createClaim({
          id: newId('claim'),
          taskId: task.id,
          runId,
          stage: task.level,
          revision: task.revision,
          nonce: claim.nonce,
          commit: claim.commit.toLowerCase(),
          dirty: claim.dirty,
          manifest: clone(claim.manifest),
          subject: clone(subject),
          subjectFingerprint,
          summary: claim.summary ?? null,
          validationState: 'valid',
          createdAt: at,
        });

        const acceptance = openAcceptance({
          task,
          runId,
          subjectFingerprint,
          items: acceptanceItems ?? task.acceptanceProfile?.items,
          actor,
          source: 'claim',
        });

        const updatedRun = applyRunTransition(run, 'reported', {
          actor,
          patch: {
            claimId: claimRecord.id,
            subjectFingerprint,
            sealedAt: at,
            endedAt: at,
          },
        });
        recordEvent('claim.recorded', {
          runId,
          taskId: task.id,
          actor,
          payload: { claim_id: claimRecord.id, subject_fingerprint: subjectFingerprint },
        });
        recordEvent('run.sealed', {
          runId,
          taskId: task.id,
          actor,
          payload: { sealed_at: at, subject_fingerprint: subjectFingerprint },
        });
        const updatedTask = applyTaskTransition(task, 'accepting', {
          // T-12: the service records the executor claim and applies the task
          // projection; the claim itself never moves a task state (PRD G03/G30).
          actor: ACTORS.SYSTEM,
          cause: `claim:${normalizeActor(actor)}`,
          patch: {
            openAcceptanceId: acceptance.id,
            subject: clone(subject),
            subjectFingerprint,
          },
        });
        return {
          task: updatedTask,
          run: updatedRun,
          acceptance,
          claim: claimRecord,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Acceptance decisions
  // ---------------------------------------------------------------------------

  function mergeAcceptanceItems(acceptance, updates) {
    if (!updates) return clone(acceptance.items);
    const byKey = new Map();
    if (Array.isArray(updates)) {
      for (const entry of updates) {
        if (entry && typeof entry.key === 'string') byKey.set(entry.key, entry);
      }
    } else if (typeof updates === 'object') {
      for (const [key, entry] of Object.entries(updates)) {
        byKey.set(key, typeof entry === 'string' ? { state: entry } : { ...(entry ?? {}), key });
      }
    }
    return acceptance.items.map((item) => {
      const update = byKey.get(item.key);
      if (!update) return item;
      return { ...item, ...clone(update), key: item.key };
    });
  }

  function decideAcceptance({
    acceptanceId,
    verdict,
    itemStates,
    actor = ACTORS.ACCEPTANCE,
    idempotencyKey,
    reviewer = null,
    reason = null,
  } = {}) {
    const normalizedVerdict = String(verdict ?? '').toLowerCase();
    if (!['pass', 'revise', 'fail', 'block', 'blocked', 'void'].includes(normalizedVerdict)) {
      throw serviceError('validation_error', `unknown acceptance verdict: ${verdict}`, { verdict });
    }
    return idempotent(
      'acceptance_decision',
      idempotencyKey,
      { acceptanceId, verdict: normalizedVerdict, itemStates, reviewer },
      () => {
        const acceptance = requireAcceptance(acceptanceId);
        const actorName = normalizeActor(actor);
        if (!ACCEPTANCE_DECISION_ACTORS.has(actorName)) {
          recordEvent('security.forbidden_transition', {
            acceptanceId,
            taskId: acceptance.taskId,
            actor: actorName,
            payload: { actor: actorName, guard: 'G29', reason: 'acceptance_service_only' },
          });
          throw serviceError(
            'forbidden_transition',
            'only the acceptance service may decide an acceptance round',
            { actor: actorName, acceptanceId },
            403,
          );
        }
        if (acceptance.state !== 'open') {
          throw serviceError(
            'invalid_state_transition',
            `acceptance ${acceptanceId} is not open`,
            { acceptanceId, state: acceptance.state, guard: 'G20' },
          );
        }

        const task = requireTask(acceptance.taskId);
        if (task.state !== 'accepting') {
          rejectTransition('task', task.state, 'completed', {
            taskId: task.id,
            actor: actorName,
            reason: 'acceptance_decision_requires_accepting_task',
            guard: 'G10',
          });
        }

        const at = now();
        const items = mergeAcceptanceItems(acceptance, itemStates);
        const decisionPatch = {
          items,
          decidedAt: at,
          decidedBy: actorName,
          reason,
          reviewer: clone(reviewer),
        };

        // G12: the subject must still match at decision time; drift voids the round.
        if (acceptance.subjectFingerprint !== task.subjectFingerprint) {
          const voided = applyAcceptanceTransition(acceptance, 'void', {
            actor: actorName,
            reason: 'subject_drift',
            patch: { ...decisionPatch, decidedAt: at },
          });
          if (acceptance.runId) {
            const run = store.getRun(acceptance.runId);
            if (run && run.state === 'reported') {
              applyRunTransition(run, 'invalidated', {
                actor: actorName,
                patch: { endedAt: at, failureReason: 'subject_drift' },
              });
            }
          }
          const updatedTask = applyTaskTransition(task, 'running', {
            actor: actorName,
            patch: { openAcceptanceId: null },
          });
          return { voided: true, acceptance: voided, task: updatedTask };
        }

        if (normalizedVerdict === 'pass') {
          const missing = items.filter((item) => item.required && item.state !== 'pass');
          if (missing.length > 0) {
            recordEvent('acceptance.incomplete', {
              acceptanceId,
              taskId: task.id,
              actor: actorName,
              payload: { missing_items: missing.map((item) => item.key), guard: 'G11' },
            });
            throw serviceError(
              'acceptance_incomplete',
              'all required acceptance items must pass before a passing verdict',
              { acceptanceId, missingItems: missing.map((item) => item.key), guard: 'G11' },
            );
          }
          if (task.level === 'goal') {
            const signoff = items.find((item) => item.key === 'human.goal_signoff');
            if (!signoff || signoff.state !== 'pass' || !isHumanSigned(signoff)) {
              throw serviceError(
                'missing_acceptance',
                'goal acceptance requires a signed human.goal_signoff item',
                { acceptanceId, taskId: task.id, reason: 'human_signoff_missing', guard: 'G31' },
              );
            }
          }

          const passed = applyAcceptanceTransition(acceptance, 'passed', {
            actor: actorName,
            reason: reason ?? 'all_required_pass',
            patch: decisionPatch,
          });

          if (acceptance.runId) {
            const run = store.getRun(acceptance.runId);
            if (run && run.state === 'reported') {
              applyRunTransition(run, 'accepted', {
                actor: actorName,
                patch: { endedAt: at, acceptanceId: passed.id },
              });
            }
          }

          const completed = applyTaskTransition(task, 'completed', {
            actor: actorName,
            patch: {
              terminalAt: at,
              openAcceptanceId: null,
              lastAcceptanceId: passed.id,
            },
          });
          return { task: completed, acceptance: passed, verdict: 'pass' };
        }

        if (normalizedVerdict === 'revise') {
          const revised = applyAcceptanceTransition(acceptance, 'revise', {
            actor: actorName,
            reason: reason ?? 'fixable_failures',
            patch: decisionPatch,
          });
          if (acceptance.runId) {
            const run = store.getRun(acceptance.runId);
            if (run && run.state === 'reported') {
              applyRunTransition(run, 'rejected', {
                actor: actorName,
                patch: { endedAt: at, rejectionReason: reason ?? 'revise' },
              });
            }
          }
          const reworking = applyTaskTransition(task, 'reworking', {
            actor: actorName,
            patch: {
              revision: task.revision + 1,
              subject: null,
              subjectFingerprint: null,
              openAcceptanceId: null,
              lastAcceptanceId: revised.id,
            },
          });
          const reworkRun = store.createRun({
            id: newId('run'),
            taskId: task.id,
            state: 'queued',
            stateVersion: 1,
            attemptNo: store.listRuns({ taskId: task.id }).length + 1,
            kind: 'rework',
            executorKind: task.executorKind ?? 'dsh_session',
            fencingToken: 1,
            idempotencyKey: null,
            dispatch: null,
            lease: null,
            claimId: null,
            subjectFingerprint: null,
            sealedAt: null,
            endedAt: null,
            failureReason: null,
            supersededBy: null,
            cancelRequestedAt: null,
            stopUnknown: false,
            startedAt: null,
            createdAt: at,
            updatedAt: at,
          });
          recordEvent('run.created', {
            taskId: task.id,
            runId: reworkRun.id,
            actor: actorName,
            payload: { attempt_no: reworkRun.attemptNo, kind: 'rework' },
          });
          const withRun = store.updateTask(
            reworking.id,
            { currentRunId: reworkRun.id, updatedAt: at },
            { expectedStateVersion: reworking.stateVersion },
          );
          return {
            task: withRun,
            acceptance: revised,
            reworkRun,
            verdict: 'revise',
          };
        }

        const acceptanceState =
          normalizedVerdict === 'fail'
            ? 'failed'
            : normalizedVerdict === 'void'
              ? 'void'
              : 'blocked';
        const closed = applyAcceptanceTransition(acceptance, acceptanceState, {
          actor: actorName,
          reason: reason ?? normalizedVerdict,
          patch: decisionPatch,
        });
        if (acceptance.runId) {
          const run = store.getRun(acceptance.runId);
          if (run && run.state === 'reported') {
            const runState = acceptanceState === 'void' ? 'invalidated' : 'rejected';
            applyRunTransition(run, runState, {
              actor: actorName,
              patch: {
                endedAt: at,
                rejectionReason: acceptanceState === 'void' ? null : reason ?? normalizedVerdict,
              },
            });
          }
        }

        let updatedTask;
        if (acceptanceState === 'void') {
          updatedTask = applyTaskTransition(task, 'running', {
            actor: actorName,
            patch: { openAcceptanceId: null },
          });
        } else {
          updatedTask = applyTaskTransition(task, 'blocked', {
            actor: actorName,
            patch: {
              openAcceptanceId: null,
              blockedReason:
                acceptanceState === 'blocked'
                  ? reason ?? 'review_unavailable'
                  : reason ?? 'acceptance_failed',
            },
          });
        }
        return { task: updatedTask, acceptance: closed, verdict: acceptanceState };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  function completeTask({
    taskId,
    actor = ACTORS.SYSTEM,
    idempotencyKey,
    expectedStateVersion,
  } = {}) {
    return idempotent('complete', idempotencyKey, { taskId }, () => {
      const task = requireTask(taskId);
      if (task.state === 'completed') {
        return { task, completed: true, alreadyCompleted: true };
      }
      // G30: completion only recognises the task's own level pass.
      const passed = findPassedAcceptance(task);
      assertCompletionGuards(task, passed, actor);
      if (task.state !== 'accepting') {
        rejectTransition('task', task.state, 'completed', {
          taskId,
          actor,
          reason: 'completion_requires_accepting_task',
          guard: 'G30',
          idempotencyKey,
        });
      }
      const at = now();
      const completed = applyTaskTransition(task, 'completed', {
        actor,
        expectedStateVersion,
        patch: {
          terminalAt: at,
          openAcceptanceId: null,
          lastAcceptanceId: passed.id,
        },
      });
      return { task: completed, completed: true, acceptance: passed };
    });
  }

  // ---------------------------------------------------------------------------
  // Parent readiness (business/goal)
  // ---------------------------------------------------------------------------

  function claimReadiness({
    taskId,
    claim = {},
    acceptanceItems,
    actor = ACTORS.BOT,
    idempotencyKey,
  } = {}) {
    return idempotent(
      'readiness_claim',
      idempotencyKey,
      { taskId, claim, acceptanceItems },
      () => {
        const task = requireTask(taskId);
        if (!['business', 'goal'].includes(task.level)) {
          throw serviceError('validation_error', 'readiness claims apply to business/goal tasks', {
            taskId,
            level: task.level,
          });
        }
        if (task.state === 'accepting') {
          return { task, acceptance: requireOpenAcceptance(task) };
        }
        if (task.state !== 'running') {
          rejectTransition('task', task.state, 'accepting', {
            taskId,
            actor,
            reason: 'readiness_requires_running_task',
            guard: 'G28',
            idempotencyKey,
          });
        }

        const children = store.listTasks({ parentTaskId: taskId });
        if (children.length === 0) {
          throw serviceError(
            'invalid_state_transition',
            `task ${taskId} has no children to gate on`,
            { taskId, guard: 'G28', reason: 'no_children' },
          );
        }
        const activeChildren = children.filter((child) =>
          ['queued', 'running', 'accepting', 'stopping'].includes(child.state),
        );
        if (activeChildren.length > 0) {
          throw serviceError(
            'invalid_state_transition',
            'cannot open a parent acceptance while children are active',
            {
              taskId,
              guard: 'G35',
              activeChildren: activeChildren.map((child) => child.id),
            },
          );
        }
        const notCompleted = children.filter((child) => child.state !== 'completed');
        const missingAcceptance = children.filter((child) => !findPassedAcceptance(child));
        if (notCompleted.length > 0 || missingAcceptance.length > 0) {
          throw serviceError(
            'invalid_state_transition',
            'all required children must be completed with a current passed acceptance',
            {
              taskId,
              guard: 'G28',
              incompleteChildren: notCompleted.map((child) => child.id),
              missingChildAcceptance: missingAcceptance.map((child) => child.id),
            },
          );
        }

        if (Array.isArray(claim.childAcceptanceIds)) {
          const known = new Set(
            children
              .flatMap((child) => store.listAcceptances({ taskId: child.id, state: 'passed' }))
              .filter((acceptance) => !acceptance.supersededAt)
              .map((acceptance) => acceptance.id),
          );
          const unknown = claim.childAcceptanceIds.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            throw serviceError(
              'claim_invalid',
              'readiness claim references unknown child acceptances',
              { taskId, unknown, guard: 'G09' },
            );
          }
        }

        const subject = {
          children: children
            .map((child) => ({
              taskId: child.id,
              subjectFingerprint: child.subjectFingerprint,
            }))
            .sort((left, right) => left.taskId.localeCompare(right.taskId)),
        };
        const subjectFingerprint = hashValue(subject);
        const at = now();
        const acceptance = openAcceptance({
          task: { ...task, revision: task.revision },
          subjectFingerprint,
          items: acceptanceItems ?? task.acceptanceProfile?.items,
          actor,
          source: 'readiness_claim',
        });
        const readinessClaim = store.createClaim({
          id: newId('claim'),
          taskId,
          runId: null,
          stage: task.level,
          revision: task.revision,
          nonce: claim.nonce ?? newId('nonce'),
          commit: null,
          dirty: false,
          manifest: [],
          subject: clone(subject),
          subjectFingerprint,
          summary: claim.summary ?? null,
          validationState: 'valid',
          childAcceptanceIds: clone(claim.childAcceptanceIds ?? []),
          createdAt: at,
        });
        recordEvent('children.gate_passed', {
          taskId,
          actor,
          payload: {
            children: children.map((child) => child.id),
            subject_fingerprint: subjectFingerprint,
          },
        });
        recordEvent('claim.recorded', {
          taskId,
          actor,
          payload: {
            claim_id: readinessClaim.id,
            stage: task.level,
            subject_fingerprint: subjectFingerprint,
          },
        });
        const accepting = applyTaskTransition(task, 'accepting', {
          actor,
          patch: {
            openAcceptanceId: acceptance.id,
            subject: clone(subject),
            subjectFingerprint,
          },
        });
        return { task: accepting, acceptance, claim: readinessClaim };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Stop cascade
  // ---------------------------------------------------------------------------

  function collectSubtree(root) {
    const result = [root];
    const queue = [root];
    while (queue.length > 0) {
      const parent = queue.shift();
      for (const child of store.listTasks({ parentTaskId: parent.id })) {
        result.push(child);
        queue.push(child);
      }
    }
    return result;
  }

  function depthOf(task) {
    let depth = 0;
    let cursor = task.parentTaskId ? store.getTask(task.parentTaskId) : null;
    while (cursor) {
      depth += 1;
      cursor = cursor.parentTaskId ? store.getTask(cursor.parentTaskId) : null;
    }
    return depth;
  }

  function requestStop({
    taskId,
    requestedBy = ACTORS.HUMAN,
    reason = 'user_stop',
    idempotencyKey,
  } = {}) {
    return idempotent('stop_request', idempotencyKey, { taskId, requestedBy, reason }, () => {
      const task = requireTask(taskId);
      if (task.state === 'stopping') {
        return { task, tasks: collectSubtree(task), stopState: task.stopState ?? 'requested' };
      }
      if (task.state === 'cancelled') {
        return { task, tasks: collectSubtree(task), stopState: 'verified', alreadyCancelled: true };
      }
      if (isTaskTerminal(task.state) || !TASK_STOPPABLE_STATES.includes(task.state)) {
        rejectTransition('task', task.state, 'stopping', {
          taskId,
          actor: requestedBy,
          reason: 'stop_requires_non_terminal_task',
          guard: 'G15',
          idempotencyKey,
        });
      }

      const at = now();
      const subtree = collectSubtree(task);
      const stopped = [];
      for (const current of subtree) {
        if (current.state === 'cancelled' || current.state === 'completed') {
          stopped.push(current);
          continue;
        }
        if (current.state === 'stopping') {
          // Already frozen (e.g. a child stop was requested first). Keep the
          // first stop metadata and only make sure its runs got the cancel.
          for (const run of store.listActiveRuns(current.id)) {
            if (run.cancelRequestedAt !== null) continue;
            const patched = store.updateRun(
              run.id,
              {
                cancelRequestedAt: at,
                fencingToken: run.fencingToken + 1,
                stopUnknown: false,
                updatedAt: at,
              },
              { expectedStateVersion: run.stateVersion },
            );
            recordEvent('run.cancel_requested', {
              runId: patched.id,
              taskId: current.id,
              actor: requestedBy,
              payload: { cancel_requested_at: at, fencing_token: patched.fencingToken },
            });
          }
          stopped.push(current);
          continue;
        }
        const open = requireOpenAcceptance(current);
        if (open) {
          applyAcceptanceTransition(open, 'void', {
            actor: requestedBy,
            reason: 'project_stopped',
            patch: { decidedAt: at, decidedBy: normalizeActor(requestedBy) },
          });
        }
        const updated = applyTaskTransition(current, 'stopping', {
          actor: requestedBy,
          patch: {
            stopState: 'requested',
            stopRequestedAt: at,
            stopRequestedBy: normalizeActor(requestedBy),
            stopReason: reason,
            stopUnknown: false,
            openAcceptanceId: null,
          },
        });
        for (const run of store.listActiveRuns(current.id)) {
          const patched = store.updateRun(
            run.id,
            {
              cancelRequestedAt: at,
              fencingToken: run.fencingToken + 1,
              stopUnknown: false,
              updatedAt: at,
            },
            { expectedStateVersion: run.stateVersion },
          );
          recordEvent('run.cancel_requested', {
            runId: patched.id,
            taskId: current.id,
            actor: requestedBy,
            payload: { cancel_requested_at: at, fencing_token: patched.fencingToken },
          });
        }
        stopped.push(updated);
      }
      return { task: stopped.find((entry) => entry.id === task.id) ?? task, tasks: stopped, stopState: 'requested' };
    });
  }

  function evaluateStopVerification(verification, minQuiescenceMs) {
    const reasons = [];
    if (!verification) {
      return { verified: false, reasons: ['missing_stop_verification'] };
    }
    if (verification.processGone !== true) reasons.push('process_still_alive');
    if (verification.cancelAck !== true && verification.processGone !== true) {
      reasons.push('no_cancel_ack');
    }
    const windowMs =
      verification.quiescenceWindowMs ??
      (typeof verification.quiescenceWindowS === 'number'
        ? verification.quiescenceWindowS * 1000
        : 0);
    if (!(windowMs >= minQuiescenceMs)) reasons.push('quiescence_window_too_short');
    const windowStart = verification.windowStartedAt;
    if (typeof windowStart !== 'number') {
      reasons.push('missing_window_start');
    }
    if (typeof verification.lastWriteAt !== 'number') {
      reasons.push('missing_last_write_at');
    } else if (typeof windowStart === 'number' && !(verification.lastWriteAt < windowStart)) {
      reasons.push('write_inside_quiescence_window');
    }
    if (verification.namespaceHashBefore == null || verification.namespaceHashAfter == null) {
      reasons.push('missing_namespace_hash');
    } else if (verification.namespaceHashBefore !== verification.namespaceHashAfter) {
      reasons.push('namespace_changed');
    }
    if ((verification.openFileHandles ?? 0) > 0) reasons.push('open_file_handles');
    return { verified: reasons.length === 0, reasons };
  }

  function verifyStop({
    taskId,
    verifications = [],
    force = false,
    decisionToken = null,
    deadlinePassed = false,
    minQuiescenceMs = DEFAULT_STOP_QUIESCENCE_MS,
    actor = ACTORS.SYSTEM,
    idempotencyKey,
  } = {}) {
    return idempotent(
      'stop_verify',
      idempotencyKey,
      { taskId, verifications, force, decisionToken, deadlinePassed },
      () => {
        const root = requireTask(taskId);
        if (root.state === 'cancelled') {
          return { cancelled: true, stopState: root.stopState ?? 'verified', blockers: [] };
        }
        if (root.state !== 'stopping') {
          rejectTransition('task', root.state, 'cancelled', {
            taskId,
            actor,
            reason: 'stop_verification_requires_stopping_task',
            guard: 'G32',
            idempotencyKey,
          });
        }

        const at = now();
        const subtree = collectSubtree(root).filter((task) => task.state === 'stopping');
        const byRun = new Map(verifications.map((verification) => [verification.runId, verification]));
        const checks = [];
        for (const task of subtree) {
          for (const run of store.listActiveRuns(task.id)) {
            if (run.state === 'queued') {
              // No executor ever held a queued run: it only needs cancellation,
              // not a quiescence proof (PRD 03 §5.2.1 step 5).
              checks.push({
                task,
                run,
                verification: null,
                verified: true,
                reasons: [],
                noExecutor: true,
              });
              continue;
            }
            const evaluation = evaluateStopVerification(byRun.get(run.id), minQuiescenceMs);
            checks.push({ task, run, verification: byRun.get(run.id) ?? null, ...evaluation });
          }
        }
        const sealedRuns = subtree.flatMap((task) =>
          store.listRuns({ taskId: task.id, state: 'reported' }),
        );
        const blockers = checks
          .filter((check) => !check.verified)
          .map((check) => ({
            runId: check.run.id,
            taskId: check.task.id,
            reasons: check.reasons,
          }));

        if (blockers.length === 0) {
          for (const check of checks) {
            store.appendStopVerification({
              taskId: check.task.id,
              runId: check.run.id,
              verdict: 'verified',
              reasons: [],
              detail: clone(check.verification),
              at,
            });
            if (ACTIVE_RUN_STATES.includes(check.run.state)) {
              applyRunTransition(check.run, 'cancelled', {
                actor,
                verifiedStop: true,
                patch: { endedAt: at, stopUnknown: false },
              });
            }
          }
          for (const run of sealedRuns) {
            applyRunTransition(run, 'cancelled', {
              actor,
              verifiedStop: true,
              patch: { endedAt: at, stopUnknown: false },
            });
          }
          const ordered = [...subtree].sort((left, right) => depthOf(right) - depthOf(left));
          const cancelledTasks = [];
          for (const task of ordered) {
            const current = requireTask(task.id);
            if (current.state !== 'stopping') continue;
            const cancelled = applyTaskTransition(current, 'cancelled', {
              actor,
              verifiedStop: true,
              patch: {
                stopState: 'verified',
                stopUnknown: false,
                stopVerifiedAt: at,
                terminalAt: at,
                openAcceptanceId: null,
              },
            });
            recordEvent('task.stop_verified', {
              taskId: current.id,
              actor,
              payload: { stop_state: 'verified', cancelled_at: at },
            });
            cancelledTasks.push(cancelled);
          }
          return {
            cancelled: true,
            stopState: 'verified',
            blockers: [],
            tasks: cancelledTasks,
          };
        }

        for (const check of blockers) {
          store.appendStopVerification({
            taskId: check.taskId,
            runId: check.runId,
            verdict: 'stop_unknown',
            reasons: check.reasons,
            detail: clone(byRun.get(check.runId) ?? null),
            at,
          });
        }

        const forced =
          force === true &&
          typeof decisionToken === 'string' &&
          decisionToken.trim() !== '';
        if (forced) {
          const ordered = [...subtree].sort((left, right) => depthOf(right) - depthOf(left));
          const cancelledTasks = [];
          for (const task of ordered) {
            const current = requireTask(task.id);
            if (current.state !== 'stopping') continue;
            const cancelled = applyTaskTransition(current, 'cancelled', {
              actor,
              verifiedStop: true,
              patch: {
                stopState: 'forced',
                stopUnknown: true,
                unsafeStop: true,
                terminalAt: at,
                openAcceptanceId: null,
              },
            });
            recordEvent('security.stop_unverified', {
              taskId: current.id,
              actor,
              payload: {
                forced: true,
                unsafe_stop: true,
                stop_state: 'forced',
                blockers,
              },
            });
            cancelledTasks.push(cancelled);
          }
          return {
            cancelled: true,
            stopState: 'forced',
            unsafeStop: true,
            blockers,
            tasks: cancelledTasks,
          };
        }

        const updatedTasks = [];
        for (const task of subtree) {
          if (deadlinePassed) {
            const blocked = applyTaskTransition(task, 'blocked', {
              actor,
              patch: {
                blockedReason: 'stop_unverified',
                stopState: 'failed',
                stopUnknown: true,
                openAcceptanceId: null,
              },
            });
            updatedTasks.push(blocked);
          } else {
            const updated = store.updateTask(
              task.id,
              {
                stopState: 'stop_unknown',
                stopUnknown: true,
                updatedAt: at,
              },
              { expectedStateVersion: task.stateVersion },
            );
            updatedTasks.push(updated);
          }
        }
        return {
          cancelled: false,
          stopState: deadlinePassed ? 'failed' : 'stop_unknown',
          blockers,
          tasks: updatedTasks,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Read helpers / generic entry points
  // ---------------------------------------------------------------------------

  function transitionTask({
    taskId,
    to,
    actor = ACTORS.SYSTEM,
    expectedStateVersion,
    idempotencyKey,
    patch = {},
    cause = null,
  } = {}) {
    return idempotent(
      'task_transition',
      idempotencyKey,
      { taskId, to, expectedStateVersion, patch },
      () => ({
        task: applyTaskTransition(requireTask(taskId), to, {
          actor,
          expectedStateVersion,
          idempotencyKey,
          patch,
          cause,
        }),
      }),
    );
  }

  function transitionRun({
    runId,
    to,
    actor = ACTORS.SYSTEM,
    patch = {},
    verifiedStop = false,
    idempotencyKey,
  } = {}) {
    return idempotent('run_transition', idempotencyKey, { runId, to, patch }, () => ({
      run: applyRunTransition(requireRun(runId), to, {
        actor,
        patch,
        verifiedStop,
        idempotencyKey,
      }),
    }));
  }

  return {
    store,
    clock: now,
    createTask,
    queueTask,
    dispatchTask,
    ackRun,
    claimRun,
    claimReadiness,
    decideAcceptance,
    completeTask,
    requestStop,
    verifyStop,
    transitionTask,
    transitionRun,
    getTask: (taskId) => requireTask(taskId),
    getRun: (runId) => requireRun(runId),
    getAcceptance: (acceptanceId) => requireAcceptance(acceptanceId),
    listEvents: (filter) => store.listEvents(filter ?? {}),
    listClaims: (filter) => store.listClaims(filter ?? {}),
    listRuns: (filter) => store.listRuns(filter ?? {}),
    listAcceptances: (filter) => store.listAcceptances(filter ?? {}),
    listStopVerifications: (filter) => store.listStopVerifications(filter ?? {}),
  };
}

export { ServiceError, serviceError };
export { createMemoryStore };
export { RUN_RETRYABLE_STATES };
