/**
 * Input readers shared by the ledger and the guard.
 *
 * Values are never coerced: a string cap is a programming error, not `10`.
 * Decimal CNY arithmetic uses a tiny epsilon so `0.1 + 0.2` still fits `0.3`.
 */

import { COST_CODES } from './constants.js';
import { costError } from './errors.js';

export const EPSILON = 1e-9;

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw costError(COST_CODES.INVALID_INPUT, `${label} must be a plain object`);
  }
}

export function readId(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw costError(COST_CODES.INVALID_INPUT, `${field} must be a non-empty string`);
  }
  return value;
}

export function readTokenCount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw costError(
      COST_CODES.INVALID_INPUT,
      'tokens must be a non-negative safe integer',
    );
  }
  return value;
}

/** Read a non-negative finite CNY amount. Negative values are refunds: never legal. */
export function readAmount(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw costError(
      COST_CODES.INVALID_INPUT,
      `${field} must be a non-negative finite number`,
    );
  }
  return value;
}

/** `null`, `undefined` and `Infinity` mean "no cap on this link". */
export function readCap(value, field) {
  if (value === undefined || value === null || value === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw costError(
      COST_CODES.INVALID_INPUT,
      `${field} must be a non-negative finite number, null or Infinity`,
    );
  }
  return value;
}

/** Round a CNY total for display without changing the gate comparison. */
export function roundCny(value) {
  return Number(value.toFixed(6));
}
