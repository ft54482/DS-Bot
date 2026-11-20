/**
 * L25 loop defaults.
 *
 * The loop config is deliberately small: one lane, one base ref, one worker
 * ceiling, one verifier and the stop-loss thresholds. The values below are the
 * PRD defaults (`docs/prd/03-acceptance-spec.md` §7 and
 * `docs/prd/04-reliability-ops.md` §4.4) and are also the values a config
 * omits.
 */

/** A loop only ever works on top of the integration branch. */
export const BASE_REF = 'origin/main';

/**
 * Worker bounds for one loop. PRD 04 §1.4 caps global concurrency at 4 and the
 * deployment uses `maxWorkers=4`, so 1..4 is the only range a loop config may
 * request. A larger value would promise parallelism the scheduler cannot give.
 */
export const MIN_WORKERS = 1;
export const MAX_WORKERS = 4;

/** Lane name used when the config does not name one. */
export const DEFAULT_LANE = 'main';

/** More than this many rounds means the loop is spinning. */
export const DEFAULT_MAX_ROUNDS = 2;

/** More than this much spend (CNY) means the loop is burning budget. */
export const DEFAULT_MAX_BUDGET = 30;

/** More than this long without progress means the loop is stuck. */
export const DEFAULT_NO_PROGRESS_MINUTES = 30;

/** Stop-loss defaults shared by the config loader and `stopLoss()`. */
export const DEFAULT_STOP_LOSS = Object.freeze({
  maxRounds: DEFAULT_MAX_ROUNDS,
  maxBudget: DEFAULT_MAX_BUDGET,
  noProgressMinutes: DEFAULT_NO_PROGRESS_MINUTES,
});
