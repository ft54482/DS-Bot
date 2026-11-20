import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryTransport,
  Outbox,
  ToolError,
  formatIdempotencyKey,
} from '../src/index.js';
import { makeClock } from './helpers.js';

function setup(options = {}) {
  const clock = makeClock();
  const transport = new InMemoryTransport({ clock: clock.now });
  const outbox = new Outbox({
    transport,
    clock: clock.now,
    leaseMs: 1_000,
    reconcileGraceMs: 0,
    ...options,
  });
  return { clock, transport, outbox };
}

function enqueue(outbox, overrides = {}) {
  return outbox.enqueue({
    taskId: 'task-1',
    runId: 'run-1',
    principalRef: 'scheduler',
    intent: 'dispatch_run',
    payload: { runId: 'run-1', marker: 'm-1' },
    ...overrides,
  });
}

test('outbox: intent -> sending -> sent -> acked records every transition', async () => {
  const { outbox, transport } = setup();
  const key = formatIdempotencyKey({
    taskId: 'task-1',
    runNo: 1,
    attempt: 1,
    intent: 'dispatch_run',
  });
  const { record } = enqueue(outbox, { idempotencyKey: key });

  assert.equal(record.state, 'intent');
  assert.equal(record.attempts, 0);
  assert.deepEqual(record.history.map((entry) => entry.state), ['intent']);

  const sent = await outbox.dispatchIntent(record.id);
  assert.equal(sent.record.state, 'sent');
  assert.equal(sent.record.attempts, 1);
  assert.equal(sent.record.receipt.accepted, true);
  assert.deepEqual(sent.record.history.map((entry) => entry.state), ['intent', 'sending', 'sent']);

  const acked = outbox.ack(record.id);
  assert.equal(acked.state, 'acked');
  assert.notEqual(acked.ackedAt, null);
  assert.deepEqual(acked.history.map((entry) => entry.state), [
    'intent',
    'sending',
    'sent',
    'acked',
  ]);

  assert.equal(transport.executionsFor(key), 1);
});

test('outbox: the same idempotencyKey only produces one external execution', async () => {
  const { outbox, transport } = setup();
  const key = 'task-1:1:1:dispatch_run';

  const first = enqueue(outbox, { idempotencyKey: key });
  const second = enqueue(outbox, { idempotencyKey: key });

  assert.equal(second.inserted, false);
  assert.equal(second.replayed, true);
  assert.equal(second.duplicated, true);
  assert.equal(outbox.list().length, 1);

  const sent = await outbox.dispatchIntent(first.record.id, { autoAck: true });
  assert.equal(sent.record.state, 'acked');
  const afterAck = await outbox.dispatchIntent(first.record.id, { autoAck: true });
  assert.equal(afterAck.action, 'skipped');

  assert.equal(transport.callsFor(key), 1);
  assert.equal(transport.executionsFor(key), 1);
  assert.equal(transport.duplicates, 0);
});

test('outbox: same key with a different payload is rejected as duplicate_dispatch', () => {
  const { outbox } = setup();
  const key = 'task-1:1:1:dispatch_run';
  enqueue(outbox, { idempotencyKey: key, payload: { marker: 'first' } });

  assert.throws(
    () => enqueue(outbox, { idempotencyKey: key, payload: { marker: 'second' } }),
    (error) => error.code === 'duplicate_dispatch' && error.status === 409,
  );
});

test('outbox: a permanent tool error ends failed and is never retried', async () => {
  const { outbox, transport } = setup();
  const key = 'task-1:1:1:dispatch_run';
  const { record } = enqueue(outbox, { idempotencyKey: key });
  transport.failBeforeDeliveryOnce(key, new ToolError('BAD_REQUEST', 'bad payload'));

  const outcome = await outbox.dispatchIntent(record.id);
  assert.equal(outcome.record.state, 'failed');
  assert.equal(outcome.record.resolution, 'failed');
  assert.equal(outcome.action, 'failed');

  const rescanned = await outbox.scan();
  assert.deepEqual(rescanned, []);
  assert.equal(transport.callsFor(key), 1);
});

test('outbox: a rate-limited send returns to intent, then a later scan delivers it', async () => {
  const { outbox, transport, clock } = setup();
  const key = 'task-1:1:1:dispatch_run';
  const { record } = enqueue(outbox, { idempotencyKey: key });
  transport.failBeforeDeliveryOnce(key, new ToolError('RATE_LIMITED', 'slow down'));

  const first = await outbox.dispatchIntent(record.id);
  assert.equal(first.record.state, 'intent');
  assert.equal(first.record.nextRetryAt, clock.now() + 30_000);

  const tooEarly = await outbox.scan();
  assert.deepEqual(tooEarly, []);
  assert.equal(transport.callsFor(key), 1);

  clock.advance(30_001);
  const results = await outbox.scan();
  assert.equal(results.length, 1);
  assert.equal(results[0].after, 'acked');
  assert.equal(transport.callsFor(key), 2);
  assert.equal(transport.executionsFor(key), 1);
});

test('outbox: ack is idempotent and cannot run before the send completes', async () => {
  const { outbox, clock } = setup();
  const { record } = enqueue(outbox);

  assert.throws(
    () => outbox.ack(record.id),
    (error) => error.code === 'invalid_transition',
  );

  await outbox.dispatchIntent(record.id);
  const first = outbox.ack(record.id);
  clock.advance(5);
  const second = outbox.ack(record.id);

  assert.equal(second.state, 'acked');
  assert.equal(second.ackedAt, first.ackedAt);
  assert.equal(second.history.filter((entry) => entry.state === 'acked').length, 1);
});

test('outbox: scan delivers pending intents once and skips them after ack', async () => {
  const { outbox, transport } = setup();
  for (let index = 1; index <= 3; index += 1) {
    enqueue(outbox, {
      taskId: `task-${index}`,
      idempotencyKey: `task-${index}:1:1:dispatch_run`,
      payload: { index },
    });
  }

  const first = await outbox.scan();
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((entry) => entry.after), ['acked', 'acked', 'acked']);
  assert.equal(transport.calls.length, 3);

  const second = await outbox.scan();
  assert.deepEqual(second, []);
  assert.equal(transport.calls.length, 3);
  assert.equal(outbox.stats().byState.acked, 3);
});

test('outbox: a crashed sending intent is reconverged and resent after the lease expires', async () => {
  const { outbox, transport, clock } = setup();
  const key = 'task-1:1:1:dispatch_run';
  const { record } = enqueue(outbox, { idempotencyKey: key });

  // Simulate a crash between T3 (send marker) and T4 (the transport call).
  const sending = outbox.beginSend(record.id);
  assert.equal(sending.state, 'sending');
  assert.equal(sending.attempts, 1);
  assert.equal(transport.calls.length, 0);

  // The lease is still live: another scanner must not touch the record.
  const whileLeased = await outbox.scan();
  assert.deepEqual(whileLeased, []);
  assert.equal(transport.calls.length, 0);

  clock.advance(1_001);
  const recovered = await outbox.scan();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].before, 'sending');
  assert.equal(recovered[0].after, 'acked');

  const after = outbox.get(record.id);
  assert.equal(after.state, 'acked');
  assert.equal(after.attempts, 2);
  assert.equal(after.resends, 1);
  assert.equal(transport.callsFor(key), 1);
  assert.equal(transport.executionsFor(key), 1);
  assert.deepEqual(after.history.map((entry) => entry.state), [
    'intent',
    'sending',
    'unknown',
    'intent',
    'sending',
    'sent',
    'acked',
  ]);
});

test('outbox: a lost response is adopted from the transport ledger without a second execution', async () => {
  const { outbox, transport } = setup();
  const key = 'task-1:1:1:dispatch_run';
  const { record } = enqueue(outbox, { idempotencyKey: key });
  transport.failAfterDeliveryOnce(key);

  const ambiguous = await outbox.dispatchIntent(record.id);
  assert.equal(ambiguous.record.state, 'unknown');
  assert.equal(transport.callsFor(key), 1);
  assert.equal(transport.executionsFor(key), 1);

  const recovered = await outbox.scan();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].after, 'acked');
  assert.equal(recovered[0].externalCall, false);

  const after = outbox.get(record.id);
  assert.equal(after.resolution, 'confirmed_sent');
  assert.equal(after.attempts, 1);
  assert.equal(transport.callsFor(key), 1);
  assert.equal(transport.executionsFor(key), 1);
});

test('outbox: polling during the reconcile grace window does not exhaust reconciliation', async () => {
  const clock = makeClock();
  const transport = new InMemoryTransport({ clock: clock.now });
  const outbox = new Outbox({
    transport,
    clock: clock.now,
    leaseMs: 1_000,
    reconcileGraceMs: 100,
  });
  const key = 'task-1:1:1:dispatch_run';
  const { record } = enqueue(outbox, { idempotencyKey: key });
  transport.failBeforeDeliveryOnce(key);

  const failed = await outbox.dispatchIntent(record.id);
  assert.equal(failed.record.state, 'unknown');

  clock.advance(40);
  const firstPoll = await outbox.scan();
  assert.equal(firstPoll[0].action, 'awaiting_grace');
  clock.advance(40);
  const secondPoll = await outbox.scan();
  assert.equal(secondPoll[0].action, 'awaiting_grace');
  assert.equal(outbox.get(record.id).reconcileAttempts, 0);

  clock.advance(21);
  const recovered = await outbox.scan();
  assert.equal(recovered[0].after, 'acked');
  assert.equal(outbox.get(record.id).resends, 1);
  assert.equal(transport.callsFor(key), 2);
  assert.equal(transport.executionsFor(key), 1);
});

test('outbox: concurrent dispatch attempts still produce one external execution', async () => {
  const clock = makeClock();
  const transport = new InMemoryTransport({
    clock: clock.now,
    handler: async () => {
      await Promise.resolve();
      return { accepted: true };
    },
  });
  const outbox = new Outbox({ transport, clock: clock.now });
  const key = 'task-1:1:1:dispatch_run';
  const { record } = enqueue(outbox, { idempotencyKey: key });

  const [first, second] = await Promise.all([
    outbox.dispatchIntent(record.id),
    outbox.dispatchIntent(record.id),
  ]);

  assert.deepEqual([first.action, second.action].sort(), ['sent', 'skipped']);
  assert.equal(outbox.get(record.id).state, 'sent');
  assert.equal(transport.callsFor(key), 1);
  assert.equal(transport.executionsFor(key), 1);
});

test('transport: concurrent sends of one idempotency key execute the handler once', async () => {
  let runs = 0;
  const transport = new InMemoryTransport({
    handler: async () => {
      runs += 1;
      await Promise.resolve();
      return { accepted: true, requestId: 'req-1' };
    },
  });

  const [first, second] = await Promise.all([
    transport.send({ idempotencyKey: 'key-1', intent: 'dispatch_run' }),
    transport.send({ idempotencyKey: 'key-1', intent: 'dispatch_run' }),
  ]);

  assert.deepEqual(first, second);
  assert.equal(runs, 1);
  assert.equal(transport.executionsFor('key-1'), 1);
  assert.equal(transport.callsFor('key-1'), 2);
  assert.equal(transport.duplicates, 1);
});

test('outbox: a stale writer epoch cannot scan or claim the record', async () => {
  const { outbox, transport, clock } = setup({ epoch: 2 });
  const key = 'task-1:1:1:dispatch_run';
  const { record } = enqueue(outbox, { idempotencyKey: key });

  assert.equal(outbox.claimLease(record.id, { owner: 'writer-2', epoch: 2 }), true);
  clock.advance(1_001);

  assert.equal(outbox.claimLease(record.id, { owner: 'writer-1', epoch: 1 }), false);
  const staleScan = await outbox.scan({ epoch: 1 });
  assert.deepEqual(staleScan, []);
  assert.equal(transport.calls.length, 0);

  const currentScan = await outbox.scan({ epoch: 2 });
  assert.equal(currentScan.length, 1);
  assert.equal(currentScan[0].after, 'acked');
  assert.equal(transport.executionsFor(key), 1);
});
