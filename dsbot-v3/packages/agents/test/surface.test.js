import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_CODES, createBusinessTools, createChiefTools } from '../src/index.js';
import { BUSINESS_SCOPE, CHIEF_SCOPE, createTree, openRuntime } from './support/runtime.js';

test('surface: the Chief exposes exactly delegate/status/accept/stop/cost', (t) => {
  const { runtime } = openRuntime(t);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  assert.deepEqual(Object.keys(chief).sort(), ['accept', 'cost', 'delegate', 'status', 'stop']);
  assert.deepEqual([...chief.toolNames], ['delegate', 'status', 'accept', 'stop', 'cost']);
  assert.equal(chief.role, 'chief');
});

test('surface: a business bot exposes exactly plan/dispatch/accept/rework', (t) => {
  const { runtime } = openRuntime(t);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  assert.deepEqual(Object.keys(business).sort(), ['accept', 'dispatch', 'plan', 'rework']);
  assert.deepEqual([...business.toolNames], ['plan', 'dispatch', 'accept', 'rework']);
  assert.equal(business.role, 'business');
});

test('surface: Chief cannot dispatch implementation work (not_allowed, no side effect)', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  for (const tool of ['dispatch', 'plan', 'rework']) {
    const result = chief[tool]({ taskId: tree.execution.id, executorKind: 'mock' });
    assert.equal(result.ok, false);
    assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
    assert.equal(result.details.tool, tool);
  }

  assert.equal(runtime.runs.list({ taskId: tree.execution.id }).length, 0);
  assert.equal(runtime.tasks.get(tree.execution.id).state, 'planned');
  assert.equal(runtime.tasks.list().length, 3);
});

test('surface: a business bot cannot use Chief tools (not_allowed)', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  for (const tool of ['delegate', 'stop', 'status', 'cost']) {
    const result = business[tool]({ goalTaskId: tree.goal.id, taskId: tree.goal.id });
    assert.equal(result.ok, false);
    assert.equal(result.code, AGENT_CODES.NOT_ALLOWED);
    assert.equal(result.details.tool, tool);
  }
});

test('surface: invoke routes allowed tools and denies unknown ones', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });
  const business = createBusinessTools({ runtime, scope: BUSINESS_SCOPE });

  const status = chief.invoke('status', { taskId: tree.goal.id });
  assert.equal(status.ok, true);
  assert.equal(status.tool, 'status');

  const denied = business.invoke('delegate', { goalTaskId: tree.goal.id });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, AGENT_CODES.NOT_ALLOWED);

  const unknown = chief.invoke('launch_rocket', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, AGENT_CODES.NOT_ALLOWED);
});

test('surface: malformed construction input fails loudly', () => {
  assert.throws(() => createChiefTools({ scope: CHIEF_SCOPE }), /runtime/);
  assert.throws(() => createBusinessTools({ scope: BUSINESS_SCOPE }), /runtime/);

  const fakeRuntime = {
    tasks: { get() {}, list() {}, delegate() {}, dispatch() {} },
    runs: { dispatchToExecutor() {}, list() {}, get() {} },
    acceptances: { get() {} },
    stop: { stop() {} },
    cost: { total() {} },
  };
  assert.throws(() => createChiefTools({ runtime: fakeRuntime, scope: { projects: 'nope' } }), /projects/);
  assert.throws(
    () => createBusinessTools({ runtime: fakeRuntime, scope: { executors: [1] } }),
    /executors/,
  );
  assert.throws(
    () => createBusinessTools({ runtime: fakeRuntime, scope: { spend_cny_cap: -1 } }),
    /spend_cny_cap/,
  );
});

test('surface: tools are thin wrappers that call the runtime', (t) => {
  const { runtime } = openRuntime(t);
  const tree = createTree(runtime);
  const chief = createChiefTools({ runtime, scope: CHIEF_SCOPE });

  const original = runtime.cost.total;
  let calls = 0;
  runtime.cost.total = (taskId) => {
    calls += 1;
    return original(taskId);
  };
  t.after(() => {
    runtime.cost.total = original;
  });

  const result = chief.cost({ taskId: tree.goal.id });
  assert.equal(result.ok, true);
  assert.ok(calls >= 1, 'chief.cost must delegate to runtime.cost.total');
});
