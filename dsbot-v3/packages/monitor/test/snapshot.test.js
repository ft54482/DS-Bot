import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

test('returns the documented shape for an empty runtime', () => {
  const snapshot = buildSnapshot({ runtime: {}, now: NOW });

  assert.deepEqual(Object.keys(snapshot), [
    'generated_at',
    'tasks',
    'stuck',
    'pending_decision',
    'budget',
  ]);
  assert.equal(snapshot.generated_at, new Date(NOW).toISOString());
  assert.deepEqual(snapshot.tasks, []);
  assert.deepEqual(snapshot.stuck, []);
  assert.deepEqual(snapshot.pending_decision, []);
  assert.deepEqual(snapshot.budget, { spent: 0, cap: null });
});

test('projects each task onto exactly id, level, state, owner and cost', () => {
  const runtime = {
    tasks: [
      {
        id: 'task-goal',
        level: 'goal',
        state: 'running',
        owner_ref: 'bot:chief',
        cost_cny: 1.23456,
      },
      {
        id: 'task-biz',
        level: 'business',
        state: 'accepting',
        owner: 'bot:content',
        cost: 2,
      },
    ],
    now: NOW,
  };

  const snapshot = buildSnapshot({ runtime, now: NOW });

  assert.deepEqual(snapshot.tasks, [
    {
      id: 'task-goal',
      level: 'goal',
      state: 'running',
      owner: 'bot:chief',
      cost: 1.2346,
    },
    {
      id: 'task-biz',
      level: 'business',
      state: 'accepting',
      owner: 'bot:content',
      cost: 2,
    },
  ]);
  for (const task of snapshot.tasks) {
    assert.deepEqual(Object.keys(task), ['id', 'level', 'state', 'owner', 'cost']);
  }
});

test('accepts common snake_case and camelCase aliases', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [
        {
          task_id: 'task-alias',
          task_level: 'execution',
          status: 'queued',
          ownerRef: 'bot:video',
          costCny: 3.5,
        },
      ],
    },
    now: NOW,
  });

  assert.deepEqual(snapshot.tasks, [
    {
      id: 'task-alias',
      level: 'execution',
      state: 'queued',
      owner: 'bot:video',
      cost: 3.5,
    },
  ]);
});

test('accepts an id-keyed task object', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: {
        'task-map': { level: 'business', state: 'running', owner_ref: 'bot:content' },
      },
    },
    now: NOW,
  });

  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].id, 'task-map');
});

test('injects the clock as epoch milliseconds, ISO string, Date or function', () => {
  const variants = [
    NOW,
    new Date(NOW),
    new Date(NOW).toISOString(),
    () => NOW,
  ];

  for (const now of variants) {
    assert.equal(
      buildSnapshot({ runtime: {}, now }).generated_at,
      new Date(NOW).toISOString(),
    );
  }

  assert.equal(
    buildSnapshot({ runtime: { now: () => NOW } }).generated_at,
    new Date(NOW).toISOString(),
  );
});

test('rejects invalid input instead of returning a misleading snapshot', () => {
  assert.throws(() => buildSnapshot({}), /runtime object/);
  assert.throws(() => buildSnapshot({ runtime: [] }), /runtime object/);
  assert.throws(
    () => buildSnapshot({ runtime: {}, now: 'not-a-date' }),
    /valid `now`/,
  );
  assert.throws(
    () => buildSnapshot({ runtime: { tasks: [{}] } }),
    /id is required/,
  );
  assert.throws(
    () => buildSnapshot({ runtime: { tasks: [{ id: 'task-1' }, { id: 'task-1' }] } }),
    /duplicate id/,
  );
});

test('does not read the ambient clock when now is injected', () => {
  const originalNow = Date.now;
  Date.now = () => {
    throw new Error('ambient clock must not be used');
  };

  try {
    const snapshot = buildSnapshot({
      runtime: {
        tasks: [
          {
            id: 'task-old',
            level: 'business',
            state: 'accepting',
            accepting_since: NOW - 25 * HOUR,
          },
        ],
      },
      now: NOW,
    });
    assert.equal(snapshot.generated_at, new Date(NOW).toISOString());
    assert.equal(snapshot.stuck.length, 1);
  } finally {
    Date.now = originalNow;
  }
});

test('is deterministic and does not mutate the runtime view', () => {
  const runtime = deepFreeze({
    tasks: [
      {
        id: 'task-1',
        level: 'business',
        state: 'accepting',
        owner_ref: 'bot:content',
        state_entered_at: NOW - 25 * HOUR,
        cost_cny: 1.5,
      },
    ],
    runs: [
      { id: 'run-1', task_id: 'task-1', run_no: 1, state: 'rejected' },
    ],
    escalations: [
      { id: 'esc-1', task_id: 'task-1', kind: 'budget', state: 'open' },
    ],
    cost_ledger: [
      { task_id: 'task-1', cost_cny: 1.5 },
    ],
    budget: { spent: 1.5, cap: 10 },
  });
  const before = JSON.stringify(runtime);

  const first = buildSnapshot({ runtime, now: NOW });
  const second = buildSnapshot({ runtime, now: NOW });

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(runtime), before);
});

test('output is JSON-serializable', () => {
  const snapshot = buildSnapshot({
    runtime: {
      tasks: [
        {
          id: 'task-1',
          level: 'execution',
          state: 'blocked',
          owner_ref: 'bot:content',
          blocked_reason: 'budget',
        },
      ],
    },
    now: NOW,
  });

  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snapshot)));
  assert.equal(snapshot.stuck[0].reason, 'blocked_not_escalated');
});

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
