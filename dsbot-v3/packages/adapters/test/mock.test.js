import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256, validateResult } from '../src/contract.js';
import { createMockAdapter } from '../src/mock.js';
import { createClock, dispatchEnvelope } from './helpers/harness.js';

const RUN = { run_id: 'run-1' };

test('mock: scripted progress then completion', async () => {
  const clock = createClock();
  const adapter = createMockAdapter({
    now: clock.now,
    script: [
      { at: 0, type: 'progress', message: 'started' },
      {
        at: 100,
        type: 'complete',
        summary: 'done',
        usage: { tokens_in: 10, tokens_out: 5, tokens_cached: 1, cost_cny: 0.1 },
        artifacts: [{ path: 'article.md', content: '# hi' }],
      },
    ],
  });

  const dispatched = await adapter.dispatch(dispatchEnvelope());
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.accepted, true);
  assert.equal(dispatched.state, 'dispatched');
  assert.deepEqual(dispatched.tracking.modes, ['status', 'follow']);

  let status = await adapter.status(RUN);
  assert.equal(status.state, 'running');
  assert.equal(status.progress.health, 'progress');

  clock.advance(100);
  status = await adapter.status(RUN);
  assert.equal(status.state, 'completed');
  assert.equal(status.usage.tokens_in, 10);
  assert.equal(status.usage.cost_cny, 0.1);

  const page = await adapter.follow(RUN, 0);
  assert.deepEqual(page.events.map((event) => event.type), ['run.started', 'run.progress', 'run.completed']);
  assert.equal(page.next_seq, 3);
  const tail = await adapter.follow(RUN, 2);
  assert.deepEqual(tail.events.map((event) => event.type), ['run.completed']);
  assert.equal(tail.next_seq, 3);
});

test('mock: scripted failure', async () => {
  const clock = createClock();
  const adapter = createMockAdapter({
    now: clock.now,
    script: [{ at: 50, type: 'fail', error: { code: 'boom', message: 'model crashed' } }],
  });
  await adapter.dispatch(dispatchEnvelope());
  clock.advance(50);
  const status = await adapter.status(RUN);
  assert.equal(status.state, 'failed');
  assert.equal(status.progress.failure.code, 'boom');
  const page = await adapter.follow(RUN, 0);
  assert.ok(page.events.some((event) => event.type === 'run.failed'));
});

test('mock: scripted timeout reports no_progress, not completion', async () => {
  const clock = createClock();
  const adapter = createMockAdapter({
    now: clock.now,
    script: [
      { at: 0, type: 'progress', message: 'working' },
      { at: 1000, type: 'timeout', message: 'no progress in 1000ms' },
    ],
  });
  await adapter.dispatch(dispatchEnvelope());
  clock.advance(2000);
  const status = await adapter.status(RUN);
  assert.equal(status.state, 'stalled');
  assert.equal(status.progress.health, 'no_progress');
  assert.equal(status.progress.timed_out, true);
  const page = await adapter.follow(RUN, 0);
  assert.equal(page.timedOut, true);
});

test('mock: cancel is verified by default and reports cancelled', async () => {
  const clock = createClock();
  const adapter = createMockAdapter({ now: clock.now, script: [{ at: 1000, type: 'complete' }] });
  await adapter.dispatch(dispatchEnvelope());

  const cancelled = await adapter.cancel(RUN);
  assert.equal(cancelled.requested, true);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(typeof cancelled.verified_stopped_at, 'number');

  const status = await adapter.status(RUN);
  assert.equal(status.state, 'cancelled');
  const page = await adapter.follow(RUN, 0);
  assert.ok(page.events.some((event) => event.type === 'run.cancelled'));
});

test('mock: unconfirmed stop returns stop_unknown, never cancelled', async () => {
  const clock = createClock();
  const adapter = createMockAdapter({
    now: clock.now,
    script: [{ at: 1000, type: 'complete' }],
    cancelVerification: 'unverified',
  });
  await adapter.dispatch(dispatchEnvelope());
  const cancelled = await adapter.cancel(RUN);
  assert.equal(cancelled.requested, true);
  assert.equal(cancelled.state, 'stop_unknown');
  assert.equal(cancelled.verified_stopped_at, null);
  assert.equal(cancelled.remote_may_still_run, true);
});

test('mock: cancel after completion is refused', async () => {
  const clock = createClock();
  const adapter = createMockAdapter({ now: clock.now, script: [{ at: 0, type: 'complete' }] });
  await adapter.dispatch(dispatchEnvelope());
  const cancelled = await adapter.cancel(RUN);
  assert.equal(cancelled.requested, false);
  assert.equal(cancelled.state, 'completed');
  assert.equal(cancelled.code, 'already_finished');
});

test('mock: artifacts, evidence and usage keep the shared shape', async () => {
  const clock = createClock();
  const adapter = createMockAdapter({
    now: clock.now,
    script: [
      {
        at: 0,
        type: 'complete',
        usage: { tokens_in: 7, tokens_out: 3, tokens_cached: 0, cost_cny: 0.02 },
        artifacts: [{ path: 'article.md', content: '# hi' }],
      },
    ],
  });
  const dispatched = await adapter.dispatch(dispatchEnvelope());
  assert.equal(dispatched.ok, true);

  const artifacts = await adapter.collectArtifacts(RUN);
  assert.equal(artifacts.items.length, 1);
  assert.equal(artifacts.items[0].path, 'article.md');
  assert.equal(artifacts.items[0].sha256, sha256('# hi'));
  assert.equal(artifacts.items[0].bytes, 4);

  const evidence = await adapter.collectEvidence(RUN);
  assert.ok(evidence.items.length >= 2);
  assert.equal(evidence.items[0].kind, 'dispatch');
  assert.equal(typeof evidence.items[0].sha256, 'string');

  const usage = await adapter.usage(RUN);
  assert.equal(usage.tokens_in, 7);
  assert.equal(usage.cost_cny, 0.02);
  assert.equal(usage.source, 'mock');

  for (const [method, result] of Object.entries({
    dispatch: dispatched,
    status: await adapter.status(RUN),
    cancel: await adapter.cancel(RUN),
    follow: await adapter.follow(RUN, 0),
    collectArtifacts: artifacts,
    collectEvidence: evidence,
    usage,
  })) {
    const validation = validateResult(adapter, method, result);
    assert.deepEqual(validation.issues, [], `${method}: ${validation.issues}`);
  }
});

test('mock: unknown run and duplicate dispatch', async () => {
  const adapter = createMockAdapter({ now: () => 0 });
  const unknownStatus = await adapter.status({ run_id: 'nope' });
  assert.equal(unknownStatus.ok, false);
  assert.equal(unknownStatus.state, 'unknown');
  assert.equal(unknownStatus.progress.health, 'unknown');

  const unknownUsage = await adapter.usage('nope');
  assert.equal(unknownUsage.tokens_in, 0);
  assert.equal(unknownUsage.source, 'unavailable');

  await adapter.dispatch(dispatchEnvelope());
  const duplicate = await adapter.dispatch(dispatchEnvelope());
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'duplicate_dispatch');
});
