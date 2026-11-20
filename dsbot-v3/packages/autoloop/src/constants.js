/**
 * L34 dev-loop policy constants.
 *
 * The rework and budget ceilings deliberately match the L25 loop defaults
 * (`packages/loop/src/constants.js`) so the driver and the loop config cannot
 * disagree about "2 rounds" or "30 CNY". They are restated here instead of
 * imported across package boundaries: the driver ships as its own npm package
 * and must load from `node_modules/@dsbot/autoloop` without the L25 source
 * tree next to it. `test/policy.test.js` pins the values back to the L25
 * defaults in a checkout, so a change there fails the driver suite.
 */

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

/** At most 2 rework rounds per lane (issue #75); equals L25 `DEFAULT_MAX_ROUNDS`. */
export const DEFAULT_MAX_REWORK_ROUNDS = 2;

/** At most 30 CNY per task (issue #75); equals L25 `DEFAULT_MAX_BUDGET`. */
export const DEFAULT_MAX_TASK_COST_CNY = 30;

/** Two consecutive rounds without a merge stop the loop (issue #75). */
export const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 2;

/** Default SuperAgent concurrency used by the sample `sa` adapter. */
export const DEFAULT_MAX_SLOTS = 4;

/** Snapshot schema version. Bump only with a migration. */
export const SNAPSHOT_VERSION = 1;
