/**
 * Vocabulary for the Chief coordination layer (PRD §5, two management levels,
 * one execution level).
 *
 * The Chief owns goals and business delegations only. Execution dispatch stays
 * with the business BOT, so `not_allowed` is part of this package's public
 * contract, not an accidental error.
 */

export const CHIEF_CODES = Object.freeze({
  /** The Chief tried to take an action that belongs to another level. */
  NOT_ALLOWED: 'not_allowed',
  /** `delegate` named a professional BOT that was not registered. */
  UNKNOWN_BOT: 'unknown_bot',
  /** A goal/delegation request crossed a budget cap. */
  BUDGET_EXCEEDED: 'budget_exceeded',
  /** `deliver` cannot produce a package before every business acceptance passes. */
  BLOCKED: 'blocked',
  /** The goal id does not exist. */
  NOT_FOUND: 'not_found',
  /** Malformed input; no side effect was attempted. */
  VALIDATION_ERROR: 'validation_error',
  /** The request leaves the delegated scope. */
  AUTHORIZATION_EXCEEDED: 'authorization_exceeded',
  /** Unexpected failure that could not be classified. */
  TOOL_ERROR: 'tool_error',
});

/**
 * Goal acceptance profile. The task service requires a signed
 * `human.goal_signoff` item for every goal-level acceptance (PRD §5.3), so the
 * profile always carries it. `mustConfirm` only decides whether `deliver`
 * surfaces the confirmation as a pending decision.
 */
export const GOAL_ACCEPTANCE_PROFILE = Object.freeze({
  id: 'chief.goal_v1',
  version: 1,
  items: Object.freeze([
    Object.freeze({ key: 'human.goal_signoff', class: 'human', required: true }),
  ]),
});

export const CHIEF_TOOLS = Object.freeze([
  'openGoal',
  'delegate',
  'status',
  'deliver',
  'dispatchExecution',
]);
