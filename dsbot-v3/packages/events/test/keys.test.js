import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalJson,
  eventKeyOf,
  formatIdempotencyKey,
  normalizePayload,
  parseIdempotencyKey,
} from '../src/index.js';

test('keys: idempotency key follows {task_id}:{run_no}:{attempt}:{intent}', () => {
  const key = formatIdempotencyKey({
    taskId: 'task-1',
    runNo: 2,
    attempt: 3,
    intent: 'dispatch_run',
  });

  assert.equal(key, 'task-1:2:3:dispatch_run');
  assert.deepEqual(parseIdempotencyKey(key), {
    taskId: 'task-1',
    runNo: 2,
    attempt: 3,
    intent: 'dispatch_run',
  });
});

test('keys: idempotency key rejects zero attempt numbers and colon task ids', () => {
  assert.throws(
    () => formatIdempotencyKey({ taskId: 'task-1', runNo: 1, attempt: 0, intent: 'dispatch_run' }),
    (error) => error.code === 'validation_error',
  );
  assert.throws(
    () => formatIdempotencyKey({ taskId: 'task:1', runNo: 1, attempt: 1, intent: 'dispatch_run' }),
    (error) => error.code === 'validation_error',
  );
});

test('keys: event key is source|session|seq|type', () => {
  assert.equal(
    eventKeyOf({ source: 'dsh', session: 'session-1', seq: 5, type: 'turn.end' }),
    'dsh|session-1|5|turn.end',
  );
  assert.throws(
    () => eventKeyOf({ source: 'dsh', session: 'a|b', seq: 5, type: 'turn.end' }),
    (error) => error.code === 'validation_error',
  );
});

test('payload: canonical JSON sorts keys and fingerprints ignore insertion order', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
  );

  const first = normalizePayload({ runId: 'run-1', task: { b: 2, a: 1 } });
  const second = normalizePayload({ task: { a: 1, b: 2 }, runId: 'run-1' });
  assert.equal(first.payloadJson, second.payloadJson);
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.match(first.payloadSha256, /^[0-9a-f]{64}$/);
});
