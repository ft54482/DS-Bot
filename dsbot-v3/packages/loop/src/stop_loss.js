/**
 * `stopLoss({ lane, rounds, budgetSpent, lastProgressAt, now })` answers one
 * question: should this loop stop now, and why?
 *
 * The three PRD guards are evaluated in a fixed order, and the first one that
 * fires supplies the reason:
 *
 *  1. `rounds > maxRounds`          → `rounds_exceeded`
 *  2. `budgetSpent > maxBudget`     → `budget_exceeded`
 *  3. `now - lastProgressAt > maxNoProgress` → `no_progress`
 *
 * All comparisons are strict: exactly 2 rounds, exactly 30 CNY or exactly
 * 30 minutes without progress do not stop the loop.
 *
 * Timestamps may be epoch milliseconds, `Date` objects or ISO-8601 strings.
 * `limits` is optional and overrides the defaults; this is how a loaded loop
 * config passes its own `stopLoss` block:
 *
 *     stopLoss({ ...sample, limits: config.stopLoss })
 */

import { DEFAULT_STOP_LOSS } from './constants.js';

/**
 * @param {{
 *   lane?: string,
 *   rounds: number,
 *   budgetSpent: number,
 *   lastProgressAt: number | Date | string,
 *   now: number | Date | string,
 *   limits?: { maxRounds?: number, maxBudget?: number, noProgressMinutes?: number },
 * }} input
 * @returns {{stop: boolean, reason: 'rounds_exceeded' | 'budget_exceeded' | 'no_progress' | null}}
 */
export function stopLoss(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('stopLoss expects a plain object');
  }

  const { rounds, budgetSpent, lastProgressAt, now } = input;

  if (input.lane !== undefined && (typeof input.lane !== 'string' || input.lane.trim() === '')) {
    throw new TypeError('stopLoss lane must be a non-empty string when supplied');
  }
  if (!Number.isInteger(rounds) || rounds < 0) {
    throw new TypeError('stopLoss rounds must be a non-negative integer');
  }
  if (!Number.isFinite(budgetSpent) || budgetSpent < 0) {
    throw new TypeError('stopLoss budgetSpent must be a non-negative number');
  }

  const limits = normalizeLimits(input.limits);
  const nowMs = parseTimestamp(now, 'now');
  const progressMs = parseTimestamp(lastProgressAt, 'lastProgressAt');

  if (rounds > limits.maxRounds) {
    return { stop: true, reason: 'rounds_exceeded' };
  }
  if (budgetSpent > limits.maxBudget) {
    return { stop: true, reason: 'budget_exceeded' };
  }
  if (nowMs - progressMs > limits.noProgressMinutes * 60_000) {
    return { stop: true, reason: 'no_progress' };
  }

  return { stop: false, reason: null };
}

function normalizeLimits(limits) {
  if (limits === undefined) return { ...DEFAULT_STOP_LOSS };
  if (!isPlainObject(limits)) {
    throw new TypeError('stopLoss limits must be a plain object');
  }

  const result = { ...DEFAULT_STOP_LOSS };

  if (limits.maxRounds !== undefined) {
    if (!Number.isInteger(limits.maxRounds) || limits.maxRounds < 1) {
      throw new TypeError('stopLoss limits.maxRounds must be an integer >= 1');
    }
    result.maxRounds = limits.maxRounds;
  }

  if (limits.maxBudget !== undefined) {
    if (!Number.isFinite(limits.maxBudget) || limits.maxBudget <= 0) {
      throw new TypeError('stopLoss limits.maxBudget must be a number > 0');
    }
    result.maxBudget = limits.maxBudget;
  }

  if (limits.noProgressMinutes !== undefined) {
    if (!Number.isFinite(limits.noProgressMinutes) || limits.noProgressMinutes <= 0) {
      throw new TypeError('stopLoss limits.noProgressMinutes must be a number > 0');
    }
    result.noProgressMinutes = limits.noProgressMinutes;
  }

  return result;
}

function parseTimestamp(value, name) {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (Number.isFinite(milliseconds)) return milliseconds;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return milliseconds;
  }

  throw new TypeError(
    `stopLoss ${name} must be epoch milliseconds, a Date or an ISO timestamp`,
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
