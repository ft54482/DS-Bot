import test from 'node:test';
import assert from 'node:assert/strict';

import { COST_CODES, guard } from '../src/index.js';

test('the effective cap is the smallest link on the chain', () => {
  assert.deepEqual(guard({ taskCap: 100, parentRemaining: 80, botCap: 90 }), {
    allowed: true,
    effectiveCap: 80,
    reason: null,
  });
  assert.equal(guard({ taskCap: 10, parentRemaining: 80, botCap: 90 }).effectiveCap, 10);
  assert.equal(guard({ taskCap: 100, parentRemaining: 80, botCap: 20 }).effectiveCap, 20);
});

test('null, undefined and Infinity mean no cap on that link', () => {
  assert.equal(
    guard({ taskCap: null, parentRemaining: 50, botCap: undefined }).effectiveCap,
    50,
  );
  assert.equal(
    guard({
      taskCap: Number.POSITIVE_INFINITY,
      parentRemaining: 50,
      botCap: 80,
    }).effectiveCap,
    50,
  );

  const unbounded = guard({});
  assert.deepEqual(unbounded, {
    allowed: true,
    effectiveCap: Number.POSITIVE_INFINITY,
    reason: null,
  });
});

test('a zero cap is valid and only a zero spend fits under it', () => {
  assert.equal(guard({ taskCap: 0, spent: 0 }).allowed, true);
  assert.equal(guard({ taskCap: 0, spent: 0.01 }).allowed, false);
  assert.equal(guard({ taskCap: 0, spent: 0.01 }).reason, COST_CODES.BUDGET_EXCEEDED);
});

test('spend exactly at the cap is allowed, including decimal tolerance', () => {
  assert.deepEqual(guard({ taskCap: 80, parentRemaining: 90, botCap: 100, spent: 80 }), {
    allowed: true,
    effectiveCap: 80,
    reason: null,
  });
  assert.equal(guard({ taskCap: 0.3, spent: 0.1 + 0.2 }).allowed, true);
});

test('spend above the effective cap is rejected with budget_exceeded', () => {
  const result = guard({ taskCap: 100, parentRemaining: 80, botCap: 90, spent: 80.01 });

  assert.deepEqual(result, {
    allowed: false,
    effectiveCap: 80,
    reason: COST_CODES.BUDGET_EXCEEDED,
  });
  assert.equal(result.reason, 'budget_exceeded');
});

test('a prospective requested amount is counted against the same cap', () => {
  assert.equal(guard({ taskCap: 100, spent: 60, requested: 40 }).allowed, true);
  assert.equal(guard({ taskCap: 100, spent: 60, requested: 40.01 }).allowed, false);
  assert.equal(guard({ taskCap: 100, spent: 60, requested: 40.01 }).reason, 'budget_exceeded');
});

test('already-over-cap spend is rejected even with no new request', () => {
  const result = guard({ taskCap: 10, spent: 12 });

  assert.equal(result.allowed, false);
  assert.equal(result.effectiveCap, 10);
  assert.equal(result.reason, 'budget_exceeded');
});

test('the result exposes exactly the contract keys and does not mutate input', () => {
  const input = { taskCap: 100, parentRemaining: 80, botCap: 90, spent: 10 };
  const snapshot = JSON.stringify(input);

  const result = guard(input);

  assert.deepEqual(Object.keys(result), ['allowed', 'effectiveCap', 'reason']);
  assert.equal(JSON.stringify(input), snapshot);
});

test('malformed caps and spend values are rejected', () => {
  for (const input of [
    null,
    [],
    { taskCap: -1 },
    { parentRemaining: Number.NaN },
    { botCap: '10' },
    { spent: -1 },
    { spent: Number.POSITIVE_INFINITY },
    { requested: -0.01 },
  ]) {
    assert.throws(
      () => guard(input),
      (error) => error.code === COST_CODES.INVALID_INPUT,
    );
  }
});

test('guard and ledger compose into a min-chain check', () => {
  const caps = { taskCap: 100, parentRemaining: 80, botCap: 90 };
  const result = guard({ ...caps, spent: 79, requested: 2 });

  assert.equal(result.effectiveCap, 80);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'budget_exceeded');
});
