import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, actionOf } from './helpers.js';
import {
  isNoProgressExhausted,
  isReworkExhausted,
  isTaskOverBudget,
  resolveLimits,
} from '../src/stop_loss.js';

test('two consecutive rounds without a merge stop the loop', async () => {
  const harness = createHarness({
    plans: [
      { tasks: [{ id: 'T1', lane: 'lane-1' }] },
      { tasks: [{ id: 'T2', lane: 'lane-1' }] },
      { done: true },
    ],
    verdicts: {
      T1: { verdict: 'PASS' },
      T2: { verdict: 'PASS' },
    },
    merges: {
      T1: { merged: false, error: 'conflict one' },
      T2: { merged: false, error: 'conflict two' },
    },
  });

  await harness.loop.step(); // plan round 1
  await harness.loop.step(); // dispatch T1
  harness.ports.ready.push({ taskId: 'T1', costCny: 1 });
  await harness.loop.step(); // collect
  await harness.loop.step(); // verify
  await harness.loop.step(); // merge fails
  const nextRound = await harness.loop.step(); // next -> plan
  assert.equal(nextRound.next, 'plan');
  assert.equal(harness.loop.snapshot().noProgressRounds, 1);

  await harness.loop.step(); // plan round 2
  await harness.loop.step(); // dispatch T2
  harness.ports.ready.push({ taskId: 'T2', costCny: 1 });
  await harness.loop.step(); // collect
  await harness.loop.step(); // verify
  await harness.loop.step(); // merge fails
  const stopped = await harness.loop.step(); // next -> stop

  assert.equal(stopped.next, 'stop');
  assert.equal(actionOf(stopped, 'stop').reason, 'no_progress');
  assert.equal(actionOf(stopped, 'stop').detail.noProgressRounds, 2);

  const snapshot = harness.loop.snapshot();
  assert.equal(snapshot.state, 'stop');
  assert.equal(snapshot.stop.reason, 'no_progress');
});

test('a merge in the round resets the no-progress counter', async () => {
  const harness = createHarness({
    plans: [
      { tasks: [{ id: 'T1', lane: 'lane-1' }] },
      { tasks: [{ id: 'T2', lane: 'lane-2' }] },
      { tasks: [{ id: 'T3', lane: 'lane-3' }] },
      { done: true },
    ],
    merges: {
      T1: { merged: false, error: 'conflict' },
      T2: { merged: true, commit: 'c2' },
      T3: { merged: false, error: 'conflict again' },
    },
  });

  await harness.loop.step(); // plan T1
  await harness.loop.step(); // dispatch
  harness.ports.ready.push({ taskId: 'T1', costCny: 1 });
  await harness.loop.step(); // collect
  await harness.loop.step(); // verify
  await harness.loop.step(); // merge fails
  await harness.loop.step(); // next -> plan (no progress 1)
  assert.equal(harness.loop.snapshot().noProgressRounds, 1);

  await harness.loop.step(); // plan T2
  await harness.loop.step(); // dispatch
  harness.ports.ready.push({ taskId: 'T2', costCny: 1 });
  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step(); // merge succeeds
  assert.equal(harness.loop.snapshot().noProgressRounds, 0);
  const next = await harness.loop.step(); // next -> plan
  assert.equal(next.next, 'plan');

  await harness.loop.step(); // plan T3
  await harness.loop.step();
  harness.ports.ready.push({ taskId: 'T3', costCny: 1 });
  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step(); // merge fails
  const after = await harness.loop.step(); // next -> plan (1, not stop)
  assert.equal(after.next, 'plan');
  assert.equal(harness.loop.snapshot().noProgressRounds, 1);
});

test('an empty plan counts as a no-progress round and stops after two', async () => {
  const harness = createHarness({
    plans: [{ tasks: [] }, { tasks: [] }],
  });

  const firstPlan = await harness.loop.step();
  assert.equal(firstPlan.next, 'next');
  const firstNext = await harness.loop.step();
  assert.equal(firstNext.next, 'plan');
  assert.equal(harness.loop.snapshot().noProgressRounds, 1);

  await harness.loop.step(); // empty plan round 2
  const secondNext = await harness.loop.step();
  assert.equal(secondNext.next, 'stop');
  assert.equal(actionOf(secondNext, 'stop').reason, 'no_progress');
});

test('manual stop is persisted and replayed without further work', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
  });

  await harness.loop.step(); // plan
  const stopped = await harness.loop.stop('human_stop', { by: 'operator' });
  assert.equal(stopped.state, 'stop');
  assert.equal(stopped.stop.reason, 'human_stop');
  assert.deepEqual(stopped.stop.detail, { by: 'operator' });

  const replayed = await harness.loop.step();
  assert.equal(replayed.state, 'stop');
  assert.equal(replayed.next, 'stop');
  assert.equal(actionOf(replayed, 'stop').replay, true);
  assert.equal(harness.ports.dispatchCalls.length, 0);
});

test('stop-loss predicates use the documented inclusive/exclusive boundaries', () => {
  const limits = resolveLimits();

  assert.equal(isTaskOverBudget({ costCny: 30 }, limits), false);
  assert.equal(isTaskOverBudget({ costCny: 30.000001 }, limits), true);
  assert.equal(isReworkExhausted({ reworkCount: 2 }, 0, limits), true);
  assert.equal(isReworkExhausted({ reworkCount: 0 }, 2, limits), true);
  assert.equal(isReworkExhausted({ reworkCount: 1 }, 1, limits), false);
  assert.equal(isNoProgressExhausted(2, limits), true);
  assert.equal(isNoProgressExhausted(1, limits), false);
});
