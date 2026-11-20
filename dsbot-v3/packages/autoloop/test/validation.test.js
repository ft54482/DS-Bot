import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoop } from '../src/loop.js';
import { createMemoryStore } from '../src/store.js';

function ports(overrides = {}) {
  return {
    goalEngine: { plan: () => ({ tasks: [] }) },
    scheduler: {
      freeSlots: () => 1,
      dispatch: () => ({ workOrderId: 'wo-1' }),
      collect: () => [],
      rework: () => ({ workOrderId: 'wo-2' }),
    },
    verifier: { verify: () => '{"verdict":"PASS"}' },
    merger: { merge: () => ({ merged: true }) },
    store: createMemoryStore(),
    clock: () => 1,
    ...overrides,
  };
}

test('createLoop validates the dependency surface', () => {
  assert.throws(() => createLoop(), /options object/);
  assert.throws(() => createLoop({}), /goalEngine\.plan/);

  const base = ports();
  assert.throws(
    () => createLoop({ ...base, scheduler: undefined }),
    /requires scheduler or sa/,
  );
  assert.throws(
    () => createLoop({ ...base, merger: undefined }),
    /requires merger or git/,
  );
  assert.throws(
    () => createLoop({ ...base, clock: undefined }),
    /clock/,
  );
  assert.throws(
    () => createLoop({ ...base, verifier: {} }),
    /verifier\.verify/,
  );
  assert.throws(
    () => createLoop({ ...base, store: {} }),
    /store\.load/,
  );
  assert.throws(
    () =>
      createLoop({
        ...base,
        scheduler: { freeSlots: () => 1, dispatch: () => ({}), collect: () => [] },
      }),
    /scheduler\.rework/,
  );
});

test('createLoop validates stop-loss options', () => {
  const base = ports();

  assert.throws(
    () => createLoop({ ...base, maxReworkRounds: 0 }),
    /maxReworkRounds/,
  );
  assert.throws(
    () => createLoop({ ...base, maxTaskCostCny: -1 }),
    /maxTaskCostCny/,
  );
  assert.throws(
    () => createLoop({ ...base, maxNoProgressRounds: 1.5 }),
    /maxNoProgressRounds/,
  );

  const loop = createLoop({
    ...base,
    maxReworkRounds: 3,
    maxTaskCostCny: 12,
    maxNoProgressRounds: 4,
  });
  assert.deepEqual(loop.config, {
    loopId: loop.config.loopId,
    maxReworkRounds: 3,
    maxTaskCostCny: 12,
    maxNoProgressRounds: 4,
  });
});

test('planned tasks are validated', async () => {
  const noId = ports({
    goalEngine: { plan: () => ({ tasks: [{ lane: 'lane-1' }] }) },
  });
  await assert.rejects(() => createLoop(noId).step(), /has no id/);

  const noLane = ports({
    goalEngine: { plan: () => ({ tasks: [{ id: 'T1' }] }) },
  });
  await assert.rejects(() => createLoop(noLane).step(), /has no lane/);

  const badBudget = ports({
    goalEngine: {
      plan: () => ({ tasks: [{ id: 'T1', lane: 'lane-1', budgetCny: 0 }] }),
    },
  });
  await assert.rejects(
    () => createLoop(badBudget).step(),
    /budgetCny must be > 0/,
  );
});

test('a task budget above 30 is clamped to the loop cap', async () => {
  const loop = createLoop(
    ports({
      goalEngine: {
        plan: () => ({ tasks: [{ id: 'T1', lane: 'lane-1', budgetCny: 500 }] }),
      },
    }),
  );
  await loop.step();
  assert.equal(loop.snapshot().tasks.T1.budgetCny, 30);

  await loop.step();
  assert.equal(loop.config.maxTaskCostCny, 30);
});

test('step without a store snapshot starts at plan and returns the documented shape', async () => {
  const loop = createLoop(ports());
  const result = await loop.step();

  assert.deepEqual(Object.keys(result).sort(), ['actions', 'next', 'state']);
  assert.equal(result.state, 'plan');
  assert.equal(result.next, 'next');
  assert.equal(result.actions[0].type, 'plan');
});

test('concurrent step calls share one in-flight pass', async () => {
  const store = createMemoryStore();
  const loop = createLoop(
    ports({
      store,
      goalEngine: {
        plan: async () => {
          await Promise.resolve();
          return { tasks: [{ id: 'T1', lane: 'lane-1' }] };
        },
      },
    }),
  );

  const [first, second] = await Promise.all([loop.step(), loop.step()]);
  assert.equal(first, second);
  assert.equal(loop.snapshot().round, 1);
  assert.equal(store.peek().round, 1);
});
