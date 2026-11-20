import assert from 'node:assert/strict';
import test from 'node:test';

import { createScheduler } from '../src/index.js';
import { createClock, createExecutor, createFakeRuntime, makeRun, makeTask } from './support/harness.js';

test('createScheduler rejects missing dependencies and invalid limits', () => {
  const clock = createClock();
  const runtime = createFakeRuntime({ clock });
  const executor = createExecutor({ clock });

  assert.throws(() => createScheduler({ executor }), /runtime/);
  assert.throws(() => createScheduler({ runtime }), /executor/);
  assert.throws(
    () => createScheduler({ runtime, executor, maxWorkers: 0 }),
    /maxWorkers/,
  );
  assert.throws(
    () => createScheduler({ runtime, executor, maxWorkers: 1.5 }),
    /maxWorkers/,
  );
  assert.throws(
    () => createScheduler({ runtime, executor, clock: 42 }),
    /clock/,
  );
  assert.throws(
    () => createScheduler({ runtime, executor, baseBackoffMs: 0 }),
    /baseBackoffMs/,
  );
  assert.throws(
    () => createScheduler({ runtime, executor, baseBackoffMs: 2000, maxBackoffMs: 1000 }),
    /maxBackoffMs/,
  );
});

test('tick dispatches a queued run, marks it dispatched and records an outbox intent', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-1')],
    runs: [makeRun({ id: 'run-1', taskId: 'task-1' })],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({
    runtime,
    executor,
    clock: clock.now,
    maxWorkers: 4,
  });

  const pass = await scheduler.tick();

  assert.equal(pass.at, clock.now());
  assert.equal(pass.dispatched.length, 1);
  assert.equal(pass.dispatched[0].runId, 'run-1');
  assert.equal(pass.dispatched[0].taskId, 'task-1');
  assert.equal(pass.dispatched[0].attempt, 1);
  assert.equal(pass.failed.length, 0);
  assert.equal(pass.waiting.length, 0);
  assert.equal(pass.skipped.length, 0);
  assert.equal(pass.active, 1);
  assert.equal(pass.available, 3);

  assert.equal(runtime.findRun('run-1').state, 'dispatched');
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0].request.run_id, 'run-1');

  assert.equal(runtime.outbox.length, 1);
  const [entry] = runtime.outbox;
  assert.equal(entry.id, 'outbox-run-1-a1');
  assert.equal(entry.intent, 'dispatch_run');
  assert.equal(entry.state, 'sent');
  assert.equal(entry.runId, 'run-1');
  assert.equal(entry.taskId, 'task-1');
  assert.equal(entry.attempt, 1);
  assert.equal(entry.idempotencyKey, 'scheduler:run-1:dispatch:1');
  assert.deepEqual(entry.payload, {
    run_id: 'run-1',
    task_id: 'task-1',
    executor_kind: 'mock',
    attempt: 1,
    idempotency_key: 'scheduler:run-1:dispatch:1',
  });
  assert.equal(scheduler.hasDispatched('run-1'), true);
  assert.equal(entry.sentAt, clock.now());
});

test('dispatch request carries the task pack, workspace, budget and tracker', async () => {
  const clock = createClock();
  const task = makeTask('task-1', 'queued', {
    title: 'write the article',
    subject: { goal: 'publish a reviewed article' },
    acceptanceProfile: {
      items: [
        { key: 'auto.contract', class: 'auto', required: true },
        { key: 'independent.review', class: 'independent', required: true },
      ],
    },
    budget: { capCny: 2.5 },
  });
  const runtime = createFakeRuntime({
    clock,
    tasks: [task],
    runs: [makeRun({ id: 'run-1', taskId: 'task-1' })],
  });
  const executor = createExecutor({ clock });
  const scheduler = createScheduler({
    runtime,
    executor,
    clock: clock.now,
    workspacePath: 'C:/work/run-1',
  });

  await scheduler.tick();

  const { request } = executor.calls[0];
  assert.deepEqual(request.run, {
    id: 'run-1',
    executor_kind: 'mock',
    executorKind: 'mock',
  });
  assert.equal(request.task_id, 'task-1');
  assert.equal(request.attempt, 1);
  assert.equal(request.idempotency_key, 'scheduler:run-1:dispatch:1');
  assert.deepEqual(request.taskPack, {
    goal: 'publish a reviewed article',
    constraints: [],
    acceptance: ['auto.contract', 'independent.review'],
    context_refs: [],
  });
  assert.deepEqual(request.workspace, { path: 'C:/work/run-1' });
  assert.deepEqual(request.budget, { cny_cap: 2.5 });
  assert.deepEqual(request.tracking, { status: true, follow: true });
  assert.equal(request.task.id, 'task-1');
});

test('repeated tick does not re-dispatch a run even if the queue view is stale', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-1')],
    runs: [makeRun({ id: 'run-1', taskId: 'task-1' })],
  });
  runtime.freezeQueue();

  const executor = createExecutor({ clock });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const first = await scheduler.tick();
  const second = await scheduler.tick();

  assert.equal(first.dispatched.length, 1);
  assert.equal(second.dispatched.length, 0);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0].runId, 'run-1');
  assert.equal(second.skipped[0].reason, 'already_dispatched');
  assert.equal(executor.calls.length, 1, 'the executor is called exactly once');
  assert.equal(runtime.outbox.length, 1, 'the outbox intent is recorded exactly once');
});

test('overlapping tick calls share one in-flight pass', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({
    clock,
    tasks: [makeTask('task-1')],
    runs: [makeRun({ id: 'run-1', taskId: 'task-1' })],
  });

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const executor = createExecutor({
    clock,
    handler: async () => {
      await gate;
      return { ok: true, accepted: true, run_id: 'run-1' };
    },
  });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const first = scheduler.tick();
  const second = scheduler.tick();
  assert.equal(first, second, 'both callers observe the same pass');

  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(left.dispatched.length, 1);
  assert.equal(executor.calls.length, 1);
  assert.equal(runtime.outbox.length, 1);
});

test('the L9 runtime facade is adapted to the scheduler port', async () => {
  const clock = createClock();
  const task = makeTask('task-1');
  const run = makeRun({ id: 'run-1', taskId: 'task-1' });
  const transitions = [];
  const outbox = [];

  const facade = {
    runs: {
      list(filter = {}) {
        if (filter.state !== undefined) {
          return [run].filter((candidate) => candidate.state === filter.state);
        }
        return [run];
      },
      get(runId) {
        return runId === run.id ? run : null;
      },
    },
    tasks: {
      get(taskId) {
        return taskId === task.id ? task : null;
      },
    },
    service: {
      transitionRun({ runId, to }) {
        transitions.push({ runId, to });
        run.state = to;
        return { run };
      },
    },
    store: {
      enqueueOutbox(input) {
        outbox.push({ ...input });
        return { ...input };
      },
    },
  };

  const scheduler = createScheduler({
    runtime: facade,
    executor: createExecutor({ clock }),
    clock: clock.now,
    maxWorkers: 2,
  });
  const pass = await scheduler.tick();

  assert.equal(pass.dispatched.length, 1);
  assert.deepEqual(transitions, [{ runId: 'run-1', to: 'dispatched' }]);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].task_id, 'task-1');
  assert.equal(outbox[0].run_id, 'run-1');
  assert.equal(outbox[0].principal_ref, 'scheduler');
  assert.equal(outbox[0].intent, 'dispatch_run');
  assert.equal(outbox[0].state, 'sent');
  assert.equal(outbox[0].idempotency_key, 'scheduler:run-1:dispatch:1');
  assert.equal(outbox[0].attempts, 1);
  assert.deepEqual(JSON.parse(outbox[0].payload_json), {
    run_id: 'run-1',
    task_id: 'task-1',
    executor_kind: 'mock',
    attempt: 1,
    idempotency_key: 'scheduler:run-1:dispatch:1',
  });
});

test('an empty queue produces an empty pass', async () => {
  const clock = createClock();
  const runtime = createFakeRuntime({ clock });
  const scheduler = createScheduler({
    runtime,
    executor: createExecutor({ clock }),
    clock: clock.now,
    maxWorkers: 2,
  });

  const pass = await scheduler.tick();
  assert.deepEqual(pass.dispatched, []);
  assert.deepEqual(pass.failed, []);
  assert.deepEqual(pass.waiting, []);
  assert.deepEqual(pass.skipped, []);
  assert.equal(pass.active, 0);
  assert.equal(pass.available, 2);
});
