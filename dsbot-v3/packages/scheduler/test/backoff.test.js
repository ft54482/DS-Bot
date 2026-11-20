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

function oneRun(clock) {
  return createFakeRuntime({
    clock,
    tasks: [makeTask('task-1')],
    runs: [makeRun({ id: 'run-1', taskId: 'task-1' })],
  });
}

test('a failed dispatch backs off for one second', async () => {
  const clock = createClock();
  const runtime = oneRun(clock);
  let failures = 1;
  const executor = createExecutor({
    clock,
    handler: () => {
      if (failures-- > 0) throw new Error('bridge down');
      return { ok: true, accepted: true, run_id: 'run-1' };
    },
  });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const failed = await scheduler.tick();
  assert.equal(failed.dispatched.length, 0);
  assert.equal(failed.failed.length, 1);
  assert.equal(failed.failed[0].attempt, 1);
  assert.equal(failed.failed[0].error, 'bridge down');
  assert.equal(failed.failed[0].nextRetryAt, clock.now() + 1000);
  assert.equal(runtime.findRun('run-1').state, 'queued');
  assert.equal(runtime.outbox.length, 1);
  assert.equal(runtime.outbox[0].state, 'pending');
  assert.equal(runtime.outbox[0].nextRetryAt, clock.now() + 1000);
  assert.equal(runtime.outbox[0].lastError, 'bridge down');

  const waiting = await scheduler.tick();
  assert.equal(waiting.waiting.length, 1);
  assert.equal(waiting.waiting[0].reason, 'backoff');
  assert.equal(executor.calls.length, 1);

  clock.advance(999);
  const stillWaiting = await scheduler.tick();
  assert.equal(stillWaiting.waiting[0].reason, 'backoff');
  assert.equal(executor.calls.length, 1);

  clock.advance(1);
  const retried = await scheduler.tick();
  assert.equal(retried.dispatched.length, 1);
  assert.equal(retried.dispatched[0].attempt, 2);
  assert.equal(executor.calls.length, 2);
  assert.equal(runtime.findRun('run-1').state, 'dispatched');
  assert.equal(runtime.outbox.length, 2);
  assert.equal(runtime.outbox[1].state, 'sent');
  assert.equal(scheduler.getRetryState('run-1'), null, 'success clears the retry window');
});

test('failure backoff doubles from one to two to four seconds', async () => {
  const clock = createClock();
  const runtime = oneRun(clock);
  const executor = createExecutor({
    clock,
    handler: () => {
      throw new Error('executor unavailable');
    },
  });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const delays = [];
  for (let failure = 0; failure < 3; failure += 1) {
    const pass = await scheduler.tick();
    assert.equal(pass.failed.length, 1);
    delays.push(pass.failed[0].nextRetryAt - clock.now());
    clock.advance(pass.failed[0].nextRetryAt - clock.now());
  }

  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(executor.calls.length, 3);
  assert.equal(runtime.outbox.length, 3);
});

test('failure backoff is capped at four seconds', async () => {
  const clock = createClock();
  const runtime = oneRun(clock);
  const executor = createExecutor({
    clock,
    handler: () => {
      throw new Error('executor unavailable');
    },
  });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const delays = [];
  for (let failure = 0; failure < 5; failure += 1) {
    const pass = await scheduler.tick();
    assert.equal(pass.failed.length, 1);
    delays.push(pass.failed[0].nextRetryAt - clock.now());
    clock.advance(pass.failed[0].nextRetryAt - clock.now());
  }

  assert.deepEqual(delays, [1000, 2000, 4000, 4000, 4000]);
  assert.equal(executor.calls.length, 5);
  assert.equal(scheduler.getRetryState('run-1').failures, 5);
});

test('an executor rejection result is treated as a retryable failure', async () => {
  const clock = createClock();
  const runtime = oneRun(clock);
  const executor = createExecutor({
    clock,
    handler: () => ({
      ok: false,
      accepted: false,
      code: 'RATE_LIMITED',
      message: 'bridge queue is full',
    }),
  });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const pass = await scheduler.tick();
  assert.equal(pass.dispatched.length, 0);
  assert.equal(pass.failed.length, 1);
  assert.equal(pass.failed[0].code, 'RATE_LIMITED');
  assert.equal(pass.failed[0].error, 'bridge queue is full');
  assert.equal(pass.failed[0].nextRetryAt, clock.now() + 1000);
  assert.equal(runtime.findRun('run-1').state, 'queued');
  assert.equal(runtime.outbox[0].state, 'pending');
  assert.equal(runtime.outbox[0].lastError, 'bridge queue is full');
});

test('a success after two failures resets the backoff window', async () => {
  const clock = createClock();
  const runtime = oneRun(clock);
  const outcomes = ['fail', 'fail', 'ok'];
  const executor = createExecutor({
    clock,
    handler: () => {
      const outcome = outcomes.shift();
      if (outcome === 'fail') throw new Error('transient');
      return { ok: true, accepted: true, run_id: 'run-1' };
    },
  });
  const scheduler = createScheduler({ runtime, executor, clock: clock.now });

  const first = await scheduler.tick();
  assert.equal(first.failed[0].attempt, 1);
  clock.advance(1000);

  const second = await scheduler.tick();
  assert.equal(second.failed[0].attempt, 2);
  assert.equal(second.failed[0].nextRetryAt - clock.now(), 2000);
  clock.advance(2000);

  const third = await scheduler.tick();
  assert.equal(third.dispatched.length, 1);
  assert.equal(third.dispatched[0].attempt, 3);
  assert.equal(scheduler.getRetryState('run-1'), null);
  assert.equal(scheduler.hasDispatched('run-1'), true);
});
