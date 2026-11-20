import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, actionOf, actionsOf } from './helpers.js';

test('dispatch stops at the free-slot boundary', async () => {
  const harness = createHarness({
    plans: [
      {
        tasks: [
          { id: 'A', lane: 'lane-1' },
          { id: 'B', lane: 'lane-1' },
        ],
      },
    ],
    maxSlots: 1,
  });

  await harness.loop.step(); // plan
  const dispatched = await harness.loop.step(); // dispatch

  assert.equal(actionsOf(dispatched, 'dispatch').length, 1);
  assert.equal(actionOf(dispatched, 'dispatch').taskId, 'A');
  assert.equal(actionOf(dispatched, 'dispatch_skipped').reason, 'no_slot');

  const snapshot = harness.loop.snapshot();
  assert.equal(snapshot.tasks.A.state, 'dispatched');
  assert.equal(snapshot.tasks.B.state, 'planned');
  assert.equal(dispatched.next, 'collect');
});

test('a full pool dispatches nothing and waits', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'A', lane: 'lane-1' }] }],
    maxSlots: 1,
    active: 1,
  });

  await harness.loop.step(); // plan
  const dispatched = await harness.loop.step(); // dispatch

  assert.equal(actionsOf(dispatched, 'dispatch').length, 0);
  assert.equal(actionOf(dispatched, 'slots_full').freeSlots, 0);
  assert.equal(dispatched.next, 'collect');

  const waited = await harness.loop.step(); // collect
  assert.equal(waited.next, 'collect');
  assert.equal(actionOf(waited, 'wait').reason, 'no_slot');
});

test('a slot freed by a submission is used for the next planned task', async () => {
  const harness = createHarness({
    plans: [
      {
        tasks: [
          { id: 'A', lane: 'lane-1' },
          { id: 'B', lane: 'lane-1' },
        ],
      },
    ],
    maxSlots: 1,
  });

  await harness.loop.step(); // plan
  await harness.loop.step(); // dispatch A
  harness.ports.ready.push({ taskId: 'A', workOrderId: 'wo-1', costCny: 1 });
  const collected = await harness.loop.step(); // collect
  assert.equal(collected.next, 'verify');

  const verified = await harness.loop.step(); // verify
  assert.equal(verified.next, 'merge');
  const merged = await harness.loop.step(); // merge
  assert.equal(merged.next, 'next');
  const next = await harness.loop.step(); // next -> dispatch B
  assert.equal(next.next, 'dispatch');

  const dispatched = await harness.loop.step();
  assert.equal(actionOf(dispatched, 'dispatch').taskId, 'B');
  assert.equal(harness.loop.snapshot().tasks.B.state, 'dispatched');
  assert.equal(harness.ports.dispatchCalls.length, 2);
});

test('a failed dispatch keeps the task planned and retries with the same idempotency key', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'A', lane: 'lane-1' }] }],
    failDispatchTimes: 1,
  });

  await harness.loop.step(); // plan
  const failed = await harness.loop.step(); // dispatch -> throws
  assert.equal(actionOf(failed, 'dispatch_failed').taskId, 'A');
  assert.equal(harness.loop.snapshot().tasks.A.state, 'planned');
  assert.equal(failed.next, 'collect');

  const collected = await harness.loop.step(); // collect sees a free slot
  assert.equal(collected.next, 'dispatch');
  const retried = await harness.loop.step();
  assert.equal(actionOf(retried, 'dispatch').taskId, 'A');
  assert.equal(retried.next, 'collect');

  assert.equal(harness.ports.dispatchCalls.length, 2);
  assert.equal(
    harness.ports.dispatchCalls[0].idempotencyKey,
    harness.ports.dispatchCalls[1].idempotencyKey,
  );
});

test('duplicate task ids in one plan are skipped', async () => {
  const harness = createHarness({
    plans: [
      {
        tasks: [
          { id: 'A', lane: 'lane-1' },
          { id: 'A', lane: 'lane-1' },
        ],
      },
    ],
  });

  const planned = await harness.loop.step();
  assert.deepEqual(actionOf(planned, 'plan').taskIds, ['A']);
  assert.equal(actionOf(planned, 'plan_skipped').reason, 'duplicate_task_id');
  assert.deepEqual(harness.loop.snapshot().order, ['A']);
});
