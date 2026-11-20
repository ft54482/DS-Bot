#!/usr/bin/env node
/**
 * Reproducible acceptance evidence for L34.
 *
 * This is a demo, not a test suite: it uses in-memory fakes for every port and
 * prints the raw step sequence, stop-loss result and crash-recovery decision.
 *
 *   node packages/autoloop/scripts/acceptance.mjs
 */

import { createLoop, createMemoryStore } from '../src/index.js';

const NOW = 1_700_000_000_000;

function makeLoop({ store, tasks, maxSlots = 1 }) {
  const dispatchCalls = [];
  const ready = [];
  let round = 0;
  let workOrder = 0;
  let submitted = false;

  const goalEngine = {
    plan() {
      round += 1;
      return round === 1 ? { tasks } : { done: true };
    },
  };

  const scheduler = {
    freeSlots: () => Math.max(0, maxSlots - dispatchCalls.length + ready.length),
    dispatch(request) {
      dispatchCalls.push(request);
      workOrder += 1;
      return { workOrderId: `wo-${workOrder}` };
    },
    collect() {
      if (submitted || ready.length === 0) return [];
      submitted = true;
      return ready.splice(0);
    },
    rework() {
      workOrder += 1;
      return { workOrderId: `wo-${workOrder}` };
    },
  };

  const loop = createLoop({
    goalEngine,
    scheduler,
    verifier: { verify: () => '{"verdict":"PASS"}' },
    merger: { merge: ({ task }) => ({ merged: true, commit: `merge-${task.id}` }) },
    store,
    clock: () => NOW,
    loopId: 'acceptance',
    maxSlots,
  });

  return { loop, dispatchCalls, ready };
}

const happy = makeLoop({
  store: createMemoryStore(),
  tasks: [{ id: 'T1', lane: 'main', title: 'demo task' }],
});
happy.ready.push({ taskId: 'T1', commit: 'c1', costCny: 5 });

console.log('step sequence:');
for (let index = 0; index < 8; index += 1) {
  const result = await happy.loop.step();
  console.log(
    `  ${result.state} -> ${result.next} [${result.actions.map((a) => a.type).join(', ')}]`,
  );
  if (result.next === 'done') break;
}
const happySnapshot = happy.loop.snapshot();
console.log(
  `final: state=${happySnapshot.state} task=${happySnapshot.tasks.T1.state} ` +
    `spent=${happySnapshot.spentCny} stop=${happySnapshot.stop}`,
);

const store = createMemoryStore();
const first = makeLoop({
  store,
  tasks: [
    { id: 'A', lane: 'main' },
    { id: 'B', lane: 'main' },
  ],
  maxSlots: 1,
});
await first.loop.step(); // plan
await first.loop.step(); // dispatch A; B waits for a slot
console.log('\nbefore crash: A=' + first.loop.snapshot().tasks.A.state +
  ' B=' + first.loop.snapshot().tasks.B.state);

const second = makeLoop({
  store,
  tasks: [
    { id: 'A', lane: 'main' },
    { id: 'B', lane: 'main' },
  ],
  maxSlots: 1,
});
const resumed = await second.loop.resume();
console.log(
  `resume: state=${resumed.state} inFlight=${JSON.stringify(resumed.actions[0].inFlight)}`,
);

second.ready.push({ taskId: 'A', workOrderId: 'wo-1', costCny: 1 });
await second.loop.step(); // collect A
await second.loop.step(); // verify A
await second.loop.step(); // merge A
await second.loop.step(); // next -> dispatch B
await second.loop.step(); // dispatch B
console.log(
  `after resume: dispatched=${JSON.stringify(second.dispatchCalls.map((c) => c.taskId))} ` +
    `A=${second.loop.snapshot().tasks.A.state} B=${second.loop.snapshot().tasks.B.state}`,
);
