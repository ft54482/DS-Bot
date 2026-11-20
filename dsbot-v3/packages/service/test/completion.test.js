import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHarness,
  passedItemStates,
  startAcceptingTask,
  startRunningTask,
  validClaim,
} from './support/fixtures.js';

test('complete(task) is refused without a passed acceptance at the task own level', () => {
  const { service } = createHarness();
  const { task } = startRunningTask(service);

  assert.throws(
    () => service.completeTask({ taskId: task.id }),
    (error) => {
      assert.equal(error.code, 'missing_acceptance');
      assert.equal(error.status, 422);
      assert.equal(error.details.guard, 'G30');
      return true;
    },
  );
  assert.equal(service.getTask(task.id).state, 'running');
});

test('complete(task) is refused while the own acceptance is still open/pending', () => {
  const { service } = createHarness();
  const { task, acceptance } = startAcceptingTask(service);

  assert.throws(
    () => service.completeTask({ taskId: task.id }),
    (error) => {
      assert.equal(error.code, 'missing_acceptance');
      assert.equal(error.status, 422);
      return true;
    },
  );
  assert.equal(service.getAcceptance(acceptance.id).state, 'open');
  assert.equal(service.getTask(task.id).state, 'accepting');
});

test('a passing own-level decision completes the task and accepts the run', () => {
  const { service } = createHarness();
  const { task, run, acceptance } = startAcceptingTask(service);

  const decided = service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(acceptance),
  });

  assert.equal(decided.acceptance.state, 'passed');
  assert.equal(decided.task.state, 'completed');
  assert.equal(decided.verdict, 'pass');
  assert.equal(service.getRun(run.id).state, 'accepted');
  assert.equal(service.getTask(task.id).terminalAt !== null, true);

  const types = service.listEvents().map((event) => event.type);
  assert.ok(types.includes('acceptance.passed'));
  assert.ok(types.includes('run.accepted'));
  assert.ok(types.includes('task.completed'));

  // Repeating completion is a replay, not a second completion transition.
  const replay = service.completeTask({ taskId: task.id });
  assert.equal(replay.alreadyCompleted, true);
  assert.equal(service.getTask(task.id).state, 'completed');
});

test('a passing verdict cannot bypass incomplete required items', () => {
  const { service } = createHarness();
  const { task, acceptance } = startAcceptingTask(service);

  assert.throws(
    () => service.decideAcceptance({ acceptanceId: acceptance.id, verdict: 'pass' }),
    (error) => {
      assert.equal(error.code, 'acceptance_incomplete');
      assert.equal(error.status, 422);
      assert.deepEqual(error.details.missingItems, ['auto.checks']);
      return true;
    },
  );
  assert.equal(service.getTask(task.id).state, 'accepting');
  assert.equal(service.getAcceptance(acceptance.id).state, 'open');
});

test('a child completion never completes the parent; a readiness claim is required', () => {
  const { service } = createHarness();
  const goal = service.createTask({ level: 'goal', title: 'goal' });
  const business = service.createTask({
    level: 'business',
    parentTaskId: goal.id,
    title: 'business',
  });
  const execution = startAcceptingTask(service, {
    task: { parentTaskId: business.id, title: 'execution' },
  });
  service.decideAcceptance({
    acceptanceId: execution.acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(execution.acceptance),
  });
  assert.equal(service.getTask(execution.task.id).state, 'completed');

  const parent = service.getTask(business.id);
  assert.equal(parent.state, 'planned');

  // Parent must be moved into running by its owner before readiness can open.
  service.transitionTask({ taskId: business.id, to: 'queued' });
  service.transitionTask({ taskId: business.id, to: 'running' });

  // A forged shortcut still needs the parent's own passed acceptance.
  assert.throws(
    () => service.completeTask({ taskId: business.id }),
    (error) => {
      assert.equal(error.code, 'missing_acceptance');
      return true;
    },
  );

  const readiness = service.claimReadiness({ taskId: business.id });
  assert.equal(readiness.task.state, 'accepting');
  assert.equal(readiness.acceptance.state, 'open');
  assert.ok(
    service
      .listEvents()
      .some((event) => event.type === 'child.completed' && event.taskId === execution.task.id),
  );

  const businessPass = service.decideAcceptance({
    acceptanceId: readiness.acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(readiness.acceptance),
  });
  assert.equal(businessPass.task.state, 'completed');
  // Completing the business child still does not complete the goal.
  assert.equal(service.getTask(goal.id).state, 'planned');
});

test('readiness is refused while a required child is still running', () => {
  const { service } = createHarness();
  const business = service.createTask({ level: 'business', title: 'business' });
  service.transitionTask({ taskId: business.id, to: 'queued' });
  service.transitionTask({ taskId: business.id, to: 'running' });

  startRunningTask(service, {
    task: { parentTaskId: business.id, title: 'still running child' },
    dispatchKey: 'child-dispatch',
  });

  assert.throws(
    () => service.claimReadiness({ taskId: business.id }),
    (error) => {
      assert.equal(error.code, 'invalid_state_transition');
      assert.equal(error.details.guard, 'G35');
      return true;
    },
  );
  assert.equal(service.getTask(business.id).state, 'running');
  assert.equal(
    service.listAcceptances({ taskId: business.id }).length,
    0,
  );
});

test('goal completion requires a signed human.goal_signoff item', () => {
  const { service } = createHarness();
  const goal = service.createTask({ level: 'goal', title: 'goal with signoff' });
  const business = service.createTask({
    level: 'business',
    parentTaskId: goal.id,
    title: 'business',
  });
  const execution = startAcceptingTask(service, {
    task: { parentTaskId: business.id, title: 'execution' },
  });
  service.decideAcceptance({
    acceptanceId: execution.acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(execution.acceptance),
  });
  service.transitionTask({ taskId: business.id, to: 'queued' });
  service.transitionTask({ taskId: business.id, to: 'running' });
  const businessReadiness = service.claimReadiness({ taskId: business.id });
  service.decideAcceptance({
    acceptanceId: businessReadiness.acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(businessReadiness.acceptance),
  });
  assert.equal(service.getTask(business.id).state, 'completed');

  service.transitionTask({ taskId: goal.id, to: 'queued' });
  service.transitionTask({ taskId: goal.id, to: 'running' });
  const goalReadiness = service.claimReadiness({ taskId: goal.id });
  const goalItems = goalReadiness.acceptance.items;
  assert.deepEqual(
    goalItems.map((item) => item.key).sort(),
    ['auto.checks', 'human.goal_signoff'],
  );

  assert.throws(
    () =>
      service.decideAcceptance({
        acceptanceId: goalReadiness.acceptance.id,
        verdict: 'pass',
        itemStates: {
          'auto.checks': 'pass',
          'human.goal_signoff': 'pass',
        },
      }),
    (error) => {
      assert.equal(error.code, 'missing_acceptance');
      assert.equal(error.details.reason, 'human_signoff_missing');
      return true;
    },
  );

  const goalPass = service.decideAcceptance({
    acceptanceId: goalReadiness.acceptance.id,
    verdict: 'pass',
    itemStates: {
      'auto.checks': 'pass',
      'human.goal_signoff': { state: 'pass', signedBy: 'human:owner' },
    },
  });
  assert.equal(goalPass.task.state, 'completed');
  const signoff = service
    .getAcceptance(goalReadiness.acceptance.id)
    .items.find((item) => item.key === 'human.goal_signoff');
  assert.equal(signoff.signedBy, 'human:owner');
});

test('a human reopen starts a new cycle whose old pass no longer counts', () => {
  const { service } = createHarness();
  const { task, acceptance } = startAcceptingTask(service);
  service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'pass',
    itemStates: passedItemStates(acceptance),
  });
  assert.equal(service.getTask(task.id).state, 'completed');

  const reopened = service.transitionTask({
    taskId: task.id,
    to: 'queued',
    actor: 'human',
  });
  assert.equal(reopened.task.state, 'queued');
  assert.equal(reopened.task.cycleNo, 2);
  assert.equal(reopened.task.revision, 1);
  assert.equal(reopened.task.subjectFingerprint, null);
  assert.equal(service.getAcceptance(acceptance.id).supersededAt !== null, true);

  assert.throws(
    () => service.completeTask({ taskId: task.id }),
    (error) => {
      assert.equal(error.code, 'missing_acceptance');
      return true;
    },
  );
});

test('a task outside accepting cannot be completed even with a passed acceptance', () => {
  const { service } = createHarness();
  const { task, run } = startRunningTask(service);
  const { acceptance } = service.claimRun({ runId: run.id, claim: validClaim() });
  service.decideAcceptance({
    acceptanceId: acceptance.id,
    verdict: 'block',
    itemStates: { 'auto.checks': 'blocked' },
  });
  assert.equal(service.getTask(task.id).state, 'blocked');

  assert.throws(
    () => service.completeTask({ taskId: task.id }),
    (error) => {
      assert.equal(error.code, 'missing_acceptance');
      return true;
    },
  );
});
