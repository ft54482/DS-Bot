import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHZ_CODES, effectiveBudget } from '../src/index.js';

test('takes the minimum of task, parent and bot caps', () => {
  assert.deepEqual(effectiveBudget({ taskCap: 100, parentRemaining: 80, botCap: 90 }), {
    ok: true,
    cap: 80,
    remaining: 80,
  });
  assert.equal(effectiveBudget({ taskCap: 10, parentRemaining: 80, botCap: 90 }).cap, 10);
  assert.equal(effectiveBudget({ taskCap: 100, parentRemaining: 80, botCap: 20 }).cap, 20);
});

test('null, undefined and Infinity mean "no cap on this link"', () => {
  assert.equal(
    effectiveBudget({ taskCap: null, parentRemaining: 50, botCap: undefined }).cap,
    50,
  );
  assert.equal(
    effectiveBudget({ taskCap: Number.POSITIVE_INFINITY, parentRemaining: 50, botCap: 80 }).cap,
    50,
  );

  const unbounded = effectiveBudget({});
  assert.equal(unbounded.ok, true);
  assert.equal(unbounded.cap, Number.POSITIVE_INFINITY);
  assert.equal(unbounded.remaining, Number.POSITIVE_INFINITY);
});

test('a zero cap is valid and reports no remaining budget', () => {
  assert.deepEqual(effectiveBudget({ taskCap: 0, parentRemaining: 10, botCap: 5 }), {
    ok: true,
    cap: 0,
    remaining: 0,
  });
});

test('a request exactly at the cap passes', () => {
  const result = effectiveBudget({
    taskCap: 100,
    parentRemaining: 80,
    botCap: 90,
    requested: 80,
  });

  assert.deepEqual(result, { ok: true, cap: 80, remaining: 0 });
});

test('a request over the effective cap returns budget_exceeded', () => {
  const result = effectiveBudget({
    taskCap: 100,
    parentRemaining: 80,
    botCap: 90,
    requested: 81,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, AUTHZ_CODES.BUDGET_EXCEEDED);
  assert.equal(result.cap, 80);
  assert.equal(result.requested, 81);
  assert.equal(result.committed, 81);
  assert.equal(result.remaining, 0);
  assert.equal(result.reason, 'cap_exceeded');
});

test('spent and reserved amounts count against the same cap', () => {
  const fits = effectiveBudget({
    taskCap: 100,
    parentRemaining: 80,
    botCap: 90,
    spent: 60,
    reserved: 10,
    requested: 10,
  });
  assert.deepEqual(fits, { ok: true, cap: 80, remaining: 0 });

  const over = effectiveBudget({
    taskCap: 100,
    parentRemaining: 80,
    botCap: 90,
    spent: 61,
    reserved: 10,
    requested: 10,
  });
  assert.equal(over.ok, false);
  assert.equal(over.committed, 81);
});

test('decimal arithmetic within a tiny tolerance does not overflow', () => {
  const result = effectiveBudget({ taskCap: 0.3, requested: 0.1 + 0.2 });
  assert.equal(result.ok, true);
  assert.equal(result.cap, 0.3);
});

test('caps of different links are combined without mutating input', () => {
  const input = { taskCap: 100, parentRemaining: 80, botCap: 90, requested: 20 };
  const snapshot = JSON.stringify(input);

  const result = effectiveBudget(input);
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 60);
  assert.equal(JSON.stringify(input), snapshot);
});

test('malformed input throws TypeError', () => {
  assert.throws(() => effectiveBudget(null), TypeError);
  assert.throws(() => effectiveBudget([]), TypeError);
  assert.throws(() => effectiveBudget({ taskCap: -1 }), TypeError);
  assert.throws(() => effectiveBudget({ parentRemaining: Number.NaN }), TypeError);
  assert.throws(() => effectiveBudget({ botCap: '10' }), TypeError);
  assert.throws(() => effectiveBudget({ requested: -1 }), TypeError);
  assert.throws(() => effectiveBudget({ spent: Number.POSITIVE_INFINITY }), TypeError);
});
