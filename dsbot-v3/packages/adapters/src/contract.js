/**
 * L3 executor adapter contract (DS Bot V3, docs/prd/02-api-contract.md §2.4,
 * docs/prd/16-execution-paths.md).
 *
 * Every adapter exposes the same seven lifecycle methods:
 *   dispatch(run, taskPack, workspace, budget) -> { accepted, session_id|ticket_id, run_id }
 *   status(handle)                             -> { state, progress, usage }
 *   cancel(handle)                             -> { requested, verified_stopped_at|null }
 *   follow(handle, sinceSeq)                   -> { events[], next_seq }
 *   collectArtifacts(handle)                   -> [{ path, sha256, bytes }]
 *   collectEvidence(handle)                    -> [{ kind, ref, sha256, command, output_excerpt }]
 *   usage(handle)                              -> { tokens_in, tokens_out, tokens_cached, cost_cny }
 *
 * Hard rules (16 §2.5 / §3.5):
 *  1. A dispatch without an explicit tracker (status or follow) is rejected.
 *  2. A request is only `cancelled` when the stop is verified; otherwise `stop_unknown`
 *     and `remote_may_still_run: true`.
 *  3. An unavailable executor is `blocked`; it is never silently swapped for another kind.
 */

import { createHash } from 'node:crypto';

export const CONTRACT_VERSION = 1;

export const EXECUTOR_KINDS = Object.freeze(['mock', 'tool_chain', 'dsh_session', 'superagent']);

export const CONTRACT_METHODS = Object.freeze([
  'dispatch',
  'status',
  'cancel',
  'follow',
  'collectArtifacts',
  'collectEvidence',
  'usage',
]);

/** A dispatch must name at least one tracker it will actually use. */
export const TRACKER_MODES = Object.freeze(['status', 'follow']);

/** Tracker health reported by every `status`/`follow` (16 §2.5). */
export const TRACKER_HEALTH = Object.freeze({
  progress: 'progress',
  noProgress: 'no_progress',
  unknown: 'unknown',
});

export const RUN_STATES = Object.freeze([
  'queued',
  'dispatched',
  'running',
  'idle',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'stop_unknown',
  'blocked',
  'stalled',
  'timed_out',
  'lost',
  'unknown',
]);

export const ERROR_CODES = Object.freeze({
  trackerMissing: 'tracker_missing',
  trackingUnsupported: 'tracking_unsupported',
  invalidRequest: 'invalid_request',
  executorUnavailable: 'executor_unavailable',
  executorNotRegistered: 'executor_not_registered',
  bridgeUnreachable: 'bridge_unreachable',
  bridgeError: 'bridge_error',
  bridgeBadResponse: 'bridge_bad_response',
  orchestratorUnreachable: 'orchestrator_unreachable',
  orchestratorError: 'orchestrator_error',
  githubUnreachable: 'github_unreachable',
  githubError: 'github_error',
  unknownRun: 'unknown_run',
  ticketNotFound: 'ticket_not_found',
  alreadyFinished: 'already_finished',
  stopUnverified: 'stop_unverified',
  notConfigured: 'not_configured',
});

/* ------------------------------------------------------------------ helpers */

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function truncate(text, max = 400) {
  const string = typeof text === 'string' ? text : JSON.stringify(text ?? null);
  return string.length <= max ? string : `${string.slice(0, max)}…`;
}

export function emptyUsage(source = 'unavailable') {
  return { tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_cny: 0, source };
}

/**
 * Normalise dispatch arguments. Accepts either the envelope
 * `dispatch({ run, taskPack, workspace, budget, tracking })` or the positional
 * form from 02 §2.4 `dispatch(run, taskPack, workspace, budget)`, where tracking
 * may live on `run.tracking` or `taskPack.tracking`.
 */
export function readDispatchRequest(request, taskPack, workspace, budget) {
  const isEnvelope = Boolean(
    request && typeof request === 'object' && request.run && typeof request.run === 'object',
  );
  const envelope = isEnvelope
    ? request
    : {
        run: request ?? {},
        taskPack: taskPack ?? {},
        workspace: workspace ?? {},
        budget: budget ?? {},
        tracking: taskPack?.tracking ?? request?.tracking,
      };
  const run = envelope.run ?? {};
  const pack = envelope.taskPack ?? {};
  const ws = envelope.workspace ?? {};
  const issues = [];
  if (typeof run.id !== 'string' || run.id.length === 0) issues.push('run.id');
  if (typeof pack.goal !== 'string' || pack.goal.trim().length === 0) issues.push('taskPack.goal');
  if (issues.length > 0) {
    return { ok: false, code: ERROR_CODES.invalidRequest, message: `invalid dispatch request: ${issues.join(', ')}`, issues };
  }
  return {
    ok: true,
    value: {
      run,
      taskPack: pack,
      workspace: ws,
      budget: envelope.budget ?? {},
      tracking: envelope.tracking,
      session_id: envelope.session_id ?? run.session_id ?? null,
    },
  };
}

/**
 * Enforce "no tracker, no dispatch" (16 §2.5). Returns the modes the adapter will use.
 */
export function resolveTracking(adapter, tracking) {
  if (!tracking || typeof tracking !== 'object') {
    return {
      ok: false,
      code: ERROR_CODES.trackerMissing,
      message: 'dispatch requires an explicit tracker: pass tracking:{status:true} and/or tracking:{follow:true}',
    };
  }
  const modes = TRACKER_MODES.filter((mode) => tracking[mode] === true);
  if (modes.length === 0) {
    return {
      ok: false,
      code: ERROR_CODES.trackerMissing,
      message: 'dispatch requires an explicit tracker: tracking.status or tracking.follow must be true',
    };
  }
  const supported = adapter.capabilities?.tracking ?? {};
  const unsupported = modes.filter((mode) => supported[mode] !== true);
  if (unsupported.length > 0) {
    return {
      ok: false,
      code: ERROR_CODES.trackingUnsupported,
      message: `${adapter.kind} cannot track via ${unsupported.join(', ')}`,
      details: { unsupported, supported: TRACKER_MODES.filter((mode) => supported[mode] === true) },
    };
  }
  return { ok: true, modes };
}

export function readHandle(handle) {
  if (typeof handle === 'string' && handle.length > 0) return { run_id: handle };
  if (handle && typeof handle === 'object') {
    const runId = handle.run_id ?? handle.runId ?? handle.id ?? null;
    return { ...handle, run_id: typeof runId === 'string' && runId.length > 0 ? runId : null };
  }
  return { run_id: null };
}

/* ---------------------------------------------------------------- builders */

function base(kind, method, fields) {
  return { contract_version: CONTRACT_VERSION, kind, method, ...fields };
}

export function dispatchAccepted({
  kind,
  run_id,
  tracking,
  session_id = null,
  ticket_id = null,
  ticket_id_pending = false,
  issue = null,
  state = 'dispatched',
  detail = {},
}) {
  return base(kind, 'dispatch', {
    ok: true,
    accepted: true,
    run_id,
    state,
    session_id,
    ticket_id,
    ticket_id_pending,
    issue,
    tracking,
    detail,
  });
}

export function dispatchRejected({
  kind,
  code,
  message,
  state = 'rejected',
  run_id = null,
  degraded = false,
  fallback = 'none',
  details = {},
}) {
  return base(kind, 'dispatch', {
    ok: false,
    accepted: false,
    run_id,
    state,
    code,
    message,
    degraded,
    fallback,
    details,
  });
}

export function runStatusOk({ kind, run_id, state, health, usage, progress = {}, detail = {} }) {
  return base(kind, 'status', {
    ok: true,
    run_id,
    state,
    progress: { health, ...progress },
    usage,
    detail,
  });
}

export function runStatusUnknown({ kind, run_id, code, message, detail = {} }) {
  return base(kind, 'status', {
    ok: false,
    run_id,
    state: 'unknown',
    code,
    message,
    progress: { health: TRACKER_HEALTH.unknown },
    usage: emptyUsage('unavailable'),
    detail,
  });
}

export function cancelResult({
  kind,
  run_id,
  requested,
  state,
  verified_stopped_at = null,
  code = null,
  message = null,
  remote_may_still_run = false,
  reasons = [],
}) {
  return base(kind, 'cancel', {
    ok: true,
    run_id,
    requested,
    state,
    verified_stopped_at,
    code,
    message,
    remote_may_still_run,
    reasons,
  });
}

export function followResult({
  kind,
  run_id,
  events = [],
  next_seq = 0,
  timedOut = false,
  hasMore = false,
  detail = {},
}) {
  return base(kind, 'follow', {
    ok: true,
    run_id,
    events,
    next_seq,
    timedOut,
    hasMore,
    detail,
  });
}

export function followUnavailable({ kind, run_id, code, message, next_seq = 0 }) {
  return base(kind, 'follow', { ok: false, run_id, code, message, events: [], next_seq, timedOut: false, hasMore: false });
}

export function artifactList({ kind, run_id, items = [] }) {
  return base(kind, 'collectArtifacts', { ok: true, run_id, items });
}

export function evidenceList({ kind, run_id, items = [] }) {
  return base(kind, 'collectEvidence', { ok: true, run_id, items });
}

export function usageReport({ kind, run_id, usage }) {
  return { ...base(kind, 'usage', { ok: true, run_id }), ...usage };
}

/**
 * Stop verification. Every condition must hold; anything else is `stop_unknown`
 * (16 §3.5, 17 §4.3): cancel accepted, remote confirmed stopped, no child
 * processes, workspace writes stable for at least `minStableMs`.
 */
export function confirmStop({
  accepted,
  remoteStopped,
  children = null,
  stableForMs = null,
  minStableMs = 2000,
  reasons = [],
}) {
  const failures = [...reasons];
  if (accepted !== true) failures.push('cancel_not_accepted');
  if (remoteStopped !== true) failures.push('remote_not_stopped');
  if (children !== null && children !== 0) failures.push('process_children_remaining');
  if (stableForMs === null || !(stableForMs >= minStableMs)) failures.push('workspace_writes_unstable');
  return failures.length === 0 ? { verified: true, reasons: [] } : { verified: false, reasons: failures };
}

/* ------------------------------------------------------------- adapter glue */

export function defineAdapter({ kind, capabilities, methods }) {
  if (!EXECUTOR_KINDS.includes(kind)) throw new TypeError(`unknown executor kind: ${kind}`);
  const tracking = capabilities?.tracking ?? {};
  const adapter = {
    kind,
    contract_version: CONTRACT_VERSION,
    capabilities: {
      ...capabilities,
      tracking: { status: tracking.status === true, follow: tracking.follow === true },
    },
    ...methods,
  };
  for (const method of CONTRACT_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`${kind} adapter is missing contract method "${method}"`);
    }
  }
  return adapter;
}

/** Structural check used by tests and by the service at startup. */
export function validateContract(adapter) {
  const issues = [];
  if (!adapter || typeof adapter !== 'object') return { ok: false, issues: ['adapter'] };
  if (!EXECUTOR_KINDS.includes(adapter.kind)) issues.push(`kind:${String(adapter.kind)}`);
  if (adapter.contract_version !== CONTRACT_VERSION) issues.push('contract_version');
  for (const method of CONTRACT_METHODS) {
    if (typeof adapter[method] !== 'function') issues.push(`missing:${method}`);
  }
  const tracking = adapter.capabilities?.tracking ?? {};
  if (!TRACKER_MODES.some((mode) => tracking[mode] === true)) issues.push('capabilities.tracking');
  return { ok: issues.length === 0, issues };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkUsage(issues, prefix, usage) {
  if (!usage || typeof usage !== 'object') return issues.push(`${prefix}.usage`);
  for (const key of ['tokens_in', 'tokens_out', 'tokens_cached', 'cost_cny']) {
    if (!isFiniteNumber(usage[key])) issues.push(`${prefix}.usage.${key}`);
  }
  if (typeof usage.source !== 'string') issues.push(`${prefix}.usage.source`);
  return issues;
}

/** Method-aware result shape check: guarantees "每个适配器导出一致的形状". */
export function validateResult(adapter, method, result) {
  const issues = [];
  if (!CONTRACT_METHODS.includes(method)) return { ok: false, issues: [`unknown method:${method}`] };
  if (!result || typeof result !== 'object') return { ok: false, issues: ['result'] };
  if (result.kind !== adapter.kind) issues.push(`kind:${String(result.kind)}`);
  if (result.method !== method) issues.push(`method:${String(result.method)}`);
  if (typeof result.ok !== 'boolean') issues.push('ok');
  if (result.run_id !== null && typeof result.run_id !== 'string') issues.push('run_id');

  if (method === 'dispatch') {
    if (result.ok === true) {
      if (result.accepted !== true) issues.push('dispatch.accepted');
      if (!['dispatched', 'running', 'completed', 'cancelled', 'failed'].includes(result.state)) issues.push('dispatch.state');
      if (!result.session_id && !result.ticket_id && result.ticket_id_pending !== true) {
        // Local adapters (mock/tool_chain) are addressed by run_id; remote ones must
        // return the session/ticket handle the service will use for every later call.
        if (adapter.capabilities?.remote === true) issues.push('dispatch.handle');
      }
      if (!result.tracking || typeof result.tracking !== 'object') issues.push('dispatch.tracking');
    } else {
      if (!['rejected', 'blocked'].includes(result.state)) issues.push('dispatch.state');
      if (typeof result.code !== 'string') issues.push('dispatch.code');
      if (result.fallback !== 'none') issues.push('dispatch.fallback');
    }
  }

  if (method === 'status') {
    if (!RUN_STATES.includes(result.state)) issues.push('status.state');
    if (!Object.values(TRACKER_HEALTH).includes(result.progress?.health)) issues.push('status.progress.health');
    checkUsage(issues, 'status', result.usage);
  }

  if (method === 'cancel') {
    if (typeof result.requested !== 'boolean') issues.push('cancel.requested');
    if (!RUN_STATES.includes(result.state)) issues.push('cancel.state');
    if (!(result.verified_stopped_at === null || isFiniteNumber(result.verified_stopped_at))) {
      issues.push('cancel.verified_stopped_at');
    }
    if (result.state === 'cancelled' && result.verified_stopped_at === null) {
      issues.push('cancel.cancelled_without_verification');
    }
    if (result.state === 'stop_unknown' && result.remote_may_still_run !== true) {
      issues.push('cancel.stop_unknown_without_remote_flag');
    }
    if (result.requested === true && result.state === 'stop_unknown' && result.verified_stopped_at !== null) {
      issues.push('cancel.stop_unknown_verified');
    }
  }

  if (method === 'follow') {
    if (!Array.isArray(result.events)) issues.push('follow.events');
    if (!isFiniteNumber(result.next_seq)) issues.push('follow.next_seq');
    const maxSeq = Array.isArray(result.events)
      ? result.events.reduce((max, event) => (isFiniteNumber(event?.seq) ? Math.max(max, event.seq) : max), 0)
      : 0;
    if (isFiniteNumber(result.next_seq) && result.next_seq < maxSeq) issues.push('follow.next_seq_before_events');
    if (result.events?.some((event) => !isFiniteNumber(event?.seq) || typeof event?.type !== 'string')) {
      issues.push('follow.event');
    }
  }

  if (method === 'collectArtifacts') {
    if (!Array.isArray(result.items)) issues.push('artifacts.items');
    for (const item of result.items ?? []) {
      if (typeof item?.path !== 'string' || item.path.length === 0) issues.push('artifacts.path');
      if (!(item?.sha256 === null || (typeof item?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)))) {
        issues.push('artifacts.sha256');
      }
      if (!isFiniteNumber(item?.bytes)) issues.push('artifacts.bytes');
    }
  }

  if (method === 'collectEvidence') {
    if (!Array.isArray(result.items)) issues.push('evidence.items');
    for (const item of result.items ?? []) {
      if (typeof item?.kind !== 'string') issues.push('evidence.kind');
      if (typeof item?.ref !== 'string') issues.push('evidence.ref');
      if (!(item?.sha256 === null || (typeof item?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)))) {
        issues.push('evidence.sha256');
      }
      if (!(item?.command === null || typeof item?.command === 'string')) issues.push('evidence.command');
      if (typeof item?.output_excerpt !== 'string') issues.push('evidence.output_excerpt');
    }
  }

  if (method === 'usage') checkUsage(issues, 'usage', result);

  return { ok: issues.length === 0, issues };
}
