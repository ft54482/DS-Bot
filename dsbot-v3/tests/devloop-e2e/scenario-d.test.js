import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeWorld, fail } from './support/world.js';

const BUDGET_CNY = 10;

function scenarioD() {
  return createFakeWorld({
    tasks: [
      {
        id: 'api-r1',
        lane: 'api',
        title: 'api lane with a hard budget',
        goal: 'make the api lane pass without exceeding its budget',
        budgetCny: BUDGET_CNY,
      },
    ],
    batchSize: 1,
    maxSlots: 1,
    budgetCny: BUDGET_CNY,
    maxTaskCostCny: BUDGET_CNY,
    costOf: () => 6,
    loopId: 'scenario-d',
    verdict: () => fail('the first submission needs another attempt'),
  });
}

test('scenario D: cumulative spend over budgetCny stops the loop with budget_exceeded', async (t) => {
  const world = scenarioD();
  const last = await world.runToTerminal();
  const snapshot = world.snapshot();
  const task = snapshot.tasks['api-r1'];

  assert.equal(last.next, 'stop');
  assert.equal(snapshot.state, 'stop');
  assert.equal(world.status(), 'stopped');
  assert.equal(snapshot.stop.reason, 'budget_exceeded');
  assert.equal(snapshot.stop.detail.taskId, 'api-r1');
  assert.equal(snapshot.stop.detail.lane, 'api');
  assert.equal(snapshot.stop.detail.costCny, 12);
  assert.equal(snapshot.stop.detail.capCny, BUDGET_CNY);

  assert.equal(world.loop.config.maxTaskCostCny, BUDGET_CNY);
  assert.equal(task.budgetCny, BUDGET_CNY);
  assert.equal(task.costCny, 12);
  assert.equal(task.state, 'stopped');
  assert.equal(task.lastError, 'budget_exceeded');
  assert.equal(snapshot.spentCny, 12);
  assert.ok(snapshot.spentCny > BUDGET_CNY);

  const submissions = world.log
    .flatMap((entry) => entry.actions)
    .filter((action) => action.type === 'submission');
  assert.deepEqual(
    submissions.map((action) => action.costCny),
    [6, 6],
  );
  assert.equal(
    submissions.reduce((total, action) => total + action.costCny, 0),
    snapshot.spentCny,
  );

  // The second submission is collected, then the cumulative guard stops the
  // loop before a second verification or any merge.
  assert.equal(world.verifier.verifyCalls.length, 1);
  assert.equal(world.sa.reworkCalls().length, 1);
  assert.equal(world.git.mergeCalls().length, 0);
  assert.equal(world.github.mergedPulls().length, 0);
  assert.equal(world.github.pulls()[0].state, 'open');

  const stop = world.log
    .flatMap((entry) => entry.actions)
    .find((action) => action.type === 'stop');
  assert.equal(stop.reason, 'budget_exceeded');
  assert.equal(stop.detail.costCny, 12);

  t.diagnostic(
    `scenario D: spentCny=${snapshot.spentCny}, capCny=${BUDGET_CNY}, stop=${snapshot.stop.reason}, merges=${snapshot.stats.merged}`,
  );
});

test('scenario D: the budget stop is terminal and does not spend or dispatch more', async () => {
  const world = scenarioD();
  await world.runToTerminal();

  const before = {
    spent: world.snapshot().spentCny,
    verify: world.verifier.verifyCalls.length,
    rework: world.sa.reworkCalls().length,
    dispatch: world.sa.dispatchCalls().length,
    merge: world.git.mergeCalls().length,
  };

  const replay = await world.step();

  assert.equal(replay.state, 'stop');
  assert.equal(replay.next, 'stop');
  assert.equal(replay.actions[0].type, 'stop');
  assert.equal(replay.actions[0].reason, 'budget_exceeded');
  assert.equal(replay.actions[0].replay, true);

  assert.equal(world.snapshot().spentCny, before.spent);
  assert.equal(world.verifier.verifyCalls.length, before.verify);
  assert.equal(world.sa.reworkCalls().length, before.rework);
  assert.equal(world.sa.dispatchCalls().length, before.dispatch);
  assert.equal(world.git.mergeCalls().length, before.merge);
  assert.equal(world.snapshot().tasks['api-r1'].state, 'stopped');
});
