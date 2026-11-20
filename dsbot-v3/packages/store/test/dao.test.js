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

test('createTask applies documented defaults and can be read back', (t) => {
  const store = withStore(t);
  const created = goalTask(store, { id: 'task-fixed', idempotency_key: 'idem-task-1' });

  assert.equal(created.id, 'task-fixed');
  assert.equal(created.state, 'planned');
  assert.equal(created.domain, 'ops');
  assert.equal(Number(created.priority), 50);
  assert.equal(created.acceptance_criteria, '[]');
  assert.equal(created.authorization_json, '{}');
  assert.equal(created.closed_at, null);

  const read = store.getTask('task-fixed');
  assert.deepEqual(read, created);
  assert.equal(store.getTask('task-missing'), null);
});

test('createTask rejects missing required fields and duplicate idempotency keys', (t) => {
  const store = withStore(t);
  assert.throws(
    () => store.createTask({ level: 'goal', title: 'x' }),
    (error) => {
      assert.equal(error.code, 'validation_error');
      return true;
    },
  );

  goalTask(store, { id: 'task-a', idempotency_key: 'same-key' });
  assert.throws(
    () => goalTask(store, { id: 'task-b', idempotency_key: 'same-key' }),
    (error) => {
      assert.equal(error.code, 'conflict');
      return true;
    },
  );
});

test('listTasks filters by level/state/project', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal', project: 'alpha' });
  store.createTask({
    level: 'business',
    parent_task_id: goal.id,
    title: 'business title',
    goal: 'business goal',
    project: 'alpha',
    delegator_kind: 'chief',
    delegator_ref: 'bot:chief',
    owner_ref: 'bot:cs',
    state: 'running',
  });
  store.createTask({
    level: 'goal',
    title: 'other goal',
    goal: 'other',
    project: 'beta',
    delegator_kind: 'human',
    delegator_ref: 'human:ft54482',
    owner_ref: 'bot:chief',
  });

  assert.deepEqual(store.listTasks({ level: 'business' }).map((task) => task.project), ['alpha']);
  assert.deepEqual(store.listTasks({ project: 'beta' }).map((task) => task.level), ['goal']);
  assert.deepEqual(store.listTasks({ level: 'business', state: 'running' }).length, 1);
  assert.deepEqual(store.listTasks({ level: 'business', state: 'completed' }), []);
});

test('appendTaskEvent and updateTaskState keep an append-only ledger', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });

  const manual = store.appendTaskEvent({
    task_id: goal.id,
    type: 'task.comment',
    actor: 'human:ft54482',
    payload: { text: 'please start' },
  });
  assert.equal(manual.payload_json, '{"text":"please start"}');

  const queued = store.updateTaskState(goal.id, 'queued', {
    actor: 'human:ft54482',
    expectedState: 'planned',
  });
  assert.equal(queued.state, 'queued');

  const events = store.listTaskEvents(goal.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'task.comment');
  assert.equal(events[1].type, 'task.state_changed');
  assert.equal(events[1].from_state, 'planned');
  assert.equal(events[1].to_state, 'queued');
  assert.equal(events[1].actor, 'human:ft54482');
});

test('listTaskEvents keeps insertion order when timestamps tie', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });
  const at = 1_700_000_000_000;

  // Explicit ids sort in reverse insertion order, so ordering by id (the old
  // tie-breaker) would deterministically return these events backwards.
  const inserted = [
    { id: 'evt-tie-c', type: 'task.comment' },
    {
      id: 'evt-tie-b',
      type: 'task.state_changed',
      from_state: 'planned',
      to_state: 'queued',
    },
    { id: 'evt-tie-a', type: 'task.assigned' },
  ].map((event) => store.appendTaskEvent({
    task_id: goal.id,
    actor: 'system:test',
    created_at: at,
    ...event,
  }));

  assert.deepEqual(
    store.listTaskEvents(goal.id).map((event) => event.id),
    inserted.map((event) => event.id),
  );
});

test('run, acceptance, evidence, cost, outbox and inbox round-trip', (t) => {
  const store = withStore(t);
  const goal = goalTask(store, { id: 'task-goal' });

  const run = store.createRun({
    task_id: goal.id,
    executor_kind: 'dsh_session',
    idempotency_key: 'run-once',
  });
  assert.equal(Number(run.run_no), 1);
  assert.equal(run.state, 'queued');
  const secondRun = store.createRun({
    task_id: goal.id,
    executor_kind: 'dsh_session',
    idempotency_key: 'run-twice',
  });
  assert.equal(Number(secondRun.run_no), 2);

  const acceptance = store.createAcceptance({
    stage: 'goal',
    target_task_id: goal.id,
    run_id: run.id,
    mode: 'human',
    criteria: [{ id: 'c1', text: 'works' }],
  });
  assert.equal(acceptance.state, 'open');
  assert.equal(acceptance.criteria_json, '[{"id":"c1","text":"works"}]');

  const item = store.addAcceptanceItem({
    acceptance_id: acceptance.id,
    class: 'human',
    criterion: 'works',
    result: 'pass',
    decided_by: 'human:ft54482',
  });
  assert.equal(store.listAcceptanceItems(acceptance.id).length, 1);
  assert.equal(item.result, 'pass');

  const evidence = store.appendEvidence({
    acceptance_id: acceptance.id,
    kind: 'test_output',
    ref: 'node --test',
    output_excerpt: 'ok 1',
  });
  assert.equal(store.listEvidence(acceptance.id)[0].id, evidence.id);

  const decided = store.decideAcceptance(acceptance.id, 'passed', {
    reviewer: 'human:ft54482',
  });
  assert.equal(decided.state, 'passed');
  assert.ok(Number(decided.decided_at) > 0);

  const cost = store.recordCost({
    task_id: goal.id,
    run_id: run.id,
    kind: 'llm',
    tokens_in: 10,
    tokens_out: 20,
    cost_cny: 0.5,
  });
  assert.equal(store.listCosts(goal.id)[0].id, cost.id);

  const outbox = store.enqueueOutbox({
    task_id: goal.id,
    run_id: run.id,
    principal_ref: 'bot:chief',
    intent: 'dispatch_run',
    payload: { run_id: run.id },
    idempotency_key: 'outbox-once',
  });
  assert.equal(outbox.state, 'pending');
  assert.equal(store.getOutbox(outbox.id).payload_json, JSON.stringify({ run_id: run.id }));

  const first = store.appendInboxEvent({
    source: 'dsh',
    event_key: 'dsh|session-1|1|run.completed',
    source_seq: 1,
    type: 'run.completed',
    payload: { ok: true },
  });
  assert.equal(first.inserted, true);
  const duplicate = store.appendInboxEvent({
    source: 'dsh',
    event_key: 'dsh|session-1|1|run.completed',
    source_seq: 1,
    type: 'run.completed',
    payload: { ok: true },
  });
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.event.id, first.event.id);

  store.advanceWatermark('dsh', 10);
  const watermark = store.advanceWatermark('dsh', 4);
  assert.equal(Number(watermark.last_seq), 10);
});

test('a reopened database keeps tasks and events', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-store-'));
  const path = join(dir, 'control.sqlite');

  const first = openStore({ path });
  goalTask(first, { id: 'task-persist' });
  first.updateTaskState('task-persist', 'queued', { actor: 'system:test' });
  first.close();

  const second = openStore({ path });
  t.after(() => {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(second.getTask('task-persist').state, 'queued');
  assert.equal(second.listTaskEvents('task-persist').length, 1);
});
