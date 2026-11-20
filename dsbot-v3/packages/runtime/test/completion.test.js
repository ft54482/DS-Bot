import assert from 'node:assert/strict';
import test from 'node:test';

import { openAcceptingRun } from './support/harness.js';

test('completion: refused while no acceptance has passed', async (t) => {
  const { runtime, tree, run, claimed } = await openAcceptingRun(t);
  assert.equal(runtime.tasks.get(tree.execution.id).state, 'accepting');

  // The facade has no complete() on purpose: completion is a consequence of a
  // passing acceptance. Pin the service guard the runtime exposes.
  assert.throws(
    () => runtime.service.completeTask({ taskId: tree.execution.id }),
    (error) => {
      assert.equal(error.code, 'missing_acceptance');
      assert.equal(error.details.guard, 'G30');
      return true;
    },
    'an accepting task with no passed acceptance cannot complete',
  );

  assert.equal(runtime.tasks.get(tree.execution.id).state, 'accepting');
  assert.equal(runtime.runs.get(run.id).state, 'reported');
  assert.equal(runtime.acceptances.get(claimed.acceptance.id).state, 'open');
});

test('completion: a passing verdict with missing required items is rejected', async (t) => {
  const { runtime, tree, claimed } = await openAcceptingRun(t);

  assert.throws(
    () =>
      runtime.acceptances.decide({
        acceptanceId: claimed.acceptance.id,
        verdict: 'pass',
        itemStates: { 'auto.contract': 'pass' },
      }),
    (error) => error.code === 'acceptance_incomplete',
    'required independent.review must pass before a passing verdict',
  );

  assert.equal(runtime.tasks.get(tree.execution.id).state, 'accepting');
  assert.equal(runtime.acceptances.get(claimed.acceptance.id).state, 'open');
});

test('completion: a passing acceptance completes the task and accepts the run', async (t) => {
  const { runtime, tree, run, claimed } = await openAcceptingRun(t);

  const decided = runtime.acceptances.decide({
    acceptanceId: claimed.acceptance.id,
    verdict: 'pass',
    itemStates: {
      'auto.contract': 'pass',
      'independent.review': 'pass',
    },
  });

  assert.equal(decided.verdict, 'pass');
  assert.equal(decided.acceptance.state, 'passed');
  assert.equal(decided.task.state, 'completed');

  const task = runtime.tasks.get(tree.execution.id);
  assert.equal(task.state, 'completed');
  assert.notEqual(task.terminalAt, null);
  assert.equal(runtime.runs.get(run.id).state, 'accepted');
  assert.equal(runtime.service.listAcceptances({ taskId: tree.execution.id, state: 'passed' }).length, 1);

  // A child pass never completes its parents.
  assert.equal(runtime.tasks.get(tree.business.id).state, 'planned');
  assert.equal(runtime.tasks.get(tree.goal.id).state, 'planned');

  // A replayed decision is idempotent and changes nothing.
  const replay = runtime.acceptances.decide({
    acceptanceId: claimed.acceptance.id,
    verdict: 'pass',
    itemStates: {
      'auto.contract': 'pass',
      'independent.review': 'pass',
    },
  });
  assert.equal(replay.replayed, true);
  assert.equal(runtime.tasks.get(tree.execution.id).state, 'completed');
});

test('completion: a completed task refuses any further dispatch', async (t) => {
  const { runtime, tree, run, claimed } = await openAcceptingRun(t);
  runtime.acceptances.decide({
    acceptanceId: claimed.acceptance.id,
    verdict: 'pass',
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'pass' },
  });

  assert.throws(
    () =>
      runtime.tasks.dispatch({
        taskId: tree.execution.id,
        executorKind: 'mock',
        idempotencyKey: 'dispatch-after-complete',
      }),
    (error) => error.code === 'invalid_state_transition' && error.status === 409,
    'a completed task can never look freshly dispatched',
  );
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 1);
  assert.equal(runtime.runs.get(run.id).state, 'accepted');
});
