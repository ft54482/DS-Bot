import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextPack,
  DEFAULT_BUDGETS,
  drilldownRef,
  estimateTokens,
  HARD_CAPS,
  LEVELS,
  measurePack,
  resolveBudget,
} from '../src/index.js';
import {
  COUNT,
  makeQuestions,
  makeRecent,
  makeTask,
} from './helpers.js';

test('returns exactly the five contract keys for every level', () => {
  for (const level of LEVELS) {
    const pack = buildContextPack({
      level,
      task: makeTask({ level }),
      recent: makeRecent(2),
      open_questions: makeQuestions(),
      budgets: level === 'execution' ? { execution: 100_000 } : {},
      countTokens: COUNT,
    });

    assert.deepEqual(Object.keys(pack).sort(), [
      'identity',
      'open_questions',
      'pointers',
      'recent',
      'task_pack',
    ]);
    assert.equal(pack.identity.level, level);
    assert.equal(pack.task_pack.level, level);
    assert.equal(pack.task_pack.task_id, 'task-biz-1');
    assert.equal(pack.task_pack.goal, 'Ship the level-aware context pack');
    assert.ok(pack.pointers.some((pointer) => pointer.kind === 'task'));
    assert.equal(pack.open_questions.length, 2);
  }
});

test('identity carries the layer role and visibility labels', () => {
  const goal = buildContextPack({
    level: 'goal',
    task: makeTask(),
    budgets: {},
    countTokens: COUNT,
  });
  assert.equal(goal.identity.role, 'chief');
  assert.equal(goal.identity.principal, 'bot:content');
  assert.deepEqual(goal.identity.visible, [
    'goal_task',
    'business_reports',
    'pending_decisions',
    'recent_dialogue',
  ]);
  assert.ok(goal.identity.hidden.includes('execution_logs'));

  const business = buildContextPack({
    level: 'business',
    task: makeTask(),
    budgets: {},
    countTokens: COUNT,
  });
  assert.equal(business.identity.role, 'business_bot');
  assert.equal(business.identity.scope.bot_scope, 'bot:content');
  assert.deepEqual(business.identity.scope.projects, ['superagent-lab']);

  const execution = buildContextPack({
    level: 'execution',
    task: makeTask(),
    budgets: { execution: 100_000 },
    countTokens: COUNT,
  });
  assert.equal(execution.identity.role, 'executor');
  assert.ok(execution.identity.visible.includes('baseline_sha'));
});

test('task pack keeps the service-owned contract fields', () => {
  const pack = buildContextPack({
    level: 'business',
    task: makeTask(),
    budgets: {},
    countTokens: COUNT,
  });
  const taskPack = pack.task_pack;

  assert.equal(taskPack.base_sha, 'a'.repeat(40));
  assert.deepEqual(taskPack.scope.allowed_paths, ['packages/context/**']);
  assert.deepEqual(taskPack.scope.forbidden_paths, ['docs/prd/**']);
  assert.equal(taskPack.acceptance.stage, 'business');
  assert.equal(taskPack.acceptance.criteria.length, 2);
  assert.equal(taskPack.idempotency_key, 'idem-1');
  assert.deepEqual(taskPack.stop_conditions, [
    'budget exceeded',
    'hard rule violation',
  ]);
  assert.deepEqual(taskPack.conclusions, [
    'Level-aware assembly implemented.',
  ]);
  assert.equal(taskPack.outcome, 'done');
  assert.equal(taskPack.latest_run.run_id, 'run-1');
  assert.equal(taskPack.latest_run.summary, 'tests pass');
  assert.equal(taskPack.latest_acceptance.result, 'passed');
});

test('goal and business budgets are clamped to the PRD hard caps', () => {
  assert.equal(DEFAULT_BUDGETS.goal, 60_000);
  assert.equal(DEFAULT_BUDGETS.business, 80_000);
  assert.equal(HARD_CAPS.goal, 60_000);
  assert.equal(HARD_CAPS.business, 80_000);

  assert.deepEqual(resolveBudget('goal', { goal: 100_000 }), {
    level: 'goal',
    limit: 60_000,
    requested: 100_000,
    capped: true,
  });
  assert.equal(resolveBudget('business', { business: 90_000 }).limit, 80_000);
  assert.equal(resolveBudget('business', { business: 1_000 }).limit, 1_000);
  assert.equal(resolveBudget('execution', { executor: 50_000 }).limit, 50_000);
  assert.equal(
    resolveBudget('execution', { execution: null, executor: 50_000 }).limit,
    50_000,
  );
  assert.equal(resolveBudget('execution', 50_000).limit, 50_000);
});

test('goal-level assembly trims a 70k recent turn back under 60k', () => {
  const countBytes = (text) => text.length;
  const pack = buildContextPack({
    level: 'goal',
    task: makeTask({ level: 'goal' }),
    recent: [{ role: 'user', text: 'x'.repeat(70_000) }],
    budgets: { goal: 100_000 },
    countTokens: countBytes,
  });

  assert.equal(pack.recent.length, 0);
  assert.ok(measurePack(pack, countBytes) <= 60_000);
});

test('business-level assembly trims a 90k recent turn back under 80k', () => {
  const countBytes = (text) => text.length;
  const pack = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: [{ role: 'user', text: 'y'.repeat(90_000) }],
    budgets: { business: 100_000 },
    countTokens: countBytes,
  });

  assert.equal(pack.recent.length, 0);
  assert.ok(measurePack(pack, countBytes) <= 80_000);
});

test('execution budget comes from configuration', () => {
  const countBytes = (text) => text.length;
  const pack = buildContextPack({
    level: 'execution',
    task: makeTask(),
    recent: [{ role: 'user', text: 'z'.repeat(90_000) }],
    budgets: { execution: 100_000 },
    countTokens: countBytes,
  });
  assert.equal(pack.recent.length, 1);
  assert.ok(measurePack(pack, countBytes) <= 100_000);

  assert.throws(
    () =>
      buildContextPack({
        level: 'execution',
        task: makeTask(),
        budgets: {},
      }),
    /execution contexts have no PRD-wide cap/,
  );

  assert.equal(
    buildContextPack({
      level: 'execution',
      task: makeTask(),
      budgets: 100_000,
      countTokens: COUNT,
    }).identity.level,
    'execution',
  );
});

test('open questions drop closed entries and fall back to task fields', () => {
  const pack = buildContextPack({
    level: 'business',
    task: makeTask({
      open_questions: [
        { id: 'q-1', question: 'Open?', state: 'open', options: ['a', 'b'] },
        { id: 'q-2', question: 'Closed?', state: 'resolved' },
      ],
    }),
    budgets: {},
    countTokens: COUNT,
  });

  assert.deepEqual(pack.open_questions, [
    { question: 'Open?', id: 'q-1', options: ['a', 'b'] },
  ]);

  const fromNeedsDecision = buildContextPack({
    level: 'goal',
    task: makeTask({
      needs_decision: [
        { question: 'Approve?', options: ['yes', 'no'] },
        { question: 'Old?', state: 'done' },
      ],
    }),
    budgets: {},
    countTokens: COUNT,
  });
  assert.equal(fromNeedsDecision.open_questions.length, 1);
  assert.equal(fromNeedsDecision.open_questions[0].question, 'Approve?');
});

test('recent dialogue is normalized to role/text/at/id only', () => {
  const single = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: { role: 'user', text: 'single turn', raw_log: 'RAW LOG' },
    budgets: {},
    countTokens: COUNT,
  });
  assert.deepEqual(single.recent, [{ role: 'user', text: 'single turn' }]);

  const pack = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: {
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          content: 'conclusion only',
          at: '2026-11-20T15:00:00.000Z',
          raw_log: 'RAW LOG',
          tool_calls: [{ name: 'secret' }],
        },
        'plain message',
        { role: 'user', text: '   ' },
      ],
    },
    budgets: {},
    countTokens: COUNT,
  });

  assert.deepEqual(pack.recent, [
    {
      role: 'assistant',
      text: 'conclusion only',
      at: '2026-11-20T15:00:00.000Z',
      id: 'm-1',
    },
    { role: 'user', text: 'plain message' },
  ]);
});

test('raw execution material never reaches the pack', () => {
  const pack = buildContextPack({
    level: 'business',
    task: makeTask({
      transcript: 'SECRET TRANSCRIPT',
      raw_log: 'SECRET TASK LOG',
      latest_run: {
        run_id: 'run-1',
        state: 'accepted',
        summary: 'tests pass',
        logs: ['SECRET RUN LOG'],
        tool_calls: [{ name: 'secret-tool' }],
        stdout: 'SECRET STDOUT',
      },
    }),
    recent: makeRecent(1),
    budgets: {},
    countTokens: COUNT,
  });

  const serialized = JSON.stringify(pack);
  for (const leak of [
    'SECRET',
    'RAW LOG',
    'RAW RECENT LOG',
    'raw_log',
    'tool_calls',
    'stdout',
    'transcript',
  ]) {
    assert.equal(serialized.includes(leak), false, `leaked ${leak}`);
  }
  assert.match(serialized, /tests pass/);
});

test('minimal task only needs an id and a goal', () => {
  const pack = buildContextPack({
    level: 'business',
    task: { task_id: 'task-min', goal: 'Minimal goal' },
    budgets: {},
    countTokens: COUNT,
  });

  assert.deepEqual(pack.task_pack, {
    task_id: 'task-min',
    level: 'business',
    goal: 'Minimal goal',
  });
  assert.deepEqual(pack.recent, []);
  assert.deepEqual(pack.open_questions, []);
  assert.equal(pack.pointers[0].ref, 'task:task-min');
});

test('invalid input throws instead of emitting a misleading pack', () => {
  assert.throws(() => buildContextPack(null), /input object/);
  assert.throws(() => buildContextPack(), /level/);
  assert.throws(
    () => buildContextPack({ level: 'team', task: makeTask(), budgets: {} }),
    /level/,
  );
  assert.throws(
    () => buildContextPack({ level: 'business', task: null, budgets: {} }),
    /task object/,
  );
  assert.throws(
    () => buildContextPack({ level: 'business', task: { goal: 'x' }, budgets: {} }),
    /task.task_id/,
  );
  assert.throws(
    () =>
      buildContextPack({
        level: 'business',
        task: { task_id: 'x' },
        budgets: {},
      }),
    /task.goal/,
  );
  assert.throws(
    () =>
      buildContextPack({
        level: 'business',
        task: makeTask(),
        budgets: { business: 0 },
      }),
    /positive finite number/,
  );
  assert.throws(
    () =>
      buildContextPack({
        level: 'business',
        task: makeTask(),
        budgets: { business: Number.NaN },
      }),
    /positive finite number/,
  );
  assert.throws(
    () =>
      buildContextPack({
        level: 'business',
        task: makeTask(),
        budgets: {},
        countTokens: 'not a function',
      }),
    /countTokens/,
  );
  assert.throws(
    () =>
      buildContextPack({
        level: 'business',
        task: makeTask(),
        budgets: {},
        countTokens: () => Number.NaN,
      }),
    /non-negative finite number/,
  );
});

test('default token estimate is deterministic', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('中'), 1);
  assert.equal(estimateTokens('中中'), 2);
});

test('drilldownRef composes task and evidence read references', () => {
  const pack = buildContextPack({
    level: 'business',
    task: makeTask(),
    budgets: {},
    countTokens: COUNT,
  });
  const taskPointer = pack.pointers.find((pointer) => pointer.kind === 'task');
  const evidencePointer = pack.pointers.find(
    (pointer) => pointer.kind === 'evidence',
  );
  const runPointer = pack.pointers.find((pointer) => pointer.kind === 'run');

  assert.equal(
    drilldownRef(taskPointer),
    '/v1/tasks/task-biz-1',
  );
  assert.equal(
    drilldownRef(taskPointer, { fields: ['state', 'cost'] }),
    '/v1/tasks/task-biz-1?fields=state,cost',
  );
  assert.equal(drilldownRef(evidencePointer), '/v1/evidence/evidence-1');
  assert.equal(drilldownRef(runPointer), 'run:run-1');
  assert.throws(() => drilldownRef(null), /pointer object/);
  assert.throws(() => drilldownRef({ kind: 'run' }), /pointer.ref/);
});
