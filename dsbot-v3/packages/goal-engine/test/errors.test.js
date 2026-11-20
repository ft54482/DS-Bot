import assert from 'node:assert/strict';
import test from 'node:test';
import { decompose, ERROR_CODES } from '../src/index.js';
import { expectCode, goal, input, lane } from './helpers.js';

test('an empty goal is rejected', () => {
  for (const value of ['', '   ', {}, null, undefined, { title: '  ' }]) {
    expectCode(
      () => decompose(input({ goal: value })),
      ERROR_CODES.emptyGoal,
      `goal ${JSON.stringify(value)} must be rejected as empty`,
    );
  }
});

test('a goal of the wrong type is invalid input', () => {
  for (const value of [42, true, [], { title: 42 }]) {
    expectCode(() => decompose(input({ goal: value })), ERROR_CODES.invalidInput);
  }
});

test('two lanes with the same directory conflict', () => {
  const run = () => decompose(input({
    lanes: [lane(), lane({ lane: 'other' })],
  }));

  assert.throws(run, (error) => {
    assert.equal(error.code, ERROR_CODES.laneDirConflict);
    assert.deepEqual(error.details.lanes, ['engine', 'other']);
    assert.equal(error.details.conflict, 'same');
    return true;
  });
});

test('nested lane directories also conflict', () => {
  const run = () => decompose(input({
    lanes: [
      lane(),
      lane({ lane: 'nested', dir: 'packages/goal-engine/test' }),
    ],
  }));

  assert.throws(run, (error) => {
    assert.equal(error.code, ERROR_CODES.laneDirConflict);
    assert.equal(error.details.conflict, 'nested');
    return true;
  });
});

test('lane cost above the budget is rejected before any task book is built', () => {
  const run = () => decompose(input({ budget: { limit: 2, unit: 'points' } }));

  assert.throws(run, (error) => {
    assert.equal(error.code, ERROR_CODES.budgetExceeded);
    assert.equal(error.details.total, 3);
    assert.equal(error.details.limit, 2);
    assert.equal(error.details.unit, 'points');
    return true;
  });
});

test('spending exactly the budget is allowed', () => {
  const result = decompose(input({ budget: 3 }));

  assert.equal(result.milestones.length, 2);
});

test('an invalid budget is rejected', () => {
  for (const budget of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10', {}, { limit: '10' }]) {
    expectCode(
      () => decompose(input({ budget })),
      ERROR_CODES.invalidBudget,
      `budget ${String(budget)} must be rejected`,
    );
  }
});

test('duplicate lane names are rejected', () => {
  expectCode(
    () => decompose(input({
      lanes: [lane(), lane({ dir: 'packages/other' })],
    })),
    ERROR_CODES.duplicateLane,
  );
});

test('an unknown PRD reference is rejected', () => {
  expectCode(
    () => decompose(input({ lanes: [lane({ prd: ['99'] })] })),
    ERROR_CODES.unknownPrd,
  );
});

test('an unknown milestone reference is rejected', () => {
  expectCode(
    () => decompose(input({ lanes: [lane({ milestone: 'm9' })] })),
    ERROR_CODES.unknownMilestone,
  );
});

test('lane directories must be repository-relative and traversal-free', () => {
  for (const dir of ['', '/abs', '../x', 'C:\\x', 'a/../b', 'a/./b', 42]) {
    expectCode(
      () => decompose(input({ lanes: [lane({ dir })] })),
      ERROR_CODES.invalidLane,
      `dir ${JSON.stringify(dir)} must be rejected`,
    );
  }
});

test('lanes must be a non-empty array', () => {
  for (const value of [undefined, null, [], 'engine']) {
    expectCode(
      () => decompose(input({ lanes: value })),
      ERROR_CODES.invalidInput,
      `lanes ${JSON.stringify(value)} must be rejected`,
    );
  }
});

test('invalid lane cost or minCases is rejected', () => {
  for (const bad of [{ cost: -1 }, { cost: '1' }, { minCases: 0 }, { minCases: 1.5 }]) {
    expectCode(
      () => decompose(input({ lanes: [lane(bad)] })),
      ERROR_CODES.invalidLane,
      JSON.stringify(bad),
    );
  }
});

test('an invalid template is rejected', () => {
  for (const template of [42, {}, { render: 'nope' }]) {
    expectCode(
      () => decompose(input({ template })),
      ERROR_CODES.invalidInput,
      JSON.stringify(template),
    );
  }
});

test('goal milestones must be well formed and unique', () => {
  expectCode(
    () => decompose(input({ goal: goal({ milestones: 'm1' }) })),
    ERROR_CODES.invalidInput,
  );
  expectCode(
    () => decompose(input({
      goal: goal({ milestones: [{ id: 'm1', title: 'A' }, { id: 'm1', title: 'B' }] }),
    })),
    ERROR_CODES.invalidInput,
  );
});
