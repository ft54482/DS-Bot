/**
 * `@ds-bot/bridge` public surface.
 *
 * `createBridge({baseUrl, fetch})` is the only constructor; env/error helpers
 * are exported for wiring and for tests that need to prove the mapping without
 * a network call.
 */

export {
  DEFAULT_DISPATCH_PATH,
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  PRD_ERRORS,
  PRD_ERROR_EXTENSIONS,
  PRD_ERROR_NAMES,
  ALL_PRD_ERRORS,
} from './constants.js';
export { createBridge } from './bridge.js';
export { classifyHttpStatus, isPrdErrorCode, mapError } from './errors.js';
export { envDigest, normalizeAllowlist, pickAllowedEnv } from './env.js';
