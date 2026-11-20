import { ERROR_CODES } from './constants.js';

const RETRYABLE_CODES = new Set([
  ERROR_CODES.rate_limited,
  ERROR_CODES.upstream_error,
]);

/** Error raised by every gateway failure; `code` is stable, `message` is sanitized. */
export class GatewayError extends Error {
  constructor(code, message, options = {}) {
    super(String(message));
    this.name = 'GatewayError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.status = Number.isFinite(options.status) ? options.status : null;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
    };
  }
}

export function gatewayError(code, message, options = {}) {
  return new GatewayError(code, message, {
    retryable: options.retryable ?? RETRYABLE_CODES.has(code),
    status: options.status,
    retryAfterMs: options.retryAfterMs,
  });
}

/** Normalize anything thrown by a backend/transport into a GatewayError. */
export function asGatewayError(error, fallbackCode = ERROR_CODES.upstream_error) {
  if (error instanceof GatewayError) return error;
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  return gatewayError(fallbackCode, message);
}

export function isRetryableStatus(status) {
  return status === 429 || (Number.isFinite(status) && status >= 500);
}

/** Map one non-2xx HTTP status to the gateway error vocabulary. */
export function errorFromStatus(status, backend, detail = null) {
  const suffix = detail === null ? '' : `: ${detail}`;
  if (status === 401 || status === 403) {
    return gatewayError(ERROR_CODES.auth_failed, `${backend} authentication failed (HTTP ${status})${suffix}`, {
      status,
      retryable: false,
    });
  }
  if (status === 429) {
    return gatewayError(ERROR_CODES.rate_limited, `${backend} is rate limited (HTTP 429)${suffix}`, {
      status,
      retryable: true,
    });
  }
  if (isRetryableStatus(status)) {
    return gatewayError(ERROR_CODES.upstream_error, `${backend} returned HTTP ${status}${suffix}`, {
      status,
      retryable: true,
    });
  }
  return gatewayError(ERROR_CODES.upstream_error, `${backend} returned HTTP ${status}${suffix}`, {
    status,
    retryable: false,
  });
}
