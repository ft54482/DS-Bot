import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFY_EVENTS } from '../src/index.js';
import { createHarness, NOW, requiredKeys, RUN, TASK } from './helpers.js';

test('stuck() sends a complete task template', () => {
  const { notifier, sent } = createHarness();

  const result = notifier.stuck(TASK);

  assert.equal(result.delivered, true);
  assert.equal(result.reason, null);
  assert.equal(sent.length, 1);
  const notification = sent[0];
  assert.equal(notification.event, NOTIFY_EVENTS.STUCK);
  assert.equal(notification.kind, 'stuck');
  assert.equal(notification.created_at, new Date(NOW).toISOString());
  assert.deepEqual(notification.task, {
    id: 'task-1',
    level: 'business',
    state: 'running',
    owner: 'bot:content',
  });
  assert.equal(notification.run, null);
  assert.equal(notification.reason, 'stuck');
  assert.equal(notification.level, null);
  assert.match(notification.title, /task-1/);
  assert.match(notification.message, /stuck/);
  assert.equal(notification.dedupe_key, 'stuck:task-1');
  assert.equal(requiredKeys(notification), true);
});

test('stuck() preserves an explicit reason from the task or blocked reason', () => {
  const { notifier, sent } = createHarness();

  notifier.stuck({ id: 'task-a', reason: 'accepting_timeout' });
  notifier.stuck({ id: 'task-b', blocked_reason: 'no_progress' });

  assert.equal(sent[0].reason, 'accepting_timeout');
  assert.equal(sent[1].reason, 'no_progress');
});

test('failed() sends the run, reason and its task context', () => {
  const { notifier, sent } = createHarness();

  notifier.failed(RUN, 'bridge returned exit code 1');

  assert.equal(sent.length, 1);
  const notification = sent[0];
  assert.equal(notification.event, NOTIFY_EVENTS.FAILED);
  assert.deepEqual(notification.run, {
    id: 'run-1',
    task_id: 'task-1',
    state: 'failed',
    attempt: 1,
    run_no: 2,
  });
  assert.deepEqual(notification.task, {
    id: 'task-1',
    level: null,
    state: null,
    owner: null,
  });
  assert.equal(notification.reason, 'bridge returned exit code 1');
  assert.equal(notification.level, null);
  assert.match(notification.message, /run-1/);
  assert.equal(requiredKeys(notification), true);
});

test('failed() accepts an Error reason and a nested task object', () => {
  const { notifier, sent } = createHarness();

  notifier.failed(
    {
      run_id: 'run-9',
      state: 'failed',
      task: { task_id: 'task-9', level: 'execution', status: 'failed' },
    },
    new Error('session not found'),
  );

  assert.equal(sent[0].run.id, 'run-9');
  assert.equal(sent[0].task.id, 'task-9');
  assert.equal(sent[0].task.level, 'execution');
  assert.equal(sent[0].task.state, 'failed');
  assert.equal(sent[0].reason, 'session not found');
});

test('failed() falls back to the run failure reason', () => {
  const { notifier, sent } = createHarness();

  notifier.failed({ id: 'run-2', failure_reason: 'timeout' });

  assert.equal(sent[0].reason, 'timeout');
});

test('overBudget() sends a complete task template with a budget reason', () => {
  const { notifier, sent } = createHarness();

  notifier.overBudget({
    id: 'task-budget',
    level: 'execution',
    state: 'blocked',
    blocked_reason: 'budget',
  });

  const notification = sent[0];
  assert.equal(notification.event, NOTIFY_EVENTS.OVER_BUDGET);
  assert.equal(notification.task.id, 'task-budget');
  assert.equal(notification.run, null);
  assert.equal(notification.reason, 'budget');
  assert.equal(notification.level, null);
  assert.match(notification.title, /over budget/);
  assert.equal(requiredKeys(notification), true);
});

test('overBudget() uses a stable default reason', () => {
  const { notifier, sent } = createHarness();

  notifier.overBudget({ task_id: 'task-budget-2' });

  assert.equal(sent[0].reason, 'budget_exceeded');
  assert.equal(sent[0].task.id, 'task-budget-2');
});

test('escalate() sends the requested level and task', () => {
  const { notifier, sent } = createHarness();

  notifier.escalate({ id: 'task-esc', level: 'business', reason: 'conflict' }, 1);

  const notification = sent[0];
  assert.equal(notification.event, NOTIFY_EVENTS.ESCALATION);
  assert.equal(notification.task.id, 'task-esc');
  assert.equal(notification.run, null);
  assert.equal(notification.reason, 'conflict');
  assert.equal(notification.level, 1);
  assert.match(notification.title, /level 1/);
  assert.equal(requiredKeys(notification), true);
});

test('delivered notifications have unique ids and monotonic timestamps', () => {
  const { notifier, sent, advance } = createHarness();

  notifier.stuck({ id: 'task-1' });
  advance(1000);
  notifier.failed(RUN, 'boom');
  advance(1000);
  notifier.overBudget({ id: 'task-2' });

  assert.equal(new Set(sent.map((entry) => entry.id)).size, 3);
  assert.ok(Date.parse(sent[1].created_at) > Date.parse(sent[0].created_at));
});

test('notification construction does not mutate the caller input', () => {
  const task = { id: 'task-immutable', level: 'business', state: 'running' };
  const snapshot = { ...task };
  const run = { id: 'run-immutable', task_id: 'task-immutable' };
  const runSnapshot = { ...run };
  const { notifier } = createHarness();

  notifier.stuck(task);
  notifier.failed(run, 'boom');
  notifier.overBudget(task);
  notifier.escalate(task, 1);

  assert.deepEqual(task, snapshot);
  assert.deepEqual(run, runSnapshot);
});
