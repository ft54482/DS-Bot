import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, passedItemStates, startAcceptingTask } from './support/fixtures.js';

test('a revise verdict returns the task to rework with revision+1 and a derived run', () => {
  const { service } = createHarness();
  const { task, run, acceptance } = startAcceptingTask(service);
  assert.equal(service.getTask(task.id).revision, 0);

  const result = service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'revise',
    itemStates: { 'auto.checks': 'fail' },
  });

  assert.equal(result.acceptance.state, 'revise');
  assert.equal(result.task.state, 'reworking');
  assert.equal(result.task.revision, 1);
  assert.equal(result.task.subjectFingerprint, null);
  assert.equal(result.task.openAcceptanceId, null);
  assert.equal(service.getRun(run.id).state, 'rejected');
  assert.equal(result.reworkRun.state, 'queued');
  assert.equal(result.reworkRun.kind, 'rework');
  assert.equal(result.task.currentRunId, result.reworkRun.id);

  const types = service.listEvents().map((event) => event.type);
  assert.ok(types.includes('acceptance.revise'));
  assert.ok(types.includes('run.rejected'));
  assert.ok(types.includes('task.reworking'));

  // The rework run is dispatched through the normal path and the task leaves reworking.
  const dispatched = service.dispatchTask({
    taskId: task.id,
    idempotencyKey: 'rework-dispatch',
  });
  assert.equal(dispatched.run.id, result.reworkRun.id);
  assert.equal(dispatched.task.state, 'queued');
  assert.equal(dispatched.run.state, 'dispatched');
});

test('a void verdict returns the task to running and invalidates the run', () => {
  const { service } = createHarness();
  const { task, run, acceptance } = startAcceptingTask(service);

  const result = service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'void',
    reason: 'snapshot_corrupted',
  });

  assert.equal(result.acceptance.state, 'void');
  assert.equal(result.task.state, 'running');
  assert.equal(result.task.openAcceptanceId, null);
  assert.equal(service.getRun(run.id).state, 'invalidated');
});

test('subject drift at decision time voids the round instead of passing it', () => {
  const { service, store } = createHarness();
  const { task, acceptance } = startAcceptingTask(service);
  const current = service.getTask(task.id);
  store.updateTask(
    task.id,
    { subjectFingerprint: 'f'.repeat(64) },
    { expectedStateVersion: current.stateVersion },
  );

  const result = service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(acceptance),
  });

  assert.equal(result.voided, true);
  assert.equal(result.acceptance.state, 'void');
  assert.equal(result.task.state, 'running');
  assert.equal(service.getTask(task.id).state, 'running');
});

test('only the acceptance service may decide a round', () => {
  const { service } = createHarness();
  const { acceptance } = startAcceptingTask(service);

  for (const actor of ['bot', 'chief', 'executor', 'human']) {
    assert.throws(
      () =>
        service.decideAcceptance({
          acceptanceId: acceptance.id,
          verdict: 'pass',
          itemStates: passedItemStates(acceptance),
          actor,
        }),
      (error) => {
        assert.equal(error.code, 'forbidden_transition');
        assert.equal(error.status, 403);
        return true;
      },
      `actor ${actor} must not decide acceptance`,
    );
  }
  assert.equal(service.getAcceptance(acceptance.id).state, 'open');
});

test('a block verdict parks the task with a blocked reason and keeps the run terminal', () => {
  const { service } = createHarness();
  const { task, run, acceptance } = startAcceptingTask(service);

  const result = service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'block',
    reason: 'review_unavailable',
    itemStates: { 'auto.checks': 'blocked' },
  });

  assert.equal(result.acceptance.state, 'blocked');
  assert.equal(result.task.state, 'blocked');
  assert.equal(result.task.blockedReason, 'review_unavailable');
  assert.equal(service.getRun(run.id).state, 'rejected');
});
