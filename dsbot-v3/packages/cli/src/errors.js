/**
 * Error helpers for the operator CLI.
 *
 * The PRD error table is owned by `packages/service`; the CLI reuses it instead
 * of keeping a second copy. A runtime error that already carries a numeric
 * `status` wins, so a facade can surface a PRD code without the CLI knowing it.
 */
import { ERROR_STATUS } from '../../service/src/errors.js';

export class CliError extends Error {
  constructor(code, message, details = {}, status = ERROR_STATUS[code] ?? 500) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function cliError(code, message, details = {}, status = ERROR_STATUS[code] ?? 500) {
  return new CliError(code, message, details, status);
}

export function isKnownErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS, code);
}

/**
 * Resolve the PRD/HTTP status for any thrown error.
 *
 * A status supplied by the runtime (e.g. a `ServiceError` from `packages/service`)
 * is authoritative; otherwise the shared PRD error table is consulted.
 */
export function statusOf(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    return error.status;
  }
  if (typeof error?.code === 'string' && isKnownErrorCode(error.code)) {
    return ERROR_STATUS[error.code];
  }
  return 500;
}

/** Plain, serialisable error payload used by `--json` and the text formatter. */
export function toErrorPayload(error) {
  const status = statusOf(error);
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal_error';
  const message =
    typeof error?.message === 'string' && error.message !== ''
      ? error.message
      : 'internal server error';
  const details =
    error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
      ? error.details
      : {};
  return { code, status, message, details };
}

/**
 * Process exit code for an error status.
 *
 * PRD client errors (403/409/422, also 404/402) are surfaced verbatim so shell
 * callers and the JSON payload agree on the code. Server errors collapse to 1.
 * Note: POSIX shells only carry 8 bits, so 409/422 are exact on Windows and are
 * truncated by a POSIX shell; `--json` always carries the exact `error.status`.
 */
export function exitCodeForStatus(status) {
  if (!Number.isInteger(status)) return 1;
  return status >= 400 && status < 500 ? status : 1;
}

export function internalError(message, details = {}) {
  return cliError('internal_error', message, details, 500);
}

export function notFoundError(message, details = {}) {
  return cliError('not_found', message, details, 404);
}
