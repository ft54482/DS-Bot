import assert from 'node:assert/strict';
import test from 'node:test';

import { CHIEF_CODES, createChief } from '../src/index.js';
import {
  createFakeAcceptance,
  createFakeChief,
  createFakeMetrics,
  createFakeRuntime,
  serviceError,
} from './support/fakes.js';

function setup({
  bots = {
    content: {
      scope: { projects: ['self-media'], max_delegate_level: 'business' },
    },
  },
  scope = {},
  acceptance = createFakeAcceptance(),
  metrics = createFakeMetrics(),
} = {}) {
  const fake = createFakeRuntime();
  const fakeChief = createFakeChief({ runtime: fake.runtime });
  const agents = { chief: fakeChief, ...bots };
  const chief = createChief({
    runtime: fake.runtime,
    agents,
    acceptance,
    metrics,
    scope,
  });
  return { ...fake, fakeChief, agents, acceptance, metrics, chief };
}

function openGoal(chief, overrides = {}) {
  return chief.openGoal({
    title: 'goal: ship the self-media pilot',
    scope: { projects: ['self-media'], max_delegate_level: 'goal' },
    budgetCny: 100,
    mustConfirm: false,
    ...overrides,
  });
}

function delegate(chief, goalId, bot, overrides = {}) {
  return chief.delegate({
    goalId,
    bot,
    brief: {
      title: `business: ${bot} workstream`,
      budgetCny: 20,
      scope: { projects: ['self-media'], max_delegate_level: 'business' },
      ...overrides,
    },
  });
}

test('surface: createChief exposes goal coordination tools and no dispatch entry', () => {
  const { chief } = setup();

  assert.equal(chief.role, 'chief');
  assert.deepEqual(Object.keys(chief).sort(), [
    'delegate',
    'deliver',
    'dispatchExecution',
    'openGoal',
    'role',
    'status',
    'toolNames',
  ]);
  assert.deepEqual([...chief.toolNames], [
    'openGoal',
    'delegate',
    'status',
    'deliver',
    'dispatchExecution',
  ]);
  assert.equal('dispatch' in chief, true);
  assert.equal(Object.keys(chief).includes('dispatch'), false);
});

test('construction: missing dependencies fail loudly', () => {
  const fake = createFakeRuntime();
  const agents = { chief: createFakeChief({ runtime: fake.runtime }), content: {} };

  assert.throws(
    () => createChief({ agents, acceptance: createFakeAcceptance(), metrics: createFakeMetrics() }),
    /runtime/,
  );
  assert.throws(
    () =>
      createChief({
        runtime: fake.runtime,
        acceptance: createFakeAcceptance(),
        metrics: createFakeMetrics(),
      }),
    /agents/,
  );
  assert.throws(
    () =>
      createChief({
        runtime: fake.runtime,
        agents,
        metrics: createFakeMetrics(),
      }),
    /acceptance\.evaluate/,
  );
  assert.throws(
    () =>
      createChief({
        runtime: fake.runtime,
        agents,
        acceptance: createFakeAcceptance(),
      }),
    /metrics\.computeMetrics/,
  );
});

test('openGoal: creates a goal task with scope, budget, owner and confirmation flag', () => {
  const { chief, runtime, calls } = setup();

  const result = chief.openGoal({
    title: 'goal: produce one deliverable',
    scope: { projects: ['self-media'], max_delegate_level: 'goal' },
    budgetCny: 80,
    mustConfirm: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.tool, 'openGoal');
  assert.equal(typeof result.goalId, 'string');
  assert.equal(result.goal.level, 'goal');
  assert.equal(result.goal.owner, 'chief');
  assert.equal(result.goal.budget.capCny, 80);
  assert.deepEqual(result.goal.authScope.projects, ['self-media']);
  assert.equal(result.goal.subject.project, 'self-media');
  assert.equal(result.goal.subject.mustConfirm, true);
  assert.equal(
    result.goal.acceptanceProfile.items.some((item) => item.key === 'human.goal_signoff'),
    true,
  );
  assert.equal(runtime.tasks.get(result.goalId).title, 'goal: produce one deliverable');
  assert.equal(calls.createTask.length, 1);
});

test('openGoal: defaults to human confirmation and accepts a project string scope', () => {
  const { chief } = setup();

  const result = chief.openGoal({ title: 'goal: default confirmation', scope: 'self-media' });

  assert.equal(result.ok, true);
  assert.equal(result.goal.subject.mustConfirm, true);
  assert.deepEqual(result.goal.authScope.projects, ['self-media']);
  assert.equal(result.goal.subject.project, 'self-media');
  assert.equal(result.goal.budget, null);
});

test('openGoal: rejects invalid title and budget without creating a task', () => {
  const { chief, calls } = setup();

  const noTitle = chief.openGoal({ title: '   ' });
  assert.equal(noTitle.ok, false);
  assert.equal(noTitle.code, CHIEF_CODES.VALIDATION_ERROR);

  const badBudget = chief.openGoal({ title: 'goal: bad budget', budgetCny: -1 });
  assert.equal(badBudget.ok, false);
  assert.equal(badBudget.code, CHIEF_CODES.VALIDATION_ERROR);

  assert.equal(calls.createTask.length, 0);
});

test('openGoal: a budget above the Chief cap is budget_exceeded with no side effect', () => {
  const { chief, calls } = setup({ scope: { spend_cny_cap: 50 } });

  const result = chief.openGoal({ title: 'goal: too expensive', budgetCny: 60 });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.BUDGET_EXCEEDED);
  assert.equal(result.details.cap, 50);
  assert.equal(result.details.requested, 60);
  assert.equal(calls.createTask.length, 0);
});

test('delegate: creates a business task under the goal and calls the agent surface', () => {
  const { chief, runtime, fakeChief } = setup();
  const goal = openGoal(chief, { mustConfirm: false });

  const result = chief.delegate({
    goalId: goal.goalId,
    bot: 'content',
    brief: {
      title: 'business: write the article',
      brief: 'Draft one article with sources.',
      budgetCny: 30,
      scope: { projects: ['self-media'], max_delegate_level: 'business' },
      subject: { note: 'narrowed' },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.tool, 'delegate');
  assert.equal(result.goalId, goal.goalId);
  assert.equal(result.bot, 'content');
  assert.equal(result.task.level, 'business');
  assert.equal(result.task.parentTaskId, goal.goalId);
  assert.equal(result.task.owner, 'bot:content');
  assert.equal(result.task.budget.capCny, 30);
  assert.equal(result.task.subject.bot, 'content');
  assert.equal(result.task.subject.note, 'narrowed');
  assert.equal(result.task.subject.brief, 'Draft one article with sources.');
  assert.equal(fakeChief.calls.delegate.length, 1);
  assert.equal(fakeChief.calls.delegate[0].toBot, 'content');
  assert.equal(fakeChief.calls.delegate[0].title, 'business: write the article');
  assert.equal(runtime.tasks.list({ parentTaskId: goal.goalId }).length, 1);
});

test('delegate: a string brief becomes the business title', () => {
  const { chief } = setup();
  const goal = openGoal(chief);

  const result = chief.delegate({ goalId: goal.goalId, bot: 'content', brief: 'produce a draft' });

  assert.equal(result.ok, true);
  assert.equal(result.task.title, 'produce a draft');
  assert.equal(result.task.subject.brief, 'produce a draft');
});

test('delegate: an unregistered bot is unknown_bot and creates nothing', () => {
  const { chief, fakeChief, runtime } = setup();
  const goal = openGoal(chief);
  const before = runtime.tasks.list().length;

  const result = chief.delegate({ goalId: goal.goalId, bot: 'video' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.UNKNOWN_BOT);
  assert.equal(result.details.bot, 'video');
  assert.deepEqual(result.details.registered, ['content']);
  assert.equal(fakeChief.calls.delegate.length, 0);
  assert.equal(runtime.tasks.list().length, before);
});

test('delegate: an allocation above the goal remaining budget is budget_exceeded', () => {
  const { chief, fakeChief } = setup();
  const goal = openGoal(chief, { budgetCny: 10 });

  const result = chief.delegate({
    goalId: goal.goalId,
    bot: 'content',
    brief: { title: 'business: too big', budgetCny: 15 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.BUDGET_EXCEEDED);
  assert.equal(result.details.cap, 10);
  assert.equal(result.details.requested, 15);
  assert.equal(fakeChief.calls.delegate.length, 0);
});

test('delegate: an allocation above the BOT cap is budget_exceeded', () => {
  const { chief, fakeChief } = setup({
    bots: {
      content: {
        scope: { projects: ['self-media'], spend_cny_cap: 5 },
      },
    },
  });
  const goal = openGoal(chief, { budgetCny: 100 });

  const result = chief.delegate({
    goalId: goal.goalId,
    bot: 'content',
    brief: { title: 'business: above bot cap', budgetCny: 10 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.BUDGET_EXCEEDED);
  assert.equal(result.details.cap, 5);
  assert.equal(fakeChief.calls.delegate.length, 0);
});

test('delegate: a non-goal parent is not_allowed', () => {
  const { chief, seedGoal, seedBusiness } = setup();
  const goal = seedGoal({ title: 'seeded goal' });
  const business = seedBusiness(goal.id, { title: 'seeded business' });

  const result = chief.delegate({ goalId: business.id, bot: 'content' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.NOT_ALLOWED);
  assert.equal(result.details.level, 'business');
});

test('delegate: an unknown goal id is not_found', () => {
  const { chief } = setup();

  const result = chief.delegate({ goalId: 'task-missing', bot: 'content' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.NOT_FOUND);
});

test('delegate: an agent-layer service error keeps its machine-readable code', () => {
  const { chief, fakeChief } = setup();
  const goal = openGoal(chief);
  fakeChief.delegate = () => {
    throw serviceError('authorization_exceeded', 'scope widened', { dimension: 'projects' });
  };

  const result = chief.delegate({ goalId: goal.goalId, bot: 'content' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.AUTHORIZATION_EXCEEDED);
  assert.deepEqual(result.details, { dimension: 'projects' });
});

test('dispatchExecution: the Chief is denied and no runtime dispatch is attempted', () => {
  const { chief, calls, runtime } = setup();
  const before = runtime.tasks.list().length;

  const result = chief.dispatchExecution({ taskId: 'task-1', executorKind: 'mock' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.NOT_ALLOWED);
  assert.equal(result.details.role, 'chief');
  assert.equal(result.details.tool, 'dispatchExecution');
  assert.equal(calls.dispatchTask.length, 0);
  assert.equal(runtime.tasks.list().length, before);

  const alias = chief.dispatch({ taskId: 'task-1' });
  assert.equal(alias.ok, false);
  assert.equal(alias.code, CHIEF_CODES.NOT_ALLOWED);
  assert.equal(calls.dispatchTask.length, 0);
});

test('status: aggregates business states, acceptance, cost and blockers', () => {
  const { chief, seedAcceptance, seedGoal, seedBusiness, setCost } = setup();
  const goal = seedGoal({ title: 'goal: aggregate', budget: { capCny: 100 } });
  const content = seedBusiness(goal.id, {
    title: 'business: content',
    owner: 'bot:content',
    state: 'completed',
  });
  const video = seedBusiness(goal.id, {
    title: 'business: video',
    owner: 'bot:video',
    state: 'completed',
  });
  seedAcceptance({
    taskId: content.id,
    state: 'passed',
    items: [{ key: 'independent.review', required: true, state: 'pass' }],
  });
  seedAcceptance({
    taskId: video.id,
    state: 'revise',
    items: [{ key: 'independent.review', required: true, state: 'fail' }],
  });
  setCost(goal.id, 1);
  setCost(content.id, 2);
  setCost(video.id, 3);

  const result = chief.status({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(result.goalId, goal.id);
  assert.equal(result.goal.title, 'goal: aggregate');
  assert.equal(result.businesses.length, 2);
  assert.equal(result.businesses[0].acceptance.result, 'pass');
  assert.equal(result.businesses[0].acceptance.accepted, true);
  assert.equal(result.businesses[1].acceptance.result, 'rework');
  assert.equal(result.businesses[1].acceptance.accepted, false);
  assert.deepEqual(result.counts, { completed: 2 });
  assert.equal(result.acceptance.total, 2);
  assert.equal(result.acceptance.passed, 1);
  assert.equal(result.acceptance.rework, 1);
  assert.equal(result.acceptance.allPassed, false);
  assert.equal(result.cost.cny, 6);
  assert.equal(result.cost.capCny, 100);
  assert.equal(result.cost.remainingCny, 94);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'acceptance_rework'));
  assert.equal(typeof result.generatedAt, 'number');
});

test('status: a business without an acceptance round is missing, not passed', () => {
  const { chief, seedGoal, seedBusiness } = setup();
  const goal = seedGoal({ title: 'goal: pending' });
  const business = seedBusiness(goal.id, { title: 'business: pending', state: 'running' });

  const result = chief.status({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(result.businesses[0].acceptance.state, 'missing');
  assert.equal(result.businesses[0].acceptance.result, 'missing');
  assert.equal(result.businesses[0].acceptance.accepted, false);
  assert.equal(result.acceptance.missing, 1);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'acceptance_missing'));
  assert.equal(business.state, 'running');
});

test('status: an open acceptance is pending even when every item already passes', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance } = setup();
  const goal = seedGoal({ title: 'goal: open round' });
  const business = seedBusiness(goal.id, { title: 'business: open', state: 'accepting' });
  seedAcceptance({
    taskId: business.id,
    state: 'open',
    items: [{ key: 'independent.review', required: true, state: 'pass' }],
  });

  const result = chief.status({ goalId: goal.id });

  assert.equal(result.businesses[0].acceptance.result, 'pending');
  assert.equal(result.businesses[0].acceptance.accepted, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'acceptance_pending'));
});

test('status: evaluates every business acceptance through the injected engine', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance, acceptance } = setup();
  const goal = seedGoal({ title: 'goal: evaluate' });
  for (const name of ['content', 'video']) {
    const business = seedBusiness(goal.id, { title: `business: ${name}` });
    seedAcceptance({
      taskId: business.id,
      state: 'passed',
      items: [{ key: 'independent.review', required: true, state: 'pass' }],
    });
  }

  const result = chief.status({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(acceptance.calls.length, 2);
  for (const input of acceptance.calls) {
    assert.equal(input.stage, 'business');
    assert.equal(input.rubric.stage, 'business');
    assert.equal(input.rubric.items[0].verdict, 'pass');
    assert.equal(input.task.level, 'business');
  }
});

test('status: composes the metrics package over the goal subtree', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance, setCost, addRun, metrics } = setup();
  const goal = seedGoal({ title: 'goal: metrics', budget: { capCny: 100 } });
  const business = seedBusiness(goal.id, { title: 'business: metrics', state: 'completed' });
  seedAcceptance({
    taskId: business.id,
    state: 'passed',
    items: [{ key: 'independent.review', required: true, state: 'pass' }],
  });
  setCost(business.id, 2);
  addRun({ taskId: business.id });

  const result = chief.status({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(metrics.calls.length, 1);
  const input = metrics.calls[0];
  assert.deepEqual(input.tasks.map((task) => task.id).sort(), [goal.id, business.id].sort());
  assert.equal(input.runs.length, 1);
  assert.equal(input.acceptances.length, 1);
  assert.equal(input.costs.length, 1);
  assert.equal(result.metrics.cost_per_accepted_task, 12.5);
  assert.equal(result.cost.runs, 1);
});

test('status: a metrics failure does not break the status view', () => {
  const failing = createFakeMetrics({
    impl() {
      throw new Error('metrics exploded');
    },
  });
  const { chief, seedGoal, seedBusiness } = setup({ metrics: failing });
  const goal = seedGoal({ title: 'goal: metrics failure' });
  seedBusiness(goal.id, { title: 'business: metrics failure' });

  const result = chief.status({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(result.metrics, null);
  assert.match(result.metricsError, /metrics exploded/);
});

test('status: an acceptance evaluator failure becomes a blocked conclusion', () => {
  const failing = createFakeAcceptance({
    impl() {
      throw new Error('evaluator exploded');
    },
  });
  const { chief, seedGoal, seedBusiness, seedAcceptance } = setup({ acceptance: failing });
  const goal = seedGoal({ title: 'goal: evaluator failure' });
  const business = seedBusiness(goal.id, { title: 'business: evaluator failure', state: 'completed' });
  seedAcceptance({
    taskId: business.id,
    state: 'passed',
    items: [{ key: 'independent.review', required: true, state: 'pass' }],
  });

  const result = chief.status({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(result.businesses[0].acceptance.result, 'blocked');
  assert.match(result.businesses[0].acceptance.evaluation.error, /evaluator exploded/);
});

test('status: an unknown goal is not_found and a non-goal is not_allowed', () => {
  const { chief, seedGoal, seedBusiness } = setup();

  const missing = chief.status({ goalId: 'task-missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CHIEF_CODES.NOT_FOUND);

  const goal = seedGoal({ title: 'seeded' });
  const business = seedBusiness(goal.id, { title: 'business' });
  const wrongLevel = chief.status({ goalId: business.id });
  assert.equal(wrongLevel.ok, false);
  assert.equal(wrongLevel.code, CHIEF_CODES.NOT_ALLOWED);
});

test('deliver: blocked while any business acceptance has not passed', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance } = setup();
  const goal = seedGoal({ title: 'goal: deliver blocked', budget: { capCny: 100 } });
  const content = seedBusiness(goal.id, { title: 'business: content', state: 'completed' });
  const video = seedBusiness(goal.id, { title: 'business: video', state: 'completed' });
  seedAcceptance({
    taskId: content.id,
    state: 'passed',
    items: [{ key: 'independent.review', required: true, state: 'pass' }],
  });
  seedAcceptance({
    taskId: video.id,
    state: 'open',
    items: [{ key: 'independent.review', required: true, state: 'pending' }],
  });

  const result = chief.deliver({ goalId: goal.id });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.BLOCKED);
  assert.equal(result.details.goalId, goal.id);
  assert.equal(result.details.pending.length, 1);
  assert.equal(result.details.pending[0].taskId, video.id);
  assert.ok(result.details.blockers.length >= 1);
  assert.ok(result.details.blockers.every((entry) => entry.taskId === video.id));
});

test('deliver: a goal without delegations is blocked with a concrete reason', () => {
  const { chief, seedGoal } = setup();
  const goal = seedGoal({ title: 'goal: empty' });

  const result = chief.deliver({ goalId: goal.id });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.BLOCKED);
  assert.equal(result.details.blockers[0].code, 'no_business_delegations');
});

test('deliver: a passed acceptance on a blocked business still blocks delivery', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance } = setup();
  const goal = seedGoal({ title: 'goal: blocked business' });
  const business = seedBusiness(goal.id, {
    title: 'business: blocked',
    state: 'blocked',
    blockedReason: 'dependency unavailable',
  });
  seedAcceptance({
    taskId: business.id,
    state: 'passed',
    items: [{ key: 'independent.review', required: true, state: 'pass' }],
  });

  const result = chief.deliver({ goalId: goal.id });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.BLOCKED);
  assert.ok(result.details.blockers.some((entry) => entry.code === 'task_blocked'));
});

test('deliver: returns the result package when every business acceptance passed', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance, setCost } = setup();
  const goal = seedGoal({
    title: 'goal: deliverable',
    budget: { capCny: 100 },
    subject: { project: 'self-media', mustConfirm: false },
  });
  const content = seedBusiness(goal.id, {
    title: 'business: content',
    state: 'completed',
    owner: 'bot:content',
    subject: {
      project: 'self-media',
      deliverables: [{ name: 'article', path: 'article.md', sha256: 'a'.repeat(64) }],
      risks: ['source freshness'],
    },
  });
  const video = seedBusiness(goal.id, {
    title: 'business: video',
    state: 'completed',
    owner: 'bot:video',
  });
  for (const business of [content, video]) {
    seedAcceptance({
      taskId: business.id,
      state: 'passed',
      items: [{ key: 'independent.review', required: true, state: 'pass' }],
    });
  }
  setCost(content.id, 2);
  setCost(video.id, 3);

  const result = chief.deliver({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(result.tool, 'deliver');
  assert.equal(result.goal_id, goal.id);
  assert.equal(result.outcome, 'done');
  assert.match(result.summary, /2 business delegation/);
  assert.equal(result.acceptance.stage, 'business');
  assert.equal(result.acceptance.result, 'passed');
  assert.equal(result.acceptance.businesses.length, 2);
  assert.equal(result.deliverables.length, 1);
  assert.equal(result.deliverables[0].path, 'article.md');
  assert.equal(result.deliverables[0].task_id, content.id);
  assert.equal(result.cost.cny, 5);
  assert.equal(result.cost.capCny, 100);
  assert.deepEqual(result.risks, ['source freshness']);
  assert.deepEqual(result.needs_decision, []);
  assert.equal(result.needs_confirmation, false);
});

test('deliver: mustConfirm adds a confirmation decision to the package', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance } = setup();
  const goal = seedGoal({
    title: 'goal: needs confirmation',
    subject: { mustConfirm: true },
  });
  const business = seedBusiness(goal.id, { title: 'business: done', state: 'completed' });
  seedAcceptance({
    taskId: business.id,
    state: 'passed',
    items: [{ key: 'independent.review', required: true, state: 'pass' }],
  });

  const result = chief.deliver({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(result.must_confirm, true);
  assert.equal(result.needs_confirmation, true);
  assert.equal(result.needs_decision.length, 1);
  assert.equal(result.needs_decision[0].options[0], 'confirm');
});

test('deliver: an unknown goal is not_found', () => {
  const { chief } = setup();

  const result = chief.deliver({ goalId: 'task-missing' });

  assert.equal(result.ok, false);
  assert.equal(result.code, CHIEF_CODES.NOT_FOUND);
});

test('deliver: a passed acceptance without items is trusted as passed', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance } = setup();
  const goal = seedGoal({ title: 'goal: minimal acceptance' });
  const business = seedBusiness(goal.id, { title: 'business: minimal', state: 'completed' });
  seedAcceptance({ taskId: business.id, state: 'passed', items: [] });

  const result = chief.deliver({ goalId: goal.id });

  assert.equal(result.ok, true);
  assert.equal(result.acceptance.result, 'passed');
});

test('status and deliver never call the runtime dispatch or delegate paths for execution work', () => {
  const { chief, seedGoal, seedBusiness, seedAcceptance, calls } = setup();
  const goal = seedGoal({ title: 'goal: no dispatch' });
  const business = seedBusiness(goal.id, { title: 'business: no dispatch', state: 'completed' });
  seedAcceptance({
    taskId: business.id,
    state: 'passed',
    items: [{ key: 'independent.review', required: true, state: 'pass' }],
  });

  chief.status({ goalId: goal.id });
  chief.deliver({ goalId: goal.id });

  assert.equal(calls.dispatchTask.length, 0);
  assert.equal(calls.delegateTask.length, 0);
});
