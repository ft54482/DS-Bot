import {
  ACTIVE_RUN_STATES,
  DEFAULT_POLICY,
  IDLE_EXECUTOR_STATES,
  LIVE_EXECUTOR_STATES,
  TERMINAL_RUN_STATES,
} from './policy.js';
import {
  firstFinite,
  firstString,
  firstTime,
  isRecord,
  lower,
  parseTime,
  toIso,
  toList,
} from './normalize.js';

const ACTIVE_SET = new Set(ACTIVE_RUN_STATES);
const TERMINAL_SET = new Set(TERMINAL_RUN_STATES);
const LIVE_SET = new Set(LIVE_EXECUTOR_STATES);
const IDLE_SET = new Set(IDLE_EXECUTOR_STATES);

const AMBIGUOUS_OUTBOX_STATES = new Set(['sending', 'sent', 'unknown']);
const DISPATCH_OUTBOX_INTENTS = new Set([
  'dispatch_run',
  'dispatch',
  'run_dispatch',
]);
const NOT_DISPATCHED_RUN_STATES = new Set(['planned', 'created', 'queued']);

/**
 * Build a crash-recovery plan for a restarted service.
 *
 * This is a **read-only planning step**: it performs no network calls, opens no
 * database and never mutates its input. The caller decides how to apply the
 * plan (update the run/outbox rows, append events) in its own transaction.
 *
 * Input (`runtime`, normally mapped from the restored store):
 *
 *   runs:       [{ id, task_id, state, heartbeat_at?, started_at?,
 *                  dispatched_at?, created_at?, updated_at?, lease_until? }]
 *   outbox:     [{ id, run_id, intent, state, send_started_at? }]
 *   worktrees:  [{ path, ticket_id?, task_id?, run_id?, state? }]
 *   tickets:    [{ id }] or ['ticket-id']   (snapshot of known tickets/tasks)
 *   policy:     { heartbeat_stall_ms }
 *   now:        epoch ms | ISO-8601 | Date
 *
 * `executorProbe(run)` is an optional **synchronous** observation callback. It
 * answers "is this attempt still alive on the executor?" with
 * `{ queryable: boolean, running?: boolean, state?: string }` (aliases such as
 * `reachable`, `active`, `status`, `found` are accepted). Anything it cannot
 * prove is treated as lost, never as safe to re-dispatch.
 *
 * Result:
 *
 *   {
 *     redispatch: [...], // safe to send again (outbox never sent / executor idle)
 *     markLost:   [...], // cannot prove liveness or delivery: mark lost only
 *     orphans:    [...], // worktree without a ticket; reported, never deleted
 *     kept:       [...]  // terminal, queued, live or otherwise untouched entries
 *   }
 *
 * Every entry carries a stable `idempotency_key`; lost and orphan entries also
 * carry the event descriptor the caller should append. Two calls over the same
 * snapshot are deeply equal, so a second restart does not add new actions.
 *
 * @param {{ runtime: object, executorProbe?: Function, now?: number|string|Date|Function }} input
 */
export function reconcile({ runtime, executorProbe, now } = {}) {
  if (!isRecord(runtime)) {
    throw new TypeError('reconcile requires a runtime object');
  }
  if (
    executorProbe !== undefined &&
    executorProbe !== null &&
    typeof executorProbe !== 'function'
  ) {
    throw new TypeError('reconcile executorProbe must be a function when provided');
  }

  const at = resolveNow(now, runtime);
  const policy = resolvePolicy(runtime);
  const runs = normalizeRuns(runtime.runs);
  const outbox = normalizeOutbox(
    runtime.dispatch_outbox ??
      runtime.dispatchOutbox ??
      runtime.outbox ??
      runtime.pending_outbox ??
      runtime.pendingOutbox,
  );
  const worktrees = normalizeWorktrees(runtime.worktrees);
  const tickets = collectTickets(runtime.tickets ?? runtime.tasks);

  const outboxByRun = indexOutbox(outbox);
  const redispatch = [];
  const markLost = [];
  const orphans = [];
  const kept = [];

  const orderedRuns = runs.slice().sort((left, right) => left.id.localeCompare(right.id));
  for (const run of orderedRuns) {
    decideRun({
      run,
      at,
      policy,
      outboxes: outboxByRun.get(run.id) ?? [],
      executorProbe,
      redispatch,
      markLost,
      kept,
    });
  }

  const orderedWorktrees = worktrees
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const worktree of orderedWorktrees) {
    decideWorktree({ worktree, tickets, at, orphans, kept });
  }

  return { redispatch, markLost, orphans, kept };
}

/**
 * Flatten the event descriptors of a plan, in bucket order.
 *
 * `reconcile` never appends events itself. This helper lets the caller count
 * what it is about to write (for example "one `run.lost` per lost run") without
 * understanding every bucket entry shape.
 */
export function collectEvents(result) {
  if (!isRecord(result)) {
    throw new TypeError('collectEvents requires a reconcile result');
  }
  const events = [];
  for (const bucket of ['redispatch', 'markLost', 'orphans']) {
    const entries = result[bucket];
    if (!Array.isArray(entries)) {
      throw new TypeError(`reconcile result.${bucket} must be an array`);
    }
    for (const entry of entries) {
      if (isRecord(entry) && isRecord(entry.event)) events.push(entry.event);
    }
  }
  return events;
}

function resolveNow(nowValue, runtime) {
  let value = nowValue;
  if (typeof value === 'function') value = value();
  if (value === undefined || value === null) {
    value = runtime.now;
    if (typeof value === 'function') value = value();
  }
  if (value === undefined || value === null) value = Date.now();
  const at = parseTime(value);
  if (at === null) {
    throw new TypeError(
      'reconcile requires a valid now (epoch milliseconds, ISO-8601 string, Date, or function)',
    );
  }
  return at;
}

function resolvePolicy(runtime) {
  const policy = isRecord(runtime.policy) ? runtime.policy : {};
  const reliability = isRecord(runtime.reliability) ? runtime.reliability : {};
  const threshold = firstFinite(
    policy.heartbeat_stall_ms,
    policy.heartbeatStallMs,
    reliability.heartbeat_stall_ms,
    reliability.heartbeatStallMs,
    runtime.heartbeat_stall_ms,
    runtime.heartbeatStallMs,
  );
  return {
    heartbeat_stall_ms:
      threshold !== null && threshold >= 0
        ? threshold
        : DEFAULT_POLICY.heartbeat_stall_ms,
  };
}

function normalizeRuns(value) {
  const seen = new Set();
  return toList(value, 'runs').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runtime.runs[${index}] must be an object`);
    }
    const id = firstString(entry.id, entry.run_id, entry.runId);
    if (id === null) {
      throw new TypeError(`runtime.runs[${index}].id is required`);
    }
    if (seen.has(id)) {
      throw new TypeError(`runtime.runs contains duplicate id ${id}`);
    }
    seen.add(id);

    return {
      id,
      taskId: firstString(entry.task_id, entry.taskId),
      state: lower(firstString(entry.state, entry.status)),
      heartbeatAt: firstTime(
        entry.heartbeat_at,
        entry.heartbeatAt,
        entry.last_heartbeat_at,
        entry.lastHeartbeatAt,
        entry.last_heartbeat,
        entry.lastHeartbeat,
        entry.heartbeat,
      ),
      leaseUntil: firstTime(entry.lease_until, entry.leaseUntil),
      startedAt: firstTime(entry.started_at, entry.startedAt),
      dispatchedAt: firstTime(
        entry.dispatched_at,
        entry.dispatchedAt,
        entry.dispatch_ack_at,
        entry.dispatchAckAt,
      ),
      createdAt: firstTime(entry.created_at, entry.createdAt),
      updatedAt: firstTime(entry.updated_at, entry.updatedAt),
    };
  });
}

function normalizeOutbox(value) {
  return toList(value, 'outbox').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runtime.outbox[${index}] must be an object`);
    }
    return {
      id:
        firstString(entry.id, entry.outbox_id, entry.outboxId) ??
        `outbox:${index + 1}`,
      runId: firstString(entry.run_id, entry.runId),
      taskId: firstString(entry.task_id, entry.taskId),
      intent: lower(firstString(entry.intent)),
      state: lower(firstString(entry.state, entry.status)),
      sendStartedAt: firstTime(
        entry.send_started_at,
        entry.sendStartedAt,
        entry.sent_at,
        entry.sentAt,
      ),
      attempts: firstFinite(entry.attempts) ?? 0,
      idempotencyKey: firstString(entry.idempotency_key, entry.idempotencyKey),
    };
  });
}

function normalizeWorktrees(value) {
  const seen = new Set();
  return toList(value, 'worktrees').map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`runtime.worktrees[${index}] must be an object`);
    }
    const path = firstString(...worktreePathAliases(entry));
    if (path === null) {
      throw new TypeError(`runtime.worktrees[${index}].path is required`);
    }
    if (seen.has(path)) {
      throw new TypeError(`runtime.worktrees contains duplicate path ${path}`);
    }
    seen.add(path);

    return {
      path,
      ticketId: firstString(
        entry.ticket_id,
        entry.ticketId,
        entry.ticket,
        entry.task_id,
        entry.taskId,
      ),
      runId: firstString(entry.run_id, entry.runId),
      state: lower(firstString(entry.state, entry.status)),
    };
  });
}

function worktreePathAliases(entry) {
  return [entry.path, entry.worktree_path, entry.worktreePath, entry.workspace_path, entry.workspacePath];
}

function collectTickets(value) {
  if (value === undefined || value === null) return null;
  const ids = new Set();
  for (const entry of toList(value, 'tickets')) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      ids.add(String(entry));
      continue;
    }
    if (!isRecord(entry)) continue;
    const id = firstString(
      entry.id,
      entry.ticket_id,
      entry.ticketId,
      entry.task_id,
      entry.taskId,
    );
    if (id !== null) ids.add(id);
  }
  return ids;
}

function indexOutbox(outbox) {
  const byRun = new Map();
  for (const entry of outbox) {
    if (entry.runId === null) continue;
    if (!byRun.has(entry.runId)) byRun.set(entry.runId, []);
    byRun.get(entry.runId).push(entry);
  }
  return byRun;
}

function decideRun({ run, at, policy, outboxes, executorProbe, redispatch, markLost, kept }) {
  if (run.state === null) {
    kept.push(keptRun(run, 'unknown_state'));
    return;
  }
  if (TERMINAL_SET.has(run.state)) {
    kept.push(keptRun(run, 'terminal_state'));
    return;
  }
  if (NOT_DISPATCHED_RUN_STATES.has(run.state)) {
    kept.push(keptRun(run, 'not_dispatched'));
    return;
  }
  if (run.state === 'cancelling') {
    // Stop verification owns this run; recovery must not re-dispatch it.
    kept.push(keptRun(run, 'stop_in_progress'));
    return;
  }
  if (!ACTIVE_SET.has(run.state)) {
    kept.push(keptRun(run, 'not_active'));
    return;
  }

  const liveness = assessLiveness(run, at, policy);
  if (!liveness.stale) {
    kept.push(keptRun(run, liveness.reason));
    return;
  }

  const outboxClass = classifyOutbox(outboxes);
  if (outboxClass.kind === 'unsent') {
    redispatch.push(
      makeRedispatch(run, at, 'outbox_never_sent', outboxClass.entry, null),
    );
    return;
  }
  if (outboxClass.kind === 'ambiguous') {
    markLost.push(
      makeMarkLost(run, at, policy, liveness, {
        reason: 'dispatch_ambiguous',
        proof: null,
        outbox: outboxClass.entry,
      }),
    );
    return;
  }
  if (outboxClass.kind === 'failed') {
    markLost.push(
      makeMarkLost(run, at, policy, liveness, {
        reason: 'dispatch_failed',
        proof: null,
        outbox: outboxClass.entry,
      }),
    );
    return;
  }

  const probe = runProbe(executorProbe, run);
  if (probe.kind === 'alive') {
    kept.push(keptRun(run, 'executor_alive'));
    return;
  }
  if (probe.kind === 'idle') {
    redispatch.push(
      makeRedispatch(run, at, 'heartbeat_stale_queryable_idle', outboxClass.entry, probe.detail),
    );
    return;
  }

  const reason =
    probe.kind === 'unqueryable'
      ? 'executor_unqueryable'
      : probe.kind === 'no_answer'
        ? 'executor_no_answer'
        : 'executor_state_unknown';
  markLost.push(
    makeMarkLost(run, at, policy, liveness, {
      reason,
      proof: probe.detail,
      outbox: outboxClass.entry,
    }),
  );
}

function decideWorktree({ worktree, tickets, at, orphans, kept }) {
  const ticketKnown =
    worktree.ticketId !== null &&
    (tickets === null || tickets.has(worktree.ticketId));

  if (ticketKnown) {
    kept.push({
      kind: 'worktree',
      id: worktree.path,
      path: worktree.path,
      ticket_id: worktree.ticketId,
      state: worktree.state,
      reason: 'worktree_tracked',
    });
    return;
  }

  const reason =
    worktree.ticketId === null
      ? 'worktree_without_ticket'
      : 'worktree_ticket_missing';

  // Orphans are reported only. There is deliberately no delete call anywhere in
  // this module: a worktree can be evidence, and PRD 05 forbids dropping it.
  orphans.push({
    kind: 'worktree',
    id: worktree.path,
    path: worktree.path,
    ticket_id: worktree.ticketId,
    run_id: worktree.runId,
    state: worktree.state,
    action: 'report_only',
    reason,
    deleted: false,
    event: {
      type: 'worktree.orphan',
      key: `worktree.orphan:${worktree.path}`,
      path: worktree.path,
      ticket_id: worktree.ticketId,
      reason,
      at: toIso(at),
    },
  });
}

function assessLiveness(run, now, policy) {
  if (run.leaseUntil !== null && run.leaseUntil > now) {
    return {
      stale: false,
      reason: 'lease_active',
      at: run.leaseUntil,
      field: 'lease_until',
      age: run.leaseUntil - now,
    };
  }

  const activity = runActivity(run);
  if (activity.at === null) {
    // No heartbeat, no start time, no creation time: nothing proves life.
    return { stale: true, reason: 'heartbeat_missing', at: null, field: null, age: null };
  }

  const age = now - activity.at;
  if (age > policy.heartbeat_stall_ms) {
    return {
      stale: true,
      reason:
        activity.field === 'heartbeat_at' ? 'heartbeat_stale' : 'heartbeat_missing',
      at: activity.at,
      field: activity.field,
      age,
    };
  }

  return {
    stale: false,
    reason:
      activity.field === 'heartbeat_at' ? 'heartbeat_fresh' : 'within_stall_window',
    at: activity.at,
    field: activity.field,
    age,
  };
}

function runActivity(run) {
  if (run.heartbeatAt !== null) {
    return { at: run.heartbeatAt, field: 'heartbeat_at' };
  }
  const candidates = [
    { at: run.startedAt, field: 'started_at' },
    { at: run.dispatchedAt, field: 'dispatched_at' },
    { at: run.createdAt, field: 'created_at' },
    { at: run.updatedAt, field: 'updated_at' },
  ].filter((candidate) => candidate.at !== null);

  if (candidates.length === 0) return { at: null, field: null };
  let latest = candidates[0];
  for (const candidate of candidates) {
    if (candidate.at > latest.at) latest = candidate;
  }
  return latest;
}

function classifyOutbox(outboxes) {
  const explicitDispatch = outboxes.filter((entry) =>
    DISPATCH_OUTBOX_INTENTS.has(entry.intent),
  );
  const unlabelled = outboxes.filter((entry) => entry.intent === null);
  // Only dispatch intents are evidence about whether the run was sent. A
  // pending cancel/stop row must not cause a re-dispatch. When a fixture omits
  // `intent` entirely, a single label-less row is treated as the dispatch row.
  const candidates =
    explicitDispatch.length > 0
      ? explicitDispatch
      : unlabelled.length === outboxes.length
        ? unlabelled
        : [];

  if (candidates.length === 0) return { kind: 'none', entry: null };

  const ambiguous = candidates.find((entry) =>
    AMBIGUOUS_OUTBOX_STATES.has(entry.state),
  );
  if (ambiguous) return { kind: 'ambiguous', entry: ambiguous };

  // A pending row with a send marker means T3 committed but the outcome was
  // never written. Treat it as "possibly sent" (PRD 04 §2.1.3).
  const pendingWithMarker = candidates.find(
    (entry) => entry.state === 'pending' && entry.sendStartedAt !== null,
  );
  if (pendingWithMarker) return { kind: 'ambiguous', entry: pendingWithMarker };

  const pending = candidates.find((entry) => entry.state === 'pending');
  const acked = candidates.find((entry) => entry.state === 'acked');
  if (pending && acked) {
    // Conflicting rows for one run: do not guess which intent is current.
    return { kind: 'ambiguous', entry: pending };
  }
  if (pending) return { kind: 'unsent', entry: pending };

  const failed = candidates.find((entry) => entry.state === 'failed');
  if (failed) return { kind: 'failed', entry: failed };

  return { kind: 'settled', entry: acked ?? candidates[0] };
}

function runProbe(executorProbe, run) {
  if (typeof executorProbe !== 'function') {
    return {
      kind: 'unqueryable',
      detail: {
        attempted: false,
        queryable: false,
        state: null,
        running: null,
        error: 'executorProbe not provided',
      },
    };
  }

  let result;
  try {
    result = executorProbe({
      run_id: run.id,
      task_id: run.taskId,
      state: run.state,
      heartbeat_at: toIso(run.heartbeatAt),
      started_at: toIso(run.startedAt),
      dispatched_at: toIso(run.dispatchedAt),
    });
  } catch (error) {
    return {
      kind: 'unqueryable',
      detail: {
        attempted: true,
        queryable: false,
        state: null,
        running: null,
        error: error?.message ?? String(error),
      },
    };
  }

  return classifyProbe(result);
}

function classifyProbe(result) {
  if (!isRecord(result)) {
    return {
      kind: 'no_answer',
      detail: {
        attempted: true,
        queryable: false,
        state: null,
        running: null,
        error: 'probe returned no observation',
      },
    };
  }

  const rawError =
    result.error ?? result.last_error ?? result.lastError ?? null;
  const error =
    rawError === null || rawError === undefined || rawError === ''
      ? null
      : typeof rawError === 'string'
        ? rawError
        : String(rawError?.message ?? rawError);
  const queryable =
    result.queryable !== false &&
    result.reachable !== false &&
    result.connected !== false &&
    result.ok !== false &&
    error === null;

  const state = lower(
    firstString(result.state, result.status, result.executor_state, result.executorState),
  );
  const running =
    typeof result.running === 'boolean'
      ? result.running
      : typeof result.active === 'boolean'
        ? result.active
        : typeof result.busy === 'boolean'
          ? result.busy
          : null;
  const exists =
    typeof result.exists === 'boolean'
      ? result.exists
      : typeof result.found === 'boolean'
        ? result.found
        : null;

  const detail = {
    attempted: true,
    queryable,
    state,
    running,
    error,
  };

  if (!queryable) return { kind: 'unqueryable', detail };
  if (running === true || (state !== null && LIVE_SET.has(state))) {
    return { kind: 'alive', detail };
  }
  if (
    running === false ||
    (state !== null && IDLE_SET.has(state)) ||
    exists === false
  ) {
    return { kind: 'idle', detail };
  }
  return { kind: 'unknown', detail };
}

function keptRun(run, reason) {
  return {
    kind: 'run',
    id: run.id,
    run_id: run.id,
    task_id: run.taskId,
    state: run.state,
    reason,
  };
}

function makeRedispatch(run, at, reason, outbox, proof) {
  return {
    kind: 'run',
    id: run.id,
    run_id: run.id,
    task_id: run.taskId,
    state: run.state,
    action: 'redispatch',
    reason,
    outbox_id: outbox?.id ?? null,
    outbox_idempotency_key: outbox?.idempotencyKey ?? null,
    idempotency_key: `recovery:redispatch:${run.id}`,
    probe: proof,
    event: {
      type: 'run.redispatched',
      key: `run.redispatched:${run.id}`,
      run_id: run.id,
      task_id: run.taskId,
      from_state: run.state,
      reason,
      at: toIso(at),
    },
  };
}

function makeMarkLost(run, at, policy, liveness, { reason, proof, outbox }) {
  return {
    kind: 'run',
    id: run.id,
    run_id: run.id,
    task_id: run.taskId,
    state: run.state,
    action: 'mark_lost',
    reason,
    idempotency_key: `recovery:markLost:${run.id}`,
    evidence: {
      heartbeat_at: toIso(run.heartbeatAt),
      last_activity_at: toIso(liveness.at),
      last_activity_field: liveness.field,
      age_ms: liveness.age,
      threshold_ms: policy.heartbeat_stall_ms,
      probe: proof,
      outbox_id: outbox?.id ?? null,
      outbox_state: outbox?.state ?? null,
    },
    event: {
      type: 'run.lost',
      key: `run.lost:${run.id}`,
      run_id: run.id,
      task_id: run.taskId,
      from_state: run.state,
      reason,
      at: toIso(at),
    },
  };
}
