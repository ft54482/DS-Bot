/**
 * Stop-loss predicates for the L34 driver.
 *
 * Three independent limits are enforced:
 *
 *  1. a lane may receive at most `maxReworkRounds` rework dispatches;
 *  2. one task may spend at most `maxTaskCostCny` CNY;
 *  3. `maxNoProgressRounds` consecutive completed rounds without a merge stop.
 *
 * Rework and budget limits stop the whole loop because the driver has no safe
 * way to keep spending on a task or lane it is not allowed to continue. The
 * reason and the offending task/lane travel in the stop detail so a caller can
 * escalate without re-reading the snapshot.
 */

import {
  DEFAULT_MAX_NO_PROGRESS_ROUNDS,
  DEFAULT_MAX_REWORK_ROUNDS,
  DEFAULT_MAX_TASK_COST_CNY,
} from './constants.js';

/**
 * @param {{
 *   maxReworkRounds?: number,
 *   maxTaskCostCny?: number,
 *   maxNoProgressRounds?: number,
 * }} [options]
 */
export function resolveLimits(options = {}) {
  return {
    maxReworkRounds: positiveInteger(
      options.maxReworkRounds,
      DEFAULT_MAX_REWORK_ROUNDS,
      'maxReworkRounds',
    ),
    maxTaskCostCny: positiveNumber(
      options.maxTaskCostCny,
      DEFAULT_MAX_TASK_COST_CNY,
      'maxTaskCostCny',
    ),
    maxNoProgressRounds: positiveInteger(
      options.maxNoProgressRounds,
      DEFAULT_MAX_NO_PROGRESS_ROUNDS,
      'maxNoProgressRounds',
    ),
  };
}

/** Budget is exceeded only above the cap: exactly 30 CNY is still allowed. */
export function isTaskOverBudget(task, limits) {
  return Number.isFinite(task.costCny) && task.costCny > limits.maxTaskCostCny;
}

/**
 * A task or its lane has used every allowed rework round. The next rework
 * would be round 3, so the loop must stop instead of dispatching it.
 */
export function isReworkExhausted(task, laneReworkRounds, limits) {
  return (
    task.reworkCount >= limits.maxReworkRounds ||
    laneReworkRounds >= limits.maxReworkRounds
  );
}

/** Two consecutive no-merge rounds are enough to stop. */
export function isNoProgressExhausted(noProgressRounds, limits) {
  return noProgressRounds >= limits.maxNoProgressRounds;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`createLoop ${name} must be an integer >= 1`);
  }
  return value;
}

function positiveNumber(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`createLoop ${name} must be a number > 0`);
  }
  return value;
}
