/**
 * Typed service errors.
 *
 * Every guard failure maps to the error codes used by `docs/prd/02-api-contract.md`
 * (HTTP semantics), so a transport layer can translate `error.status` directly.
 */
export const ERROR_STATUS = Object.freeze({
  invalid_state_transition: 409,
  state_conflict: 409,
  version_mismatch: 409,
  missing_acceptance: 422,
  acceptance_incomplete: 422,
  claim_invalid: 422,
  validation_error: 422,
  hierarchy_violation: 409,
  idempotency_conflict: 409,
  duplicate_dispatch: 409,
  run_already_reported: 409,
  forbidden_transition: 403,
  stop_unverified: 409,
  not_found: 404,
});

export class ServiceError extends Error {
  constructor(code, message, details = {}, httpStatus = ERROR_STATUS[code] ?? 400) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = httpStatus;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      details: this.details,
    };
  }
}

export function serviceError(code, message, details = {}, httpStatus = ERROR_STATUS[code] ?? 400) {
  return new ServiceError(code, message, details, httpStatus);
}

export function isServiceError(error, code) {
  return error instanceof ServiceError && (code === undefined || error.code === code);
}
