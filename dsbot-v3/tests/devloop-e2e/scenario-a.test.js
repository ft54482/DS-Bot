import assert from 'node:assert/strict';
import test from 'node:test';

import { decomposeGoalIntoLanes } from './support/goal.js';
import { PASS, createFakeWorld } from './support/world.js';

const LANE_INPUTS = [
  { lane: 'api', dir: 'packages/api', cost: 2 },
  { lane: 'worker', dir: 'packages/service', cost: 2 },
  { lane: 'ui', dir: 'tests/e2e', cost: 2 },
];

function scenarioA() {
  const tasks = decomposeGoalIntoLanes({
    title: 'Ship three lanes through the fake dev loop',
    lanes: LANE_INPUTS,
    budget: 30,
  });
  return createFakeWorld({
    goal: 'Ship three lanes through the fake dev loop',
    tasks,
    batchSize: 1,
    maxSlots: 3,
    budgetCny: 30,
    loopId: 'scenario-a',
    verdict: () => PASS,
  });
}

test('scenario A: a three-lane goal advances through three rounds and ends completed', async (t) => {
  const world = scenarioA();
  const last = await world.runToTerminal();
  const snapshot = world.snapshot();

  assert.equal(last.next, 'done');
  assert.equal(snapshot.state, 'done');
  assert.equal(world.status(), 'completed');
  assert.equal(snapshot.goalDone, true);
  assert.equal(snapshot.stop, null);

  // The shipped goal engine produced one task book per lane.
  assert.equal(world.tasks.length, 3);
  assert.deepEqual(
    world.tasks.map((task) => task.lane),
    ['api', 'worker', 'ui'],
  );
  assert.ok(
    world.tasks.every(
      (task) =>
        task.taskBook.allowedPaths.length > 0 &&
        task.taskBook.workBase.sha.length === 40,
    ),
  );

  // Three work rounds plus the final done plan.
  assert.deepEqual(
    world.goalEngine.planCalls.map((call) => call.round),
    [1, 2, 3, 4],
  );
  assert.equal(world.rounds, 3);

  const tasks = Object.values(snapshot.tasks);
  assert.equal(tasks.length, 3);
  assert.deepEqual(
    [...new Set(tasks.map((task) => task.lane))].sort(),
    ['api', 'ui', 'worker'],
  );
  assert.ok(tasks.every((task) => task.state === 'merged'));

  assert.deepEqual(snapshot.stats, {
    dispatched: 3,
    submitted: 3,
    verified: 3,
    merged: 3,
    reworked: 0,
    failed: 0,
    stopped: 0,
  });
  assert.equal(snapshot.spentCny, 6);
  assert.equal(world.github.pulls().length, 3);
  assert.equal(world.github.mergedPulls().length, 3);
  assert.equal(world.verifier.verifyCalls.length, 3);
  assert.equal(world.sa.dispatchCalls().length, 3);
  assert.equal(world.sa.reworkCalls().length, 0);
  assert.equal(world.git.mergeCalls().length, 3);

  // "Next round" is explicit: every work round routes back to plan, and each
  // round carries the next decomposed lane.
  const actions = world.log.flatMap((entry) => entry.actions);
  assert.deepEqual(
    actions
      .filter((action) => action.type === 'plan')
      .map((action) => action.taskIds),
    [['api'], ['worker'], ['ui'], []],
  );
  assert.deepEqual(
    actions
      .filter((action) => action.type === 'dispatch')
      .map((action) => action.lane),
    ['api', 'worker', 'ui'],
  );
  assert.deepEqual(
    actions
      .filter((action) => action.type === 'merge')
      .map((action) => action.lane),
    ['api', 'worker', 'ui'],
  );

  const nextRoutes = actions
    .filter((action) => action.type === 'next')
    .map((action) => action.route);
  assert.deepEqual(nextRoutes, ['plan', 'plan', 'plan']);
  assert.ok(actions.some((action) => action.type === 'goal_done'));

  t.diagnostic(
    `scenario A: rounds=${world.rounds}, lanes=${world.tasks
      .map((task) => task.lane)
      .join('/')}, merges=${snapshot.stats.merged}, status=${world.status()}`,
  );
});

test('scenario A: every lane task opens one PR and every PR is merged exactly once', async () => {
  const world = scenarioA();
  await world.runToTerminal();

  const pulls = world.github.pulls();
  assert.equal(pulls.length, 3);
  assert.equal(new Set(pulls.map((pull) => pull.number)).size, 3);
  assert.ok(pulls.every((pull) => pull.state === 'merged'));
  assert.ok(pulls.every((pull) => pull.commits.length === 1));

  const merges = world.github.mergeEvents();
  assert.equal(merges.length, 3);
  assert.equal(new Set(merges.map((merge) => merge.pr)).size, 3);

  const snapshot = world.snapshot();
  for (const task of Object.values(snapshot.tasks)) {
    const pull = pulls.find((candidate) => candidate.taskId === task.id);
    assert.ok(pull, `no pull request for ${task.id}`);
    assert.equal(task.merge.pr.number, pull.number);
    assert.equal(task.merge.commit, pull.mergeCommit);
    assert.ok(pull.commits.includes(task.submission.commit));
    assert.equal(merges.filter((merge) => merge.pr === pull.number).length, 1);
  }

  const mergeFailures = world.log
    .flatMap((entry) => entry.actions)
    .filter((action) => action.type === 'merge_failed');
  assert.deepEqual(mergeFailures, []);

  const keys = world.sa.dispatchCalls().map((call) => call.idempotencyKey);
  assert.equal(new Set(keys).size, 3);
  assert.ok(
    keys.every((key) => key.startsWith('autoloop:scenario-a:')),
  );
});
