import { createHash } from 'node:crypto';

import { EventsError } from './errors.js';

// Canonical JSON and request fingerprints.
//
// The outbox stores the normalized request (`payload_json`) and its SHA-256
// (`payload_sha256`). A repeated idempotency key is only a replay when the
// fingerprint matches; a different payload for the same key is a conflict
// (PRD 02 `duplicate_dispatch`, PRD 04 §2.2).

function normalize(value, path, seen) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new EventsError('validation_error', `${path} must be a finite number`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new EventsError('validation_error', `${path} must not be circular`);
    }
    seen.add(value);
    const normalized = value.map((entry, index) => (
      entry === undefined ? null : normalize(entry, `${path}[${index}]`, seen)
    ));
    seen.delete(value);
    return normalized;
  }

  if (type === 'object') {
    if (seen.has(value)) {
      throw new EventsError('validation_error', `${path} must not be circular`);
    }
    seen.add(value);
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      normalized[key] = normalize(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return normalized;
  }

  throw new EventsError(
    'validation_error',
    `${path} contains an unsupported ${type} value`,
  );
}

/** Deterministic JSON: object keys sorted, no whitespace, JSON scalar rules. */
export function canonicalJson(value) {
  return JSON.stringify(normalize(value, 'payload', new WeakSet()));
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Normalize a payload and return both its canonical text and fingerprint. */
export function normalizePayload(payload = {}) {
  const payloadJson = canonicalJson(payload);
  return { payloadJson, payloadSha256: sha256Hex(payloadJson) };
}

/** Fingerprint of canonical JSON text (used to compare stored payloads). */
export function fingerprintJson(payloadJson) {
  if (typeof payloadJson !== 'string') {
    throw new EventsError('validation_error', 'payloadJson must be a string');
  }
  return sha256Hex(payloadJson);
}
