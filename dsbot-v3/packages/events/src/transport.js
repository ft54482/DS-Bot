import { OUTBOX_INTENTS } from './constants.js';
import { EventsError, ToolError, TransportError } from './errors.js';

// In-memory transport used by tests and by the demo composition.
//
// It deliberately keeps two ledgers: `calls` (how many times the outbox invoked
// it) and `executions` (how many times the handler produced a side effect). The
// reliable-dispatch invariant is about the latter: a repeated delivery of the
// same idempotency key is answered from the receipt cache, so the external
// effect happens once even if the response was lost and the outbox retried.
export class InMemoryTransport {
  #handler;
  #clock;
  #deliveries = new Map();
  #executionsByKey = new Map();
  #inflight = new Map();
  #failBeforeDelivery = new Map();
  #failAfterDelivery = new Map();

  constructor({
    handler = () => ({ accepted: true }),
    clock = () => Date.now(),
  } = {}) {
    if (typeof handler !== 'function') {
      throw new EventsError('validation_error', 'handler must be a function');
    }
    this.#handler = handler;
    this.#clock = clock;
    this.calls = [];
    this.duplicates = 0;
  }

  get executions() {
    let total = 0;
    for (const count of this.#executionsByKey.values()) total += count;
    return total;
  }

  async send(request = {}) {
    const { idempotencyKey, intent } = request;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new EventsError('validation_error', 'idempotencyKey is required');
    }
    if (!OUTBOX_INTENTS.includes(intent)) {
      throw new EventsError('validation_error', `unknown intent: ${intent}`);
    }

    const at = this.#clock();
    this.calls.push({ idempotencyKey, intent, at, attempt: request.attempt ?? null });

    const delivered = this.#deliveries.get(idempotencyKey);
    if (delivered) {
      this.duplicates += 1;
      return { ...delivered.receipt };
    }

    // Concurrent sends of the same key share one execution. The outbox already
    // serializes per record, but the transport guarantee must hold on its own.
    const inflight = this.#inflight.get(idempotencyKey);
    if (inflight) {
      this.duplicates += 1;
      return { ...(await inflight) };
    }

    const pending = this.#deliver(request);
    this.#inflight.set(idempotencyKey, pending);
    try {
      return { ...(await pending) };
    } finally {
      this.#inflight.delete(idempotencyKey);
    }
  }

  async #deliver(request) {
    const { idempotencyKey } = request;

    const before = this.#failBeforeDelivery.get(idempotencyKey);
    if (before) {
      this.#failBeforeDelivery.delete(idempotencyKey);
      throw before;
    }

    const raw = (await this.#handler({ ...request })) ?? { accepted: true };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new EventsError('validation_error', 'transport handler must return an object receipt');
    }
    const receipt = { ...raw };
    this.#deliveries.set(idempotencyKey, { receipt, at: this.#clock() });
    this.#executionsByKey.set(
      idempotencyKey,
      (this.#executionsByKey.get(idempotencyKey) ?? 0) + 1,
    );

    const after = this.#failAfterDelivery.get(idempotencyKey);
    if (after) {
      this.#failAfterDelivery.delete(idempotencyKey);
      throw after;
    }

    return receipt;
  }

  /** Side-effect probe used by reconciliation; never triggers the handler. */
  lookup(idempotencyKey) {
    const delivered = this.#deliveries.get(idempotencyKey);
    return delivered ? { ...delivered.receipt } : null;
  }

  callsFor(idempotencyKey) {
    return this.calls.filter((call) => call.idempotencyKey === idempotencyKey).length;
  }

  executionsFor(idempotencyKey) {
    return this.#executionsByKey.get(idempotencyKey) ?? 0;
  }

  /** Fail the next send for `key` before the handler runs (request never landed). */
  failBeforeDeliveryOnce(key, error = new TransportError('transport_error', 'connection refused')) {
    this.#failBeforeDelivery.set(key, error);
    return this;
  }

  /** Execute the handler, then fail: the side effect landed but the response was lost. */
  failAfterDeliveryOnce(key, error = new TransportError('response_lost', 'response lost after delivery')) {
    this.#failAfterDelivery.set(key, error);
    return this;
  }

  reset() {
    this.calls = [];
    this.duplicates = 0;
    this.#deliveries.clear();
    this.#executionsByKey.clear();
    this.#inflight.clear();
    this.#failBeforeDelivery.clear();
    this.#failAfterDelivery.clear();
  }
}

export { ToolError, TransportError };
