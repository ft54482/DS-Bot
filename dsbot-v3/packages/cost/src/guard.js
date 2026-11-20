/**
 * Min-chain budget guard.
 *
 * The effective cap is the smallest of the task cap, the parent's remaining
 * budget and the bot-scope cap; a missing (`null`/`undefined`/`Infinity`) link
 * does not constrain. Spend and an optional prospective request are checked
 * against that cap with a small decimal tolerance.
 *
 * PRD: `docs/prd/02-api-contract.md` §4.2 and
 * `docs/prd/04-reliability-ops.md` §1.6/§4.3.
 */

import { COST_CODES } from './constants.js';
import { EPSILON, assertPlainObject, readAmount, readCap, roundCny } from './values.js';

/**
 * @param {object} input
 * @param {number|null} [input.taskCap] this task's cap
 * @param {number|null} [input.parentRemaining] parent's remaining budget
 * @param {number|null} [input.botCap] bot-scope spend cap
 * @param {number} [input.spent] already spent on the task (default 0)
 * @param {number} [input.requested] amount to commit now (default 0)
 * @returns {{allowed: boolean, effectiveCap: number, reason: 'budget_exceeded'|null}}
 * @throws {import('./errors.js').CostError} on malformed input
 */
export function guard(input = {}) {
  assertPlainObject(input, 'guard input');

  const taskCap = readCap(input.taskCap, 'taskCap');
  const parentRemaining = readCap(input.parentRemaining, 'parentRemaining');
  const botCap = readCap(input.botCap, 'botCap');
  const spent = input.spent === undefined ? 0 : readAmount(input.spent, 'spent');
  const requested = input.requested === undefined ? 0 : readAmount(input.requested, 'requested');

  const effectiveCap = Math.min(taskCap, parentRemaining, botCap);
  const committed = roundCny(spent + requested);
  const allowed = !Number.isFinite(effectiveCap) || committed - effectiveCap <= EPSILON;

  return {
    allowed,
    effectiveCap,
    reason: allowed ? null : COST_CODES.BUDGET_EXCEEDED,
  };
}
