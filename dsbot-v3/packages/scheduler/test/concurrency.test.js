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

function fiveRunsAndTasks() {
  const ids = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'];
  return {
    tasks: ids.map((id) => makeTask(`task-${id}`)),
    runs: ids.map((id, index) =>
      makeRun({ id, taskId: `task-${id}`, createdAt: index + 1 }),
    ),
    ids,
  };
}

test('maxWorkers=4 dispatches four of five runs and the fifth waits', async () => {
  const clock = createClock();
  const { tasks, runs } = fiveRunsAndTasks();
  const runtime = createFakeRuntime({ clock, tasks, runs });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({
    runtime,
    executor,
    clock: clock.now,
    maxWorkers: 4,
  });

  const pass = await scheduler.tick();

  assert.equal(pass.dispatched.length, 4);
  assert.deepEqual(
    pass.dispatched.map((entry) => entry.runId),
    ['run-1', 'run-2', 'run-3', 'run-4'],
  );
  assert.equal(pass.waiting.length, 1);
  assert.equal(pass.waiting[0].runId, 'run-5');
  assert.equal(pass.waiting[0].reason, 'concurrency_limit');
  assert.equal(pass.active, 4);
  assert.equal(pass.available, 0);

  assert.equal(executor.calls.length, 4);
  assert.equal(runtime.findRun('run-5').state, 'queued', 'the fifth run stays queued');
  assert.equal(runtime.outbox.length, 4);
});

test('a freed worker slot dispatches the waiting run on the next tick', async () => {
  const clock = createClock();
  clock.advance(10);
  const { tasks, runs } = fiveRunsAndTasks();
  const runtime = createFakeRuntime({ clock, tasks, runs });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({
    runtime,
    executor,
    clock: clock.now,
    maxWorkers: 4,
  });

  await scheduler.tick();
  assert.equal(runtime.findRun('run-5').state, 'queued');

  runtime.complete('run-1');
  clock.advance(1000);
  const pass = await scheduler.tick();

  assert.equal(pass.dispatched.length, 1);
  assert.equal(pass.dispatched[0].runId, 'run-5');
  assert.equal(pass.active, 4, 'three old runs plus the new one occupy the pool');
  assert.equal(pass.waiting.length, 0);
  assert.equal(runtime.findRun('run-5').state, 'dispatched');
  assert.equal(executor.calls.length, 5);
});

test('runs already dispatched or running count against maxWorkers', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-1'), makeTask('task-2'), makeTask('task-3')],
    runs: [
      makeRun({ id: 'run-1', taskId: 'task-1', state: 'running', createdAt: 1 }),
      makeRun({ id: 'run-2', taskId: 'task-2', state: 'dispatched', createdAt: 2 }),
      makeRun({ id: 'run-3', taskId: 'task-3', createdAt: 3 }),
    ],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({
    runtime,
    executor,
    clock: clock.now,
    maxWorkers: 2,
  });

  const blocked = await scheduler.tick();
  assert.equal(blocked.dispatched.length, 0);
  assert.equal(blocked.waiting.length, 1);
  assert.equal(blocked.waiting[0].reason, 'concurrency_limit');
  assert.equal(executor.calls.length, 0);

  runtime.complete('run-1');
  const pass = await scheduler.tick();
  assert.equal(pass.dispatched.length, 1);
  assert.equal(pass.dispatched[0].runId, 'run-3');
  assert.equal(pass.active, 2);
});

test('queued runs are dispatched in FIFO createdAt order', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-late'), makeTask('task-early'), makeTask('task-mid')],
    runs: [
      makeRun({ id: 'run-late', taskId: 'task-late', createdAt: 20 }),
      makeRun({ id: 'run-early', taskId: 'task-early', createdAt: 10 }),
      makeRun({ id: 'run-mid', taskId: 'task-mid', createdAt: 30 }),
    ],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({
    runtime,
    executor,
    clock: clock.now,
    maxWorkers: 3,
  });

  const pass = await scheduler.tick();

  assert.deepEqual(
    pass.dispatched.map((entry) => entry.runId),
    ['run-early', 'run-late', 'run-mid'],
  );
  assert.deepEqual(
    executor.calls.map((call) => call.request.run_id),
    ['run-early', 'run-late', 'run-mid'],
  );
});

test('higher priority wins over an older createdAt', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-low'), makeTask('task-high')],
    runs: [
      makeRun({ id: 'run-low', taskId: 'task-low', createdAt: 1, priority: 10 }),
      makeRun({ id: 'run-high', taskId: 'task-high', createdAt: 99, priority: 90 }),
    ],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({
    runtime,
    executor,
    clock: clock.now,
    maxWorkers: 2,
  });

  const pass = await scheduler.tick();
  assert.deepEqual(
    pass.dispatched.map((entry) => entry.runId),
    ['run-high', 'run-low'],
  );
});
