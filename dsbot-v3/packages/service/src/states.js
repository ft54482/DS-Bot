/**
 * Canonical state names for the L2 task ledger.
 *
 * Naming source: `docs/prd/03-acceptance-spec.md` §10 (authoritative naming for
 * the PRD set), as required by the ticket. `reworking` from 02-api-contract §2.3
 * is kept as the rework facade; the PRD's "rework = accepting -> queued" is
 * expressed as `accepting -> reworking` and the new run remains gated by the
 * same completion guard.
 *
 * The PRD §3.4 intermediate run state `cancelling` is intentionally not a
 * separate state in this layer: cancel requests are recorded as
 * `run.cancelRequestedAt` and the run only becomes `cancelled` after stop
 * verification (D-V3-27, 17-minimal-implementation-package §4.3). The ticket's
 * run-state list is the contract for this module; adding `cancelling` would
 * create a second cancel vocabulary without a verified-stop guarantee.
 */
export const TASK_STATES = Object.freeze([
  'planned',
  'queued',
  'running',
  'accepting',
  'reworking',
  'stopping',
  'completed',
  'blocked',
  'paused',
  'cancelled',
]);

export const TASK_TERMINAL_STATES = Object.freeze(['completed', 'cancelled']);

/** Non-terminal states that a stop request may freeze (T-32). */
export const TASK_STOPPABLE_STATES = Object.freeze([
  'planned',
  'queued',
  'running',
  'accepting',
  'reworking',
  'blocked',
  'paused',
]);

export const RUN_STATES = Object.freeze([
  'queued',
  'dispatched',
  'dispatch_unknown',
  'running',
  'reported',
  'accepted',
  'rejected',
  'invalidated',
  'superseded',
  'failed',
  'cancelled',
  'lost',
  'timed_out',
]);

/**
 * Terminal for the run's own attempt. `failed/lost/timed_out` are attempt
 * terminals that may still become `superseded` (PRD R-22).
 */
export const RUN_TERMINAL_STATES = Object.freeze([
  'accepted',
  'rejected',
  'cancelled',
  'invalidated',
  'superseded',
]);

export const RUN_RETRYABLE_STATES = Object.freeze(['failed', 'lost', 'timed_out']);

/** States in which a run can still write/execute (used by stop verification). */
export const ACTIVE_RUN_STATES = Object.freeze([
  'queued',
  'dispatched',
  'dispatch_unknown',
  'running',
]);

export const ACCEPTANCE_STATES = Object.freeze([
  'open',
  'passed',
  'revise',
  'failed',
  'blocked',
  'void',
  'superseded',
]);

export const ACCEPTANCE_ITEM_STATES = Object.freeze(['pending', 'pass', 'fail', 'blocked', 'waived']);

export const ACCEPTANCE_ITEM_CLASSES = Object.freeze(['auto', 'independent', 'human']);

export function isTaskTerminal(state) {
  return TASK_TERMINAL_STATES.includes(state);
}

export function isRunTerminal(state) {
  return RUN_TERMINAL_STATES.includes(state);
}

export function isActiveRunState(state) {
  return ACTIVE_RUN_STATES.includes(state);
}

export function isTaskState(state) {
  return TASK_STATES.includes(state);
}

export function isRunState(state) {
  return RUN_STATES.includes(state);
}

export function isAcceptanceState(state) {
  return ACCEPTANCE_STATES.includes(state);
}
