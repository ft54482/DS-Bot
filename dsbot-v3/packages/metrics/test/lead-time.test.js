import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 21, 0, 0, 0);
const BASE = Date.UTC(2026, 10, 20, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

test('accepts a task whose own-level acceptance passed even when task state lags', () => {
  const metrics = computeMetrics({
    tasks: [{ id: 'task-1', level: 'execution', state: 'running', created_at: BASE }],
    runs: [],
    acceptances: [
      {
        id: 'acc-1',
        target_task_id: 'task-1',
        stage: 'execution',
        state: 'passed',
        mode: 'auto',
        decided_at: BASE + 2 * HOUR,
      },
    ],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.totals.accepted_tasks, 1);
  assert.equal(metrics.lead_time.median_hours, 2);
  assert.equal(metrics.lead_time.p90_hours, 2);
  assert.equal(metrics.lead_time.samples, 1);
});

test('ignores an acceptance for a different level', () => {
  const metrics = computeMetrics({
    tasks: [{ id: 'task-1', level: 'execution', state: 'running', created_at: BASE }],
    runs: [],
    acceptances: [
      {
        id: 'acc-1',
        target_task_id: 'task-1',
        stage: 'business',
        state: 'passed',
        mode: 'auto',
        decided_at: BASE + 2 * HOUR,
      },
    ],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.totals.accepted_tasks, 0);
  assert.equal(metrics.lead_time.median_hours, null);
});

test('reports median and nearest-rank P90 in hours', () => {
  const metrics = computeMetrics({
    tasks: [
      { id: 't1', level: 'execution', state: 'completed', created_at: BASE, accepted_at: BASE + 1 * HOUR },
      { id: 't2', level: 'execution', state: 'completed', created_at: BASE, accepted_at: BASE + 2 * HOUR },
      { id: 't3', level: 'execution', state: 'completed', created_at: BASE, accepted_at: BASE + 10 * HOUR },
    ],
    runs: [],
    costs: [],
    clock: NOW,
  });

  assert.deepEqual(metrics.lead_time, {
    median_hours: 2,
    p90_hours: 10,
    samples: 3,
    missing: 0,
  });
});

test('keeps accepted tasks with missing or invalid times out of the distribution', () => {
  const metrics = computeMetrics({
    tasks: [
      { id: 't1', level: 'execution', state: 'completed', created_at: BASE, accepted_at: BASE + 2 * HOUR },
      { id: 't2', level: 'execution', state: 'completed', created_at: BASE },
      { id: 't3', level: 'execution', state: 'completed', created_at: BASE + 5 * HOUR, accepted_at: BASE + 1 * HOUR },
    ],
    runs: [],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.totals.accepted_tasks, 3);
  assert.deepEqual(metrics.lead_time, {
    median_hours: 2,
    p90_hours: 2,
    samples: 1,
    missing: 2,
  });
  assert.equal(metrics.totals.missing.lead_time, 2);
  assert.equal(metrics.totals.data_complete, false);
});

test('parses ISO-8601 timestamps', () => {
  const metrics = computeMetrics({
    tasks: [
      {
        id: 't1',
        level: 'execution',
        state: 'completed',
        created_at: new Date(BASE).toISOString(),
        accepted_at: new Date(BASE + 90 * 60 * 1000).toISOString(),
      },
    ],
    runs: [],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.lead_time.median_hours, 1.5);
});
