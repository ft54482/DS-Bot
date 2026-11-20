import { INBOX_STATUSES } from './constants.js';
import { EventsError } from './errors.js';
import { eventKeyOf, eventSeqPrefixOf } from './keys.js';
import { Watermark } from './watermark.js';

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EventsError('validation_error', `${field} is required`);
  }
  return value;
}

function requireSeq(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new EventsError('validation_error', 'seq must be a positive integer');
  }
  return value;
}

function sessionKeyOf(source, session) {
  return `${source}\u0000${session}`;
}

/**
 * In-memory `event_inbox`.
 *
 * - dedupe by `event_key = source|session|seq|type`;
 * - buffer out-of-order records until the gap fills;
 * - advance the per-session watermark only after a contiguous record was
 *   processed successfully (a failed handler blocks the stream);
 * - keep duplicates, stale records, conflicts and unknown types visible instead
 *   of silently dropping them.
 */
export class Inbox {
  #clock;
  #handler;
  #knownTypes;
  #events = new Map();
  #byKey = new Map();
  #seqIndex = new Map();
  #sessions = new Map();
  #conflicts = [];
  #idFactory;

  constructor({
    clock = () => Date.now(),
    handler = null,
    knownTypes = null,
    idFactory = null,
  } = {}) {
    if (handler !== null && typeof handler !== 'function') {
      throw new EventsError('validation_error', 'handler must be a function');
    }
    if (knownTypes !== null) {
      this.#knownTypes = new Set(knownTypes);
    }
    this.#clock = clock;
    this.#handler = handler;
    this.#idFactory = idFactory;
  }

  /** Derive the canonical event key; exposed for callers that log before receive. */
  keyOf(event = {}) {
    return eventKeyOf(this.#normalize(event, false));
  }

  receive(event, { process = true } = {}) {
    const normalized = this.#normalize(event, true);
    const { source, session, seq, type, eventKey } = normalized;
    const now = this.#clock();

    const duplicate = this.#byKey.get(eventKey);
    if (duplicate) {
      return {
        inserted: false,
        duplicate: true,
        conflict: false,
        event: this.#view(duplicate),
        watermark: this.watermark(source, session),
      };
    }

    const prefix = eventSeqPrefixOf({ source, session, seq });
    const sameSeqKey = this.#seqIndex.get(prefix);
    if (sameSeqKey && sameSeqKey !== eventKey) {
      const conflict = {
        id: this.#idFactory ? this.#idFactory('inbox') : eventKey,
        source,
        session,
        seq,
        type,
        eventKey,
        payload: normalized.payload,
        receivedAt: now,
        processedAt: null,
        status: 'conflict',
        reason: `same seq already received as ${sameSeqKey}`,
      };
      this.#events.set(eventKey, conflict);
      this.#byKey.set(eventKey, conflict);
      this.#conflicts.push({
        eventKey,
        existingKey: sameSeqKey,
        source,
        session,
        seq,
        at: now,
      });
      return {
        inserted: true,
        duplicate: false,
        conflict: true,
        event: this.#view(conflict),
        watermark: this.watermark(source, session),
      };
    }

    const record = {
      id: this.#idFactory ? this.#idFactory('inbox') : eventKey,
      source,
      session,
      seq,
      type,
      eventKey,
      payload: normalized.payload,
      receivedAt: now,
      processedAt: null,
      status: 'buffered',
      reason: null,
      lastError: null,
    };

    const state = this.#state(source, session, true);
    this.#events.set(eventKey, record);
    this.#byKey.set(eventKey, record);
    this.#seqIndex.set(prefix, eventKey);

    if (seq <= state.watermark.value) {
      record.status = 'ignored';
      record.reason = 'stale';
      record.processedAt = now;
      return {
        inserted: true,
        duplicate: false,
        conflict: false,
        stale: true,
        event: this.#view(record),
        watermark: this.watermark(source, session),
      };
    }

    state.buffer.set(seq, eventKey);
    state.watermark.observe(seq);

    if (seq > state.watermark.value + 1) {
      state.gapDetectedAt ??= now;
      return {
        inserted: true,
        duplicate: false,
        conflict: false,
        buffered: true,
        event: this.#view(record),
        watermark: this.watermark(source, session),
      };
    }

    if (process) {
      const drained = this.#drain(state);
      return {
        inserted: true,
        duplicate: false,
        conflict: false,
        buffered: record.status === 'buffered',
        processed: record.status === 'processed' || record.status === 'ignored',
        drained: drained.processed,
        event: this.#view(record),
        watermark: this.watermark(source, session),
      };
    }

    return {
      inserted: true,
      duplicate: false,
      conflict: false,
      buffered: true,
      event: this.#view(record),
      watermark: this.watermark(source, session),
    };
  }

  receiveBatch(events) {
    return events.map((event) => this.receive(event));
  }

  /** Drain every contiguous buffered record for one stream. */
  drain(source, session) {
    const state = this.#state(source, session, false);
    if (!state) return { processed: [], blocked: null };
    return this.#drain(state);
  }

  /** Re-run the handler for a failed record that is still at the watermark edge. */
  retry(eventKey) {
    const record = this.#byKey.get(eventKey);
    if (!record) {
      throw new EventsError('not_found', `inbox event ${eventKey} not found`, { status: 404 });
    }
    const state = this.#state(record.source, record.session, false);
    if (record.status !== 'failed') {
      return { retried: false, event: this.#view(record), watermark: this.#snapshot(state) };
    }
    if (!state || record.seq !== state.watermark.value + 1) {
      throw new EventsError(
        'invalid_transition',
        'only the failed record at the watermark edge can be retried',
        { status: 409 },
      );
    }
    const consumed = this.#consume(record, state);
    const drained = consumed ? this.#drain(state) : { processed: [] };
    return {
      retried: true,
      consumed,
      event: this.#view(record),
      processed: drained.processed,
      watermark: this.#snapshot(state),
    };
  }

  watermark(source, session) {
    return this.#snapshot(this.#state(source, session, false));
  }

  get(eventKey) {
    const record = this.#byKey.get(eventKey);
    return record ? this.#view(record) : null;
  }

  list({ status, source, session } = {}) {
    if (status !== undefined && !INBOX_STATUSES.includes(status)) {
      throw new EventsError('validation_error', `unknown inbox status: ${status}`);
    }
    return [...this.#events.values()]
      .filter((record) => status === undefined || record.status === status)
      .filter((record) => source === undefined || record.source === source)
      .filter((record) => session === undefined || record.session === session)
      .sort((a, b) => (a.receivedAt - b.receivedAt) || a.eventKey.localeCompare(b.eventKey))
      .map((record) => this.#view(record));
  }

  conflicts() {
    return this.#conflicts.map((entry) => ({ ...entry }));
  }

  stats() {
    const byStatus = Object.fromEntries(INBOX_STATUSES.map((status) => [status, 0]));
    for (const record of this.#events.values()) byStatus[record.status] += 1;
    let buffered = 0;
    for (const state of this.#sessions.values()) buffered += state.buffer.size;
    return {
      total: this.#events.size,
      sessions: this.#sessions.size,
      buffered,
      conflicts: this.#conflicts.length,
      byStatus,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #normalize(event = {}, requireFields = true) {
    const source = requireFields ? requireString(event.source, 'source') : event.source;
    const session = requireFields
      ? requireString(event.session ?? event.sessionId, 'session')
      : (event.session ?? event.sessionId);
    const seq = requireFields ? requireSeq(event.seq ?? event.sourceSeq) : (event.seq ?? event.sourceSeq);
    const type = requireFields ? requireString(event.type, 'type') : event.type;
    return {
      source,
      session,
      seq,
      type,
      payload: event.payload ?? {},
      eventKey: eventKeyOf({ source, session, seq, type }),
    };
  }

  #state(source, session, create) {
    const key = sessionKeyOf(source, session);
    let state = this.#sessions.get(key);
    if (!state && create) {
      state = {
        source,
        session,
        watermark: new Watermark({ clock: this.#clock }),
        buffer: new Map(),
        gapDetectedAt: null,
      };
      this.#sessions.set(key, state);
    }
    return state ?? null;
  }

  #consume(record, state) {
    const now = this.#clock();
    if (this.#knownTypes && !this.#knownTypes.has(record.type)) {
      record.status = 'ignored';
      record.reason = 'unknown_type';
      record.processedAt = now;
      state.watermark.advance(record.seq);
      this.#clearGapIfFilled(state);
      return true;
    }

    try {
      const verdict = this.#handler ? this.#handler(this.#view(record)) : true;
      if (verdict === false) {
        record.status = 'ignored';
        record.reason = 'handler_ignored';
      } else {
        record.status = 'processed';
        record.reason = null;
      }
      record.processedAt = now;
      record.lastError = null;
      state.watermark.advance(record.seq);
      this.#clearGapIfFilled(state);
      return true;
    } catch (error) {
      record.status = 'failed';
      record.lastError = `${error?.code ?? error?.name ?? 'error'}: ${String(error?.message ?? error)}`;
      return false;
    }
  }

  #drain(state) {
    const processed = [];
    while (true) {
      const next = state.watermark.value + 1;
      const eventKey = state.buffer.get(next);
      if (!eventKey) break;
      state.buffer.delete(next);
      const record = this.#events.get(eventKey);
      const consumed = this.#consume(record, state);
      processed.push({ eventKey, consumed, status: record.status });
      if (!consumed) break;
    }
    this.#clearGapIfFilled(state);
    const blocked = state.buffer.size > 0
      ? (state.buffer.has(state.watermark.value + 1) ? null : 'gap')
      : null;
    return { processed, blocked };
  }

  #clearGapIfFilled(state) {
    if (state.buffer.size === 0) state.gapDetectedAt = null;
  }

  #snapshot(state) {
    if (!state) {
      return { lastSeqConsumed: 0, lastSeqSeen: 0, buffered: 0, gapDetectedAt: null };
    }
    return {
      lastSeqConsumed: state.watermark.value,
      lastSeqSeen: state.watermark.lastSeen,
      buffered: state.buffer.size,
      gapDetectedAt: state.gapDetectedAt,
    };
  }

  #view(record) {
    return { ...record, payload: record.payload };
  }
}
