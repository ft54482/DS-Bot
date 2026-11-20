/**
 * Uniform tool result contract.
 *
 * Every tool returns a plain result object instead of throwing across the agent
 * boundary: an unauthorized action must be observable and testable
 * (`not_allowed`, `authorization_exceeded`, `budget_exceeded`), not an
 * exception a caller could mistake for a transport failure.
 */

import { AGENT_CODES } from './constants.js';

export function ok(tool, payload = {}) {
  return { ok: true, tool, ...payload };
}

export function fail(code, message, details = undefined) {
  const result = { ok: false, code, message };
  if (details !== undefined) result.details = details;
  return result;
}

export function notAllowed(role, tool, message) {
  return fail(
    AGENT_CODES.NOT_ALLOWED,
    message ?? `${role} is not allowed to call ${tool}`,
    { role, tool },
  );
}

export function authorizationExceeded(message, details = undefined) {
  return fail(AGENT_CODES.AUTHORIZATION_EXCEEDED, message, details);
}

export function budgetExceeded(message, details = undefined) {
  return fail(AGENT_CODES.BUDGET_EXCEEDED, message, details);
}

export function validationError(message, details = undefined) {
  return fail(AGENT_CODES.VALIDATION_ERROR, message, details);
}

/**
 * Map a thrown error (service guard, store, adapter) onto the result contract.
 * The original machine-readable code is preserved so callers see `not_found`,
 * `invalid_state_transition`, `acceptance_incomplete`, ... unchanged.
 */
export function fromError(error, fallbackCode = 'tool_error') {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : fallbackCode;
  const result = fail(code, error?.message ?? String(error));
  if (error?.details !== undefined) result.details = error.details;
  return result;
}

/** Run a synchronous tool body, converting unexpected throws into results. */
export function guard(fn, fallbackCode = 'tool_error') {
  try {
    return fn();
  } catch (error) {
    return fromError(error, fallbackCode);
  }
}

/** Async counterpart of `guard`. */
export async function guardAsync(fn, fallbackCode = 'tool_error') {
  try {
    return await fn();
  } catch (error) {
    return fromError(error, fallbackCode);
  }
}
