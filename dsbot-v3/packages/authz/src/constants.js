/**
 * Stable machine-readable codes shared with the PRD error table
 * (`docs/prd/02-api-contract.md` §1).
 */
export const AUTHZ_CODES = Object.freeze({
  AUTHORIZATION_EXCEEDED: 'authorization_exceeded',
  BUDGET_EXCEEDED: 'budget_exceeded',
  RULE_BLOCKED: 'rule_blocked',
});

/**
 * Delegation levels from narrowest to broadest. `max_delegate_level` in a
 * child scope may only stay at or below the parent's rank (AR-3).
 */
export const LEVEL_RANK = Object.freeze({
  execution: 1,
  business: 2,
  goal: 3,
});
