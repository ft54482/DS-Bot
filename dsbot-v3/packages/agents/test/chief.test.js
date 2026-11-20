import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_CODES, createChiefTools } from '../src/index.js';
import {
  CHIEF_SCOPE,
  createTree,
  driveToAcceptance,
  openGoalAcceptance,
  openRuntime,
} from './support/runtime.js';

test('chief.delegate: creates a business task under the goal with scope and budget', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const result = chief.delegate({
    goalTaskId: tree.goal.id,
    title: 'business: second workstream',
    toBot: 'content',
    budgetCny: 30,
    scope: { projects: ['self-media'], max_delegate_level: 'business' },
    subject: { note: 'narrowed delegation' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.task.level, 'business');
  assert.equal(result.task.parentTaskId, tree.goal.id);
  assert.equal(result.task.owner, 'bot:content');
  assert.equal(result.task.budget.capCny, 30);
  assert.equal(result.task.project, 'self-media');

  const stored = runtime.tasks.get(result.task.id);
  assert.deepEqual(stored.authScope.projects, ['self-media']);
  assert.equal(stored.authScope.max_delegate_level, 'business');
  assert.equal(runtime.tasks.list({ parentTaskId: tree.goal.id }).length, 2);
});

test('chief.delegate: refuses an execution or business parent (not_allowed)', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });
  const before = runtime.tasks.list().length;

  const result = chief.delegate({ goalTaskId: tree.business.id, title: 'illegal delegation' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
  assert.equal(runtime.tasks.list().length, before);
});

test('chief.delegate: clamps a default delegation ceiling to business', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const result = chief.delegate({ goalTaskId: tree.goal.id, title: 'default-scope business' });

  assert.equal(result.ok, true);
  const stored = runtime.tasks.get(result.task.id);
  assert.equal(stored.authScope.max_delegate_level, 'business');
  assert.deepEqual(stored.authScope.projects, ['self-media']);
});

test('chief.delegate: refuses a child scope wider than the Chief scope', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const result = chief.delegate({
    goalTaskId: tree.goal.id,
    title: 'widen my permissions',
    scope: { projects: ['video'] },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
  assert.ok(result.details.violations.length >= 1);
});

test('chief.delegate: refuses an allocation above the parent remaining budget', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime, { goalBudget: 10 });
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const result = chief.delegate({
    goalTaskId: tree.goal.id,
    title: 'over-allocated business',
    budgetCny: 15,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.BUDGET_EXCEEDED);
  assert.equal(result.details.cap, 10);
});

test('chief.status: summarises the goal and its delegations without run logs', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const result = chief.status({ taskId: tree.goal.id });

  assert.equal(result.ok, true);
  assert.equal(result.task.id, tree.goal.id);
  assert.equal(result.task.project, 'self-media');
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0].level, 'business');
  assert.deepEqual(result.counts, { planned: 1 });
  assert.equal('runs' in result.task, false);
  assert.equal('events' in result, false);
});

test('chief.status: denies a task outside the Chief project scope', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime, { project: 'video' });
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const result = chief.status({ taskId: tree.goal.id });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
  assert.ok(result.details.violations.some((violation) => violation.dimension === 'projects'));
});

test('chief.accept: cannot decide an execution acceptance round (not_allowed)', async (t) => {
  const { runtime, clock, adapter } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });
  const { acceptance } = await driveToAcceptance({ runtime, clock, adapter }, tree.execution);

  const result = chief.accept({ acceptanceId: acceptance.id, verdict: 'pass' });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
  assert.equal(runtime.acceptances.get(acceptance.id).state, 'open');
});

test('chief.accept: cannot sign the human goal sign-off item', async (t) => {
  const { runtime, chiefTools, goalAcceptance } = await openGoalAcceptance(t);

  const result = chiefTools.accept({
    acceptanceId: goalAcceptance.id,
    verdict: 'pass',
    itemStates: {
      'human.goal_signoff': { state: 'pass', signedBy: 'human:owner', producer: 'human:owner' },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
  assert.match(result.message, /human/i);
  assert.equal(runtime.acceptances.get(goalAcceptance.id).state, 'open');
});

test('chief.accept: records its goal review through the acceptance service', async (t) => {
  const { runtime, chiefTools, goalAcceptance } = await openGoalAcceptance(t);

  const result = chiefTools.accept({
    acceptanceId: goalAcceptance.id,
    verdict: 'fail',
    itemStates: { 'human.goal_signoff': 'fail' },
    reason: 'goal not met',
  });

  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'failed');
  assert.equal(result.acceptance.state, 'failed');
  assert.equal(result.task.state, 'blocked');
  assert.equal(runtime.service.listEvents({ type: 'acceptance.failed' }).length, 1);
});

test('chief.stop: stops the whole subtree and reports a verified stop', async (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const result = await chief.stop({ taskId: tree.goal.id, reason: 'user_stop' });

  assert.equal(result.ok, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.stopState, 'verified');
  assert.equal(result.task.state, 'cancelled');
  for (const task of [tree.goal, tree.business, tree.execution]) {
    assert.equal(runtime.tasks.get(task.id).state, 'cancelled');
  }
  assert.deepEqual(result.blockers, []);
});

test('chief.stop: denies a task outside the Chief project scope', async (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime, { project: 'video' });
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const result = await chief.stop({ taskId: tree.goal.id });

  assert.equal(result.ok, false);
  assert.equal(result.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
  assert.equal(runtime.tasks.get(tree.goal.id).state, 'planned');
});

test('chief.cost: reports task cost, cap and remaining from the runtime ledger', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });
  runtime.cost.record({ taskId: tree.business.id, kind: 'llm', costCny: 1.5 });

  const taskCost = chief.cost({ taskId: tree.business.id });
  assert.equal(taskCost.ok, true);
  assert.equal(taskCost.total.costCny, 1.5);
  assert.equal(taskCost.cap, 50);
  assert.equal(taskCost.remaining, 48.5);

  runtime.cost.record({ taskId: tree.execution.id, kind: 'tool', costCny: 0.5 });
  const aggregate = chief.cost({});
  assert.equal(aggregate.ok, true);
  assert.equal(aggregate.total.costCny, 2);
  assert.equal(aggregate.total.entries, 2);
  assert.equal(aggregate.tasks.length, 3);
});

test('chief.cost: aggregate excludes scoped-out projects', (t) => {
  const { runtime } = openRuntime(t);
  const inScope = createTree(runtime);
  const outOfScope = createTree(runtime, { project: 'video' });
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });
  runtime.cost.record({ taskId: inScope.execution.id, kind: 'llm', costCny: 1 });
  runtime.cost.record({ taskId: outOfScope.execution.id, kind: 'llm', costCny: 9 });

  const aggregate = chief.cost({});
  assert.equal(aggregate.ok, true);
  assert.equal(aggregate.total.costCny, 1);
  assert.equal(aggregate.tasks.length, 3);

  const denied = chief.cost({ taskId: outOfScope.goal.id });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, AGENT_CODES.AUTHORIZATION_EXCEEDED);
});

test('chief.accept: rejects a malformed acceptance id without throwing', (t) => {
  const { runtime } = openRuntime(t);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const missing = chief.accept({ acceptanceId: 'does-not-exist', verdict: 'pass' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not_found');

  const malformed = chief.accept({ verdict: 'pass' });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, AGENT_CODES.VALIDATION_ERROR);
});
