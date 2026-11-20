import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, actionOf, actionsOf } from './helpers.js';

test('collect waits when no submission has arrived', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
  });

  await harness.loop.step(); // plan
  await harness.loop.step(); // dispatch
  const collected = await harness.loop.step(); // collect

  assert.equal(collected.state, 'collect');
  assert.equal(collected.next, 'collect');
  assert.equal(actionOf(collected, 'wait').reason, 'submission_pending');
  assert.deepEqual(actionOf(collected, 'wait').pending, ['T1']);
});

test('a duplicate submission for the same work order is ignored', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [
      { taskId: 'T1', workOrderId: 'wo-1', costCny: 1 },
      { taskId: 'T1', workOrderId: 'wo-1', costCny: 1 },
    ],
  });

  await harness.loop.step(); // plan
  await harness.loop.step(); // dispatch
  const collected = await harness.loop.step();

  assert.equal(actionsOf(collected, 'submission').length, 1);
  assert.equal(actionOf(collected, 'ignored_submission').reason, 'task_not_dispatched');
  assert.equal(harness.loop.snapshot().tasks.T1.costCny, 1);
  assert.equal(collected.next, 'verify');
});

test('a submission from a previous work order is ignored', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', workOrderId: 'stale-wo', costCny: 1 }],
  });

  await harness.loop.step(); // plan
  await harness.loop.step(); // dispatch -> wo-1
  const collected = await harness.loop.step();

  assert.equal(actionOf(collected, 'ignored_submission').reason, 'stale_work_order');
  assert.equal(harness.loop.snapshot().tasks.T1.state, 'dispatched');
  assert.equal(collected.next, 'collect');
});

test('a submission for an unknown task is ignored', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'GHOST', costCny: 1 }],
  });

  await harness.loop.step();
  await harness.loop.step();
  const collected = await harness.loop.step();

  assert.equal(actionOf(collected, 'ignored_submission').reason, 'unknown_task');
  assert.equal(collected.next, 'collect');
});

test('reported cost accumulates across rework and stops above 30 CNY', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    verdicts: {
      T1: [
        { verdict: 'FAIL', feedback: 'still broken' },
        { verdict: 'PASS' },
      ],
    },
  });

  await harness.loop.step(); // plan
  await harness.loop.step(); // dispatch wo-1
  harness.ports.ready.push({ taskId: 'T1', workOrderId: 'wo-1', costCny: 20 });
  await harness.loop.step(); // collect -> 20
  await harness.loop.step(); // verify FAIL
  await harness.loop.step(); // merge -> rework wo-2

  assert.equal(harness.ports.reworkCalls.length, 1);
  assert.equal(harness.loop.snapshot().tasks.T1.costCny, 20);
  assert.equal(harness.loop.snapshot().state, 'collect');

  harness.ports.ready.push({ taskId: 'T1', workOrderId: 'wo-2', costCny: 11 });
  const collected = await harness.loop.step();

  assert.equal(actionOf(collected, 'submission').costCny, 11);
  assert.equal(actionOf(collected, 'stop').reason, 'budget_exceeded');
  assert.equal(collected.next, 'stop');
  const snapshot = harness.loop.snapshot();
  assert.equal(snapshot.tasks.T1.costCny, 31);
  assert.equal(snapshot.spentCny, 31);
  assert.equal(snapshot.tasks.T1.state, 'stopped');
  assert.equal(snapshot.stop.detail.capCny, 30);
});

test('exactly 30 CNY is allowed and the task can merge', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 30 }],
    verdicts: { T1: { verdict: 'PASS' } },
  });

  await harness.loop.step();
  await harness.loop.step();
  const collected = await harness.loop.step();
  assert.equal(collected.next, 'verify');
  assert.equal(harness.loop.snapshot().stop, null);

  await harness.loop.step(); // verify
  await harness.loop.step(); // merge
  const snapshot = harness.loop.snapshot();
  assert.equal(snapshot.stop, null);
  assert.equal(snapshot.tasks.T1.state, 'merged');
});
