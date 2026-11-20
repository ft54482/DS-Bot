import { MAX_BACKOFF_MS } from './constants.js';
import { asGatewayError } from './errors.js';

/**
 * Run `operation(attempt)` and retry once (default) with exponential backoff.
 * `onError(error, attempt)` may downgrade retryability (e.g. after a bridge
 * prompt was already accepted, retrying would duplicate work).
 */
export async function retryOperation(operation, options) {
  const maxRetries = options.maxRetries;
  const backoffMs = options.backoffMs;
  const clock = options.clock;
  let attempt = 0;
  for (;;) {
    try {
      return await operation(attempt);
    } catch (error) {
      const normalized = asGatewayError(error);
      const mapped = typeof options.onError === 'function' ? options.onError(normalized, attempt) : normalized;
      if (attempt >= maxRetries || mapped.retryable !== true) throw mapped;
      const retryAfterMs = Number.isFinite(mapped.retryAfterMs) ? mapped.retryAfterMs : null;
      const delay =
        retryAfterMs === null ? Math.min(backoffMs * 2 ** attempt, MAX_BACKOFF_MS) : Math.min(retryAfterMs, MAX_BACKOFF_MS);
      await clock.sleep(delay);
      attempt += 1;
    }
  }
}
