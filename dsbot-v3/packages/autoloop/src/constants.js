/**
 * L34 dev-loop policy constants.
 *
 * The rework and budget ceilings deliberately reuse the L25 loop defaults
 * (`packages/loop/src/constants.js`) so the driver and the loop config cannot
 * disagree about "2 rounds" or "30 CNY". The no-progress ceiling is new: the
 * driver counts completed rounds, not wall-clock idle time.
 */

import {
  DEFAULT_MAX_BUDGET,
  DEFAULT_MAX_ROUNDS,
} from '../../loop/src/constants.js';

/** Driver states. `stop` and `done` are terminal. */
export const LOOP_STATES = Object.freeze({
  PLAN: 'plan',
  DISPATCH: 'dispatch',
  COLLECT: 'collect',
  VERIFY: 'verify',
  MERGE: 'merge',
  NEXT: 'next',
  STOP: 'stop',
  DONE: 'done',
});

/** Per-task states inside one loop snapshot. */
export const TASK_STATES = Object.freeze({
  PLANNED: 'planned',
  DISPATCHED: 'dispatched',
  SUBMITTED: 'submitted',
  PASSED: 'passed',
  FAILED: 'failed',
  MERGED: 'merged',
  MERGE_FAILED: 'merge_failed',
  ERROR: 'error',
  STOPPED: 'stopped',
});

/** States that still need driver work. */
export const ACTIVE_TASK_STATES = Object.freeze([
  TASK_STATES.PLANNED,
  TASK_STATES.DISPATCHED,
  TASK_STATES.SUBMITTED,
  TASK_STATES.PASSED,
  TASK_STATES.FAILED,
]);

/** States the driver will never revisit. */
export const TERMINAL_TASK_STATES = Object.freeze([
  TASK_STATES.MERGED,
  TASK_STATES.MERGE_FAILED,
  TASK_STATES.ERROR,
  TASK_STATES.STOPPED,
]);

/** At most 2 rework rounds per lane (issue #75). */
export const DEFAULT_MAX_REWORK_ROUNDS = DEFAULT_MAX_ROUNDS;

/** At most 30 CNY per task (issue #75). */
export const DEFAULT_MAX_TASK_COST_CNY = DEFAULT_MAX_BUDGET;

/** Two consecutive rounds without a merge stop the loop (issue #75). */
export const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 2;

/** Default SuperAgent concurrency used by the sample `sa` adapter. */
export const DEFAULT_MAX_SLOTS = 4;

/** Snapshot schema version. Bump only with a migration. */
export const SNAPSHOT_VERSION = 1;
