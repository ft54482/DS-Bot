import test from 'node:test';

import {
  RUN_STATES,
  TASK_STATES,
  ACCEPTANCE_STATES,
} from '../../packages/service/src/index.js';
import {
  expectDeepEqual,
  expectFalse,
  expectOneOf,
  expectStatus,
  expectTrue,
} from './support/conformance.js';
import {
  createExecutor,
  createTree,
  openRuntime,
  reportClaim,
  startApi,
  startRun,
} from './support/harness.js';

/** Task names fixed by `docs/prd/03-acceptance-spec.md` §10.1 (+ 00-PRD C6). */
const TASK_NAMES = Object.freeze([
  'planned',
  'queued',
  'running',
  'accepting',
  'reworking',
  'stopping',
  'completed',
  'blocked',
  'paused',
  'cancelled',
]);

/** Run names fixed by `docs/prd/03-acceptance-spec.md` §10.2. */
const RUN_NAMES = Object.freeze([
  'queued',
  'dispatched',
  'dispatch_unknown',
  'running',
  'reported',
  'accepted',
  'rejected',
  'invalidated',
  'superseded',
  'failed',
  'cancelled',
  'lost',
  'timed_out',
]);

/** Names 03 §10 replaces; keeping any of them would be a second vocabulary. */
const RETIRED_TASK_NAMES = Object.freeze(['draft', 'awaiting_acceptance', 'done', 'rework']);
const RETIRED_RUN_NAMES = Object.freeze(['created', 'completed', 'stalled', 'quarantined', 'cancelling']);

test('[PRD 03 §10.1] task states are the canonical names, with no second vocabulary', () => {
  expectDeepEqual(
    '03 §10.1',
    'task state set',
    [...TASK_STATES].sort(),
    [...TASK_NAMES].sort(),
  );
  for (const retired of RETIRED_TASK_NAMES) {
    expectFalse('03 §10.1', `retired task name ${retired} must not exist`, TASK_STATES.includes(retired));
  }
  expectTrue('03 §10.1', 'stopping is a first-class state', TASK_STATES.includes('stopping'));
});

test('[PRD 03 §10.2] run states are the canonical names, with no second vocabulary', () => {
  expectDeepEqual(
    '03 §10.2',
    'run state set',
    [...RUN_STATES].sort(),
    [...RUN_NAMES].sort(),
  );
  for (const retired of RETIRED_RUN_NAMES) {
    expectFalse('03 §10.2', `retired run name ${retired} must not exist`, RUN_STATES.includes(retired));
  }
  expectTrue(
    '03 §10.2',
    'author completion is reported, not completed',
    RUN_STATES.includes('reported') && !RUN_STATES.includes('completed'),
  );
});

test('[PRD 03 §10 + 02 §2.2] the HTTP API projects only canonical task/run/acceptance names', async (t) => {
  const { adapter } = createExecutor();
  const { runtime } = openRuntime(t, { adapter });
  const { execution } = createTree(runtime);

  const url = await startApi(t, runtime);
  const planned = await expectStatus(
    '03 §10',
    'task read before dispatch',
    await fetch(`${url}/v1/tasks/${execution.id}`),
    200,
  );
  expectOneOf('03 §10', 'task name from the API', planned.state, TASK_STATES);

  const { run } = await startRun(runtime, execution.id);
  const claimed = await reportClaim(runtime, run.id, 'state-names');

  const afterClaim = await expectStatus(
    '03 §10',
    'task read after the claim',
    await fetch(`${url}/v1/tasks/${execution.id}`),
    200,
  );
  expectOneOf('03 §10', 'task name from the API after claim', afterClaim.state, TASK_STATES);
  expectOneOf('03 §10', 'run name from the API after claim', afterClaim.runs[0].state, RUN_STATES);
  expectOneOf(
    '03 §10',
    'acceptance name from the API after claim',
    afterClaim.open_acceptance.state,
    ACCEPTANCE_STATES,
  );
  expectDeepEqual(
    '03 §10',
    'API and service agree on the task name',
    afterClaim.state,
    runtime.tasks.get(execution.id).state,
  );
  expectDeepEqual(
    '03 §10',
    'API and service agree on the run name',
    afterClaim.runs[0].state,
    runtime.runs.get(claimed.run.id).state,
  );
});
