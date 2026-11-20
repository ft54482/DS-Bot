import assert from 'node:assert/strict';
import test from 'node:test';

import * as acceptance from '../../acceptance/src/index.js';
import * as metrics from '../../metrics/src/index.js';
import { createRuntime } from '../../runtime/src/index.js';
import { CHIEF_CODES, createChief } from '../src/index.js';

/**
 * One composition test with the real packages proves the fakes are standing in
 * for the actual contracts: runtime facade, agent delegation surface, the
 * acceptance evaluator and the metrics projection.
 */
test('integration: real runtime and agents create/delegate/status/deliver without execution dispatch', async (t) => {
  const runtime = createRuntime({ dbPath: ':memory:' });
  t.after(() => runtime.close());

  const chief = createChief({
    runtime,
    agents: {
      content: {
        scope: {
          projects: ['self-media'],
          executors: ['mock'],
          spend_cny_cap: 50,
          max_delegate_level: 'business',
        },
      },
    },
    acceptance,
    metrics,
    scope: {
      projects: ['self-media'],
      spend_cny_cap: 100,
      max_delegate_level: 'goal',
    },
  });

  const goal = chief.openGoal({
    title: 'goal: integration',
    scope: { projects: ['self-media'], max_delegate_level: 'goal' },
    budgetCny: 80,
    mustConfirm: false,
  });
  assert.equal(goal.ok, true);
  assert.equal(runtime.tasks.get(goal.goalId).level, 'goal');

  const delegated = chief.delegate({
    goalId: goal.goalId,
    bot: 'content',
    brief: {
      title: 'business: integration workstream',
      budgetCny: 30,
      scope: { projects: ['self-media'], max_delegate_level: 'business' },
    },
  });
  assert.equal(delegated.ok, true);
  assert.equal(delegated.task.level, 'business');
  assert.equal(delegated.task.owner, 'bot:content');

  const stored = runtime.tasks.get(delegated.task.id);
  assert.equal(stored.parentTaskId, goal.goalId);
  assert.equal(stored.budget.capCny, 30);
  assert.deepEqual(stored.authScope.projects, ['self-media']);
  assert.equal(runtime.tasks.list({ parentTaskId: goal.goalId }).length, 1);
  assert.equal(runtime.runs.list({ taskId: stored.id }).length, 0);

  const status = chief.status({ goalId: goal.goalId });
  assert.equal(status.ok, true);
  assert.equal(status.businesses.length, 1);
  assert.equal(status.businesses[0].acceptance.result, 'missing');
  assert.equal(status.acceptance.missing, 1);
  assert.equal(status.cost.cny, 0);
  assert.ok(status.metrics !== null);
  assert.ok(status.blockers.some((blocker) => blocker.code === 'acceptance_missing'));

  const delivered = chief.deliver({ goalId: goal.goalId });
  assert.equal(delivered.ok, false);
  assert.equal(delivered.code, CHIEF_CODES.BLOCKED);
  assert.equal(delivered.details.pending[0].taskId, stored.id);

  const denied = chief.dispatchExecution({ taskId: stored.id, executorKind: 'mock' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, CHIEF_CODES.NOT_ALLOWED);
  assert.equal(runtime.runs.list({ taskId: stored.id }).length, 0);
});

test('integration: the real acceptance package downgrades a passed round with a failed item', async (t) => {
  const runtime = createRuntime({ dbPath: ':memory:' });
  t.after(() => runtime.close());

  const chief = createChief({
    runtime,
    agents: { content: { scope: { projects: ['self-media'] } } },
    acceptance,
    metrics,
    scope: { projects: ['self-media'], max_delegate_level: 'goal' },
  });

  const goal = chief.openGoal({
    title: 'goal: real acceptance',
    scope: { projects: ['self-media'] },
    budgetCny: 10,
    mustConfirm: false,
  });
  assert.equal(goal.ok, true);

  const delegated = chief.delegate({
    goalId: goal.goalId,
    bot: 'content',
    brief: { title: 'business: real acceptance', subject: { project: 'self-media' } },
  });
  assert.equal(delegated.ok, true);

  const business = runtime.tasks.get(delegated.task.id);
  const acceptanceRecord = {
    id: 'acc-real-1',
    taskId: business.id,
    stage: 'business',
    state: 'passed',
    roundNo: 1,
    items: [{ key: 'independent.review', required: true, state: 'fail' }],
    evidence: [],
    decidedAt: 1,
  };
  const originalList = runtime.acceptances.list;
  runtime.acceptances.list = (filter = {}) => {
    if (filter.taskId === business.id) return [acceptanceRecord];
    if (filter.taskId == null && filter.stage == null) return [acceptanceRecord];
    return originalList(filter);
  };
  t.after(() => {
    runtime.acceptances.list = originalList;
  });

  const status = chief.status({ goalId: goal.goalId });
  assert.equal(status.ok, true);
  assert.equal(status.businesses[0].acceptance.state, 'passed');
  assert.equal(status.businesses[0].acceptance.result, 'rework');
  assert.equal(status.businesses[0].acceptance.accepted, false);
});
