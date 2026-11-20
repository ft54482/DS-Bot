import assert from 'node:assert/strict';
import test from 'node:test';

import { createTree, openRuntime } from './support/harness.js';

// Read-only count over the store the runtime owns; no DAO logic is reimplemented.
function outboxCount(runtime) {
  return runtime.store.db.prepare('SELECT COUNT(*) AS count FROM dispatch_outbox').get().count;
}

test('dispatch: writes the run and a pending dispatch_outbox intent', (t) => {
  const { runtime } = openRuntime(t);
  const { execution } = createTree(runtime);

  const dispatched = runtime.tasks.dispatch({
    taskId: execution.id,
    executorKind: 'mock',
    idempotencyKey: 'dispatch-once',
  });
  const { run } = dispatched;

  // The run is durable and points back at the execution task.
  assert.equal(dispatched.task.state, 'queued');
  assert.equal(dispatched.task.currentRunId, run.id);
  assert.equal(run.state, 'dispatched');
  assert.equal(run.executorKind, 'mock');
  assert.equal(run.attemptNo, 1);
  assert.equal(runtime.runs.get(run.id).state, 'dispatched');
  assert.equal(runtime.runs.list({ taskId: execution.id }).length, 1);

  // The dispatch intent is written in the same transaction, before any send.
  const intent = runtime.store.getOutbox(`outbox-${run.id}`);
  assert.notEqual(intent, null, 'dispatch must persist an outbox intent');
  assert.equal(intent.intent, 'dispatch_run');
  assert.equal(intent.state, 'pending');
  assert.equal(intent.task_id, execution.id);
  assert.equal(intent.run_id, run.id);
  assert.equal(intent.principal_ref, 'scheduler');
  assert.equal(intent.idempotency_key, 'outbox:dispatch-once');
  assert.deepEqual(JSON.parse(intent.payload_json), {
    run_id: run.id,
    task_id: execution.id,
    executor_kind: 'mock',
    idempotency_key: 'dispatch-once',
  });
});

test('dispatch: repeating the same dispatch replays and creates nothing new', (t) => {
  const { runtime } = openRuntime(t);
  const { execution } = createTree(runtime);

  // Same caller, no explicit key: the runtime derives it from the task.
  const first = runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock' });
  const replay = runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock' });

  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.task.currentRunId, first.run.id);
  assert.equal(runtime.runs.list({ taskId: execution.id }).length, 1);
  assert.equal(outboxCount(runtime), 1, 'a replay must not enqueue a second intent');
  assert.notEqual(runtime.store.getOutbox(`outbox-${first.run.id}`), null);
});

test('dispatch: a different key while a run is active is refused', (t) => {
  const { runtime } = openRuntime(t);
  const { execution } = createTree(runtime);

  const first = runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock' });

  assert.throws(
    () =>
      runtime.tasks.dispatch({
        taskId: execution.id,
        executorKind: 'mock',
        idempotencyKey: 'dispatch-other',
      }),
    (error) => error.code === 'invalid_state_transition' && error.status === 409,
    'one execution task may not own two active runs',
  );
  assert.equal(runtime.runs.list({ taskId: execution.id }).length, 1);
  assert.equal(runtime.tasks.get(execution.id).currentRunId, first.run.id);
  assert.equal(outboxCount(runtime), 1);
});
