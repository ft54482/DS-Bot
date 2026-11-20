import assert from 'node:assert/strict';
import test from 'node:test';

import { createScheduler } from '../src/index.js';
import {
  createClock,
  createExecutor,
  createFakeRuntime,
  makeRun,
  makeTask,
} from './support/harness.js';

test('a task in stopping is not dispatched', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-1', 'stopping')],
    runs: [makeRun({ id: 'run-1', taskId: 'task-1' })],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const pass = await scheduler.tick();

  assert.equal(pass.dispatched.length, 0);
  assert.equal(pass.skipped.length, 1);
  assert.equal(pass.skipped[0].runId, 'run-1');
  assert.equal(pass.skipped[0].reason, 'task_stopping');
  assert.equal(executor.calls.length, 0);
  assert.equal(runtime.outbox.length, 0);
  assert.equal(runtime.findRun('run-1').state, 'queued');
});

test('a run with cancelRequestedAt is not dispatched', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-1')],
    runs: [makeRun({ id: 'run-1', taskId: 'task-1', cancelRequestedAt: clock.now() })],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const pass = await scheduler.tick();

  assert.equal(pass.dispatched.length, 0);
  assert.equal(pass.skipped[0].reason, 'run_stopping');
  assert.equal(executor.calls.length, 0);
});

test('completed and cancelled tasks are not dispatched', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-1', 'completed'), makeTask('task-2', 'cancelled')],
    runs: [
      makeRun({ id: 'run-1', taskId: 'task-1', createdAt: 1 }),
      makeRun({ id: 'run-2', taskId: 'task-2', createdAt: 2 }),
    ],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const pass = await scheduler.tick();

  assert.equal(pass.dispatched.length, 0);
  assert.deepEqual(
    pass.skipped.map((entry) => entry.reason),
    ['task_completed', 'task_cancelled'],
  );
  assert.equal(executor.calls.length, 0);
});

test('a missing task is reported and skipped', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    runs: [makeRun({ id: 'run-1', taskId: 'task-missing' })],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const pass = await scheduler.tick();
  assert.equal(pass.dispatched.length, 0);
  assert.equal(pass.skipped[0].reason, 'task_missing');
  assert.equal(executor.calls.length, 0);
});

test('a run that is no longer queued in the runtime view is skipped', async () => {
  const clock = createClock();
  const fake = createFakeRuntime({
    clock,
    tasks: [makeTask('task-1')],
    runs: [makeRun({ id: 'run-1', taskId: 'task-1' })],
  });
  const runtime = {
    ...fake,
    listQueuedRuns() {
      return [makeRun({ id: 'run-1', taskId: 'task-1', state: 'dispatched' })];
    },
  };
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const pass = await scheduler.tick();
  assert.equal(pass.dispatched.length, 0);
  assert.equal(pass.skipped[0].reason, 'run_not_queued');
  assert.equal(executor.calls.length, 0);
});
