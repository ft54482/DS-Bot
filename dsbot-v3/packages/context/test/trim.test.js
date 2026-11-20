import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextPack,
  CONTEXT_TRIM_ORDER,
  measurePack,
  TASK_PACK_TRIM_ORDER,
} from '../src/index.js';
import {
  COUNT,
  makeQuestions,
  makeRecent,
  makeTask,
} from './helpers.js';

function fullPack() {
  return buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: makeRecent(6),
    open_questions: makeQuestions(),
    budgets: { business: 80_000 },
    countTokens: COUNT,
  });
}

test('trim order is recent, then open questions, then task pack', () => {
  assert.deepEqual(CONTEXT_TRIM_ORDER, [
    'recent',
    'open_questions',
    'task_pack',
  ]);
  assert.deepEqual(TASK_PACK_TRIM_ORDER, [
    'latest_run',
    'latest_acceptance',
    'latest_report',
    'title',
    'state',
    'owner',
    'budget',
    'due_at',
  ]);
});

test('recent dialogue is trimmed before open questions and task pack', () => {
  const full = fullPack();
  assert.equal(full.recent.length, 6);
  assert.equal(full.open_questions.length, 2);

  const withoutRecent = { ...full, recent: [] };
  const limit = measurePack(withoutRecent, COUNT);
  const trimmed = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: makeRecent(6),
    open_questions: makeQuestions(),
    budgets: { business: limit },
    countTokens: COUNT,
  });

  assert.equal(trimmed.recent.length, 0);
  assert.deepEqual(trimmed.open_questions, full.open_questions);
  assert.deepEqual(trimmed.task_pack, full.task_pack);
  assert.ok(measurePack(trimmed, COUNT) <= limit);
});

test('the newest recent turns survive when only part of the list is dropped', () => {
  const full = fullPack();
  const withoutOldest = {
    ...full,
    recent: full.recent.slice(1),
  };
  const limit = measurePack(withoutOldest, COUNT);
  const trimmed = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: makeRecent(6),
    open_questions: makeQuestions(),
    budgets: { business: limit },
    countTokens: COUNT,
  });

  assert.equal(trimmed.recent.length, 5);
  assert.deepEqual(trimmed.recent, full.recent.slice(1));
  assert.equal(trimmed.recent[0].id, 'msg-1');
});

test('open questions are trimmed only after recent is empty', () => {
  const full = fullPack();
  const withoutQuestions = {
    ...full,
    recent: [],
    open_questions: [],
  };
  const limit = measurePack(withoutQuestions, COUNT);
  const trimmed = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: makeRecent(6),
    open_questions: makeQuestions(),
    budgets: { business: limit },
    countTokens: COUNT,
  });

  assert.equal(trimmed.recent.length, 0);
  assert.equal(trimmed.open_questions.length, 0);
  assert.deepEqual(trimmed.task_pack, full.task_pack);
  assert.ok(measurePack(trimmed, COUNT) <= limit);
});

test('task pack is trimmed last and keeps every required field', () => {
  const full = fullPack();
  const withoutOptional = structuredClone(full);
  for (const field of TASK_PACK_TRIM_ORDER) {
    delete withoutOptional.task_pack[field];
  }
  withoutOptional.recent = [];
  withoutOptional.open_questions = [];
  const limit = measurePack(withoutOptional, COUNT);

  const trimmed = buildContextPack({
    level: 'business',
    task: makeTask(),
    recent: makeRecent(6),
    open_questions: makeQuestions(),
    budgets: { business: limit },
    countTokens: COUNT,
  });

  assert.equal(trimmed.recent.length, 0);
  assert.equal(trimmed.open_questions.length, 0);
  for (const field of TASK_PACK_TRIM_ORDER) {
    assert.equal(
      Object.hasOwn(trimmed.task_pack, field),
      false,
      `${field} should have been trimmed`,
    );
  }
  assert.ok(Object.keys(trimmed.task_pack).length > 0);
  for (const field of [
    'task_id',
    'level',
    'goal',
    'scope',
    'acceptance',
    'delivery',
    'base_sha',
    'stop_conditions',
    'idempotency_key',
    'outcome',
    'conclusions',
    'risks',
  ]) {
    assert.ok(
      Object.hasOwn(trimmed.task_pack, field),
      `${field} must survive trimming`,
    );
  }
  assert.ok(measurePack(trimmed, COUNT) <= limit);
});

test('an impossible budget throws rather than returning an empty task pack', () => {
  assert.throws(
    () =>
      buildContextPack({
        level: 'business',
        task: makeTask(),
        recent: makeRecent(6),
        open_questions: makeQuestions(),
        budgets: { business: 1 },
        countTokens: COUNT,
      }),
    (error) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /too small for the required business pack/);
      return true;
    },
  );
});

test('the assembled pack never exceeds its effective budget', () => {
  const cases = [
    { level: 'goal', budgets: {}, recent: makeRecent(3) },
    { level: 'business', budgets: { business: 5_000 }, recent: makeRecent(3) },
    {
      level: 'execution',
      budgets: { execution: 5_000 },
      recent: makeRecent(3),
    },
  ];

  for (const entry of cases) {
    const pack = buildContextPack({
      level: entry.level,
      task: makeTask({ level: entry.level }),
      recent: entry.recent,
      open_questions: makeQuestions(),
      budgets: entry.budgets,
      countTokens: COUNT,
    });
    const limit =
      entry.level === 'goal'
        ? 60_000
        : entry.level === 'business'
          ? 5_000
          : 5_000;
    assert.ok(
      measurePack(pack, COUNT) <= limit,
      `${entry.level} pack exceeded ${limit}`,
    );
  }
});
