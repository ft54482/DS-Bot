import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEDUPE_WINDOW_MS,
  NOTIFY_EVENTS,
  SUPPRESS_REASONS,
} from '../src/index.js';
import { createHarness, MINUTE, RUN } from './helpers.js';

test('the default dedupe window is five minutes', () => {
  assert.equal(DEDUPE_WINDOW_MS, 5 * MINUTE);
});

test('the same stuck event is suppressed within five minutes', () => {
  const { notifier, sent } = createHarness();

  const first = notifier.stuck({ id: 'task-1' });
  const second = notifier.stuck({ id: 'task-1' });

  assert.equal(first.delivered, true);
  assert.equal(second.delivered, false);
  assert.equal(second.reason, SUPPRESS_REASONS.DUPLICATE);
  assert.equal(sent.length, 1);
});

test('the event is delivered again at exactly five minutes', () => {
  const { notifier, sent, advance } = createHarness();

  notifier.stuck({ id: 'task-1' });
  advance(DEDUPE_WINDOW_MS - 1);
  assert.equal(notifier.stuck({ id: 'task-1' }).delivered, false);
  advance(1);
  const boundary = notifier.stuck({ id: 'task-1' });

  assert.equal(boundary.delivered, true);
  assert.equal(sent.length, 2);
});

test('dedupe is keyed per task, not global', () => {
  const { notifier, sent } = createHarness();

  notifier.stuck({ id: 'task-1' });
  notifier.stuck({ id: 'task-2' });

  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((entry) => entry.task.id),
    ['task-1', 'task-2'],
  );
});

test('a failed run is deduped by run id', () => {
  const { notifier, sent } = createHarness();

  notifier.failed(RUN, 'boom');
  notifier.failed({ ...RUN, reason: 'a later different wording' }, 'boom');

  assert.equal(sent.length, 1);
});

test('a new failure reason for a different run is not deduped', () => {
  const { notifier, sent } = createHarness();

  notifier.failed({ id: 'run-1', task_id: 'task-1' }, 'boom');
  notifier.failed({ id: 'run-2', task_id: 'task-1' }, 'boom');

  assert.equal(sent.length, 2);
});

test('overBudget is deduped independently from stuck', () => {
  const { notifier, sent } = createHarness();

  notifier.stuck({ id: 'task-1' });
  notifier.overBudget({ id: 'task-1' });
  notifier.overBudget({ id: 'task-1' });
  notifier.stuck({ id: 'task-1' });

  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((entry) => entry.event),
    [NOTIFY_EVENTS.STUCK, NOTIFY_EVENTS.OVER_BUDGET],
  );
});

test('separate notifier instances keep separate dedupe state', () => {
  const first = createHarness();
  const second = createHarness();

  first.notifier.stuck({ id: 'task-1' });
  second.notifier.stuck({ id: 'task-1' });

  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 1);
});

test('dedupeWindowMs can be configured', () => {
  const { notifier, sent, advance } = createHarness({ dedupeWindowMs: 1000 });

  notifier.stuck({ id: 'task-1' });
  advance(999);
  assert.equal(notifier.stuck({ id: 'task-1' }).delivered, false);
  advance(1);
  assert.equal(notifier.stuck({ id: 'task-1' }).delivered, true);
  assert.equal(sent.length, 2);
});

test('suppressed notifications still expose the would-be template', () => {
  const { notifier } = createHarness();

  notifier.stuck({ id: 'task-1', reason: 'no_progress' });
  const suppressed = notifier.stuck({ id: 'task-1', reason: 'no_progress' });

  assert.equal(suppressed.delivered, false);
  assert.equal(suppressed.notification.task.id, 'task-1');
  assert.equal(suppressed.notification.reason, 'no_progress');
});
