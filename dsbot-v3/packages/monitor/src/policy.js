/**
 * Default thresholds for the status snapshot.
 *
 * The PRD set does not fix an acceptance SLA, so the monitor exposes the
 * threshold as an injected runtime policy and uses a conservative default.
 * `rework_rounds_threshold` is capped at the ticket's hard minimum of 2: a
 * single rework round is not a stuck task, two consecutive rounds are.
 */
export const DEFAULT_POLICY = Object.freeze({
  accepting_timeout_ms: 24 * 60 * 60 * 1000,
  rework_rounds_threshold: 2,
});

/** Stable machine-readable reasons. `detail` carries the human wording. */
export const STUCK_REASONS = Object.freeze({
  ACCEPTING_TIMEOUT: 'accepting_timeout',
  REWORK_ROUNDS: 'rework_rounds',
  BLOCKED_NOT_ESCALATED: 'blocked_not_escalated',
});

/** Run states that mean the author's attempt was sent back for rework. */
export const REJECTED_RUN_STATES = Object.freeze([
  'rejected',
  'revise',
  'rework',
  'reworking',
]);
