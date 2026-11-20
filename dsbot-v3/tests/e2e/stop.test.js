import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMemoryStore } from '../../packages/service/src/memory-store.js';
import {
  createBusiness,
  createClock,
  createExecution,
  createExecutor,
  createGoal,
  createIds,
  createService,
  dispatchToMock,
  hashTree,
} from './support/harness.js';

test('step10 one-click stop cascades and only cancels after verified quiescence', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsbot-e2e-stop-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'article.md'), '# sealed draft\n', 'utf8');
  const hashBeforeStop = hashTree(workspace);

  const clock = createClock();
  const ids = createIds(5000);
  const service = createService(createMemoryStore(), clock, ids);

  const goal = createGoal(service);
  service.transitionTask({
    taskId: goal.id,
    to: 'queued',
    actor: 'chief',
    idempotencyKey: 'stop-goal-queued',
  });
  const business = createBusiness(service, goal);
  service.transitionTask({
    taskId: business.id,
    to: 'queued',
    actor: 'bot',
    idempotencyKey: 'stop-business-queued',
  });
  const execution = createExecution(service, business);

  const dispatched = service.dispatchTask({
    taskId: execution.id,
    idempotencyKey: 'stop-dispatch-1',
    executorKind: 'mock',
  });
  const run = dispatched.run;
  const executor = createExecutor({
    usage: { tokens_in: 10, tokens_out: 5, tokens_cached: 0, cost_cny: 0.01 },
    artifact: '# in progress',
    completeAt: 60_000,
  });
  const accepted = await dispatchToMock({ adapter: executor.adapter, run });
  assert.equal(accepted.accepted, true);
  service.ackRun({ runId: run.id });

  service.transitionTask({
    taskId: business.id,
    to: 'running',
    actor: 'system',
    idempotencyKey: 'stop-business-running',
  });
  service.transitionTask({
    taskId: goal.id,
    to: 'running',
    actor: 'system',
    idempotencyKey: 'stop-goal-running',
  });
  assert.equal(service.getTask(execution.id).state, 'running');
  assert.equal(service.getRun(run.id).state, 'running');

  // One request on the root freezes the whole subtree; it does not fake "stopped".
  const stopRequested = service.requestStop({
    taskId: goal.id,
    requestedBy: 'human',
    reason: 'user_stop',
    idempotencyKey: 'stop-request-1',
  });
  assert.equal(stopRequested.stopState, 'requested');
  for (const task of [goal, business, execution]) {
    const current = service.getTask(task.id);
    assert.equal(current.state, 'stopping');
    assert.notEqual(current.state, 'cancelled');
    assert.equal(current.terminalAt, null);
  }
  const runAfterStop = service.getRun(run.id);
  assert.equal(runAfterStop.state, 'running');
  assert.notEqual(runAfterStop.cancelRequestedAt, null);
  assert.ok(runAfterStop.fencingToken > dispatched.run.fencingToken);
  assert.ok(
    service.listEvents({ type: 'run.cancel_requested' }).some((event) => event.runId === run.id),
  );

  const repeatedStop = service.requestStop({
    taskId: goal.id,
    idempotencyKey: 'stop-request-1',
  });
  assert.equal(repeatedStop.task.state, 'stopping');
  assert.equal(service.listEvents({ type: 'task.stopping' }).length, 3);

  // Missing stop evidence must fail closed: still stopping, never cancelled.
  const pending = service.verifyStop({
    taskId: goal.id,
    verifications: [],
    idempotencyKey: 'stop-verify-pending',
  });
  assert.equal(pending.cancelled, false);
  assert.equal(pending.stopState, 'stop_unknown');
  assert.ok(
    pending.blockers.some(
      (blocker) => blocker.runId === run.id && blocker.reasons.includes('missing_stop_verification'),
    ),
  );
  for (const task of [goal, business, execution]) {
    const current = service.getTask(task.id);
    assert.equal(current.state, 'stopping');
    assert.equal(current.stopUnknown, true);
  }
  assert.equal(service.getRun(run.id).state, 'running');

  // The executor confirms stop and the workspace is quiescent: hash unchanged.
  const cancel = await executor.adapter.cancel({ run_id: run.id });
  assert.equal(cancel.requested, true);
  assert.equal(cancel.state, 'cancelled');
  assert.equal(typeof cancel.verified_stopped_at, 'number');
  assert.equal(cancel.remote_may_still_run, false);
  assert.deepEqual(cancel.reasons, []);
  const hashAfterStop = hashTree(workspace);
  assert.equal(hashAfterStop, hashBeforeStop, 'the stopped executor must not write after cancel');

  const windowStartedAt = clock.now();
  const verified = service.verifyStop({
    taskId: goal.id,
    verifications: [
      {
        runId: run.id,
        processGone: true,
        cancelAck: true,
        quiescenceWindowMs: 5000,
        windowStartedAt,
        lastWriteAt: windowStartedAt - 1,
        namespaceHashBefore: hashBeforeStop,
        namespaceHashAfter: hashAfterStop,
        openFileHandles: 0,
      },
    ],
    minQuiescenceMs: 5000,
    idempotencyKey: 'stop-verify-verified',
  });
  assert.equal(verified.cancelled, true);
  assert.equal(verified.stopState, 'verified');
  assert.deepEqual(verified.blockers, []);
  for (const task of [goal, business, execution]) {
    const current = service.getTask(task.id);
    assert.equal(current.state, 'cancelled');
    assert.equal(current.stopState, 'verified');
    assert.equal(current.stopUnknown, false);
    assert.equal(current.terminalAt !== null, true);
  }
  assert.equal(service.getRun(run.id).state, 'cancelled');

  const cancelledOrder = service
    .listEvents({ type: 'task.cancelled' })
    .map((event) => event.taskId);
  assert.deepEqual(cancelledOrder, [execution.id, business.id, goal.id]);
  const verifiedOrder = service
    .listEvents({ type: 'task.stop_verified' })
    .map((event) => event.taskId);
  assert.deepEqual(verifiedOrder, [execution.id, business.id, goal.id]);

  const proofs = service.listStopVerifications({ runId: run.id });
  assert.ok(proofs.length >= 2);
  assert.equal(proofs[0].verdict, 'stop_unknown');
  assert.equal(proofs.at(-1).verdict, 'verified');

  // No new dispatch is accepted after the stop.
  const runsBefore = service.listRuns({ taskId: execution.id }).length;
  assert.throws(
    () =>
      service.dispatchTask({
        taskId: execution.id,
        idempotencyKey: 'stop-dispatch-after-cancel',
        executorKind: 'mock',
      }),
    (error) => error.code === 'invalid_state_transition' && error.status === 409,
  );
  assert.equal(service.listRuns({ taskId: execution.id }).length, runsBefore);
});
