import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHarness,
  passedItemStates,
  startAcceptingTask,
  startRunningTask,
  validClaim,
} from './support/fixtures.js';

function stopProof(runId, overrides = {}) {
  return {
    runId,
    cancelAck: true,
    processGone: true,
    quiescenceWindowMs: 5000,
    windowStartedAt: 10_000,
    lastWriteAt: 9_000,
    namespaceHashBefore: 'namespace-hash-a',
    namespaceHashAfter: 'namespace-hash-a',
    openFileHandles: 0,
    ...overrides,
  };
}

test('a stop request only freezes the task: it does not mark it cancelled', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);

  const requested = service.requestStop({ taskId: task.id, reason: 'user_cancelled' });

  assert.equal(requested.task.state, 'stopping');
  assert.equal(requested.task.stopState, 'requested');
  assert.equal(requested.task.stopUnknown, false);
  assert.notEqual(requested.task.state, 'cancelled');
  assert.equal(requested.task.terminalAt, null);

  const activeRun = service.getRun(run.id);
  assert.equal(activeRun.state, 'running');
  assert.equal(activeRun.cancelRequestedAt !== null, true);
  assert.ok(
    service
      .listEvents()
      .some((event) => event.type === 'run.cancel_requested' && event.runId === run.id),
  );
});

test('a stop request voids an open acceptance instead of letting it pass', () => {
  const { service } = createHarness();
  const { task, acceptance } = startAcceptingTask(service);

  service.requestStop({ taskId: task.id });

  assert.equal(service.getAcceptance(acceptance.id).state, 'void');
  assert.equal(service.getTask(task.id).state, 'stopping');
  assert.equal(service.getTask(task.id).openAcceptanceId, null);
});

test('unverified stop writes stop_unknown and never sets cancelled', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  service.requestStop({ taskId: task.id });

  const result = service.verifyStop({
    taskId: task.id,
    verifications: [
      stopProof(run.id, {
        processGone: false,
        cancelAck: true,
        windowStartedAt: 10_000,
        lastWriteAt: 10_500, // write inside the quiescence window
      }),
    ],
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.stopState, 'stop_unknown');
  assert.ok(result.blockers.length > 0);
  assert.ok(result.blockers[0].reasons.includes('process_still_alive'));
  assert.ok(result.blockers[0].reasons.includes('write_inside_quiescence_window'));

  const taskAfter = service.getTask(task.id);
  assert.equal(taskAfter.state, 'stopping');
  assert.equal(taskAfter.stopUnknown, true);
  assert.equal(taskAfter.stopState, 'stop_unknown');
  assert.notEqual(taskAfter.state, 'cancelled');
  assert.equal(service.getRun(run.id).state, 'running');

  const stored = service.listStopVerifications({ taskId: task.id });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].verdict, 'stop_unknown');
});

test('a changed namespace hash fails stop verification even when the process is gone', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  service.requestStop({ taskId: task.id });

  const result = service.verifyStop({
    taskId: task.id,
    verifications: [stopProof(run.id, { namespaceHashAfter: 'namespace-hash-b' })],
  });
  assert.equal(result.cancelled, false);
  assert.ok(result.blockers[0].reasons.includes('namespace_changed'));
  assert.equal(service.getTask(task.id).state, 'stopping');
});

test('verified stop cancels the run and the task', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  service.requestStop({ taskId: task.id });

  const result = service.verifyStop({
    taskId: task.id,
    verifications: [stopProof(run.id)],
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.stopState, 'verified');
  const taskAfter = service.getTask(task.id);
  assert.equal(taskAfter.state, 'cancelled');
  assert.equal(taskAfter.stopState, 'verified');
  assert.equal(taskAfter.stopUnknown, false);
  assert.equal(taskAfter.terminalAt !== null, true);
  assert.equal(service.getRun(run.id).state, 'cancelled');

  const types = service.listEvents().map((event) => event.type);
  assert.ok(types.includes('task.stop_verified'));
  assert.ok(types.includes('task.cancelled'));
  assert.ok(types.includes('run.cancelled'));

  const stored = service.listStopVerifications({ taskId: task.id });
  assert.equal(stored[0].verdict, 'verified');
});

test('stop verification fails closed when a verification record is missing', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  service.requestStop({ taskId: task.id });

  const result = service.verifyStop({ taskId: task.id, verifications: [] });
  assert.equal(result.cancelled, false);
  assert.ok(result.blockers[0].reasons.includes('missing_stop_verification'));
  assert.equal(service.getTask(task.id).state, 'stopping');
  assert.equal(service.getRun(run.id).state, 'running');
});

test('an expired stop verification deadline becomes blocked(stop_unverified), not cancelled', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  service.requestStop({ taskId: task.id });

  const result = service.verifyStop({
    taskId: task.id,
    verifications: [stopProof(run.id, { processGone: false })],
    deadlinePassed: true,
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.stopState, 'failed');
  const taskAfter = service.getTask(task.id);
  assert.equal(taskAfter.state, 'blocked');
  assert.equal(taskAfter.blockedReason, 'stop_unverified');
  assert.equal(taskAfter.stopUnknown, true);
  assert.notEqual(taskAfter.state, 'cancelled');
  assert.equal(service.getRun(run.id).state, 'running');
});

test('stop cascade is child-first and a parent only cancels after its subtree is verified', () => {
  const { service } = createHarness();
  const goal = service.createTask({ level: 'goal', title: 'stop goal' });
  const business = service.createTask({
    level: 'business',
    parentTaskId: goal.id,
    title: 'stop business',
  });
  const execution = startRunningTask(service, {
    task: { parentTaskId: business.id, title: 'stop execution' },
    dispatchKey: 'stop-child-dispatch',
  });

  service.requestStop({ taskId: goal.id });
  assert.equal(service.getTask(goal.id).state, 'stopping');
  assert.equal(service.getTask(business.id).state, 'stopping');
  assert.equal(service.getTask(execution.task.id).state, 'stopping');

  const result = service.verifyStop({
    taskId: goal.id,
    verifications: [stopProof(execution.run.id)],
  });
  assert.equal(result.cancelled, true);
  assert.equal(service.getTask(goal.id).state, 'cancelled');
  assert.equal(service.getTask(business.id).state, 'cancelled');
  assert.equal(service.getTask(execution.task.id).state, 'cancelled');
  assert.equal(service.getRun(execution.run.id).state, 'cancelled');

  const cancelledOrder = service
    .listEvents()
    .filter((event) => event.type === 'task.cancelled')
    .map((event) => event.taskId);
  assert.deepEqual(cancelledOrder, [execution.task.id, business.id, goal.id]);
});

test('an explicit forced stop is recorded as unsafe and never silent', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  service.requestStop({ taskId: task.id });

  const result = service.verifyStop({
    taskId: task.id,
    verifications: [stopProof(run.id, { processGone: false })],
    force: true,
    decisionToken: 'human-signed-token',
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.stopState, 'forced');
  assert.equal(result.unsafeStop, true);
  const taskAfter = service.getTask(task.id);
  assert.equal(taskAfter.state, 'cancelled');
  assert.equal(taskAfter.unsafeStop, true);
  assert.ok(
    service.listEvents().some((event) => event.type === 'security.stop_unverified'),
  );
});

test('blocked(stop_unverified) cannot resume work without an explicit stop decision', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  service.requestStop({ taskId: task.id });
  service.verifyStop({
    taskId: task.id,
    verifications: [stopProof(run.id, { processGone: false })],
    deadlinePassed: true,
  });
  assert.equal(service.getTask(task.id).state, 'blocked');
  assert.equal(service.getTask(task.id).blockedReason, 'stop_unverified');

  for (const to of ['queued', 'planned']) {
    assert.throws(
      () => service.transitionTask({ taskId: task.id, to, actor: 'human' }),
      (error) => {
        assert.equal(error.code, 'invalid_state_transition');
        assert.equal(error.details.reason, 'stop_unverified_requires_manual_force');
        return true;
      },
    );
  }
  assert.equal(service.getTask(task.id).state, 'blocked');
});

test('a task cannot jump into stopping when it is already terminal', () => {
  const { service } = createHarness();
  const { task, acceptance } = startAcceptingTask(service);
  service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(acceptance),
  });
  assert.equal(service.getTask(task.id).state, 'completed');

  assert.throws(
    () => service.requestStop({ taskId: task.id }),
    (error) => {
      assert.equal(error.code, 'invalid_state_transition');
      assert.equal(error.status, 409);
      assert.equal(error.details.from, 'completed');
      return true;
    },
  );
  assert.equal(service.getTask(task.id).state, 'completed');
});

test('stop requests are idempotent and keep the first stop metadata', () => {
  const { service } = createHarness();
  const { task } = startRunningTask(service);
  const first = service.requestStop({ taskId: task.id, requestedBy: 'human' });
  const second = service.requestStop({ taskId: task.id, requestedBy: 'human' });

  assert.equal(second.task.state, 'stopping');
  assert.equal(second.task.stopRequestedAt, first.task.stopRequestedAt);
  assert.equal(
    service.listEvents().filter((event) => event.type === 'task.stopping').length,
    1,
  );
});

test('a claimed-but-unaccepted run keeps the claim while stop is pending', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  const claimed = service.claimRun({ runId: run.id, claim: validClaim() });
  assert.equal(claimed.run.state, 'reported');

  service.requestStop({ taskId: task.id });
  assert.equal(service.getTask(task.id).state, 'stopping');
  assert.equal(service.getRun(run.id).state, 'reported');
  assert.equal(service.getAcceptance(claimed.acceptance.id).state, 'void');
});

test('a successful stop cancels a sealed reported run without executor proof', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  service.claimRun({ runId: run.id, claim: validClaim() });
  service.requestStop({ taskId: task.id });

  const result = service.verifyStop({ taskId: task.id, verifications: [] });
  assert.equal(result.cancelled, true);
  assert.equal(service.getTask(task.id).state, 'cancelled');
  assert.equal(service.getRun(run.id).state, 'cancelled');
});

test('a queued rework run only needs cancellation, not a quiescence proof', () => {
  const { service } = createHarness();
  const { task, acceptance } = startAcceptingTask(service);
  const revised = service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'revise',
    itemStates: { 'auto.checks': 'fail' },
  });
  assert.equal(revised.reworkRun.state, 'queued');

  service.requestStop({ taskId: task.id });
  const result = service.verifyStop({ taskId: task.id, verifications: [] });
  assert.equal(result.cancelled, true);
  assert.equal(service.getRun(revised.reworkRun.id).state, 'cancelled');
  assert.equal(service.getTask(task.id).state, 'cancelled');
});
