import assert from 'node:assert/strict';
import test from 'node:test';

import { stopLoss } from '../src/index.js';

const NOW = Date.parse('2026-11-20T16:00:00.000Z');
const MINUTE = 60_000;

function evaluate(overrides = {}) {
  return stopLoss({
    lane: 'content',
    rounds: 0,
    budgetSpent: 0,
    lastProgressAt: NOW,
    now: NOW,
    ...overrides,
  });
}

test('returns exactly {stop, reason} and keeps looping below every threshold', () => {
  const result = evaluate({ rounds: 2, budgetSpent: 30, lastProgressAt: NOW - 30 * MINUTE });

  assert.deepEqual(result, { stop: false, reason: null });
  assert.deepEqual(Object.keys(result).sort(), ['reason', 'stop']);
});

test('more than two rounds stops the loop', () => {
  assert.deepEqual(evaluate({ rounds: 3 }), { stop: true, reason: 'rounds_exceeded' });
});

test('more than 30 CNY of spend stops the loop', () => {
  assert.deepEqual(evaluate({ budgetSpent: 30.01 }), { stop: true, reason: 'budget_exceeded' });
});

test('more than 30 minutes without progress stops the loop', () => {
  assert.deepEqual(
    evaluate({ lastProgressAt: NOW - 30 * MINUTE - 1 }),
    { stop: true, reason: 'no_progress' },
  );
});

test('reports rounds before budget and budget before no-progress', () => {
  assert.deepEqual(
    evaluate({ rounds: 3, budgetSpent: 100, lastProgressAt: NOW - 60 * MINUTE }),
    { stop: true, reason: 'rounds_exceeded' },
  );
  assert.deepEqual(
    evaluate({ rounds: 2, budgetSpent: 100, lastProgressAt: NOW - 60 * MINUTE }),
    { stop: true, reason: 'budget_exceeded' },
  );
});

test('accepts ISO timestamps and Date objects', () => {
  assert.deepEqual(
    stopLoss({
      lane: 'content',
      rounds: 0,
      budgetSpent: 0,
      lastProgressAt: '2026-11-20T15:29:59.999Z',
      now: '2026-11-20T16:00:00.000Z',
    }),
    { stop: true, reason: 'no_progress' },
  );

  assert.deepEqual(
    evaluate({
      lastProgressAt: new Date(NOW - 31 * MINUTE),
      now: new Date(NOW),
    }),
    { stop: true, reason: 'no_progress' },
  );
});

test('a clock that went backwards does not trigger no-progress', () => {
  assert.deepEqual(
    evaluate({ lastProgressAt: NOW + 5 * MINUTE }),
    { stop: false, reason: null },
  );
});

test('lane is optional context, but an empty lane is rejected', () => {
  assert.deepEqual(
    stopLoss({ rounds: 0, budgetSpent: 0, lastProgressAt: NOW, now: NOW }),
    { stop: false, reason: null },
  );
  assert.throws(() => evaluate({ lane: '   ' }), /lane/);
});

test('limits override the defaults without changing the others', () => {
  assert.deepEqual(
    evaluate({ budgetSpent: 75, limits: { maxBudget: 100 } }),
    { stop: false, reason: null },
  );
  assert.deepEqual(
    evaluate({ rounds: 4, limits: { maxRounds: 5 } }),
    { stop: false, reason: null },
  );
  assert.deepEqual(
    evaluate({ lastProgressAt: NOW - 6 * MINUTE, limits: { noProgressMinutes: 5 } }),
    { stop: true, reason: 'no_progress' },
  );
  assert.deepEqual(
    evaluate({ rounds: 3, limits: { maxBudget: 100 } }),
    { stop: true, reason: 'rounds_exceeded' },
  );
});

test('rejects malformed counters and timestamps', () => {
  assert.throws(() => stopLoss(null), /plain object/);
  assert.throws(() => evaluate({ rounds: -1 }), /rounds/);
  assert.throws(() => evaluate({ rounds: 1.5 }), /rounds/);
  assert.throws(() => evaluate({ budgetSpent: -1 }), /budgetSpent/);
  assert.throws(() => evaluate({ budgetSpent: Number.NaN }), /budgetSpent/);
  assert.throws(() => evaluate({ now: undefined }), /now/);
  assert.throws(() => evaluate({ lastProgressAt: 'not-a-date' }), /lastProgressAt/);
  assert.throws(() => evaluate({ limits: { maxRounds: 0 } }), /maxRounds/);
  assert.throws(() => evaluate({ limits: { maxBudget: 0 } }), /maxBudget/);
  assert.throws(() => evaluate({ limits: { noProgressMinutes: 0 } }), /noProgressMinutes/);
});
