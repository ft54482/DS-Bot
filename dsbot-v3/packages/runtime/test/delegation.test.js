import assert from 'node:assert/strict';
import test from 'node:test';

import { GOAL_PROFILE, openRuntime } from './support/harness.js';

test('tasks: goal delegation builds goal → business → execution', (t) => {
  const { runtime } = openRuntime(t);

  const goal = runtime.tasks.create({
    level: 'goal',
    title: '写一篇关于 AI 的文章',
    acceptanceProfile: GOAL_PROFILE,
  });
  assert.equal(goal.level, 'goal');
  assert.equal(goal.state, 'planned');

  const business = runtime.tasks.delegate({
    parentTaskId: goal.id,
    title: '内容 BOT：拆解并交付稿件',
  });
  assert.equal(business.level, 'business');
  assert.equal(business.parentTaskId, goal.id);
  assert.equal(business.state, 'planned');

  const execution = runtime.tasks.delegate({
    parentTaskId: business.id,
    title: '写稿 + 自检',
  });
  assert.equal(execution.level, 'execution');
  assert.equal(execution.parentTaskId, business.id);
  assert.equal(execution.state, 'planned');

  assert.equal(runtime.tasks.list().length, 3);
  assert.equal(
    runtime.service.listEvents({ type: 'delegation.created' }).length,
    2,
    'both delegations are recorded in the append-only ledger',
  );
});

test('tasks: delegation must advance exactly one level', (t) => {
  const { runtime } = openRuntime(t);
  const goal = runtime.tasks.create({ level: 'goal', title: 'goal' });
  const business = runtime.tasks.delegate({ parentTaskId: goal.id, title: 'business' });

  assert.throws(
    () => runtime.tasks.delegate({ parentTaskId: goal.id, level: 'execution', title: 'skip' }),
    (error) => error.code === 'hierarchy_violation',
    'a goal cannot delegate an execution child directly',
  );
  assert.throws(
    () => runtime.tasks.delegate({ parentTaskId: business.id, level: 'goal', title: 'backwards' }),
    (error) => error.code === 'hierarchy_violation',
    'a business task cannot delegate a goal child',
  );

  const execution = runtime.tasks.delegate({ parentTaskId: business.id, title: 'execution' });
  assert.throws(
    () => runtime.tasks.delegate({ parentTaskId: execution.id, title: 'too deep' }),
    (error) => error.code === 'hierarchy_violation',
    'an execution task cannot own a delegated child',
  );
  assert.equal(runtime.tasks.list().length, 3, 'rejected delegations create no task');
});
