/**
 * L20 bridge constants.
 *
 * The ten base error names come from `docs/prd/02-api-contract.md` §1. The
 * `rate_limited` code is the documented 429 extension in
 * `docs/prd/04-reliability-ops.md` §9 (also named in 05 §3), kept separate so
 * the PRD table is not silently widened.
 */

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MIN_TIMEOUT_MS = 1;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_DISPATCH_PATH = '/v1/dispatch';

export const PRD_ERRORS = Object.freeze({
  invalid_state_transition: Object.freeze({ status: 409, category: 'conflict' }),
  missing_acceptance: Object.freeze({ status: 422, category: 'validation' }),
  version_mismatch: Object.freeze({ status: 409, category: 'conflict' }),
  hierarchy_violation: Object.freeze({ status: 409, category: 'conflict' }),
  authorization_exceeded: Object.freeze({ status: 403, category: 'authorization' }),
  budget_exceeded: Object.freeze({ status: 402, category: 'budget' }),
  scope_denied: Object.freeze({ status: 403, category: 'authorization' }),
  rule_blocked: Object.freeze({ status: 403, category: 'rule' }),
  executor_unavailable: Object.freeze({
    status: 503,
    category: 'unavailable',
    retryable: true,
    requires_idempotency_key: true,
    side_effects_possible: true,
  }),
  duplicate_dispatch: Object.freeze({ status: 409, category: 'conflict' }),
});

/** PRD-documented extension: 429 rate_limited (04 §9, 05 §3). */
export const PRD_ERROR_EXTENSIONS = Object.freeze({
  rate_limited: Object.freeze({ status: 429, category: 'rate_limited', retryable: true, extension: true }),
});

export const ALL_PRD_ERRORS = Object.freeze({ ...PRD_ERRORS, ...PRD_ERROR_EXTENSIONS });

export const PRD_ERROR_NAMES = Object.freeze(Object.keys(PRD_ERRORS));

/**
 * Environment keys a dispatch may forward to the task runtime by default.
 *
 * Deliberately excludes credentials and code-injection keys (`NODE_OPTIONS`,
 * `PYTHONSTARTUP`, ...). Callers that need more must pass an explicit
 * `envAllowlist`; nothing from the host environment is forwarded implicitly.
 */
export const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'PYTHONPATH',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HOME',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
]);
