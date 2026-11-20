import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, actionOf } from './helpers.js';
import { createMemoryStore } from '../src/store.js';

test('resume with an empty store initializes a fresh plan', async () => {
  const harness = createHarness({ plans: [{ tasks: [] }] });

  const resumed = await harness.loop.resume();
  assert.equal(resumed.state, 'plan');
  assert.equal(resumed.next, 'plan');
  assert.equal(actionOf(resumed, 'init').type, 'init');
  assert.equal(harness.store.peek().state, 'plan');
});

test('resume reloads the snapshot and does not re-dispatch an in-flight task', async () => {
  const store = createMemoryStore();
  const first = createHarness({
    store,
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

  await first.loop.step(); // plan
  await first.loop.step(); // dispatch A; B stays planned
  assert.equal(first.ports.dispatchCalls.length, 1);
  assert.equal(store.peek().tasks.A.state, 'dispatched');

  const second = createHarness({
    store,
    loopId: 'other-process',
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

  const resumed = await second.loop.resume();
  assert.equal(resumed.state, 'collect');
  assert.deepEqual(actionOf(resumed, 'resume').inFlight, [
    { taskId: 'A', workOrderId: 'wo-1' },
  ]);

  second.ports.ready.push({ taskId: 'A', workOrderId: 'wo-1', costCny: 1 });
  const collected = await second.loop.step(); // collect A
  assert.equal(collected.next, 'verify');
  await second.loop.step(); // verify A
  await second.loop.step(); // merge A
  const next = await second.loop.step(); // next -> dispatch B
  assert.equal(next.next, 'dispatch');
  const dispatched = await second.loop.step();

  assert.equal(second.ports.dispatchCalls.length, 1);
  assert.equal(second.ports.dispatchCalls[0].taskId, 'B');
  assert.equal(
    second.ports.dispatchCalls[0].idempotencyKey,
    'autoloop:loop-test:B:a1',
  );
  assert.equal(second.loop.snapshot().tasks.A.state, 'merged');
});

test('resume at verify continues verification without repeating dispatch', async () => {
  const store = createMemoryStore();
  const first = createHarness({
    store,
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 1 }],
    verdicts: { T1: { verdict: 'PASS' } },
  });

  await first.loop.step(); // plan
  await first.loop.step(); // dispatch
  await first.loop.step(); // collect -> verify
  assert.equal(store.peek().state, 'verify');

  const second = createHarness({
    store,
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    verdicts: { T1: { verdict: 'PASS' } },
  });
  const resumed = await second.loop.resume();
  assert.equal(resumed.state, 'verify');

  const verified = await second.loop.step();
  assert.equal(actionOf(verified, 'verify').verdict, 'PASS');
  assert.equal(verified.next, 'merge');
  assert.equal(second.ports.dispatchCalls.length, 0);
  assert.equal(second.ports.verifyCalls.length, 1);
});

test('resume at merge continues with the persisted PASS verdict', async () => {
  const store = createMemoryStore();
  const first = createHarness({
    store,
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 1 }],
    verdicts: { T1: { verdict: 'PASS' } },
  });

  await first.loop.step();
  await first.loop.step();
  await first.loop.step();
  await first.loop.step(); // verify -> merge
  assert.equal(store.peek().state, 'merge');

  const second = createHarness({
    store,
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
  });
  const resumed = await second.loop.resume();
  assert.equal(resumed.state, 'merge');

  const merged = await second.loop.step();
  assert.equal(actionOf(merged, 'merge').taskId, 'T1');
  assert.equal(second.ports.verifyCalls.length, 0);
  assert.equal(second.ports.mergeCalls.length, 1);
});

test('resume replays a persisted stop without doing work', async () => {
  const store = createMemoryStore();
  const first = createHarness({
    store,
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
  });

  await first.loop.stop('parent_stop', { ticket: 75 });

  const second = createHarness({ store });
  const resumed = await second.loop.resume();
  assert.equal(resumed.state, 'stop');
  assert.equal(resumed.next, 'stop');

  const replayed = await second.loop.step();
  assert.equal(replayed.state, 'stop');
  assert.equal(actionOf(replayed, 'stop').reason, 'parent_stop');
  assert.equal(second.ports.dispatchCalls.length, 0);
});

test('an unsupported snapshot version is rejected', async () => {
  const store = createMemoryStore({
    version: 99,
    state: 'plan',
    tasks: {},
  });
  const harness = createHarness({ store });

  await assert.rejects(
    () => harness.loop.resume(),
    /snapshot version 99 is not supported/,
  );
});
