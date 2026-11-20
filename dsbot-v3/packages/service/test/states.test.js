import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCEPTANCE_STATES,
  RUN_STATES,
  TASK_STATES,
  isActiveRunState,
  isRunState,
  isRunTerminal,
  isTaskState,
  isTaskTerminal,
} from '../src/states.js';
import {
  ACCEPTANCE_TRANSITIONS,
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  checkAcceptanceTransition,
  checkRunTransition,
  checkTaskTransition,
  nextTaskStates,
} from '../src/transitions.js';

test('task state set matches the PRD §10 naming required by the ticket', () => {
  assert.deepEqual(
    [...TASK_STATES].sort(),
    [
      'accepting',
      'blocked',
      'cancelled',
      'completed',
      'paused',
      'planned',
      'queued',
      'reworking',
      'running',
      'stopping',
    ].sort(),
  );
});

test('run state set matches the ticket contract', () => {
  assert.deepEqual(
    [...RUN_STATES].sort(),
    [
      'accepted',
      'cancelled',
      'dispatch_unknown',
      'dispatched',
      'failed',
      'invalidated',
      'lost',
      'queued',
      'rejected',
      'reported',
      'running',
      'superseded',
      'timed_out',
    ].sort(),
  );
});

test('acceptance state set is the PRD decision vocabulary', () => {
  assert.deepEqual(
    [...ACCEPTANCE_STATES].sort(),
    ['blocked', 'failed', 'open', 'passed', 'revise', 'superseded', 'void'].sort(),
  );
});

test('terminal predicates distinguish attempt terminals from delivered states', () => {
  assert.equal(isTaskTerminal('completed'), true);
  assert.equal(isTaskTerminal('cancelled'), true);
  assert.equal(isTaskTerminal('reworking'), false);
  assert.equal(isTaskTerminal('stopping'), false);

  assert.equal(isRunTerminal('accepted'), true);
  assert.equal(isRunTerminal('rejected'), true);
  assert.equal(isRunTerminal('failed'), false);
  assert.equal(isRunTerminal('lost'), false);
  assert.equal(isRunTerminal('reported'), false);

  assert.equal(isActiveRunState('dispatched'), true);
  assert.equal(isActiveRunState('reported'), false);
  assert.equal(isTaskState('reworking'), true);
  assert.equal(isTaskState('draft'), false);
  assert.equal(isRunState('cancelling'), false);
});

test('task transition table has no terminal escape hatches', () => {
  assert.deepEqual([...nextTaskStates('stopping')].sort(), ['blocked', 'cancelled']);
  assert.deepEqual(nextTaskStates('cancelled'), []);
  assert.deepEqual([...nextTaskStates('completed')].sort(), ['blocked', 'queued']);

  // A completed task can never be reopened straight into running/finished work.
  assert.equal(checkTaskTransition('completed', 'running').allowed, false);
  assert.equal(checkTaskTransition('completed', 'completed').allowed, false);
  assert.equal(checkTaskTransition('accepted', 'completed').allowed, false);
});

test('run transition table forbids silent retries and terminal rewrites', () => {
  assert.equal(checkRunTransition('running', 'reported').allowed, true);
  assert.equal(checkRunTransition('reported', 'accepted').allowed, true);
  assert.equal(checkRunTransition('running', 'accepted').allowed, false);
  assert.equal(checkRunTransition('accepted', 'running').allowed, false);
  assert.equal(checkRunTransition('failed', 'superseded').allowed, true);
  assert.equal(checkRunTransition('failed', 'running').allowed, false);

  // every declared transition row is reachable and no unknown state leaks in.
  for (const from of Object.keys(RUN_TRANSITIONS)) {
    assert.equal(isRunState(from), true, `run transition row ${from} is not a run state`);
    for (const to of RUN_TRANSITIONS[from]) {
      assert.equal(isRunState(to), true, `run transition target ${to} is not a run state`);
    }
  }
});

test('acceptance decisions are one-shot and cannot be reopened', () => {
  assert.equal(checkAcceptanceTransition('open', 'passed').allowed, true);
  assert.equal(checkAcceptanceTransition('open', 'revise').allowed, true);
  assert.equal(checkAcceptanceTransition('passed', 'open').allowed, false);
  assert.equal(checkAcceptanceTransition('failed', 'passed').allowed, false);
  assert.deepEqual(Object.keys(ACCEPTANCE_TRANSITIONS).sort(), [
    'blocked',
    'failed',
    'open',
    'passed',
    'revise',
    'superseded',
    'void',
  ]);
});

test('task transition table targets are always declared task states', () => {
  for (const from of Object.keys(TASK_TRANSITIONS)) {
    assert.equal(isTaskState(from), true, `task transition row ${from} is not a task state`);
    for (const to of TASK_TRANSITIONS[from]) {
      assert.equal(isTaskState(to), true, `task transition target ${to} is not a task state`);
    }
  }
});
