import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/index.js';

function withStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-store-'));
  const path = join(dir, 'control.sqlite');
  const store = openStore({ path });
  t.after(() => {
    try {
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return store;
}

function expectCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

function goalTask(store, overrides = {}) {
  return store.createTask({
    level: 'goal',
    title: 'goal title',
    goal: 'goal description',
    project: 'smoke',
    delegator_kind: 'human',
    delegator_ref: 'human:ft54482',
    owner_ref: 'bot:chief',
    ...overrides,
  });
}

test('completion guard: completed without a passed acceptance at this level must fail', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });

  assert.throws(
    () => store.updateTaskState(goal.id, 'completed', { actor: 'bot:chief' }),
    expectCode('missing_acceptance'),
  );
  assert.equal(store.getTask(goal.id).state, 'planned');
  assert.equal(store.listTaskEvents(goal.id).length, 0, 'rejected transition must not write an event');
});

test('completion guard: a passed acceptance from another level does not count', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });

  const wrongLevel = store.createAcceptance({
    stage: 'execution',
    target_task_id: goal.id,
    mode: 'auto',
    criteria: [],
  });
  store.decideAcceptance(wrongLevel.id, 'passed', { reviewer: 'system:acceptance' });

  assert.throws(
    () => store.updateTaskState(goal.id, 'completed', { actor: 'bot:chief' }),
    expectCode('missing_acceptance'),
  );
  assert.equal(store.getTask(goal.id).state, 'planned');
});

test('completion guard: a passed acceptance at this level allows completed and records the event', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });

  const acceptance = store.createAcceptance({
    stage: 'goal',
    target_task_id: goal.id,
    mode: 'human',
    criteria: [{ id: 'goal-met', text: 'user goal is met' }],
  });
  store.addAcceptanceItem({
    acceptance_id: acceptance.id,
    class: 'human',
    criterion: 'user goal is met',
    result: 'pass',
    decided_by: 'human:ft54482',
  });
  const passed = store.decideAcceptance(acceptance.id, 'passed', { reviewer: 'human:ft54482' });
  assert.equal(passed.state, 'passed');

  const completed = store.updateTaskState(goal.id, 'completed', { actor: 'bot:chief' });
  assert.equal(completed.state, 'completed');
  assert.ok(Number(completed.closed_at) > 0);

  const events = store.listTaskEvents(goal.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].from_state, 'planned');
  assert.equal(events[0].to_state, 'completed');
});

test('completion guard: a rejected acceptance does not allow completed', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });
  const acceptance = store.createAcceptance({
    stage: 'goal',
    target_task_id: goal.id,
    mode: 'human',
    criteria: [],
  });
  store.decideAcceptance(acceptance.id, 'rejected', { reviewer: 'human:ft54482' });

  assert.throws(
    () => store.updateTaskState(goal.id, 'completed', { actor: 'bot:chief' }),
    expectCode('missing_acceptance'),
  );
});

test('hierarchy guard: goal may not directly own an execution task', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });

  assert.throws(
    () =>
      store.createTask({
        level: 'execution',
        parent_task_id: goal.id,
        title: 'execution title',
        goal: 'execution goal',
        project: 'smoke',
        delegator_kind: 'bot',
        delegator_ref: 'bot:chief',
        owner_ref: 'bot:exec',
      }),
    expectCode('hierarchy_violation'),
  );
  assert.equal(store.listTasks().length, 1, 'rejected task must not be inserted');
});

test('hierarchy guard: adjacent levels are accepted in order', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });
  const business = store.createTask({
    level: 'business',
    parent_task_id: goal.id,
    title: 'business title',
    goal: 'business goal',
    project: 'smoke',
    delegator_kind: 'chief',
    delegator_ref: 'bot:chief',
    owner_ref: 'bot:cs',
  });
  const execution = store.createTask({
    level: 'execution',
    parent_task_id: business.id,
    title: 'execution title',
    goal: 'execution goal',
    project: 'smoke',
    delegator_kind: 'bot',
    delegator_ref: 'bot:cs',
    owner_ref: 'bot:exec',
  });
  assert.equal(execution.parent_task_id, business.id);

  // business may not hang directly under business / execution may not hang under goal
  assert.throws(
    () =>
      store.createTask({
        level: 'business',
        parent_task_id: business.id,
        title: 'nested business',
        goal: 'x',
        project: 'smoke',
        delegator_kind: 'bot',
        delegator_ref: 'bot:cs',
        owner_ref: 'bot:cs',
      }),
    expectCode('hierarchy_violation'),
  );
  assert.throws(
    () =>
      store.createTask({
        level: 'execution',
        parent_task_id: 'task-does-not-exist',
        title: 'orphan execution',
        goal: 'x',
        project: 'smoke',
        delegator_kind: 'bot',
        delegator_ref: 'bot:cs',
        owner_ref: 'bot:exec',
      }),
    expectCode('hierarchy_violation'),
  );
});

test('hierarchy guard: level and parent are immutable after creation', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });

  assert.throws(
    () => store.db.prepare('UPDATE task SET level = ? WHERE id = ?').run('business', goal.id),
    /task level and parent are immutable/,
  );
  assert.equal(store.getTask(goal.id).level, 'goal');
});

test('invalid task state is rejected before touching the database', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });
  assert.throws(
    () => store.updateTaskState(goal.id, 'done', { actor: 'bot:chief' }),
    expectCode('validation_error'),
  );
  assert.equal(store.getTask(goal.id).state, 'planned');
});
