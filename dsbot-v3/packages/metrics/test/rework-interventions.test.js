import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 21, 0, 0, 0);
const BASE = Date.UTC(2026, 10, 20, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function acceptedTask(id) {
  return {
    id,
    level: 'execution',
    state: 'completed',
    created_at: BASE,
    accepted_at: BASE + 2 * HOUR,
  };
}

test('counts rework runs explicitly and by run_no/attempt inference', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask('t1')],
    runs: [
      { id: 'r1', task_id: 't1', run_no: 1, kind: 'initial', cost_cny: 0 },
      { id: 'r2', task_id: 't1', run_no: 2, cost_cny: 0 },
      { id: 'r3', task_id: 't1', run_no: 2, attempt: 2, cost_cny: 0 },
      { id: 'r4', task_id: 't1', run_no: 1, kind: 'retry', cost_cny: 0 },
      { id: 'r5', task_id: 't1', run_no: 3, kind: 'rework', cost_cny: 0 },
    ],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.totals.rework_runs, 2);
  assert.equal(metrics.totals.accepted_rework_runs, 2);
  assert.equal(metrics.rework_rounds, 2);
});

test('returns null rework rounds when no run exists for accepted tasks', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask('t1')],
    runs: [],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.rework_rounds, null);
  assert.equal(metrics.totals.missing.rework, 1);
});

test('counts human acceptance decisions as interventions and auto decisions as zero', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask('t1'), acceptedTask('t2')],
    runs: [],
    acceptances: [
      { id: 'a1', task_id: 't1', stage: 'execution', state: 'passed', mode: 'human' },
      { id: 'a2', task_id: 't2', stage: 'execution', state: 'passed', mode: 'auto' },
    ],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.interventions, 0.5);
  assert.equal(metrics.totals.interventions, 1);
  assert.equal(metrics.totals.missing.interventions, 0);
});

test('uses task-level intervention counts when present', () => {
  const metrics = computeMetrics({
    tasks: [{ ...acceptedTask('t1'), intervention_count: 2 }],
    runs: [],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.interventions, 2);
  assert.equal(metrics.totals.interventions, 2);
});

test('returns null interventions when the inputs contain no intervention evidence', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask('t1')],
    runs: [],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.interventions, null);
  assert.equal(metrics.totals.interventions, null);
  assert.equal(metrics.totals.missing.interventions, 1);
});

test('explicit interventions win, are deduplicated by id, and are scoped to accepted tasks', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask('t1'), acceptedTask('t2')],
    runs: [],
    acceptances: [
      { id: 'a1', task_id: 't1', stage: 'execution', state: 'passed', mode: 'human' },
    ],
    costs: [],
    interventions: [
      { id: 'i1', task_id: 't1' },
      { id: 'i1', task_id: 't1' },
      { id: 'i2', task_id: 't2' },
      { id: 'i3', task_id: 'not-accepted' },
    ],
    clock: NOW,
  });

  assert.equal(metrics.interventions, 1);
  assert.equal(metrics.totals.interventions, 2);
});

test('an explicitly empty interventions list proves zero interventions', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask('t1')],
    runs: [],
    costs: [],
    interventions: [],
    clock: NOW,
  });

  assert.equal(metrics.interventions, 0);
  assert.equal(metrics.totals.interventions, 0);
  assert.equal(metrics.totals.missing.interventions, 0);
});

test('does not count interventions from tasks outside the accepted scope', () => {
  const metrics = computeMetrics({
    tasks: [acceptedTask('t1'), { ...acceptedTask('t2'), state: 'running', accepted_at: null }],
    runs: [],
    costs: [],
    interventions: [
      { id: 'i1', task_id: 't1' },
      { id: 'i2', task_id: 't2' },
    ],
    clock: NOW,
  });

  assert.equal(metrics.interventions, 1);
  assert.equal(metrics.totals.interventions, 1);
});
