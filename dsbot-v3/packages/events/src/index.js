// L13b reliable-dispatch primitives: outbox state machine, inbox dedupe,
// watermark and idempotency keys. Pure in-memory: no file, network or timer.
export {
  INBOX_STATUSES,
  OUTBOX_INTENTS,
  OUTBOX_STATES,
  OUTBOX_TRANSITIONS,
  PERMANENT_TOOL_ERRORS,
  RETRYABLE_TOOL_ERRORS,
  TERMINAL_OUTBOX_STATES,
} from './constants.js';
export { EventsError, ToolError, TransportError, isEventsError } from './errors.js';
export {
  eventKeyOf,
  eventSeqPrefixOf,
  formatIdempotencyKey,
  parseIdempotencyKey,
} from './keys.js';
export { canonicalJson, fingerprintJson, normalizePayload, sha256Hex } from './payload.js';
export { Outbox } from './outbox.js';
export { Inbox } from './inbox.js';
export { InMemoryTransport } from './transport.js';
export { Watermark, WatermarkTable } from './watermark.js';
