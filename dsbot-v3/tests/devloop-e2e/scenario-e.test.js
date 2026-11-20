import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeWorld } from './support/world.js';

const TASK = (lane) => ({
  id: `${lane}-r1`,
  lane,
  title: `${lane} iteration`,
  goal: `advance the ${lane} lane`,
  budgetCny: 30,
});

test('scenario E: resume after a kill does not dispatch an in-flight task twice', async (t) => {
  const world = createFakeWorld({
    tasks: [TASK('api'), TASK('worker')],
    batchSize: 2,
    maxSlots: 2,
    budgetCny: 30,
    loopId: 'scenario-e1',
  });

  const planned = await world.step();
  assert.equal(planned.state, 'plan');
  assert.equal(planned.next, 'dispatch');

  const dispatched = await world.step();
  assert.equal(dispatched.state, 'dispatch');
  assert.equal(dispatched.next, 'collect');

  const beforeKill = world.snapshot();
  assert.equal(beforeKill.state, 'collect');
  const inFlight = Object.values(beforeKill.tasks)
    .filter((task) => task.state === 'dispatched')
    .map((task) => ({ taskId: task.id, workOrderId: task.workOrderId }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  assert.equal(inFlight.length, 2);
  assert.equal(world.sa.dispatchCalls().length, 2);
  assert.equal(world.github.pulls().length, 2);

  // Kill: drop the driver and build a new one over the same store and fakes.
  const second = world.restart();
  const resumed = await second.resume();
  assert.equal(resumed.state, 'collect');
  assert.equal(resumed.actions[0].type, 'resume');
  assert.deepEqual(
    [...resumed.actions[0].inFlight].sort((left, right) =>
      left.taskId.localeCompare(right.taskId),
    ),
    inFlight,
  );
  assert.equal(world.sa.dispatchCalls().length, 2);
  assert.equal(world.store.latest().state, 'collect');

  const logStart = world.log.length;
  const last = await world.runToTerminal();
  assert.equal(last.next, 'done');
  assert.equal(world.status(), 'completed');

  const afterResume = world.log.slice(logStart);
  const dispatchAfterResume = afterResume
    .flatMap((entry) => entry.actions)
    .filter((action) => action.type === 'dispatch');
  assert.deepEqual(dispatchAfterResume, []);

  assert.equal(world.sa.dispatchCalls().length, 2);
  assert.equal(world.verifier.verifyCalls.length, 2);
  assert.equal(world.git.mergeCalls().length, 2);
  assert.equal(world.github.mergedPulls().length, 2);

  const final = world.snapshot();
  assert.equal(final.state, 'done');
  assert.ok(
    Object.values(final.tasks).every((task) => task.state === 'merged'),
  );

  t.diagnostic(
    `scenario E: dispatches=${world.sa.dispatchCalls().length}, merges=${world.git.mergeCalls().length}, status=${world.status()}`,
  );
});

test('scenario E: resume after a completed merge does not merge the same PR twice', async (t) => {
  const world = createFakeWorld({
    tasks: [TASK('api')],
    batchSize: 1,
    maxSlots: 1,
    budgetCny: 30,
    loopId: 'scenario-e2',
  });

  await world.step(); // plan
  await world.step(); // dispatch
  await world.step(); // collect
  await world.step(); // verify
  const merged = await world.step(); // merge
  assert.equal(merged.state, 'merge');
  assert.equal(merged.next, 'next');

  const snapshot = world.snapshot();
  assert.equal(snapshot.state, 'next');
  assert.equal(snapshot.tasks['api-r1'].state, 'merged');
  assert.equal(world.git.mergeCalls().length, 1);
  assert.equal(world.github.mergedPulls().length, 1);
  assert.equal(world.github.mergeEvents().length, 1);

  const pull = world.github.pulls()[0];
  assert.equal(pull.state, 'merged');
  assert.equal(pull.commits.length, 1);

  // Kill after the merge was persisted, then resume at the next state.
  const second = world.restart();
  const resumed = await second.resume();
  assert.equal(resumed.state, 'next');
  assert.equal(resumed.actions[0].type, 'resume');
  assert.equal(world.git.mergeCalls().length, 1);
  assert.equal(world.github.mergedPulls().length, 1);

  const logStart = world.log.length;
  const last = await world.runToTerminal();
  assert.equal(last.next, 'done');
  assert.equal(world.snapshot().state, 'done');
  assert.equal(world.status(), 'completed');

  assert.equal(world.git.mergeCalls().length, 1);
  assert.equal(world.github.mergeEvents().length, 1);
  assert.equal(world.github.mergedPulls().length, 1);
  assert.equal(world.snapshot().tasks['api-r1'].state, 'merged');

  const afterResume = world.log.slice(logStart);
  const afterActions = afterResume.flatMap((entry) => entry.actions);
  assert.deepEqual(
    afterActions.filter((action) => action.type === 'merge'),
    [],
  );
  assert.deepEqual(
    afterActions.filter((action) => action.type === 'dispatch'),
    [],
  );

  t.diagnostic(
    `scenario E: merges=${world.git.mergeCalls().length}, mergeEvents=${world.github.mergeEvents().length}, status=${world.status()}`,
  );
});
