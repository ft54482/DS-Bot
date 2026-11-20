/** Notification kinds emitted by the notifier. */
export const NOTIFY_EVENTS = Object.freeze({
  STUCK: 'stuck',
  FAILED: 'failed',
  OVER_BUDGET: 'over_budget',
  ESCALATION: 'escalation',
});

/**
 * A repeated event is suppressed for this long. The PRD/ticket fixes the
 * window at five minutes; the notifier accepts an override for tests and for
 * deployments that want a stricter anti-spam window.
 */
export const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Escalation is two-step: a task may notify levels 1 and 2, then the notifier
 * stops repeating. Further calls are reported as `escalation_limit` instead of
 * being sent, which keeps a stuck scheduler from flooding the escalation
 * channel.
 */
export const MAX_ESCALATIONS = 2;

/** Reasons a notification was deliberately not handed to the sender. */
export const SUPPRESS_REASONS = Object.freeze({
  DUPLICATE: 'duplicate',
  ESCALATION_LIMIT: 'escalation_limit',
});
