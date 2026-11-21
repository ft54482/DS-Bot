/**
 * Stable error codes for the devloop bundle.
 *
 * Callers branch on `error.code` and never parse a message. The codes mirror
 * the underlying engines where they have an equivalent (`empty_goal`,
 * `budget_exceeded`) and add the plugin-level vocabulary (`loop_exists`,
 * `loop_not_found`, `ambiguous_loop`, `missing_dependency`,
 * `provision_failed`, `loop_error`).
 */

export const ERROR_CODES = Object.freeze({
  invalidInput: 'invalid_input',
  emptyGoal: 'empty_goal',
  loopExists: 'loop_exists',
  budgetExceeded: 'budget_exceeded',
  loopNotFound: 'loop_not_found',
  ambiguousLoop: 'ambiguous_loop',
  missingDependency: 'missing_dependency',
  provisionFailed: 'provision_failed',
  loopError: 'loop_error',
});

/** One structured devloop failure. */
export class DevloopError extends Error {
  /**
   * @param {string} code machine-readable code from {@link ERROR_CODES}
   * @param {string} message human-readable message
   * @param {object} [details] machine-readable context
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DevloopError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Build a {@link DevloopError}; kept as a function so call sites stay short.
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {DevloopError}
 */
export function devloopError(code, message, details = undefined) {
  return new DevloopError(code, message, details);
}
