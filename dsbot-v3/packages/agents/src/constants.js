/**
 * Role tool surfaces (PRD FR-14, `docs/prd/02-api-contract.md` §5).
 *
 * The Chief coordinates goals and delegations; the business bot plans and
 * dispatches execution work inside its own scope. The two surfaces are
 * deliberately disjoint apart from `accept`: a Chief may only decide the goal
 * round, a business bot may only decide its own business/execution rounds.
 */

export const AGENT_ROLES = Object.freeze({
  CHIEF: 'chief',
  BUSINESS: 'business',
});

export const ROLE_TOOLS = Object.freeze({
  chief: Object.freeze(['delegate', 'status', 'accept', 'stop', 'cost']),
  business: Object.freeze(['plan', 'dispatch', 'accept', 'rework']),
});

export const ALL_AGENT_TOOLS = Object.freeze([
  ...new Set([...ROLE_TOOLS.chief, ...ROLE_TOOLS.business]),
]);

export const AGENT_CODES = Object.freeze({
  /** The role does not own this tool at all (hierarchy violation). */
  NOT_ALLOWED: 'not_allowed',
  /** The request leaves the caller's delegated scope. */
  AUTHORIZATION_EXCEEDED: 'authorization_exceeded',
  /** The request would cross a budget cap or an exhausted cap. */
  BUDGET_EXCEEDED: 'budget_exceeded',
  /** Malformed tool input; no side effect was attempted. */
  VALIDATION_ERROR: 'validation_error',
});

/** Task levels a role may touch through a tool. */
export const ROLE_TASK_LEVELS = Object.freeze({
  chief: Object.freeze({ accept: Object.freeze(['goal']) }),
  business: Object.freeze({
    accept: Object.freeze(['business', 'execution']),
    rework: Object.freeze(['business', 'execution']),
    dispatch: Object.freeze(['execution']),
    plan: Object.freeze(['business']),
  }),
});
