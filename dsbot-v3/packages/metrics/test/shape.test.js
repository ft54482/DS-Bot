import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 21, 0, 0, 0);
const BASE = Date.UTC(2026, 10, 20, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function fixture() {
  return {
    tasks: [
      {
        id: 'task-1',
        level: 'execution',
        state: 'completed',
        created_at: BASE,
        accepted_at: BASE + 2 * HOUR,
      },
      {
        id: 'task-2',
        level: 'execution',
        state: 'completed',
        created_at: BASE,
        accepted_at: BASE + 4 * HOUR,
      },
      {
        id: 'task-3',
        level: 'execution',
        state: 'running',
        created_at: BASE,
      },
    ],
    runs: [
      { id: 'run-1', task_id: 'task-1', run_no: 1, kind: 'initial', cost_cny: 2 },
      { id: 'run-2', task_id: 'task-1', run_no: 2, kind: 'rework', cost_cny: 3 },
      { id: 'run-3', task_id: 'task-2', run_no: 1, kind: 'initial', cost_cny: 5 },
    ],
    acceptances: [
      {
        id: 'acc-1',
        target_task_id: 'task-1',
        stage: 'execution',
        state: 'passed',
        mode: 'human',
        decided_at: BASE + 2 * HOUR,
      },
      {
        id: 'acc-2',
        target_task_id: 'task-2',
        stage: 'execution',
        state: 'passed',
        mode: 'auto',
        decided_at: BASE + 4 * HOUR,
      },
    ],
    costs: [],
  };
}

test('returns the documented five-key shape for empty input', () => {
  const metrics = computeMetrics({ tasks: [], runs: [], acceptances: [], costs: [], clock: () => NOW });

  assert.deepEqual(Object.keys(metrics), [
    'cost_per_accepted_task',
    'lead_time',
    'rework_rounds',
    'interventions',
    'totals',
  ]);
  assert.equal(metrics.cost_per_accepted_task, null);
  assert.deepEqual(metrics.lead_time, {
    median_hours: null,
    p90_hours: null,
    samples: 0,
    missing: 0,
  });
  assert.equal(metrics.rework_rounds, null);
  assert.equal(metrics.interventions, null);
  assert.equal(metrics.totals.accepted_tasks, 0);
  assert.equal(metrics.totals.tasks, 0);
  assert.equal(metrics.totals.cost_cny, 0);
  assert.equal(metrics.totals.interventions, 0);
  assert.equal(metrics.totals.data_complete, true);
  assert.equal(metrics.totals.generated_at, new Date(NOW).toISOString());
});

test('computes cost, lead time, rework rounds and interventions per accepted task', () => {
  const metrics = computeMetrics({ ...fixture(), clock: () => NOW });

  assert.equal(metrics.cost_per_accepted_task, 5);
  assert.deepEqual(metrics.lead_time, {
    median_hours: 3,
    p90_hours: 4,
    samples: 2,
    missing: 0,
  });
  assert.equal(metrics.rework_rounds, 0.5);
  assert.equal(metrics.interventions, 0.5);

  assert.equal(metrics.totals.tasks, 3);
  assert.equal(metrics.totals.accepted_tasks, 2);
  assert.equal(metrics.totals.runs, 3);
  assert.equal(metrics.totals.accepted_runs, 3);
  assert.equal(metrics.totals.rework_runs, 1);
  assert.equal(metrics.totals.accepted_rework_runs, 1);
  assert.equal(metrics.totals.cost_cny, 10);
  assert.equal(metrics.totals.known_cost_cny, 10);
  assert.equal(metrics.totals.interventions, 1);
  assert.deepEqual(metrics.totals.missing, {
    cost: 0,
    lead_time: 0,
    rework: 0,
    interventions: 0,
  });
  assert.equal(metrics.totals.data_complete, true);
  assert.equal(metrics.totals.generated_at, new Date(NOW).toISOString());
});

test('accepts a missing input object and reports empty totals deterministically', () => {
  const metrics = computeMetrics({ clock: NOW });
  assert.equal(metrics.cost_per_accepted_task, null);
  assert.equal(metrics.totals.accepted_tasks, 0);
  assert.equal(metrics.totals.generated_at, new Date(NOW).toISOString());
});
