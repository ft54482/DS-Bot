import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridge } from '../src/index.js';

const FIXED_NOW = 1_700_000_000_000;

function makeBridge() {
  return createBridge({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      throw new Error('onResult must not use fetch');
    },
    now: () => FIXED_NOW,
  });
}

test('results: the first receipt is applied and subscribers run once', () => {
  const bridge = makeBridge();
  const seen = [];
  const unsubscribe = bridge.onResult((receipt) => seen.push(receipt));
  const event = { event_id: 'evt-1', task_id: 'task-1', state: 'completed', output: { ok: true } };

  const first = bridge.onResult(event);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.applied, true);
  assert.equal(first.notified, 1);
  assert.deepEqual(first.handler_errors, []);
  assert.equal(first.receipt.task_id, 'task-1');
  assert.equal(first.receipt.received_at, FIXED_NOW);
  assert.equal(seen.length, 1);

  const second = bridge.onResult({ ...event, output: { ok: true } });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
  assert.equal(second.notified, 0);
  assert.equal(seen.length, 1);

  unsubscribe();
  const third = bridge.onResult({ event_id: 'evt-2', task_id: 'task-1', state: 'completed' });
  assert.equal(third.applied, true);
  assert.equal(third.notified, 0);
  assert.equal(seen.length, 1);
});

test('results: reusing a receipt id with different content is duplicate_dispatch', () => {
  const bridge = makeBridge();
  const first = bridge.onResult({
    receipt_id: 'receipt-1',
    task_id: 'task-2',
    state: 'completed',
    output: { files: ['a.md'] },
  });
  const second = bridge.onResult({
    receipt_id: 'receipt-1',
    task_id: 'task-2',
    state: 'failed',
    error: { code: 'boom' },
  });

  assert.equal(first.ok, true);
  assert.equal(first.applied, true);
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
  assert.equal(second.code, 'duplicate_dispatch');
  assert.equal(second.prd, 'duplicate_dispatch');
  assert.equal(second.http_status, 409);
  assert.equal(second.status_class, '4xx');
  assert.equal(second.retryable, false);
  assert.equal(second.side_effects_possible, false);
});

test('results: seq identifies receipts when no event id is present', () => {
  const bridge = makeBridge();
  for (const seq of [1, 2, 3]) {
    const outcome = bridge.onResult({ task_id: 'task-3', seq, state: seq === 3 ? 'completed' : 'running' });
    assert.equal(outcome.ok, true, `seq ${seq}`);
    assert.equal(outcome.applied, true, `seq ${seq}`);
  }

  const duplicate = bridge.onResult({ task_id: 'task-3', seq: 3, state: 'completed' });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.applied, false);

  const conflict = bridge.onResult({ task_id: 'task-3', seq: 3, state: 'failed' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.prd, 'duplicate_dispatch');
});

test('results: a plain id can identify the receipt when it differs from the task id', () => {
  const bridge = makeBridge();
  const first = bridge.onResult({ id: 'evt-7', task_id: 'task-7', state: 'completed' });
  const second = bridge.onResult({ id: 'evt-7', task_id: 'task-7', state: 'completed' });

  assert.equal(first.applied, true);
  assert.equal(first.receipt.event_id, 'evt-7');
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
});

test('results: a throwing subscriber does not break receipt ingestion', () => {
  const bridge = makeBridge();
  bridge.onResult(() => {
    throw new Error('handler boom');
  });

  const outcome = bridge.onResult({ event_id: 'evt-boom', task_id: 'task-4', state: 'completed' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.notified, 0);
  assert.deepEqual(outcome.handler_errors, ['handler boom']);
});

test('results: receipts without task, state or identity are rejected', () => {
  const bridge = makeBridge();
  for (const event of [
    { state: 'completed' },
    { task_id: 'task-5' },
    { task_id: 'task-5', state: 'completed' },
  ]) {
    const outcome = bridge.onResult(event);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'invalid_receipt');
    assert.equal(outcome.prd, null);
    assert.equal(outcome.applied, false);
    assert.equal(outcome.side_effects_possible, false);
  }
});
