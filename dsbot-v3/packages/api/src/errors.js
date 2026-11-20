import { ServiceError, ERROR_STATUS } from '../../service/src/errors.js';
import { StoreError } from '../../store/src/errors.js';

/**
 * HTTP status for both service and store errors. The service table is
 * authoritative; store errors are mapped to the same PRD codes.
 */
const STORE_STATUS = Object.freeze({
  hierarchy_violation: 409,
  hierarchy_immutable: 409,
  invalid_state_transition: 409,
  state_conflict: 409,
  conflict: 409,
  missing_acceptance: 422,
  validation_error: 422,
  constraint_violation: 422,
  foreign_key_violation: 409,
  not_found: 404,
  schema_version_unsupported: 500,
  migration_failed: 500,
  sqlite_error: 500,
});

export function errorStatus(error) {
  if (error instanceof ServiceError || error instanceof StoreError) {
    return error.status ?? ERROR_STATUS[error.code] ?? STORE_STATUS[error.code] ?? 400;
  }
  return 500;
}

export function toErrorBody(error) {
  const status = errorStatus(error);
  const code = error?.code ?? 'internal_error';
  const message = error?.message ?? 'internal server error';
  const details = error?.details ?? {};
  return {
    status,
    body: {
      code,
      status,
      message,
      details,
      error: { code, status, message, details },
    },
  };
}
