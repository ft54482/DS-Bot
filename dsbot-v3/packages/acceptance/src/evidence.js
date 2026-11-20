import { sha256Hex } from './canonical.js';

const SHA256_HEX = /^[a-f0-9]{64}$/i;

function normalizeKind(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.\s-]+/g, '_');
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalise evidence records without reading anything outside the argument.
 *
 * Accepted record shape (all fields optional except a recognised `kind` for
 * the stage-specific gates):
 *
 *   {
 *     id: 'evd-commit',
 *     kind: 'commit' | 'test_output' | ...,
 *     content: '<UTF-8 text the hash is computed over>',
 *     sha256: '<64 hex; optional but verified when present>',
 *     exitCode: 0,            // test evidence only; snake_case also accepted
 *     verdict: 'pass' | 'fail' | 'blocked',
 *     ok: true | false,
 *   }
 *
 * `kind`/`type`, `sha256`/`hash` and `exitCode`/`exit_code` aliases keep the
 * engine usable with the PRD's snake_case evidence payloads.
 */
export function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) {
    throw new TypeError('evidence must be an array of evidence records');
  }
  return evidence.map((entry, index) => {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    const declared = record.sha256 ?? record.hash ?? null;
    return {
      index,
      id: normalizeText(record.id) || `evidence[${index}]`,
      kind: normalizeKind(record.kind ?? record.type),
      content: record.content,
      declaredSha256: declared,
      exitCode: record.exitCode ?? record.exit_code,
      ok: record.ok,
      passed: record.passed,
      verdict: record.verdict ?? record.result,
    };
  });
}

/**
 * Verify an optional `sha256` binding against the record's own content.
 *
 * A record without a declared hash is accepted (the hash binding is optional);
 * once a hash is declared it must be a 64-hex SHA-256 of the supplied UTF-8
 * content. Any mismatch, malformed hash or missing content makes the evidence
 * `invalid`, which the engine turns into `blocked` rather than pass or rework.
 */
export function verifyEvidence(record) {
  if (record.declaredSha256 === null || record.declaredSha256 === undefined) {
    return { valid: true };
  }
  if (typeof record.declaredSha256 !== 'string') {
    return { valid: false, reason: 'invalid sha256: must be a 64-character hex string' };
  }
  const declared = record.declaredSha256.trim().replace(/^sha256:/i, '');
  if (!SHA256_HEX.test(declared)) {
    return { valid: false, reason: 'invalid sha256: must be a 64-character hex string' };
  }
  if (typeof record.content !== 'string') {
    return { valid: false, reason: 'invalid sha256 binding: evidence content is not a UTF-8 string' };
  }
  const actual = sha256Hex(record.content);
  if (actual !== declared.toLowerCase()) {
    return {
      valid: false,
      reason: `invalid sha256: declared ${declared.toLowerCase()} does not match content hash ${actual}`,
    };
  }
  return { valid: true };
}

/** Latest record of one of the accepted kinds (append-only retries win). */
export function latestEvidence(records, kinds) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (kinds.has(records[index].kind)) return records[index];
  }
  return null;
}

export function describeRecord(record) {
  return record.kind === '' ? record.id : `${record.id} (${record.kind})`;
}
