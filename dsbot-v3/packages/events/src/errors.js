// Error taxonomy for the reliable-dispatch primitives.
//
// `EventsError` is the base; `status` mirrors the HTTP status the API layer
// should return for the same condition (PRD 02 §error codes). `TransportError`
// and `ToolError` model the two failure classes the outbox has to tell apart:
// a transport failure means "the request may or may not have arrived", a tool
// error means "the far side answered and rejected or throttled us".

export class EventsError extends Error {
  constructor(code, message, { status = 400, details = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'EventsError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class TransportError extends EventsError {
  constructor(code = 'transport_error', message = 'transport failure', options = {}) {
    super(code, message, { status: options.status ?? 502, ...options });
    this.name = 'TransportError';
    this.retryable = options.retryable ?? true;
  }
}

export class ToolError extends EventsError {
  constructor(code = 'tool_error', message = 'tool failure', options = {}) {
    super(code, message, { status: options.status ?? 409, ...options });
    this.name = 'ToolError';
    this.retryable = options.retryable ?? false;
  }
}

export function isEventsError(error) {
  return error instanceof EventsError;
}
