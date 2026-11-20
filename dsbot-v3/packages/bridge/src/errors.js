/**
 * Error conversion: bridge/transport codes -> PRD error names.
 *
 * `docs/prd/02-api-contract.md` §1 is the authoritative name table. Bridge
 * native codes come from `docs/prd/04-reliability-ops.md` §0.3
 * (`BAD_REQUEST/NOT_FOUND/FORBIDDEN_WORKSPACE/RATE_LIMITED/HOST_ERROR`).
 *
 * A converted error keeps both sides visible: `code` is what the peer sent,
 * `prd` is the canonical PRD name (or `null` when no PRD name exists). The
 * category, retryability and side-effect flag follow 04 §2.3: only clean
 * rejections are safe to treat as failed; timeouts/5xx/unknown may have been
 * applied and must be reconciled before redispatch.
 */

import { ALL_PRD_ERRORS } from './constants.js';

const CODE_ALIASES = Object.freeze({
  BAD_REQUEST: Object.freeze({ prd: 'invalid_state_transition', category: 'client', http_status: 400 }),
  NOT_FOUND: Object.freeze({ prd: 'invalid_state_transition', category: 'not_found', http_status: 404 }),
  FORBIDDEN_WORKSPACE: Object.freeze({ prd: 'scope_denied', category: 'authorization', http_status: 403 }),
  RATE_LIMITED: Object.freeze({ prd: 'rate_limited', category: 'rate_limited', http_status: 429 }),
  HOST_ERROR: Object.freeze({ prd: 'executor_unavailable', category: 'unavailable', http_status: 502 }),
  TIMEOUT: Object.freeze({ prd: 'executor_unavailable', category: 'transient', http_status: 504 }),
  NETWORK_ERROR: Object.freeze({ prd: 'executor_unavailable', category: 'transient', http_status: 502 }),
  BAD_RESPONSE: Object.freeze({
    prd: 'executor_unavailable',
    category: 'unknown',
    http_status: 502,
    retryable: false,
  }),
  UNAUTHORIZED: Object.freeze({ prd: 'authorization_exceeded', category: 'authorization', http_status: 401 }),
  FORBIDDEN: Object.freeze({ prd: 'scope_denied', category: 'authorization', http_status: 403 }),
  BUDGET_EXCEEDED: Object.freeze({ prd: 'budget_exceeded', category: 'budget', http_status: 402 }),
});

const HTTP_FALLBACKS = Object.freeze({
  400: Object.freeze({ prd: 'invalid_state_transition', category: 'client' }),
  401: Object.freeze({ prd: 'authorization_exceeded', category: 'authorization' }),
  402: Object.freeze({ prd: 'budget_exceeded', category: 'budget' }),
  403: Object.freeze({ prd: 'scope_denied', category: 'authorization' }),
  404: Object.freeze({ prd: 'invalid_state_transition', category: 'not_found' }),
  409: Object.freeze({ prd: 'invalid_state_transition', category: 'conflict' }),
  422: Object.freeze({ prd: 'missing_acceptance', category: 'validation' }),
  429: Object.freeze({ prd: 'rate_limited', category: 'rate_limited', retryable: true }),
});

const TRANSIENT_4XX = new Set([408, 425]);

function statusClassOf(status) {
  if (!Number.isInteger(status)) return null;
  return `${Math.trunc(status / 100)}xx`;
}

function normalizeCodeString(value) {
  return String(value).trim().replace(/[\s-]+/g, '_').toUpperCase();
}

function fromPrd(name, options = {}) {
  const meta = ALL_PRD_ERRORS[name];
  const httpStatus = options.http_status ?? meta.status;
  return {
    input: options.input ?? null,
    code: options.code ?? name,
    prd: name,
    prd_status: meta.status,
    http_status: httpStatus,
    status_class: statusClassOf(httpStatus),
    category: options.category ?? meta.category,
    retryable: options.retryable ?? meta.retryable ?? false,
    requires_idempotency_key: options.requires_idempotency_key ?? meta.requires_idempotency_key ?? false,
    side_effects_possible: options.side_effects_possible ?? meta.side_effects_possible ?? false,
    message: options.message ?? null,
    extension: meta.extension === true,
  };
}

function unknownResult(input, message = null, code = null) {
  return {
    input: input ?? null,
    code,
    prd: null,
    prd_status: null,
    http_status: null,
    status_class: null,
    category: 'unknown',
    retryable: false,
    requires_idempotency_key: true,
    side_effects_possible: true,
    message,
    extension: false,
  };
}

function fromCode(rawCode, options = {}) {
  const normalized = normalizeCodeString(rawCode);
  const lower = normalized.toLowerCase();
  if (Object.hasOwn(ALL_PRD_ERRORS, lower)) {
    return fromPrd(lower, {
      input: options.input,
      code: lower,
      http_status: options.http_status ?? null,
      message: options.message,
    });
  }
  const alias = CODE_ALIASES[normalized];
  if (alias) {
    return fromPrd(alias.prd, {
      input: options.input,
      code: normalized,
      http_status: options.http_status ?? alias.http_status ?? null,
      category: alias.category,
      retryable: alias.retryable,
      requires_idempotency_key: alias.requires_idempotency_key,
      side_effects_possible: alias.side_effects_possible,
      message: options.message,
    });
  }
  const result = unknownResult(options.input, options.message ?? null, normalized);
  if (Number.isFinite(options.http_status)) {
    result.http_status = options.http_status;
    result.status_class = statusClassOf(options.http_status);
  }
  return result;
}

/**
 * Classify an HTTP status without guessing a body code.
 * 4xx are clean rejections, except 408/425/429 which are retryable.
 * 5xx and invalid statuses may have been applied; reconcile before retrying.
 */
export function classifyHttpStatus(status) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    return {
      status: status ?? null,
      status_class: 'invalid',
      prd: null,
      category: 'unknown',
      retryable: false,
      requires_idempotency_key: true,
      side_effects_possible: true,
    };
  }
  const statusClass = statusClassOf(code);
  if (statusClass === '2xx') {
    return {
      status: code,
      status_class: statusClass,
      prd: null,
      category: 'ok',
      retryable: false,
      requires_idempotency_key: false,
      side_effects_possible: false,
    };
  }
  if (statusClass === '3xx') {
    return {
      status: code,
      status_class: statusClass,
      prd: null,
      category: 'redirect',
      retryable: false,
      requires_idempotency_key: false,
      side_effects_possible: false,
    };
  }
  if (statusClass === '5xx') {
    return {
      status: code,
      status_class: statusClass,
      prd: 'executor_unavailable',
      category: 'unavailable',
      retryable: true,
      requires_idempotency_key: true,
      side_effects_possible: true,
    };
  }
  if (statusClass === '1xx') {
    return {
      status: code,
      status_class: statusClass,
      prd: null,
      category: 'informational',
      retryable: false,
      requires_idempotency_key: false,
      side_effects_possible: false,
    };
  }
  if (TRANSIENT_4XX.has(code)) {
    return {
      status: code,
      status_class: statusClass,
      prd: 'executor_unavailable',
      category: 'transient',
      retryable: true,
      requires_idempotency_key: true,
      side_effects_possible: true,
    };
  }
  const fallback = HTTP_FALLBACKS[code];
  if (fallback) {
    return {
      status: code,
      status_class: statusClass,
      prd: fallback.prd,
      category: fallback.category,
      retryable: fallback.retryable ?? false,
      requires_idempotency_key: fallback.requires_idempotency_key ?? false,
      side_effects_possible: fallback.side_effects_possible ?? false,
    };
  }
  return {
    status: code,
    status_class: statusClass,
    prd: null,
    category: 'client',
    retryable: false,
    requires_idempotency_key: false,
    side_effects_possible: false,
  };
}

function fromStatus(status, options = {}) {
  const classified = classifyHttpStatus(status);
  const code = options.code ?? `http_${Number(status)}`;
  if (classified.prd) {
    return fromPrd(classified.prd, {
      input: options.input,
      code,
      http_status: classified.status,
      category: classified.category,
      retryable: classified.retryable,
      requires_idempotency_key: classified.requires_idempotency_key,
      side_effects_possible: classified.side_effects_possible,
      message: options.message,
    });
  }
  return {
    input: options.input ?? null,
    code,
    prd: null,
    prd_status: null,
    http_status: classified.status,
    status_class: classified.status_class,
    category: classified.category,
    retryable: classified.retryable,
    requires_idempotency_key: classified.requires_idempotency_key,
    side_effects_possible: classified.side_effects_possible,
    message: options.message ?? null,
    extension: false,
  };
}

/**
 * Convert a bridge/HTTP/transport error into the PRD vocabulary.
 * Accepts a code string, an HTTP status number, or `{code,status,message}`.
 */
export function mapError(input) {
  if (input === null || input === undefined) return unknownResult(input);
  if (typeof input === 'number') return fromStatus(input, { input });
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return unknownResult(input);
    if (/^[1-5]\d\d$/.test(trimmed)) return fromStatus(Number(trimmed), { input });
    return fromCode(trimmed, { input });
  }
  if (typeof input !== 'object') return unknownResult(input);

  const rawStatus = input.status ?? input.http_status ?? input.httpStatus ?? null;
  const status = rawStatus === null || rawStatus === undefined || rawStatus === '' ? null : Number(rawStatus);
  const observed = Number.isFinite(status) ? status : null;
  const message = input.message ?? input.error?.message ?? null;
  const rawCode = input.code ?? input.error_code ?? input.errorCode ?? input.error?.code ?? null;

  if (typeof rawCode === 'string' && rawCode.trim().length > 0) {
    const byCode = fromCode(rawCode, { input, message, http_status: observed });
    if (byCode.prd !== null || observed === null) return byCode;
  }
  if (observed !== null) {
    const code = typeof rawCode === 'string' && rawCode.trim().length > 0 ? rawCode : null;
    return fromStatus(observed, { input, message, code });
  }
  return unknownResult(input, message);
}

export function isPrdErrorCode(value) {
  if (typeof value !== 'string') return false;
  return Object.hasOwn(ALL_PRD_ERRORS, normalizeCodeString(value).toLowerCase());
}
