import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, defaultSend } from '../src/index.js';
import { createHarness, NOW, RUN, TASK } from './helpers.js';

test('createNotifier() has a console-only default sender', () => {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args);

  try {
    const notifier = createNotifier();
    const result = notifier.stuck(TASK);
    assert.equal(result.delivered, true);
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 1);
  const parsed = JSON.parse(lines[0][0]);
  assert.equal(parsed.event, 'stuck');
  assert.equal(parsed.task.id, 'task-1');
});

test('defaultSend writes exactly one JSON line to console', () => {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);

  try {
    defaultSend({ event: 'failed', reason: 'boom' });
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { event: 'failed', reason: 'boom' });
});

test('the injected sender receives every delivered notification', () => {
  const seen = [];
  const notifier = createNotifier({
    send: (notification) => seen.push(notification),
    now: () => NOW,
  });

  notifier.stuck(TASK);
  notifier.failed(RUN, 'boom');
  notifier.overBudget(TASK);
  notifier.escalate(TASK, 1);

  assert.equal(seen.length, 4);
  assert.deepEqual(
    seen.map((entry) => entry.event),
    ['stuck', 'failed', 'over_budget', 'escalation'],
  );
});

test('send must be a function', () => {
  assert.throws(() => createNotifier({ send: null }), /send/);
  assert.throws(() => createNotifier({ send: 'console' }), /send/);
});

test('dedupeWindowMs must be finite and non-negative', () => {
  assert.throws(() => createNotifier({ dedupeWindowMs: -1 }), /dedupeWindowMs/);
  assert.throws(() => createNotifier({ dedupeWindowMs: Number.NaN }), /dedupeWindowMs/);
  assert.throws(() => createNotifier({ dedupeWindowMs: '5m' }), /dedupeWindowMs/);
});

test('maxEscalations must be a positive integer', () => {
  assert.throws(() => createNotifier({ maxEscalations: 0 }), /maxEscalations/);
  assert.throws(() => createNotifier({ maxEscalations: 1.5 }), /maxEscalations/);
});

test('a task without an id is rejected instead of producing a bad template', () => {
  const { notifier } = createHarness();

  assert.throws(() => notifier.stuck({ level: 'business' }), /task\.id/);
  assert.throws(() => notifier.overBudget({}), /task\.id/);
  assert.throws(() => notifier.escalate({}, 1), /task\.id/);
});

test('a run without an id is rejected', () => {
  const { notifier } = createHarness();

  assert.throws(() => notifier.failed({ task_id: 'task-1' }, 'boom'), /run\.id/);
});

test('an invalid escalation level is rejected', () => {
  const { notifier } = createHarness();

  assert.throws(() => notifier.escalate(TASK, {}), /level/);
  assert.throws(() => notifier.escalate(TASK, ''), /level/);
});

test('an invalid clock is rejected', () => {
  const sent = [];
  const invalidClock = createNotifier({
    send: (notification) => sent.push(notification),
    now: () => 'not a time',
  });

  assert.throws(() => invalidClock.stuck(TASK), /now/);
  assert.throws(() => createNotifier({ now: {} }), /now/);
  assert.equal(sent.length, 0);
});

test('a fixed numeric clock and the `clock` alias are accepted', () => {
  const sent = [];
  const notifier = createNotifier({
    send: (notification) => sent.push(notification),
    clock: () => NOW,
  });

  notifier.stuck(TASK);

  assert.equal(sent[0].created_at, new Date(NOW).toISOString());
});

test('a sender failure is propagated and does not poison dedupe state', () => {
  let attempts = 0;
  const notifier = createNotifier({
    send: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('channel down');
    },
    now: () => NOW,
  });

  assert.throws(() => notifier.stuck(TASK), /channel down/);
  const retry = notifier.stuck(TASK);

  assert.equal(retry.delivered, true);
  assert.equal(attempts, 2);
});

test('the default clock produces a valid ISO timestamp', () => {
  const sent = [];
  const notifier = createNotifier({ send: (notification) => sent.push(notification) });

  notifier.stuck(TASK);

  assert.equal(typeof sent[0].created_at, 'string');
  assert.ok(Number.isFinite(Date.parse(sent[0].created_at)));
});
