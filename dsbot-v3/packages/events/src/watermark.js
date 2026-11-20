import { EventsError } from './errors.js';

// Monotonic event watermark.
//
// `advance()` only moves for the next contiguous sequence number. A higher seq
// may be observed, but it is not "consumed": the caller must buffer it and wait
// for the gap to fill (PRD 04 §2.4.2). This is deliberately stricter than
// `MAX(last_seq, incoming)`: a bridge cursor can skip records, and a watermark
// that jumps over a gap makes the gap unrecoverable.

function requireSeq(seq, field = 'seq') {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new EventsError('validation_error', `${field} must be a non-negative integer`);
  }
  return seq;
}

export class Watermark {
  #value;
  #lastSeen;
  #updatedAt;
  #clock;

  constructor({ start = 0, clock = () => Date.now() } = {}) {
    this.#value = requireSeq(start, 'start');
    this.#lastSeen = this.#value;
    this.#updatedAt = null;
    this.#clock = clock;
  }

  get value() {
    return this.#value;
  }

  get lastSeen() {
    return this.#lastSeen;
  }

  get updatedAt() {
    return this.#updatedAt;
  }

  /** Record that a higher record was seen without consuming it. */
  observe(seq) {
    const value = requireSeq(seq);
    if (value > this.#lastSeen) this.#lastSeen = value;
    return this.#lastSeen;
  }

  /**
   * Try to consume `seq`.
   * - seq === value + 1: advanced
   * - seq <= value: duplicate/stale
   * - seq > value + 1: gap, only `lastSeen` moves
   */
  advance(seq) {
    const value = requireSeq(seq);
    if (value > this.#lastSeen) this.#lastSeen = value;

    if (value <= this.#value) {
      return { advanced: false, duplicate: true, value: this.#value, lastSeen: this.#lastSeen };
    }

    if (value !== this.#value + 1) {
      return {
        advanced: false,
        duplicate: false,
        gap: value - this.#value - 1,
        value: this.#value,
        lastSeen: this.#lastSeen,
      };
    }

    this.#value = value;
    this.#updatedAt = this.#clock();
    return { advanced: true, duplicate: false, value: this.#value, lastSeen: this.#lastSeen };
  }

  snapshot() {
    return {
      value: this.#value,
      lastSeen: this.#lastSeen,
      updatedAt: this.#updatedAt,
    };
  }
}

/** Per-source watermark table for non-session event streams (PRD `event_watermark`). */
export class WatermarkTable {
  #streams = new Map();
  #clock;

  constructor({ clock = () => Date.now() } = {}) {
    this.#clock = clock;
  }

  #stream(source, create = false) {
    if (typeof source !== 'string' || source.length === 0) {
      throw new EventsError('validation_error', 'source is required');
    }
    let stream = this.#streams.get(source);
    if (!stream && create) {
      stream = new Watermark({ clock: this.#clock });
      this.#streams.set(source, stream);
    }
    return stream ?? null;
  }

  get(source) {
    return this.#stream(source)?.snapshot() ?? { value: 0, lastSeen: 0, updatedAt: null };
  }

  advance(source, seq) {
    const stream = this.#stream(source, true);
    return stream.advance(seq);
  }
}
