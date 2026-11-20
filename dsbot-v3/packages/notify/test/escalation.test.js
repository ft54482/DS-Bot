import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ESCALATIONS, SUPPRESS_REASONS } from '../src/index.js';
import { createHarness, MINUTE } from './helpers.js';

test('the default escalation cap is two steps', () => {
  assert.equal(MAX_ESCALATIONS, 2);
});

test('two escalation levels are delivered and the third is stopped', () => {
  const { notifier, sent } = createHarness();
  const task = { id: 'task-esc', level: 'business' };

  const levelOne = notifier.escalate(task, 1);
  const levelTwo = notifier.escalate(task, 2);
  const levelThree = notifier.escalate(task, 3);

  assert.equal(levelOne.delivered, true);
  assert.equal(levelTwo.delivered, true);
  assert.equal(levelThree.delivered, false);
  assert.equal(levelThree.reason, SUPPRESS_REASONS.ESCALATION_LIMIT);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((entry) => entry.level),
    [1, 2],
  );
  assert.equal(levelThree.notification.level, 3);
});

test('the escalation cap wins after the five-minute dedupe window', () => {
  const { notifier, sent, advance } = createHarness();
  const task = { id: 'task-esc' };

  notifier.escalate(task, 1);
  notifier.escalate(task, 2);
  advance(30 * MINUTE);
  const later = notifier.escalate(task, 3);

  assert.equal(later.delivered, false);
  assert.equal(later.reason, SUPPRESS_REASONS.ESCALATION_LIMIT);
  assert.equal(sent.length, 2);
});

test('repeating the same escalation level within five minutes is a duplicate', () => {
  const { notifier, sent, advance } = createHarness();
  const task = { id: 'task-esc' };

  notifier.escalate(task, 1);
  const duplicate = notifier.escalate(task, 1);

  assert.equal(duplicate.delivered, false);
  assert.equal(duplicate.reason, SUPPRESS_REASONS.DUPLICATE);
  assert.equal(sent.length, 1);

  // The duplicate did not consume the second escalation slot.
  advance(5 * MINUTE);
  assert.equal(notifier.escalate(task, 2).delivered, true);
  assert.equal(sent.length, 2);
});

test('escalation levels can be derived when omitted', () => {
  const { notifier, sent } = createHarness();
  const task = { id: 'task-auto' };

  notifier.escalate(task);
  notifier.escalate(task);
  const third = notifier.escalate(task);

  assert.deepEqual(
    sent.map((entry) => entry.level),
    [1, 2],
  );
  assert.equal(third.delivered, false);
  assert.equal(third.reason, SUPPRESS_REASONS.ESCALATION_LIMIT);
});

test('the escalation cap is tracked per task', () => {
  const { notifier, sent } = createHarness();

  notifier.escalate({ id: 'task-a' }, 1);
  notifier.escalate({ id: 'task-a' }, 2);
  notifier.escalate({ id: 'task-b' }, 1);
  notifier.escalate({ id: 'task-b' }, 2);

  assert.equal(sent.length, 4);
});

test('maxEscalations can be configured', () => {
  const { notifier, sent } = createHarness({ maxEscalations: 3 });
  const task = { id: 'task-esc' };

  notifier.escalate(task, 1);
  notifier.escalate(task, 2);
  notifier.escalate(task, 3);
  const fourth = notifier.escalate(task, 4);

  assert.equal(sent.length, 3);
  assert.equal(fourth.delivered, false);
  assert.equal(fourth.reason, SUPPRESS_REASONS.ESCALATION_LIMIT);
});

test('named escalation levels are preserved in the template', () => {
  const { notifier, sent } = createHarness();

  notifier.escalate({ id: 'task-named' }, 'chief');

  assert.equal(sent[0].level, 'chief');
  assert.match(sent[0].title, /chief/);
});
