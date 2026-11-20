import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, actionOf } from './helpers.js';

test('one task walks plan -> dispatch -> collect -> verify -> merge -> next and ends done', async () => {
  const harness = createHarness({
    plans: [
      { tasks: [{ id: 'T1', lane: 'lane-1', title: 'fix the parser' }] },
      { done: true, goal: 'all done' },
    ],
    ready: [{ taskId: 'T1', commit: 'commit-1', costCny: 5 }],
    verdicts: { T1: { verdict: 'PASS' } },
  });

  const steps = [];
  for (let index = 0; index < 8; index += 1) {
    steps.push(await harness.loop.step());
  }

  assert.deepEqual(
    steps.map((step) => step.state),
    [
      'plan',
      'dispatch',
      'collect',
      'verify',
      'merge',
      'next',
      'plan',
      'next',
    ],
  );
  assert.equal(steps[7].next, 'done');

  for (const step of steps) {
    assert.deepEqual(Object.keys(step).sort(), ['actions', 'next', 'state']);
    assert.equal(typeof step.next, 'string');
    assert.ok(Array.isArray(step.actions));
  }

  assert.equal(actionOf(steps[0], 'plan').taskIds[0], 'T1');
  assert.equal(actionOf(steps[1], 'dispatch').attempt, 1);
  assert.equal(
    actionOf(steps[1], 'dispatch').idempotencyKey,
    'autoloop:loop-test:T1:a1',
  );
  assert.equal(actionOf(steps[2], 'submission').costCny, 5);
  assert.equal(actionOf(steps[3], 'verify').verdict, 'PASS');
  assert.equal(actionOf(steps[4], 'merge').commit, 'merge-T1');
  assert.equal(actionOf(steps[5], 'next').route, 'plan');

  assert.equal(harness.ports.dispatchCalls.length, 1);
  assert.equal(harness.ports.verifyCalls.length, 1);
  assert.equal(harness.ports.mergeCalls.length, 1);

  const snapshot = harness.loop.snapshot();
  assert.equal(snapshot.state, 'done');
  assert.equal(snapshot.goalDone, true);
  assert.equal(snapshot.tasks.T1.state, 'merged');
  assert.equal(snapshot.tasks.T1.costCny, 5);
  assert.equal(snapshot.stats.merged, 1);
  assert.equal(snapshot.stop, null);
});

test('a done plan with stale tasks does not dispatch them', async () => {
  const harness = createHarness({
    plans: [{ done: true, tasks: [{ id: 'STALE', lane: 'lane-1' }] }],
  });

  const planned = await harness.loop.step();
  assert.deepEqual(actionOf(planned, 'plan').taskIds, []);
  assert.equal(planned.next, 'next');

  const next = await harness.loop.step();
  assert.equal(actionOf(next, 'goal_done').type, 'goal_done');
  assert.equal(next.next, 'done');
  assert.equal(harness.ports.dispatchCalls.length, 0);
});

test('the driver persists the snapshot after every state', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
  });

  await harness.loop.step();
  assert.equal(harness.store.peek().state, 'dispatch');
  assert.equal(harness.store.peek().round, 1);

  await harness.loop.step();
  assert.equal(harness.store.peek().state, 'collect');
  assert.equal(harness.store.peek().tasks.T1.state, 'dispatched');
});

test('async goal engines are awaited', async () => {
  const harness = createHarness({
    plans: [
      async () => {
        await Promise.resolve();
        return { tasks: [{ id: 'ASYNC', lane: 'lane-1' }] };
      },
    ],
    ready: [{ taskId: 'ASYNC', costCny: 1 }],
    verdicts: { ASYNC: '{"verdict":"PASS"}' },
  });

  const plan = await harness.loop.step();
  assert.equal(plan.state, 'plan');
  assert.deepEqual(actionOf(plan, 'plan').taskIds, ['ASYNC']);
  assert.equal(plan.next, 'dispatch');
});
