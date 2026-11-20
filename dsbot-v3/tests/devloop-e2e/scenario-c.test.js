import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeWorld, fail } from './support/world.js';

function scenarioC() {
  return createFakeWorld({
    tasks: [
      {
        id: 'api-r1',
        lane: 'api',
        title: 'api lane that never turns green',
        goal: 'make the api lane pass verification',
        budgetCny: 30,
      },
    ],
    batchSize: 1,
    maxSlots: 1,
    budgetCny: 30,
    loopId: 'scenario-c',
    verdict: () => fail('the api lane still fails its acceptance command'),
  });
}

test('scenario C: three consecutive lane FAILs stop the loop with rework_exceeded', async (t) => {
  const world = scenarioC();
  const last = await world.runToTerminal();
  const snapshot = world.snapshot();
  const task = snapshot.tasks['api-r1'];

  assert.equal(last.next, 'stop');
  assert.equal(snapshot.state, 'stop');
  assert.equal(world.status(), 'stopped');
  assert.equal(snapshot.stop.reason, 'rework_exceeded');
  assert.equal(snapshot.stop.detail.taskId, 'api-r1');
  assert.equal(snapshot.stop.detail.lane, 'api');
  assert.equal(snapshot.stop.detail.reworkCount, 2);
  assert.equal(snapshot.stop.detail.laneReworkRounds, 2);
  assert.equal(snapshot.stop.detail.maxReworkRounds, 2);

  assert.equal(task.state, 'stopped');
  assert.equal(task.lastError, 'rework_exceeded');
  assert.equal(task.reworkCount, 2);
  assert.equal(snapshot.lanes.api.reworkRounds, 2);

  assert.equal(snapshot.stats.verified, 3);
  assert.equal(snapshot.stats.reworked, 2);
  assert.equal(snapshot.stats.merged, 0);
  assert.equal(snapshot.stats.stopped, 1);

  // Three FAILs are verified, but only two reworks are allowed: the third
  // rework would be round 3 and stops the lane instead of retrying forever.
  assert.equal(world.verifier.verifyCalls.length, 3);
  assert.deepEqual(
    world.verifier.verifyCalls.map((call) => call.task.attempt),
    [1, 2, 3],
  );
  assert.equal(world.sa.reworkCalls().length, 2);
  assert.equal(world.sa.dispatchCalls().length, 1);

  const verdicts = world.log
    .flatMap((entry) => entry.actions)
    .filter((action) => action.type === 'verify')
    .map((action) => action.verdict);
  assert.deepEqual(verdicts, ['FAIL', 'FAIL', 'FAIL']);

  const stop = world.log
    .flatMap((entry) => entry.actions)
    .find((action) => action.type === 'stop');
  assert.equal(stop.reason, 'rework_exceeded');
  assert.equal(stop.detail.lane, 'api');

  // A failed lane never reaches the merger.
  assert.equal(world.git.mergeCalls().length, 0);
  assert.equal(world.github.mergedPulls().length, 0);
  assert.equal(world.github.pulls()[0].state, 'open');
  assert.equal(world.github.pulls()[0].commits.length, 3);

  t.diagnostic(
    `scenario C: verifies=${world.verifier.verifyCalls.length}, reworks=${world.sa.reworkCalls().length}, stop=${snapshot.stop.reason}, lane=${snapshot.stop.detail.lane}`,
  );
});

test('scenario C: the stopped lane is not retried and the stop replays without more work', async () => {
  const world = scenarioC();
  await world.runToTerminal();

  const before = {
    verify: world.verifier.verifyCalls.length,
    rework: world.sa.reworkCalls().length,
    dispatch: world.sa.dispatchCalls().length,
    merge: world.git.mergeCalls().length,
    steps: world.log.length,
  };

  const replay = await world.step();

  assert.equal(replay.state, 'stop');
  assert.equal(replay.next, 'stop');
  assert.equal(replay.actions.length, 1);
  assert.equal(replay.actions[0].type, 'stop');
  assert.equal(replay.actions[0].reason, 'rework_exceeded');
  assert.equal(replay.actions[0].replay, true);

  assert.equal(world.verifier.verifyCalls.length, before.verify);
  assert.equal(world.sa.reworkCalls().length, before.rework);
  assert.equal(world.sa.dispatchCalls().length, before.dispatch);
  assert.equal(world.git.mergeCalls().length, before.merge);
  assert.equal(world.log.length, before.steps + 1);

  const snapshot = world.snapshot();
  assert.equal(snapshot.state, 'stop');
  assert.equal(snapshot.tasks['api-r1'].state, 'stopped');
  assert.equal(snapshot.stop.reason, 'rework_exceeded');
  assert.equal(snapshot.stats.verified, 3);
});
