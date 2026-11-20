/**
 * Public surface of `@ds-bot/pipelines-sources` (L43).
 *
 * The module takes a self-media topic pack from an injected HTTP transport
 * without fetching full text (D-04), and cross-checks two sources before the
 * pack is used.
 */

export {
  DEFAULT_BACKOFF_MS,
  DEFAULT_ENDPOINTS,
  DEFAULT_LIMIT,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_LIMIT,
  SOURCE_ITEM_KEYS,
  createSourceClient,
  sha256Hex,
} from './client.js';

export { CROSS_CHECK_FIELDS, crossCheck } from './cross-check.js';

export { SourceError } from './errors.js';
