import { EventsError } from './errors.js';

// Key formats from PRD 04 §2.2.1 and §2.4.2.
//
// idempotency_key = "{task_id}:{run_no}:{attempt}:{intent}"
// event_key       = "{source}|{session}|{seq}|{type}"

function requirePart(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EventsError('validation_error', `${field} is required`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new EventsError('validation_error', `${field} must be a positive integer`);
  }
  return value;
}

export function formatIdempotencyKey({ taskId, runNo, attempt, intent }) {
  const task = requirePart(taskId, 'taskId');
  if (task.includes(':')) {
    throw new EventsError(
      'validation_error',
      'taskId must not contain ":" because it is the idempotency-key separator',
    );
  }
  const run = requirePositiveInteger(runNo, 'runNo');
  const tryNumber = requirePositiveInteger(attempt, 'attempt');
  const kind = requirePart(intent, 'intent');
  if (kind.includes(':')) {
    throw new EventsError('validation_error', 'intent must not contain ":"');
  }
  return `${task}:${run}:${tryNumber}:${kind}`;
}

export function parseIdempotencyKey(key) {
  const text = requirePart(key, 'idempotencyKey');
  const parts = text.split(':');
  if (parts.length < 4) {
    throw new EventsError(
      'validation_error',
      'idempotencyKey must be "{task_id}:{run_no}:{attempt}:{intent}"',
    );
  }
  const intent = parts.pop();
  const attempt = parts.pop();
  const runNo = parts.pop();
  const taskId = parts.join(':');
  return {
    taskId,
    runNo: requirePositiveInteger(Number(runNo), 'runNo'),
    attempt: requirePositiveInteger(Number(attempt), 'attempt'),
    intent,
  };
}

export function eventKeyOf({ source, session, seq, type }) {
  const sourcePart = requirePart(source, 'source');
  const sessionPart = requirePart(session, 'session');
  const typePart = requirePart(type, 'type');
  requirePositiveInteger(seq, 'seq');

  for (const [field, part] of [
    ['source', sourcePart],
    ['session', sessionPart],
    ['type', typePart],
  ]) {
    if (part.includes('|')) {
      throw new EventsError(
        'validation_error',
        `${field} must not contain "|" because it is the event-key separator`,
      );
    }
  }

  return `${sourcePart}|${sessionPart}|${seq}|${typePart}`;
}

/** The source|session|seq prefix used to detect same-seq/different-type conflicts. */
export function eventSeqPrefixOf({ source, session, seq }) {
  return `${requirePart(source, 'source')}|${requirePart(session, 'session')}|${requirePositiveInteger(seq, 'seq')}`;
}
