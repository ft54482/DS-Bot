/**
 * Recovery policy constants.
 *
 * The defaults follow `docs/prd/04-reliability-ops.md` §2.5.1: a run without a
 * heartbeat or other progress evidence for `heartbeat_stall_s` (600 s) is
 * considered lost. Deployments may tune the threshold through the injected
 * runtime policy but cannot turn the check off.
 */
export const DEFAULT_POLICY = Object.freeze({
  heartbeat_stall_ms: 10 * 60 * 1000,
});

/**
 * Run states that still own a live executor attempt.
 *
 * `dispatch_unknown` is included because the request may have reached the
 * executor; `cancelling` is deliberately not: a cancellation waiting for stop
 * verification must not be re-dispatched by recovery.
 */
export const ACTIVE_RUN_STATES = Object.freeze([
  'dispatched',
  'dispatch_unknown',
  'running',
]);

/**
 * Run states that are already settled for recovery purposes.
 *
 * `reported` is included because the author already produced a claim; it is
 * waiting for acceptance, not for another dispatch. `completed` is accepted as
 * an alias for `accepted` in snapshots that use task wording.
 */
export const TERMINAL_RUN_STATES = Object.freeze([
  'reported',
  'accepted',
  'completed',
  'rejected',
  'invalidated',
  'superseded',
  'failed',
  'cancelled',
  'canceled',
  'lost',
  'timed_out',
  'done',
  'closed',
]);

/** Executor observations that prove the attempt is still alive. */
export const LIVE_EXECUTOR_STATES = Object.freeze([
  'running',
  'active',
  'busy',
  'working',
  'executing',
  'queued',
  'pending',
  'waiting',
]);

/** Executor observations that prove no live attempt is holding the run. */
export const IDLE_EXECUTOR_STATES = Object.freeze([
  'idle',
  'ready',
  'done',
  'completed',
  'complete',
  'finished',
  'stopped',
  'stopping',
  'cancelled',
  'canceled',
  'failed',
  'missing',
  'not_found',
  'notfound',
  'not_running',
  'notrunning',
  'terminated',
  'exited',
  'gone',
]);
