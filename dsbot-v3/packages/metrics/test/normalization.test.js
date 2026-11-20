import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 21, 0, 0, 0);
const BASE = Date.UTC(2026, 10, 20, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

test('accepts camelCase aliases and id-keyed objects', () => {
  const metrics = computeMetrics({
    tasks: {
      t1: {
        taskLevel: 'execution',
        status: 'completed',
        createdAt: new Date(BASE).toISOString(),
        acceptedAt: new Date(BASE + 2 * HOUR).toISOString(),
      },
    },
    runs: {
      r1: { taskId: 't1', runNo: 1, kind: 'initial', costCny: 4 },
    },
    acceptances: {
      a1: {
        targetTaskId: 't1',
        stage: 'execution',
        verdict: 'pass',
        mode: 'human',
        decidedAt: new Date(BASE + 2 * HOUR).toISOString(),
      },
    },
    costs: [{ runId: 'r1', costCny: 4 }],
    interventions: [{ taskId: 't1' }, { taskId: 't1' }],
    clock: NOW,
  });

  assert.equal(metrics.cost_per_accepted_task, 4);
  assert.equal(metrics.lead_time.median_hours, 2);
  assert.equal(metrics.rework_rounds, 0);
  assert.equal(metrics.interventions, 2);
  assert.equal(metrics.totals.interventions, 2);
});

test('uses verdict pass with an acceptance decided_at when task state is still running', () => {
  const metrics = computeMetrics({
    tasks: [{ task_id: 't1', level: 'execution', state: 'running', created_at: BASE }],
    runs: [],
    acceptances: [
      {
        target_task_id: 't1',
        stage: 'execution',
        verdict: 'pass',
        decided_at: BASE + 3 * HOUR,
      },
    ],
    costs: [],
    clock: NOW,
  });

  assert.equal(metrics.totals.accepted_tasks, 1);
  assert.equal(metrics.lead_time.median_hours, 3);
});

test('does not mutate its input and is deterministic for a fixed clock', () => {
  const input = deepFreeze({
    tasks: [
      {
        id: 't1',
        level: 'execution',
        state: 'completed',
        created_at: BASE,
        accepted_at: BASE + HOUR,
      },
    ],
    runs: [{ id: 'r1', task_id: 't1', run_no: 1, kind: 'initial', cost_cny: 2 }],
    acceptances: [],
    costs: [],
  });
  const before = JSON.stringify(input);

  const first = computeMetrics({ ...input, clock: () => NOW });
  const second = computeMetrics({ ...input, clock: () => NOW });

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
});

test('accepts epoch milliseconds, ISO strings, Date and a clock function', () => {
  const variants = [NOW, new Date(NOW).toISOString(), new Date(NOW), () => NOW];
  for (const clock of variants) {
    const metrics = computeMetrics({ clock });
    assert.equal(metrics.totals.generated_at, new Date(NOW).toISOString());
  }
});

test('rejects an invalid clock instead of silently using the ambient clock', () => {
  assert.throws(() => computeMetrics({ clock: 'not-a-time' }), TypeError);
});

test('rejects duplicate task ids', () => {
  assert.throws(
    () =>
      computeMetrics({
        tasks: [
          { id: 't1', state: 'completed' },
          { id: 't1', state: 'completed' },
        ],
        clock: NOW,
      }),
    TypeError,
  );
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
