import test from 'node:test';
import assert from 'node:assert/strict';

import { isServiceError } from '../src/errors.js';
import { createHarness } from './support/fixtures.js';

test('illegal task transition returns invalid_state_transition with 409 semantics and writes no projection', () => {
  const { store, service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'illegal transition' });
  const before = service.getTask(task.id);
  const eventsBefore = store.listEvents().length;

  assert.throws(
    () => service.transitionTask({ taskId: task.id, to: 'running' }),
    (error) => {
      assert.equal(isServiceError(error, 'invalid_state_transition'), true);
      assert.equal(error.code, 'invalid_state_transition');
      assert.equal(error.status, 409);
      assert.equal(error.details.from, 'planned');
      assert.equal(error.details.to, 'running');
      return true;
    },
  );

  const after = service.getTask(task.id);
  assert.equal(after.state, 'planned');
  assert.equal(after.stateVersion, before.stateVersion);

  const events = store.listEvents();
  assert.equal(events.length, eventsBefore + 1);
  const rejection = events.at(-1);
  assert.equal(rejection.type, 'transition.rejected');
  assert.equal(rejection.payload.from_state, 'planned');
  assert.equal(rejection.payload.to_state, 'running');
  assert.equal(rejection.payload.guard_failed, 'transition_table');
  assert.equal(rejection.payload.actor, 'system');
});

test('illegal transition rejection keeps the event hash chain linked', () => {
  const { store, service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'event chain' });
  service.queueTask({ taskId: task.id });
  assert.throws(() => service.transitionRun({ runId: 'run-missing', to: 'running' }), /does not exist/);

  const events = store.listEvents();
  assert.ok(events.length >= 2);
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].prevHash, events[index - 1].hash);
    assert.equal(typeof events[index].hash, 'string');
    assert.equal(events[index].hash.length, 64);
  }
});

test('state_version mismatch is state_conflict, not a silent overwrite', () => {
  const { service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'cas' });

  assert.throws(
    () =>
      service.transitionTask({
        taskId: task.id,
        to: 'queued',
        expectedStateVersion: 99,
      }),
    (error) => {
      assert.equal(error.code, 'state_conflict');
      assert.equal(error.status, 409);
      assert.equal(error.details.guard, 'G02');
      return true;
    },
  );
  assert.equal(service.getTask(task.id).state, 'planned');
});

test('executor and reviewer roles cannot move a task state', () => {
  const { service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'role guard' });
  service.queueTask({ taskId: task.id });

  for (const actor of ['executor', 'adapter', 'reviewer']) {
    assert.throws(
      () => service.transitionTask({ taskId: task.id, to: 'running', actor }),
      (error) => {
        assert.equal(error.code, 'forbidden_transition');
        assert.equal(error.status, 403);
        return true;
      },
      `actor ${actor} must be rejected`,
    );
  }
  const securityEvents = service
    .listEvents()
    .filter((event) => event.type === 'security.forbidden_transition');
  assert.equal(securityEvents.length, 3);
  assert.equal(service.getTask(task.id).state, 'queued');
});

test('an executor ack applies the task projection through the service, not through executor authority', () => {
  const { service } = createHarness();
  const task = service.createTask({ level: 'execution', title: 'ack projection' });
  const { run } = service.dispatchTask({ taskId: task.id, idempotencyKey: 'dispatch-1' });
  const acked = service.ackRun({ runId: run.id });
  assert.equal(acked.task.state, 'running');
  assert.equal(acked.run.state, 'running');

  const taskEvent = service
    .listEvents()
    .find((event) => event.type === 'task.running');
  assert.equal(taskEvent.actor, 'system');
  assert.equal(taskEvent.cause, 'executor_ack:executor');
});
