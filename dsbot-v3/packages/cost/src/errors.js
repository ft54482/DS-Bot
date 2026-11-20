/**
 * Domain error for the cost ledger.
 *
 * The `code` is stable and machine-readable; malformed input and refused
 * recordings both use it so callers never have to parse an English message.
 */
export class CostError extends Error {
  /**
   * @param {string} code one of `COST_CODES`
   * @param {string} message human-readable explanation
   * @param {object} [details] extra immutable context for logs
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CostError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function costError(code, message, details) {
  return new CostError(code, message, details);
}
