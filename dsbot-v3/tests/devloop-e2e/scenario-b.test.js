import assert from 'node:assert/strict';
import test from 'node:test';

import { PASS, createFakeWorld, fail } from './support/world.js';

const TASK = {
  id: 'api-r1',
  lane: 'api',
  title: 'api rework iteration',
  goal: 'make the api lane pass verification',
  budgetCny: 30,
};
const FAIL_FEEDBACK = 'the first attempt did not include the regression test';

function scenarioB() {
  return createFakeWorld({
    tasks: [TASK],
    batchSize: 1,
    maxSlots: 1,
    budgetCny: 30,
    loopId: 'scenario-b',
    verdict: (context) =>
      context.task.attempt === 1 ? fail(FAIL_FEEDBACK) : PASS,
  });
}

test('scenario B: a first verification FAIL creates exactly one rework and the second attempt PASSes', async (t) => {
  const world = scenarioB();
  const last = await world.runToTerminal();
  const snapshot = world.snapshot();
  const task = snapshot.tasks['api-r1'];

  assert.equal(last.next, 'done');
  assert.equal(snapshot.state, 'done');
  assert.equal(world.status(), 'completed');
  assert.equal(snapshot.stop, null);
  assert.equal(task.state, 'merged');
  assert.equal(task.reworkCount, 1);
  assert.equal(task.attempt, 2);
  assert.equal(snapshot.stats.reworked, 1);
  assert.equal(snapshot.stats.merged, 1);
  assert.equal(snapshot.lanes.api.reworkRounds, 1);

  // One generated rework task, then the second verification passes.
  assert.equal(world.verifier.verifyCalls.length, 2);
  assert.equal(world.verifier.verifyCalls[0].task.attempt, 1);
  assert.equal(world.verifier.verifyCalls[1].task.attempt, 2);
  const verdicts = world.log
    .flatMap((entry) => entry.actions)
    .filter((action) => action.type === 'verify')
    .map((action) => action.verdict);
  assert.deepEqual(verdicts, ['FAIL', 'PASS']);

  const reworkActions = world.log
    .flatMap((entry) => entry.actions)
    .filter((action) => action.type === 'rework');
  assert.equal(reworkActions.length, 1);
  assert.equal(reworkActions[0].reworkRound, 1);
  assert.equal(reworkActions[0].lane, 'api');
  assert.equal(reworkActions[0].feedback, FAIL_FEEDBACK);

  assert.equal(world.sa.reworkCalls().length, 1);
  assert.equal(world.sa.reworkCalls()[0].reworkRound, 1);
  assert.equal(world.sa.reworkCalls()[0].attempt, 2);
  assert.equal(world.sa.reworkCalls()[0].feedback, FAIL_FEEDBACK);

  assert.equal(world.github.pulls().length, 1);
  assert.equal(world.github.mergedPulls().length, 1);
  assert.equal(world.git.mergeCalls().length, 1);
  assert.deepEqual(
    world.goalEngine.planCalls.map((call) => call.round),
    [1, 2],
  );

  t.diagnostic(
    `scenario B: reworkCount=${task.reworkCount}, verdicts=FAIL/PASS, reworkRounds=${snapshot.lanes.api.reworkRounds}, status=${world.status()}`,
  );
});

test('scenario B: rework is a new attempt on the same PR carrying the verifier feedback', async () => {
  const world = scenarioB();
  await world.runToTerminal();

  const pull = world.github.pulls()[0];
  assert.equal(pull.state, 'merged');
  assert.equal(pull.commits.length, 2);
  assert.notEqual(pull.commits[0], pull.commits[1]);
  assert.deepEqual(pull.commits, [
    'commit-api-r1-a1',
    'commit-api-r1-a2',
  ]);

  const rework = world.sa.reworkCalls()[0];
  assert.equal(rework.pr, pull.number);
  assert.equal(rework.reworkRound, 1);
  assert.equal(rework.attempt, 2);
  assert.equal(rework.feedback, FAIL_FEEDBACK);
  assert.equal(rework.commit, 'commit-api-r1-a2');

  const firstAttempt = world.sa.dispatchCalls()[0];
  assert.equal(firstAttempt.attempt, 1);
  assert.equal(firstAttempt.commit, 'commit-api-r1-a1');
  assert.equal(firstAttempt.id, rework.id);
  assert.equal(firstAttempt.pr, rework.pr);

  const round = world.store.round(1);
  assert.ok(round);
  const reworkInRound = round.actions.filter(
    (action) => action.type === 'rework',
  );
  assert.equal(reworkInRound.length, 1);
  assert.equal(reworkInRound[0].workOrderId, rework.id);
  assert.equal(world.store.round(2).actions.some((a) => a.type === 'rework'), false);
});
