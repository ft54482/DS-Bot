/**
 * Budget min-chain gate.
 *
 * PRD: `docs/prd/02-api-contract.md` §4.2 and
 * `docs/prd/04-reliability-ops.md` §1.6. The effective cap is the smallest of
 * the task cap, the parent's remaining budget and the bot-scope cap. When the
 * caller supplies a requested/reserved/spent amount, the gate also verifies
 * that the resulting commitment still fits under that cap and otherwise
 * returns `budget_exceeded`.
 *
 * Pure: no clock, IO or mutation. Amounts are CNY numbers.
 */

import { AUTHZ_CODES } from './constants.js';
import { isPlainObject } from './values.js';

/** Tolerance for decimal CNY arithmetic (0.1 + 0.2 is still one cap). */
const EPSILON = 1e-9;

function readCap(input, key) {
  const value = input[key];
  if (value == null || value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${key} must be a non-negative finite number, null or Infinity`);
  }
  return value;
}

function readAmount(input, key) {
  const value = input[key];
  if (value == null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${key} must be a non-negative finite number`);
  }
  return value;
}

/**
 * @param {object} input
 * @param {number|null} [input.taskCap] this task's cap
 * @param {number|null} [input.parentRemaining] parent's remaining budget
 * @param {number|null} [input.botCap] bot-scope spend cap
 * @param {number} [input.requested] amount to spend/reserve now (default 0)
 * @param {number} [input.spent] already spent amount (default 0)
 * @param {number} [input.reserved] already reserved amount (default 0)
 * @returns {{ok: true, cap: number, remaining: number} | {ok: false, code: 'budget_exceeded', cap: number, requested: number, spent: number, reserved: number, committed: number, remaining: number, reason: 'cap_exceeded'}}
 * @throws {TypeError} on malformed input
 */
export function effectiveBudget(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('budget input must be a plain object');
  }

  const cap = Math.min(
    readCap(input, 'taskCap'),
    readCap(input, 'parentRemaining'),
    readCap(input, 'botCap'),
  );
  const requested = readAmount(input, 'requested');
  const spent = readAmount(input, 'spent');
  const reserved = readAmount(input, 'reserved');
  const committed = spent + reserved + requested;
  const remaining = Number.isFinite(cap) ? Math.max(0, cap - committed) : Number.POSITIVE_INFINITY;

  if (committed - cap > EPSILON) {
    return {
      ok: false,
      code: AUTHZ_CODES.BUDGET_EXCEEDED,
      cap,
      requested,
      spent,
      reserved,
      committed,
      remaining: 0,
      reason: 'cap_exceeded',
    };
  }

  return { ok: true, cap, remaining };
}
