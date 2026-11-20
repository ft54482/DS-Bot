import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 21, 0, 0, 0);
const BASE = Date.UTC(2026, 10, 20, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function acceptedTask(overrides = {}) {
  return {
    id: 'task-1',
    level: 'execution',
    state: 'completed',
    created_at: BASE,
    accepted_at: BASE + 2 * HOUR,
    ...overrides,
  };
}

test('sums cost per run and lets ledger rows win over a run cost fallback', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask()],
    runs: [
      { id: 'run-1', task_id: 'task-1', run_no: 1, kind: 'initial', cost_cny: 99 },
      { id: 'run-2', task_id: 'task-1', run_no: 2, kind: 'rework', cost_cny: 99 },
    ],
    costs: [
      { run_id: 'run-1', cost_cny: 1.5 },
      { run_id: 'run-1', cost_cny: 0.5 },
      { run_id: 'run-2', cost_cny: 3 },
    ],
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, 5);
  assert.equal(metrics.totals.cost_cny, 5);
  assert.equal(metrics.totals.known_cost_cny, 5);
  assert.equal(metrics.totals.missing.cost, 0);
});

test('uses an explicit zero cost as zero, not as missing data', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask()],
    runs: [{ id: 'run-1', task_id: 'task-1', run_no: 1, kind: 'initial', cost_cny: 0 }],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, 0);
  assert.equal(metrics.totals.cost_cny, 0);
  assert.equal(metrics.totals.missing.cost, 0);
});

test('returns null cost per accepted task when an accepted task has no cost data', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask()],
    runs: [],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, null);
  assert.equal(metrics.totals.cost_cny, null);
  assert.equal(metrics.totals.known_cost_cny, 0);
  assert.equal(metrics.totals.missing.cost, 1);
  assert.equal(metrics.totals.data_complete, false);
});

test('returns null cost when a run has no reported cost', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask()],
    runs: [{ id: 'run-1', task_id: 'task-1', run_no: 1, kind: 'initial' }],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, null);
  assert.equal(metrics.totals.missing.cost, 1);
});

test('treats a negative or malformed ledger amount as missing, never as negative spend', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask()],
    runs: [{ id: 'run-1', task_id: 'task-1', run_no: 1, kind: 'initial' }],
    costs: [
      { run_id: 'run-1', cost_cny: 2 },
      { run_id: 'run-1', cost_cny: -1 },
    ],
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, null);
  assert.equal(metrics.totals.known_cost_cny, 2);
  assert.equal(metrics.totals.missing.cost, 1);
});

test('rolls descendant run cost into an accepted parent task', () => {
  const metrics = computeMetrics({
    tasks: [
      {
        id: 'task-goal',
        level: 'goal',
        state: 'completed',
        created_at: BASE,
        accepted_at: BASE + 3 * HOUR,
      },
      { id: 'task-biz', level: 'business', parent_task_id: 'task-goal', state: 'running' },
      { id: 'task-exec', level: 'execution', parent_task_id: 'task-biz', state: 'running' },
    ],
    runs: [{ id: 'run-1', task_id: 'task-exec', run_no: 1, kind: 'initial', cost_cny: 10 }],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.totals.accepted_tasks, 1);
  assert.equal(metrics.cost_per_accepted_task, 10);
  assert.equal(metrics.totals.accepted_runs, 1);
});

test('supports task-level ledger rows that are not tied to a run', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask()],
    runs: [],
    costs: [{ task_id: 'task-1', kind: 'acceptance', cost_cny: 2.25 }],
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, 2.25);
  assert.equal(metrics.totals.missing.cost, 0);
});

test('supports a costs object keyed by run id', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask()],
    runs: [{ id: 'run-1', task_id: 'task-1', run_no: 1, kind: 'initial' }],
    costs: { 'run-1': 1.75 },
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, 1.75);
});

test('ignores cost on tasks that were never accepted', () => {
  const metrics = computeMetrics({
    tasks: [
      acceptedTask({ id: 'task-1' }),
      { id: 'task-2', level: 'execution', state: 'failed', created_at: BASE },
    ],
    runs: [
      { id: 'run-1', task_id: 'task-1', run_no: 1, kind: 'initial', cost_cny: 2 },
      { id: 'run-2', task_id: 'task-2', run_no: 1, kind: 'initial', cost_cny: 100 },
    ],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, 2);
  assert.equal(metrics.totals.accepted_runs, 1);
});
