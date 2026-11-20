import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_CODES, createBusinessTools } from '../src/index.js';
import {
  BUSINESS_SCOPE,
  createTree,
  driveToAcceptance,
  openGoalAcceptance,
  openRuntime,
} from './support/runtime.js';

test('business.plan: creates an execution task inside the business scope', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  const result = business.plan({
    businessTaskId: tree.business.id,
    title: 'execution: second draft',
    budgetCny: 5,
    subject: { goal: 'write a second draft' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.task.level, 'execution');
  assert.equal(result.task.parentTaskId, tree.business.id);
  assert.equal(result.task.budget.capCny, 5);
  assert.equal(result.task.project, 'self-media');

  const stored = runtime.tasks.get(result.task.id);
  assert.deepEqual(stored.authScope.projects, ['self-media']);
  assert.equal(stored.authScope.max_delegate_level, 'execution');
  assert.equal(runtime.tasks.list({ parentTaskId: tree.business.id }).length, 2);
});

test('business.plan: inherits a narrowed executor allow-list into the execution scope', (t) => {
  const { runtime } = openRuntime(t);
  const goal = runtime.tasks.create({
    level: 'goal',
    title: 'goal',
    subject: { project: 'self-media' },
    authScope: { projects: ['self-media'] },
  });
  const businessTask = runtime.tasks.delegate({
    parentTaskId: goal.id,
    title: 'business',
    subject: { project: 'self-media' },
    authScope: {
      projects: ['self-media'],
      executors: ['mock'],
      max_delegate_level: 'business',
    },
  });
  const business = createBusinessTools({
    runtime,
    scope: {
      projects: ['self-media'],
      executors: ['mock', 'dsh_session'],
      spend_cny_cap: 10,
      max_delegate_level: 'business',
    },
  });

  const result = business.plan({ businessTaskId: businessTask.id, title: 'execution' });

  assert.equal(result.ok, true);
  assert.deepEqual(runtime.tasks.get(result.task.id).authScope.executors, ['mock']);
});

test('business.plan: refuses a non-business parent (not_allowed)', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });
  const before = runtime.tasks.list().length;

  const result = business.plan({ businessTaskId: tree.execution.id, title: 'invalid child' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
  assert.equal(runtime.tasks.list().length, before);
});

test('business.plan: refuses an allocation above the bot spend cap (budget_exceeded)', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: { ...BUSINESS_SCOPE, spend_cny_cap: 4 } });
  const before = runtime.tasks.list().length;

  const result = business.plan({
    businessTaskId: tree.business.id,
    title: 'over-budget execution',
    budgetCny: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.BUDGET_EXCEEDED);
  assert.equal(result.details.botCap, 4);
  assert.equal(runtime.tasks.list().length, before);
});

test('business.plan: refuses a business task outside the project scope', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime, { project: 'video' });
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  const result = business.plan({ businessTaskId: tree.business.id, title: 'wrong project' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
});

test('business.dispatch: dispatches to an executor the scope allows', async (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  const result = await business.dispatch({ taskId: tree.execution.id, executorKind: 'mock' });

  assert.equal(result.ok, true);
  assert.equal(result.run.executorKind, 'mock');
  assert.equal(result.run.state, 'dispatched');
  assert.equal(result.task.state, 'queued');
  assert.equal(result.executor.ok, true);
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 1);
  assert.notEqual(runtime.store.getOutbox(`outbox-${result.run.id}`), null);
});

test('business.dispatch: defaults to the only allowed executor', async (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  const result = await business.dispatch({ taskId: tree.execution.id });

  assert.equal(result.ok, true);
  assert.equal(result.run.executorKind, 'mock');
});

test('business.dispatch: refuses an executor outside the scope (authorization_exceeded)', async (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  const result = await business.dispatch({ taskId: tree.execution.id, executorKind: 'dsh_session' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
  assert.equal(result.details.reason, 'executor_not_in_scope');
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 0);
});

test('business.dispatch: refuses an exhausted task budget before dispatch', async (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime, { executionBudget: 5 });
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });
  runtime.cost.record({ taskId: tree.execution.id, kind: 'llm', costCny: 6 });

  const result = await business.dispatch({ taskId: tree.execution.id, executorKind: 'mock' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.BUDGET_EXCEEDED);
  assert.equal(result.details.cap, 5);
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 0);
});

test('business.dispatch: gates the executor that the queued run will actually use', async (t) => {
  const { runtime, clock, adapter } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });
  const { acceptance } = await driveToAcceptance({ runtime, clock, adapter }, tree.execution);
  const reworked = business.rework({
    acceptanceId: acceptance.id,
    itemStates: { 'independent.review': 'fail' },
  });
  assert.equal(reworked.ok, true);

  const result = await business.dispatch({ taskId: tree.execution.id, executorKind: 'mock' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
  assert.equal(result.details.executorKind, 'dsh_session');
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 2);
  assert.equal(
    runtime.runs.list({ taskId: tree.execution.id }).find((run) => run.id === reworked.reworkRun.id).state,
    'queued',
  );
});

test('business.dispatch: refuses a task outside the project scope', async (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime, { project: 'video' });
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  const result = await business.dispatch({ taskId: tree.execution.id, executorKind: 'mock' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 0);
});

test('business.dispatch: refuses a non-execution task (not_allowed)', async (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  const result = await business.dispatch({ taskId: tree.business.id, executorKind: 'mock' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
});

test('business.accept: passes an execution round and completes the task', async (t) => {
  const { runtime, clock, adapter } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });
  const { acceptance } = await driveToAcceptance({ runtime, clock, adapter }, tree.execution);

  const result = business.accept({
    acceptanceId: acceptance.id,
    verdict: 'pass',
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'pass' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.acceptance.state, 'passed');
  assert.equal(result.task.state, 'completed');
  assert.equal(runtime.tasks.get(tree.execution.id).state, 'completed');
});

test('business.accept: cannot decide a goal acceptance round (not_allowed)', async (t) => {
  const { runtime, businessTools, goalAcceptance } = await openGoalAcceptance(t);

  const result = businessTools.accept({
    acceptanceId: goalAcceptance.id,
    verdict: 'pass',
    itemStates: { 'human.goal_signoff': { state: 'pass', signedBy: 'human:owner' } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
  assert.equal(runtime.acceptances.get(goalAcceptance.id).state, 'open');
});

test('business.rework: a revise verdict derives a queued rework run', async (t) => {
  const { runtime, clock, adapter } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });
  const { acceptance } = await driveToAcceptance({ runtime, clock, adapter }, tree.execution);

  const result = business.rework({
    acceptanceId: acceptance.id,
    itemStates: { 'auto.contract': 'pass', 'independent.review': 'fail' },
    reason: 'factual_error',
  });

  assert.equal(result.ok, true);
  assert.equal(result.task.state, 'reworking');
  assert.equal(result.reworkRun.state, 'queued');
  assert.equal(result.reworkRun.kind, 'rework');
  assert.equal(result.acceptance.state, 'revise');

  const runs = runtime.runs.list({ taskId: tree.execution.id });
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.state === 'queued').id, result.reworkRun.id);
});

test('business.rework: a taskId finds the queued rework run without a new round', async (t) => {
  const { runtime, clock, adapter } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });
  const { acceptance } = await driveToAcceptance({ runtime, clock, adapter }, tree.execution);
  business.rework({ acceptanceId: acceptance.id, itemStates: { 'independent.review': 'fail' } });

  const result = business.rework({ taskId: tree.execution.id });

  assert.equal(result.ok, true);
  assert.equal(result.reworkRun.kind, 'rework');
  assert.equal(result.acceptance, null);
  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 2);
});

test('business.rework: refuses a goal acceptance (not_allowed)', async (t) => {
  const { runtime, businessTools, goalAcceptance } = await openGoalAcceptance(t);

  const result = businessTools.rework({ acceptanceId: goalAcceptance.id });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
  assert.equal(runtime.acceptances.get(goalAcceptance.id).state, 'open');
});

test('business.rework: refuses an acceptance outside the project scope', async (t) => {
  const { runtime, clock, adapter } = openRuntime(t);
  const tree = createTree(runtime, { project: 'video' });
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });
  const { acceptance } = await driveToAcceptance({ runtime, clock, adapter }, tree.execution);

  const result = business.rework({ acceptanceId: acceptance.id });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
  assert.equal(runtime.acceptances.get(acceptance.id).state, 'open');
});
