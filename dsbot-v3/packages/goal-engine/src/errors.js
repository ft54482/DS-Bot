/**
 * Domain error for the goal engine.
 *
 * The `code` is stable and machine-readable; `details` is frozen so callers
 * can log it without worrying about later mutation.
 */
export class GoalEngineError extends Error {
  /**
   * @param {string} code one of `ERROR_CODES`
   * @param {string} message human-readable explanation
   * @param {object} [details] extra immutable context for logs
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GoalEngineError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function goalError(code, message, details) {
  return new GoalEngineError(code, message, details);
}
