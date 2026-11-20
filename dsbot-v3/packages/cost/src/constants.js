/**
 * Stable machine-readable codes and the single supported currency.
 *
 * `budget_exceeded` is the PRD-wide rejection code
 * (`docs/prd/02-api-contract.md` §1, `docs/prd/04-reliability-ops.md` §4.3).
 */
export const COST_CURRENCY = 'CNY';

export const COST_CODES = Object.freeze({
  INVALID_INPUT: 'invalid_input',
  INVALID_CURRENCY: 'invalid_currency',
  DUPLICATE_RUN: 'duplicate_run',
  BUDGET_EXCEEDED: 'budget_exceeded',
});
