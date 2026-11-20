import assert from 'node:assert/strict';
import test from 'node:test';

import { createHarness, actionOf, actionsOf } from './helpers.js';

test('only a verifier PASS reaches merger.merge', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', commit: 'c1', costCny: 1 }],
    verdicts: { T1: { verdict: 'PASS' } },
    merges: { T1: { merged: true, commit: 'merged-1', pr: { number: 7 } } },
  });

  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step(); // verify
  const merged = await harness.loop.step();

  const action = actionOf(merged, 'merge');
  assert.equal(action.taskId, 'T1');
  assert.equal(action.commit, 'merged-1');
  assert.deepEqual(action.pr, { number: 7 });
  assert.equal(harness.ports.mergeCalls.length, 1);

  const snapshot = harness.loop.snapshot();
  assert.equal(snapshot.tasks.T1.state, 'merged');
  assert.equal(snapshot.tasks.T1.merge.commit, 'merged-1');
  assert.equal(snapshot.roundMerged, 1);
});

test('a merge API that refuses the merge becomes merge_failed, not a merge', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 1 }],
    verdicts: { T1: { verdict: 'PASS' } },
    merges: { T1: { merged: false, error: 'conflict in parser.js' } },
  });

  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step(); // verify
  const merged = await harness.loop.step();

  assert.equal(actionOf(merged, 'merge_failed').error, 'conflict in parser.js');
  assert.equal(actionsOf(merged, 'merge').length, 0);
  assert.equal(merged.next, 'next');
  assert.equal(harness.loop.snapshot().tasks.T1.state, 'merge_failed');
});

test('a thrown merge error becomes merge_failed', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 1 }],
    verdicts: { T1: { verdict: 'PASS' } },
    merges: { T1: new Error('git exploded') },
  });

  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  const merged = await harness.loop.step();

  assert.equal(actionOf(merged, 'merge_failed').error, 'git exploded');
  assert.equal(harness.loop.snapshot().tasks.T1.state, 'merge_failed');
});

test('FAIL is dispatched as rework with a new work order and attempt', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    ready: [{ taskId: 'T1', costCny: 1 }],
    verdicts: { T1: [{ verdict: 'FAIL', feedback: 'fix it' }, { verdict: 'PASS' }] },
  });

  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step(); // verify FAIL
  const merged = await harness.loop.step(); // merge -> rework

  const rework = actionOf(merged, 'rework');
  assert.equal(rework.taskId, 'T1');
  assert.equal(rework.reworkRound, 1);
  assert.equal(rework.workOrderId, 'wo-2');
  assert.equal(rework.feedback, 'fix it');
  assert.equal(harness.ports.reworkCalls[0].attempt, 2);
  assert.equal(
    harness.ports.reworkCalls[0].idempotencyKey,
    'autoloop:loop-test:T1:r1',
  );

  const snapshot = harness.loop.snapshot();
  assert.equal(snapshot.tasks.T1.state, 'dispatched');
  assert.equal(snapshot.tasks.T1.reworkCount, 1);
  assert.equal(snapshot.tasks.T1.attempt, 2);
  assert.equal(snapshot.lanes['lane-1'].reworkRounds, 1);
  assert.equal(merged.next, 'collect');
});

test('a lane gets at most two rework rounds before the loop stops', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    verdicts: {
      T1: [
        { verdict: 'FAIL', feedback: 'one' },
        { verdict: 'FAIL', feedback: 'two' },
        { verdict: 'FAIL', feedback: 'three' },
      ],
    },
  });

  await harness.loop.step(); // plan
  await harness.loop.step(); // dispatch

  const rounds = [];
  for (let round = 0; round < 3; round += 1) {
    harness.ports.ready.push({
      taskId: 'T1',
      workOrderId: `wo-${round + 1}`,
      costCny: 1,
    });
    await harness.loop.step(); // collect
    await harness.loop.step(); // verify
    rounds.push(await harness.loop.step()); // merge
  }

  assert.equal(rounds[0].next, 'collect');
  assert.equal(rounds[1].next, 'collect');
  assert.equal(rounds[2].next, 'stop');

  const stop = actionOf(rounds[2], 'stop');
  assert.equal(stop.reason, 'rework_exceeded');
  assert.equal(stop.detail.reworkCount, 2);
  assert.equal(stop.detail.laneReworkRounds, 2);
  assert.equal(harness.ports.reworkCalls.length, 2);
  assert.equal(harness.ports.mergeCalls.length, 0);

  const snapshot = harness.loop.snapshot();
  assert.equal(snapshot.state, 'stop');
  assert.equal(snapshot.tasks.T1.state, 'stopped');
  assert.equal(snapshot.stop.reason, 'rework_exceeded');
});

test('a successful rework can PASS and merge', async () => {
  const harness = createHarness({
    plans: [{ tasks: [{ id: 'T1', lane: 'lane-1' }] }],
    verdicts: {
      T1: [{ verdict: 'FAIL', feedback: 'one' }, { verdict: 'PASS' }],
    },
  });

  await harness.loop.step();
  await harness.loop.step();
  harness.ports.ready.push({ taskId: 'T1', workOrderId: 'wo-1', costCny: 1 });
  await harness.loop.step();
  await harness.loop.step();
  await harness.loop.step(); // rework
  harness.ports.ready.push({ taskId: 'T1', workOrderId: 'wo-2', costCny: 1 });
  await harness.loop.step(); // collect
  await harness.loop.step(); // verify PASS
  const merged = await harness.loop.step();

  assert.equal(actionOf(merged, 'merge').taskId, 'T1');
  assert.equal(harness.loop.snapshot().tasks.T1.reworkCount, 1);
  assert.equal(harness.loop.snapshot().tasks.T1.state, 'merged');
});
