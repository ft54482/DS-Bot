/**
 * L36 independent PR verification agent.
 *
 * One pure decision entry point, `verify()`, driven by an injected runner.
 * Read `./README.md` for the runner contract and
 * `node --test packages/verifier-agent/test` for the acceptance evidence.
 */

export { verify } from './verify.js';
export { countCases } from './cases.js';
export { isFullSha, normalizeAllowedDir, normalizeChangedPath, outOfScope } from './paths.js';
export {
  DEFAULT_MIN_CASES,
  MAX_ISOLATION_ATTEMPTS,
  RESULT_FIELDS,
  VERDICTS,
} from './constants.js';
