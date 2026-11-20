import assert from 'node:assert/strict';
import test from 'node:test';

import { openAcceptingRun } from './support/harness.js';

test('claim: only the run becomes reported and the task accepting', async (t) => {
  const { runtime, tree, run, claimed } = await openAcceptingRun(t);

  assert.equal(claimed.claim.validationState, 'valid');
  assert.equal(claimed.run.state, 'reported');
  assert.equal(claimed.task.state, 'accepting');
  assert.equal(claimed.acceptance.state, 'open');
  assert.deepEqual(
    claimed.acceptance.items.filter((item) => item.required).map((item) => item.key),
    ['auto.contract', 'independent.review'],
  );

  // Read the same rows back through the facade: the claim never completes work.
  const task = runtime.tasks.get(tree.execution.id);
  assert.equal(task.state, 'accepting');
  assert.equal(task.openAcceptanceId, claimed.acceptance.id);
  assert.equal(task.terminalAt, null);
  assert.equal(runtime.runs.get(run.id).state, 'reported');
  assert.equal(runtime.runs.get(run.id).claimId, claimed.claim.id);

  const eventTypes = runtime.service.listEvents({ runId: run.id }).map((event) => event.type);
  for (const expected of ['claim.recorded', 'run.sealed', 'acceptance.opened']) {
    assert.ok(eventTypes.includes(expected), `run ledger records ${expected}`);
  }
});

test('claim: a different nonce on a reported run is refused', async (t) => {
  const { runtime, tree, run, claim } = await openAcceptingRun(t);

  await assert.rejects(
    () =>
      runtime.runs.claim({
        runId: run.id,
        claim: { ...claim, nonce: 'claim-different' },
        idempotencyKey: 'claim-second',
      }),
    (error) => error.code === 'run_already_reported',
    'one run reports at most once',
  );

  assert.equal(runtime.tasks.get(tree.execution.id).state, 'accepting');
  assert.equal(runtime.service.listClaims({ runId: run.id }).length, 1);
  assert.equal(runtime.acceptances.list({ taskId: tree.execution.id }).length, 1);
});
