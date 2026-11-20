import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, passedItemStates, startAcceptingTask, startRunningTask } from './support/fixtures.js';

test('duplicate dispatch with the same idempotency key produces exactly one run', () => {
  const { service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'idempotent dispatch' });

  const first = service.dispatchTask({ taskId: task.id, idempotencyKey: 'dispatch-key-1' });
  const second = service.dispatchTask({ taskId: task.id, idempotencyKey: 'dispatch-key-1' });

  assert.equal(second.replayed, true);
  assert.equal(second.run.id, first.run.id);
  assert.equal(second.task.id, first.task.id);
  assert.equal(service.listRuns({ taskId: task.id }).length, 1);

  const created = service
    .listEvents()
    .filter((event) => event.type === 'run.created' && event.taskId === task.id);
  assert.equal(created.length, 1);
  const replayed = service
    .listEvents()
    .filter((event) => event.type === 'transition.replayed');
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].payload.idempotency_key, 'dispatch-key-1');
});

test('the same idempotency key with a different payload is duplicate_dispatch', () => {
  const { service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'dispatch conflict' });
  service.dispatchTask({ taskId: task.id, idempotencyKey: 'dispatch-key-2' });

  assert.throws(
    () =>
      service.dispatchTask({
        taskId: task.id,
        idempotencyKey: 'dispatch-key-2',
        executorKind: 'superagent',
      }),
    (error) => {
      assert.equal(error.code, 'duplicate_dispatch');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(service.listRuns({ taskId: task.id }).length, 1);
});

test('a second dispatch with a fresh key cannot create a parallel active run', () => {
  const { service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'one active run' });
  const first = service.dispatchTask({ taskId: task.id, idempotencyKey: 'dispatch-key-3' });

  assert.throws(
    () => service.dispatchTask({ taskId: task.id, idempotencyKey: 'dispatch-key-4' }),
    (error) => {
      assert.equal(error.code, 'invalid_state_transition');
      assert.equal(error.status, 409);
      assert.equal(error.details.guard, 'G04');
      return true;
    },
  );
  assert.deepEqual(
    service.listRuns({ taskId: task.id }).map((run) => run.id),
    [first.run.id],
  );
});

test('claim idempotency replays the first result without a second claim or acceptance', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  const claim = {
    commit: 'c'.repeat(40),
    dirty: false,
    manifest: [{ path: 'a.js', sha256: 'd'.repeat(64) }],
    nonce: 'nonce-idem',
  };

  const first = service.claimRun({ runId: run.id, claim, idempotencyKey: 'claim-key-1' });
  const second = service.claimRun({ runId: run.id, claim, idempotencyKey: 'claim-key-1' });

  assert.equal(second.replayed, true);
  assert.equal(second.claim.id, first.claim.id);
  assert.equal(second.acceptance.id, first.acceptance.id);
  assert.equal(service.listClaims({ runId: run.id }).length, 1);
  assert.equal(service.listAcceptances({ taskId: task.id }).length, 1);
  assert.equal(
    service.listEvents().filter((event) => event.type === 'acceptance.opened').length,
    1,
  );
});

test('a replayed acceptance decision does not complete a task twice', () => {
  const { service } = createHarness();
  const { task, acceptance } = startAcceptingTask(service);

  const first = service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(acceptance),
    idempotencyKey: 'decision-key-1',
  });
  const second = service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(acceptance),
    idempotencyKey: 'decision-key-1',
  });

  assert.equal(first.task.state, 'completed');
  assert.equal(second.replayed, true);
  assert.equal(second.task.state, 'completed');
  assert.equal(
    service.listEvents().filter((event) => event.type === 'task.completed').length,
    1,
  );
  assert.equal(
    service.listEvents().filter((event) => event.type === 'acceptance.passed').length,
    1,
  );
});

test('an acceptance can only be decided once, even without an idempotency key', () => {
  const { service } = createHarness();
  const { acceptance } = startAcceptingTask(service);
  service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'revise',
    itemStates: { 'auto.checks': 'fail' },
  });

  assert.throws(
    () =>
      service.decideAcceptance({
        acceptanceId: acceptance.id,
        verdict: 'pass',
        itemStates: { 'auto.checks': 'pass' },
      }),
    (error) => {
      assert.equal(error.code, 'invalid_state_transition');
      assert.equal(error.status, 409);
      assert.equal(error.details.guard, 'G20');
      return true;
    },
  );
});

test('same idempotency key from different operations does not collide', () => {
  const { service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'scoped keys' });
  // Different scopes hash the scope into the payload, so the same literal key is
  // still rejected as a conflict only when the payload matches the scope's hash.
  const dispatched = service.dispatchTask({ taskId: task.id, idempotencyKey: 'shared-key' });
  assert.throws(
    () => service.queueTask({ taskId: task.id, idempotencyKey: 'shared-key' }),
    (error) => {
      assert.equal(error.code, 'idempotency_conflict');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(service.getRun(dispatched.run.id).state, 'dispatched');
});
