// Reliability primitives shared by the outbox, inbox and watermark modules.
//
// The state names follow the L13b ticket (`intent -> sending -> sent -> acked`)
// and the PRD's `dispatch_outbox` table. `intent` is the durable "we intend to
// call something" row; the PRD calls the same row state `pending`. `pending` is
// therefore accepted as an alias when reading, but the canonical state is
// `intent` so the ticket's chain is visible in the history.
export const OUTBOX_STATES = [
  'intent',
  'sending',
  'sent',
  'acked',
  'failed',
  'unknown',
];

// The happy path enforced by `#transition`. `sending -> intent` and
// `unknown -> intent` are recovery edges: a retryable tool error returns the
// intent to the queue, and reconciliation may prove a send never landed.
export const OUTBOX_TRANSITIONS = {
  // `intent -> unknown` is an anomaly edge: a send marker exists on a row that
  // never entered `sending` (torn write). Treat it as "possibly sent", never
  // resend it blindly.
  intent: ['sending', 'unknown', 'failed'],
  sending: ['sent', 'intent', 'unknown', 'failed'],
  sent: ['acked', 'unknown'],
  unknown: ['sent', 'intent', 'acked', 'failed'],
  acked: [],
  failed: [],
};

export const TERMINAL_OUTBOX_STATES = ['acked', 'failed'];

export const OUTBOX_INTENTS = [
  'delegate',
  'dispatch_run',
  'cancel_run',
  'send_message',
  'request_acceptance',
  'stop_subtree',
];

// Tool error codes that must never be retried automatically. Anything else is
// treated as transient and either re-queued (RATE_LIMITED) or reconciled.
export const PERMANENT_TOOL_ERRORS = [
  'BAD_REQUEST',
  'FORBIDDEN_WORKSPACE',
  'NOT_FOUND',
];

export const RETRYABLE_TOOL_ERRORS = ['RATE_LIMITED', 'UNAVAILABLE', 'TIMEOUT'];

export const INBOX_STATUSES = [
  'buffered',
  'processed',
  'ignored',
  'failed',
  'conflict',
];
