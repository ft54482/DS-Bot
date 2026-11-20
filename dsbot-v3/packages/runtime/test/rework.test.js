import assert from 'node:assert/strict';
import test from 'node:test';

import { openAcceptingRun } from './support/harness.js';

async function reviseFirstRun(t) {
  const context = await openAcceptingRun(t);
  const decided = context.runtime.acceptances.decide({
    acceptanceId: context.claimed.acceptance.id,
    verdict: 'revise',
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'fail' },
    reason: 'factual_error',
  });
  return { ...context, decided };
}

test('rework: a revise verdict derives a new run on the same task', async (t) => {
  const { runtime, tree, run, decided } = await reviseFirstRun(t);

  assert.equal(decided.verdict, 'revise');
  assert.equal(decided.acceptance.state, 'revise');
  assert.equal(decided.task.state, 'reworking');
  assert.equal(decided.task.revision, 1);
  assert.equal(decided.task.openAcceptanceId, null);

  // The submitted run is closed; the derived run is queued on the same task.
  assert.equal(runtime.runs.get(run.id).state, 'rejected');
  assert.equal(decided.reworkRun.state, 'queued');
  assert.equal(decided.reworkRun.kind, 'rework');
  assert.equal(decided.reworkRun.attemptNo, 2);
  assert.notEqual(decided.reworkRun.id, run.id);
  assert.equal(runtime.tasks.get(tree.execution.id).currentRunId, decided.reworkRun.id);

  // Rework reopens the run, not the task hierarchy.
  assert.equal(runtime.tasks.list().length, 3, 'rework never creates a sibling task');
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 2);
  assert.equal(runtime.service.listEvents({ type: 'acceptance.revise' }).length, 1);
  assert.equal(runtime.service.listEvents({ type: 'run.rejected' }).length, 1);
});

test('rework: dispatching after a revise starts the derived run', async (t) => {
  const { runtime, tree, run, decided } = await reviseFirstRun(t);

  const dispatched = runtime.tasks.dispatch({
    taskId: tree.execution.id,
    executorKind: 'mock',
  });

  assert.equal(dispatched.replayed, undefined);
  assert.equal(dispatched.run.id, decided.reworkRun.id);
  assert.equal(dispatched.run.id === run.id, false);
  assert.equal(dispatched.run.kind, 'rework');
  assert.equal(dispatched.run.state, 'dispatched');
  assert.equal(dispatched.task.state, 'queued');
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 2);
  assert.notEqual(runtime.store.getOutbox(`outbox-${dispatched.run.id}`), null);
});
