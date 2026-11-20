import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

test('pending decisions are open escalations sorted oldest first', () => {
  const snapshot = buildSnapshot({
    runtime: {
      escalations: [
        {
          id: 'esc-new',
          task_id: 'task-2',
          kind: 'direction',
          detail: 'Choose a direction.',
          state: 'open',
          created_at: NOW - 1000,
        },
        {
          id: 'esc-old',
          task_id: 'task-1',
          kind: 'budget',
          detail: 'Raise the cap?',
          state: 'open',
          created_at: NOW - 5000,
        },
        {
          id: 'esc-closed',
          task_id: 'task-3',
          kind: 'quality',
          detail: 'Already handled.',
          state: 'closed',
          created_at: NOW - 9000,
        },
      ],
    },
    now: NOW,
  });

  assert.deepEqual(
    snapshot.pending_decision.map((entry) => entry.id),
    ['esc-old', 'esc-new'],
  );
  assert.deepEqual(Object.keys(snapshot.pending_decision[0]), [
    'id',
    'escalation_id',
    'kind',
    'task_id',
    'summary',
    'evidence',
  ]);
  assert.equal(snapshot.pending_decision[0].kind, 'budget');
  assert.equal(snapshot.pending_decision[0].task_id, 'task-1');
  assert.equal(snapshot.pending_decision[0].summary, 'Raise the cap?');
  assert.equal(snapshot.pending_decision[0].evidence.type, 'escalation');
  assert.equal(snapshot.pending_decision[0].evidence.ref, 'escalation:esc-old');
});

test('answered escalations are not pending decisions', () => {
  const snapshot = buildSnapshot({
    runtime: {
      escalations: [
        {
          id: 'esc-answered',
          task_id: 'task-1',
          kind: 'blocked',
          state: 'open',
          answered_at: NOW - 1000,
        },
      ],
    },
    now: NOW,
  });

  assert.deepEqual(snapshot.pending_decision, []);
});

test('unanswered interventions are pending decisions', () => {
  const snapshot = buildSnapshot({
    runtime: {
      user_interventions: [
        {
          id: 'int-open',
          task_id: 'task-1',
          question: 'Is this allowed?',
          asked_at: NOW - 1000,
        },
        {
          id: 'int-answered',
          task_id: 'task-2',
          question: 'Already answered?',
          answer: 'Yes.',
          asked_at: NOW - 2000,
        },
      ],
    },
    now: NOW,
  });

  assert.equal(snapshot.pending_decision.length, 1);
  const [entry] = snapshot.pending_decision;
  assert.equal(entry.id, 'int-open');
  assert.equal(entry.intervention_id, 'int-open');
  assert.equal(entry.kind, 'intervention');
  assert.equal(entry.summary, 'Is this allowed?');
  assert.equal(entry.evidence.type, 'intervention');
});

test('budget uses explicit spent and cap when provided', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [{ id: 'task-1', level: 'execution', state: 'running', cost_cny: 9 }],
      budget: { spent: 12.34567, cap: 100 },
    },
    now: NOW,
  });

  assert.deepEqual(snapshot.budget, { spent: 12.3457, cap: 100 });
});

test('budget derives spent from cost_ledger and per-task costs from it', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [
        { id: 'task-1', level: 'execution', state: 'running' },
        { id: 'task-2', level: 'execution', state: 'accepting' },
      ],
      cost_ledger: [
        { task_id: 'task-1', cost_cny: 1.23456 },
        { task_id: 'task-2', cost_cny: 2 },
        { task_id: 'task-1', cost_cny: -0.5 },
      ],
    },
    now: NOW,
  });

  assert.deepEqual(snapshot.budget, { spent: 2.7346, cap: null });
  assert.equal(snapshot.tasks[0].cost, 0.7346);
  assert.equal(snapshot.tasks[1].cost, 2);
});

test('budget derives spent from task costs when no ledger is present', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [
        { id: 'task-1', level: 'goal', state: 'running', cost_cny: 1.1 },
        { id: 'task-2', level: 'business', state: 'running', cost_cny: 2.2 },
      ],
    },
    now: NOW,
  });

  assert.deepEqual(snapshot.budget, { spent: 3.3, cap: null });
});

test('budget cap is null when the runtime supplies no scope cap', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [
        {
          id: 'task-1',
          level: 'business',
          state: 'running',
          cost_cny: 1,
          budget_cny_cap: 10,
        },
        {
          id: 'task-2',
          level: 'execution',
          state: 'running',
          cost_cny: 2,
          budget: { cap: 5 },
        },
        {
          id: 'task-3',
          level: 'execution',
          state: 'running',
          cost_cny: 3,
        },
      ],
    },
    now: NOW,
  });

  assert.deepEqual(snapshot.budget, { spent: 6, cap: null });
});

test('budget accepts a numeric cap and alias keys', () => {
  const numeric = buildSnapshot({
    runtime: { budget: 50, tasks: [{ id: 't', level: 'goal', state: 'running' }] },
    now: NOW,
  });
  assert.deepEqual(numeric.budget, { spent: 0, cap: 50 });

  const alias = buildSnapshot({
    runtime: {
      budget_cny_cap: 75,
      tasks: [{ id: 't', level: 'goal', state: 'running' }],
    },
    now: NOW,
  });
  assert.deepEqual(alias.budget, { spent: 0, cap: 75 });
});

test('budget accepts a task-id cost map', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [
        { id: 'task-1', level: 'execution', state: 'running' },
        { id: 'task-2', level: 'execution', state: 'running' },
      ],
      costs: { 'task-1': 1.5, 'task-2': '2.5' },
    },
    now: NOW,
  });

  assert.deepEqual(snapshot.budget, { spent: 4, cap: null });
  assert.equal(snapshot.tasks[0].cost, 1.5);
  assert.equal(snapshot.tasks[1].cost, 2.5);
});

test('cost_ledger wins over the costs shorthand to avoid double counting', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [{ id: 'task-1', level: 'execution', state: 'running' }],
      cost_ledger: [{ task_id: 'task-1', cost_cny: 3 }],
      costs: { 'task-1': 3 },
    },
    now: NOW,
  });

  assert.deepEqual(snapshot.budget, { spent: 3, cap: null });
});

test('an explicit task cost wins over the ledger for the task view', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [
        {
          id: 'task-1',
          level: 'execution',
          state: 'running',
          cost_cny: 7,
        },
      ],
      cost_ledger: [{ task_id: 'task-1', cost_cny: 1 }],
    },
    now: NOW,
  });

  assert.equal(snapshot.tasks[0].cost, 7);
  assert.deepEqual(snapshot.budget, { spent: 1, cap: null });
});
