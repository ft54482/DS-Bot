import { randomUUID } from 'node:crypto';

import {
  OUTBOX_INTENTS,
  OUTBOX_STATES,
  OUTBOX_TRANSITIONS,
  PERMANENT_TOOL_ERRORS,
  RETRYABLE_TOOL_ERRORS,
  TERMINAL_OUTBOX_STATES,
} from './constants.js';
import { EventsError, ToolError, TransportError } from './errors.js';
import { formatIdempotencyKey } from './keys.js';
import { normalizePayload } from './payload.js';

const TERMINAL = new Set(TERMINAL_OUTBOX_STATES);
const STATES = new Set(OUTBOX_STATES);

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EventsError('validation_error', `${field} is required`);
  }
  return value;
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new EventsError(
      'validation_error',
      `${field} must be one of ${allowed.join(', ')} (got ${String(value)})`,
    );
  }
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new EventsError('validation_error', `${field} must be a non-negative integer`);
  }
  return value;
}

function normalizeState(state) {
  // PRD 04 calls the first state `pending`; this package calls it `intent`.
  return state === 'pending' ? 'intent' : state;
}

/**
 * In-memory `dispatch_outbox` state machine.
 *
 * Happy path: `intent -> sending -> sent -> acked`.
 * Recovery: `sending` (crashed) and `unknown` (ambiguous) are reconciled before
 * anything is resent; `acked` and `failed` are terminal and never resent.
 *
 * The class never touches a file, the network or a timer. The transport is
 * injected; `InMemoryTransport` is provided for tests and demos.
 */
export class Outbox {
  #records = new Map();
  #byKey = new Map();
  #transport;
  #clock;
  #idFactory;
  #epoch;
  #leaseMs;
  #maxDispatchAttempts;
  #maxResends;
  #maxReconcileAttempts;
  #reconcileGraceMs;

  constructor({
    transport,
    clock = () => Date.now(),
    idFactory = () => `outbox-${randomUUID()}`,
    epoch = 1,
    leaseMs = 30_000,
    maxDispatchAttempts = 3,
    maxResends = 1,
    maxReconcileAttempts = 2,
    reconcileGraceMs = 120_000,
  } = {}) {
    if (!transport || typeof transport.send !== 'function') {
      throw new EventsError('validation_error', 'transport.send is required');
    }
    this.#transport = transport;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#epoch = requireNonNegativeInteger(epoch, 'epoch');
    this.#leaseMs = requireNonNegativeInteger(leaseMs, 'leaseMs');
    this.#maxDispatchAttempts = requireNonNegativeInteger(maxDispatchAttempts, 'maxDispatchAttempts');
    this.#maxResends = requireNonNegativeInteger(maxResends, 'maxResends');
    this.#maxReconcileAttempts = requireNonNegativeInteger(maxReconcileAttempts, 'maxReconcileAttempts');
    this.#reconcileGraceMs = requireNonNegativeInteger(reconcileGraceMs, 'reconcileGraceMs');
  }

  // -------------------------------------------------------------------------
  // Writing the intent (T1)
  // -------------------------------------------------------------------------

  /**
   * Persist one intent. A repeated key with the same payload is a replay; the
   * same key with a different payload is a 409 `duplicate_dispatch`.
   */
  enqueue(input = {}) {
    const intent = requireOneOf(input.intent, OUTBOX_INTENTS, 'intent');
    const taskId = requireString(input.taskId, 'taskId');
    const principalRef = requireString(input.principalRef, 'principalRef');
    const idempotencyKey = input.idempotencyKey ?? formatIdempotencyKey({
      taskId,
      runNo: input.runNo ?? 1,
      attempt: input.attempt ?? 1,
      intent,
    });
    requireString(idempotencyKey, 'idempotencyKey');

    const { payloadJson, payloadSha256 } = normalizePayload(input.payload ?? {});
    const existing = this.#byKey.get(idempotencyKey);
    if (existing) {
      if (existing.payloadSha256 !== payloadSha256) {
        throw new EventsError(
          'duplicate_dispatch',
          `idempotencyKey ${idempotencyKey} is already used with a different payload`,
          {
            status: 409,
            details: {
              idempotencyKey,
              existingPayloadSha256: existing.payloadSha256,
              incomingPayloadSha256: payloadSha256,
            },
          },
        );
      }
      return { record: this.#view(existing), inserted: false, replayed: true, duplicated: true };
    }

    const now = input.createdAt ?? this.#clock();
    const record = {
      id: input.id ?? this.#idFactory(),
      taskId,
      runId: input.runId ?? null,
      principalRef,
      intent,
      payloadJson,
      payloadSha256,
      state: 'intent',
      idempotencyKey,
      attempts: 0,
      sendStartedAt: null,
      sentAt: null,
      ackedAt: null,
      createdAt: now,
      nextRetryAt: null,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      writerEpoch: null,
      receipt: null,
      reconcileAttempts: 0,
      resends: 0,
      resolution: null,
      resolvedAt: null,
      history: [{ state: 'intent', at: now, reason: 'enqueued' }],
    };
    if (this.#records.has(record.id)) {
      throw new EventsError('validation_error', `outbox id ${record.id} already exists`);
    }
    this.#records.set(record.id, record);
    this.#byKey.set(idempotencyKey, record);
    return { record: this.#view(record), inserted: true, replayed: false, duplicated: false };
  }

  // -------------------------------------------------------------------------
  // Sending (T2/T3/T4/T5)
  // -------------------------------------------------------------------------

  /** T3: durably mark "we are about to call"; this is the crash boundary. */
  beginSend(id, {
    owner = 'scanner',
    epoch = this.#epoch,
    now = this.#clock(),
    leaseMs = this.#leaseMs,
  } = {}) {
    const record = this.#require(id);
    if (record.state !== 'intent') {
      throw new EventsError(
        'invalid_transition',
        `cannot begin send from ${record.state} (expected intent)`,
        { status: 409 },
      );
    }
    if (record.sendStartedAt != null) {
      throw new EventsError(
        'send_already_started',
        'this intent already has a send marker; recover or reconcile it',
        { status: 409 },
      );
    }
    if (record.leaseUntil != null && record.leaseUntil > now && record.leaseOwner !== owner) {
      throw new EventsError('lease_held', `lease is held by ${record.leaseOwner}`, { status: 409 });
    }
    if (epoch != null && record.writerEpoch != null && epoch < record.writerEpoch) {
      throw new EventsError('stale_epoch', 'writer epoch is older than the record epoch', { status: 409 });
    }

    this.#transition(record, 'sending', now, 'send_started');
    record.sendStartedAt = now;
    record.attempts += 1;
    record.leaseOwner = owner;
    record.leaseUntil = now + leaseMs;
    record.writerEpoch = epoch;
    record.lastError = null;
    return this.#view(record);
  }

  /** T5 success: the transport answered. `sent` still waits for `ack`. */
  completeSend(id, receipt = {}, { now = this.#clock() } = {}) {
    const record = this.#require(id);
    if (record.state !== 'sending') {
      throw new EventsError(
        'invalid_transition',
        `cannot complete a send from ${record.state} (expected sending)`,
        { status: 409 },
      );
    }
    this.#transition(record, 'sent', now, 'send_completed');
    record.sentAt = now;
    record.receipt = { ...receipt };
    record.leaseOwner = null;
    record.leaseUntil = null;
    return this.#view(record);
  }

  /** Acknowledge a sent intent. Idempotent; a late ack may resolve `unknown`. */
  ack(id, receipt = null, { now = this.#clock() } = {}) {
    const record = this.#require(id);
    if (record.state === 'acked') return this.#view(record);
    if (record.state !== 'sent' && record.state !== 'unknown') {
      throw new EventsError(
        'invalid_transition',
        `cannot ack from ${record.state} (expected sent or unknown)`,
        { status: 409 },
      );
    }
    this.#transition(record, 'acked', now, 'acked');
    record.ackedAt = now;
    if (receipt !== null) record.receipt = { ...receipt };
    record.leaseOwner = null;
    record.leaseUntil = null;
    return this.#view(record);
  }

  /** T5 failure classification, keyed on the two error classes from the bridge. */
  failSend(id, error, {
    now = this.#clock(),
    backoffMs = 30_000,
    retryable,
  } = {}) {
    const record = this.#require(id);
    if (record.state !== 'sending') {
      throw new EventsError(
        'invalid_transition',
        `cannot fail a send from ${record.state} (expected sending)`,
        { status: 409 },
      );
    }
    const isTool = error instanceof ToolError
      || error?.name === 'ToolError';
    const isTransport = error instanceof TransportError
      || error?.name === 'TransportError';

    record.lastError = formatError(error);
    record.leaseOwner = null;
    record.leaseUntil = null;

    if (isTool && PERMANENT_TOOL_ERRORS.includes(error.code)) {
      this.#transition(record, 'failed', now, `tool:${error.code}`);
      record.resolution = 'failed';
      record.resolvedAt = now;
      return this.#view(record);
    }

    const retryableTool = isTool
      && (RETRYABLE_TOOL_ERRORS.includes(error.code) || error.retryable === true || retryable === true);

    if (retryableTool) {
      // The bridge explicitly rejected/throttled the call, so no side effect
      // landed. Return to `intent` with backoff; the send marker is cleared
      // because this attempt is definitively over.
      this.#transition(record, 'intent', now, `retry:${error.code}`);
      record.sendStartedAt = null;
      record.nextRetryAt = now + backoffMs;
      return this.#view(record);
    }

    if (isTransport || !isTool) {
      this.#transition(record, 'unknown', now, `transport:${error?.code ?? 'error'}`);
      record.resolution = 'unknown';
      return this.#view(record);
    }

    // A tool error that is neither clearly permanent nor clearly retryable:
    // do not guess, reconcile the side effect.
    this.#transition(record, 'unknown', now, `tool:${error.code}`);
    record.resolution = 'unknown';
    return this.#view(record);
  }

  // -------------------------------------------------------------------------
  // Dispatch and recovery
  // -------------------------------------------------------------------------

  /**
   * One delivery attempt. Never resends `sent`/`acked`/`failed`; a crashed
   * `sending` marker is routed through reconciliation first.
   */
  async dispatchIntent(id, {
    owner = 'scanner',
    epoch = this.#epoch,
    now = this.#clock(),
    autoAck = false,
  } = {}) {
    const record = this.#require(id);

    if (TERMINAL.has(record.state)) {
      return { record: this.#view(record), action: 'skipped', reason: 'terminal', externalCall: false };
    }
    if (record.state === 'sent') {
      if (autoAck) this.ack(id, record.receipt, { now });
      return {
        record: this.#view(record),
        action: 'skipped',
        reason: autoAck ? 'acked' : 'awaiting_ack',
        externalCall: false,
      };
    }
    if (record.state === 'sending' || record.state === 'unknown') {
      return this.reconcile(id, { owner, epoch, now, autoAck });
    }

    // state === 'intent'
    if (record.sendStartedAt != null) {
      this.#markUnknown(record, now, 'pending_with_send_marker');
      return this.reconcile(id, { owner, epoch, now, autoAck });
    }
    if (record.nextRetryAt != null && record.nextRetryAt > now) {
      return { record: this.#view(record), action: 'skipped', reason: 'backoff', externalCall: false };
    }
    if (record.attempts >= this.#maxDispatchAttempts) {
      this.#transition(record, 'failed', now, 'max_attempts');
      record.resolution = 'failed';
      record.resolvedAt = now;
      return { record: this.#view(record), action: 'failed', reason: 'max_attempts', externalCall: false };
    }

    this.beginSend(id, { owner, epoch, now });
    try {
      const receipt = await this.#transport.send({
        idempotencyKey: record.idempotencyKey,
        intent: record.intent,
        payload: JSON.parse(record.payloadJson),
        payloadSha256: record.payloadSha256,
        attempt: record.attempts,
        outboxId: record.id,
      });
      this.completeSend(id, receipt ?? {}, { now });
      if (autoAck) this.ack(id, receipt ?? {}, { now });
      return { record: this.#view(record), action: 'sent', externalCall: true };
    } catch (error) {
      this.failSend(id, error, { now });
      return {
        record: this.#view(record),
        action: record.state === 'failed'
          ? 'failed'
          : record.state === 'intent'
            ? 'retry_scheduled'
            : 'unknown',
        reason: error?.code ?? null,
        externalCall: false,
      };
    }
  }

  /**
   * Reconcile an ambiguous/aborted send before any resend.
   *
   * 1. Probe the transport ledger. A receipt means the side effect landed:
   *    adopt it (and ack) without calling again.
   * 2. Without a receipt, wait for the grace window.
   * 3. After the grace window, allow at most one resend with the SAME key.
   * 4. If that is exhausted or reconciliation itself is exhausted, stop and
   *    leave the record failed/manual instead of guessing.
   */
  async reconcile(id, {
    owner = 'scanner',
    epoch = this.#epoch,
    now = this.#clock(),
    autoAck = true,
  } = {}) {
    const record = this.#require(id);

    if (record.state === 'acked' || record.state === 'failed') {
      return { record: this.#view(record), action: 'skipped', reason: 'terminal', externalCall: false };
    }

    if (record.state === 'intent') {
      return this.dispatchIntent(id, { owner, epoch, now, autoAck });
    }

    if (record.state === 'sending') {
      // A live lease belongs to some scanner, including a concurrent call with
      // the same owner string. Only an expired lease may be treated as crashed.
      if (record.leaseUntil != null && record.leaseUntil > now) {
        return { record: this.#view(record), action: 'skipped', reason: 'lease_held', externalCall: false };
      }
      this.#markUnknown(record, now, 'sending_timeout');
    }

    if (record.state === 'sent') {
      if (autoAck) this.ack(id, record.receipt, { now });
      return {
        record: this.#view(record),
        action: autoAck ? 'acked' : 'awaiting_ack',
        reason: 'sent',
        externalCall: false,
      };
    }

    if (record.state !== 'unknown') {
      throw new EventsError(
        'invalid_transition',
        `cannot reconcile from ${record.state}`,
        { status: 409 },
      );
    }

    record.lastError ??= 'unknown';

    // Probe first: a lost response must not look like a lost request.
    const probe = typeof this.#transport.lookup === 'function'
      ? await this.#transport.lookup(record.idempotencyKey)
      : null;
    if (probe) {
      this.#transition(record, 'sent', now, 'reconciled_sent');
      record.receipt = { ...probe };
      record.sentAt ??= now;
      record.resolution = 'confirmed_sent';
      record.leaseOwner = null;
      record.leaseUntil = null;
      if (autoAck) this.ack(id, record.receipt, { now });
      return {
        record: this.#view(record),
        action: autoAck ? 'acked' : 'reconciled_sent',
        reason: 'confirmed_sent',
        externalCall: false,
      };
    }

    if (record.sendStartedAt != null && now - record.sendStartedAt < this.#reconcileGraceMs) {
      // Polling during the grace window must not burn the reconciliation budget.
      return { record: this.#view(record), action: 'awaiting_grace', reason: null, externalCall: false };
    }

    record.reconcileAttempts += 1;

    if (record.reconcileAttempts > this.#maxReconcileAttempts) {
      this.#finalizeManual(record, now, 'reconcile_exhausted');
      return { record: this.#view(record), action: 'failed', reason: 'reconcile_exhausted', externalCall: false };
    }

    if (record.resends >= this.#maxResends) {
      this.#finalizeManual(record, now, 'cannot_prove_not_sent');
      return { record: this.#view(record), action: 'failed', reason: 'cannot_prove_not_sent', externalCall: false };
    }

    this.#transition(record, 'intent', now, 'confirmed_not_sent');
    record.sendStartedAt = null;
    record.resends += 1;
    record.nextRetryAt = null;
    record.resolution = 'confirmed_not_sent';
    record.leaseOwner = null;
    record.leaseUntil = null;
    return this.dispatchIntent(id, { owner, epoch, now, autoAck });
  }

  /**
   * Recovery scan: the only writer that turns durable intents into calls.
   * Candidates are non-terminal records whose retry/grace/lease windows allow
   * work. `acked` and `failed` are never selected.
   */
  async scan({
    now = this.#clock(),
    owner = 'scanner',
    epoch = this.#epoch,
    limit = 20,
    autoAck = true,
  } = {}) {
    const candidates = [...this.#records.values()]
      .filter((record) => this.#actionable(record, now, epoch))
      .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit);

    const results = [];
    for (const candidate of candidates) {
      const before = candidate.state;
      let outcome;
      if (before === 'sent') {
        outcome = this.ack(candidate.id, candidate.receipt, { now });
        results.push({
          id: candidate.id,
          before,
          after: outcome.state,
          action: 'acked',
          reason: 'sent_receipt',
          externalCall: false,
        });
        continue;
      }
      outcome = before === 'intent'
        ? await this.dispatchIntent(candidate.id, { owner, epoch, now, autoAck })
        : await this.reconcile(candidate.id, { owner, epoch, now, autoAck });
      results.push({
        id: candidate.id,
        before,
        after: outcome.record.state,
        action: outcome.action,
        reason: outcome.reason ?? null,
        externalCall: outcome.externalCall ?? false,
      });
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Leases and epochs (single-writer protection, PRD 04 §2)
  // -------------------------------------------------------------------------

  claimLease(id, {
    owner = 'scanner',
    epoch = this.#epoch,
    now = this.#clock(),
    leaseMs = this.#leaseMs,
  } = {}) {
    const record = this.#require(id);
    if (TERMINAL.has(record.state)) return false;
    if (epoch != null && record.writerEpoch != null && epoch < record.writerEpoch) return false;
    if (record.leaseUntil != null && record.leaseUntil > now && record.leaseOwner !== owner) return false;
    record.leaseOwner = owner;
    record.leaseUntil = now + leaseMs;
    if (epoch != null) record.writerEpoch = epoch;
    return true;
  }

  releaseLease(id, { owner } = {}) {
    const record = this.#records.get(id);
    if (!record) return false;
    if (owner !== undefined && record.leaseOwner !== owner) return false;
    record.leaseOwner = null;
    record.leaseUntil = null;
    return true;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  get(id) {
    const record = this.#records.get(id);
    return record ? this.#view(record) : null;
  }

  getByIdempotencyKey(idempotencyKey) {
    const record = this.#byKey.get(idempotencyKey);
    return record ? this.#view(record) : null;
  }

  list({ state, intent, taskId } = {}) {
    const wanted = state === undefined ? null : normalizeState(state);
    if (wanted !== null && !STATES.has(wanted)) {
      throw new EventsError('validation_error', `unknown outbox state: ${state}`);
    }
    return [...this.#records.values()]
      .filter((record) => wanted === null || record.state === wanted)
      .filter((record) => intent === undefined || record.intent === intent)
      .filter((record) => taskId === undefined || record.taskId === taskId)
      .map((record) => this.#view(record));
  }

  stats() {
    const byState = Object.fromEntries(OUTBOX_STATES.map((state) => [state, 0]));
    for (const record of this.#records.values()) byState[record.state] += 1;
    return { total: this.#records.size, byState };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #require(id) {
    const record = this.#records.get(id);
    if (!record) {
      throw new EventsError('not_found', `outbox record ${id} not found`, { status: 404 });
    }
    return record;
  }

  #transition(record, to, at, reason) {
    const allowed = OUTBOX_TRANSITIONS[record.state] ?? [];
    if (!allowed.includes(to)) {
      throw new EventsError(
        'invalid_transition',
        `illegal outbox transition ${record.state} -> ${to}`,
        { status: 409 },
      );
    }
    record.state = to;
    record.history.push({ state: to, at, reason });
  }

  #markUnknown(record, at, reason) {
    if (record.state !== 'sending' && record.state !== 'intent') return;
    this.#transition(record, 'unknown', at, reason);
    record.resolution = 'unknown';
    record.leaseOwner = null;
    record.leaseUntil = null;
  }

  #finalizeManual(record, at, reason) {
    this.#transition(record, 'failed', at, reason);
    record.resolution = 'manual';
    record.resolvedAt = at;
    record.leaseOwner = null;
    record.leaseUntil = null;
  }

  #actionable(record, now, epoch) {
    if (TERMINAL.has(record.state)) return false;
    if (record.nextRetryAt != null && record.nextRetryAt > now) return false;
    if (record.leaseUntil != null && record.leaseUntil > now) return false;
    if (epoch != null && record.writerEpoch != null && record.writerEpoch > epoch) return false;
    return true;
  }

  #view(record) {
    return {
      ...record,
      payload: JSON.parse(record.payloadJson),
      receipt: record.receipt ? { ...record.receipt } : null,
      history: record.history.map((entry) => ({ ...entry })),
    };
  }
}

function formatError(error) {
  if (!error) return 'unknown error';
  const code = error.code ?? error.name ?? 'error';
  const message = String(error.message ?? '').slice(0, 200);
  return message ? `${code}: ${message}` : String(code);
}
