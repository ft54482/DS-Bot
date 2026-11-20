/**
 * Stable failure shape for the source client.
 *
 * Codes:
 *   - http_error        non-2xx response (all 4xx/5xx are retried)
 *   - timeout           one attempt exceeded `timeoutMs` (retried)
 *   - network_error     transport failure before a status was read (retried)
 *   - invalid_response  body was not JSON / not the expected envelope
 *   - invalid_item      an item body missed or malformed a required field
 *
 * `invalid_response` and `invalid_item` are structural and are never retried;
 * retrying an unchanged malformed body would only hide the defect.
 */
export class SourceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SourceError';
    this.code = code;
    this.retryable = options.retryable === true;
    if (options.status !== undefined) this.status = options.status;
    if (options.url !== undefined) this.url = options.url;
    if (options.attempts !== undefined) this.attempts = options.attempts;
    if (options.missing !== undefined) this.missing = options.missing;
    if (options.invalid !== undefined) this.invalid = options.invalid;
    if (options.index !== undefined) this.index = options.index;
  }
}
