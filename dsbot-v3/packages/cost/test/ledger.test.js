import test from 'node:test';
import assert from 'node:assert/strict';

import { COST_CODES, createLedger } from '../src/index.js';

test('records accumulate across runs on the same task', () => {
  const ledger = createLedger();

  const first = ledger.record({
    taskId: 'task-1',
    runId: 'run-1',
    tokens: 100,
    cny: 1.25,
  });
  assert.equal(first.totals.tokens, 100);
  assert.equal(first.totals.cny, 1.25);
  assert.equal(first.totals.runs, 1);

  const second = ledger.record({
    taskId: 'task-1',
    runId: 'run-2',
    tokens: 50,
    cny: 2.75,
  });
  assert.equal(second.totals.tokens, 150);
  assert.equal(second.totals.cny, 4);
  assert.equal(second.totals.runs, 2);

  assert.equal(ledger.spent('task-1'), 4);
  assert.deepEqual(ledger.totals('task-1'), {
    taskId: 'task-1',
    tokens: 150,
    cny: 4,
    runs: 2,
  });
});

test('decimal CNY amounts are summed and rounded for display', () => {
  const ledger = createLedger();
  ledger.record({ taskId: 'task-1', runId: 'run-1', tokens: 1, cny: 0.1 });
  ledger.record({ taskId: 'task-1', runId: 'run-2', tokens: 1, cny: 0.2 });

  assert.equal(ledger.spent('task-1'), 0.3);
});

test('different tasks are isolated from each other', () => {
  const ledger = createLedger();
  ledger.record({ taskId: 'task-a', runId: 'run-a', tokens: 10, cny: 1 });
  ledger.record({ taskId: 'task-b', runId: 'run-b', tokens: 20, cny: 2 });

  assert.equal(ledger.spent('task-a'), 1);
  assert.equal(ledger.spent('task-b'), 2);
  assert.equal(ledger.totals('task-a').runs, 1);
  assert.equal(ledger.totals('task-b').runs, 1);
});

test('an unknown task reports zero spend, zero totals and full remaining budget', () => {
  const ledger = createLedger();

  assert.equal(ledger.spent('task-none'), 0);
  assert.deepEqual(ledger.totals('task-none'), {
    taskId: 'task-none',
    tokens: 0,
    cny: 0,
    runs: 0,
  });
  assert.deepEqual(ledger.entries('task-none'), []);
  assert.equal(ledger.entry('run-none'), null);
  assert.equal(ledger.remaining('task-none', 10), 10);
  assert.equal(ledger.remaining('task-none'), Number.POSITIVE_INFINITY);
});

test('remaining subtracts spend, honours Infinity and clamps at zero', () => {
  const ledger = createLedger();
  assert.equal(ledger.remaining('task-1', 10), 10);

  ledger.record({ taskId: 'task-1', runId: 'run-1', tokens: 1, cny: 4 });
  assert.equal(ledger.remaining('task-1', 10), 6);
  assert.equal(ledger.remaining('task-1', 3), 0);
  assert.equal(ledger.remaining('task-1'), Number.POSITIVE_INFINITY);

  ledger.record({ taskId: 'task-1', runId: 'run-2', tokens: 1, cny: 6 });
  assert.equal(ledger.remaining('task-1', 10), 0);
});

test('entries and lookups return copies, never ledger internals', () => {
  const ledger = createLedger();
  ledger.record({ taskId: 'task-1', runId: 'run-1', tokens: 7, cny: 0.5 });

  const rows = ledger.entries('task-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, 'run-1');
  assert.equal(rows[0].currency, 'CNY');
  assert.ok(Object.isFrozen(rows));
  assert.ok(Object.isFrozen(rows[0]));
  assert.throws(() => {
    rows[0].cny = 999;
  }, TypeError);

  const row = ledger.entry('run-1');
  assert.notEqual(row, rows[0]);
  assert.equal(row.cny, 0.5);
  assert.equal(ledger.entries('task-1')[0].cny, 0.5);
});

test('rejects negative CNY amounts and token counts (refunds are illegal)', () => {
  const ledger = createLedger();
  const base = { taskId: 'task-1', runId: 'run-1', tokens: 10, cny: 1 };

  for (const input of [
    { ...base, cny: -0.01 },
    { ...base, tokens: -1 },
    { ...base, cny: Number.NaN },
    { ...base, cny: Number.POSITIVE_INFINITY },
    { ...base, tokens: 1.5 },
    { ...base, tokens: Number.NEGATIVE_INFINITY },
  ]) {
    assert.throws(
      () => ledger.record(input),
      (error) => error.code === COST_CODES.INVALID_INPUT,
    );
  }

  assert.equal(ledger.spent('task-1'), 0);
});

test('rejects malformed task and run identifiers', () => {
  const ledger = createLedger();

  for (const input of [
    null,
    [],
    {},
    { taskId: '', runId: 'run-1', tokens: 1, cny: 1 },
    { taskId: '   ', runId: 'run-1', tokens: 1, cny: 1 },
    { taskId: 'task-1', runId: '', tokens: 1, cny: 1 },
    { taskId: 'task-1', runId: 42, tokens: 1, cny: 1 },
    { taskId: 'task-1', runId: 'run-1', tokens: '10', cny: 1 },
    { taskId: 'task-1', runId: 'run-1', tokens: 10, cny: '1' },
  ]) {
    assert.throws(
      () => ledger.record(input),
      (error) => error.code === COST_CODES.INVALID_INPUT,
    );
  }

  assert.throws(
    () => ledger.spent(''),
    (error) => error.code === COST_CODES.INVALID_INPUT,
  );
  assert.throws(
    () => ledger.remaining('   ', 5),
    (error) => error.code === COST_CODES.INVALID_INPUT,
  );
});

test('only CNY is accepted', () => {
  const ledger = createLedger();

  for (const currency of ['USD', 'usd', 'EUR', 0]) {
    assert.throws(
      () =>
        ledger.record({
          taskId: 'task-1',
          runId: `run-${String(currency)}`,
          tokens: 1,
          cny: 1,
          currency,
        }),
      (error) => error.code === COST_CODES.INVALID_CURRENCY,
    );
  }

  const row = ledger.record({
    taskId: 'task-1',
    runId: 'run-cny',
    tokens: 1,
    cny: 1,
    currency: 'CNY',
  });
  assert.equal(row.currency, 'CNY');
});

test('a record that would cross the cap is refused atomically', () => {
  const ledger = createLedger({ capCny: 10 });
  ledger.record({ taskId: 'task-1', runId: 'run-1', tokens: 10, cny: 4 });
  ledger.record({ taskId: 'task-1', runId: 'run-2', tokens: 10, cny: 6 });
  assert.equal(ledger.spent('task-1'), 10);
  assert.equal(ledger.remaining('task-1', 10), 0);

  assert.throws(
    () => ledger.record({ taskId: 'task-1', runId: 'run-3', tokens: 1, cny: 0.01 }),
    (error) => {
      assert.equal(error.code, COST_CODES.BUDGET_EXCEEDED);
      assert.equal(error.details.cap, 10);
      assert.equal(error.details.spent, 10);
      assert.equal(error.details.attempted, 10.01);
      return true;
    },
  );

  assert.equal(ledger.spent('task-1'), 10);
  assert.equal(ledger.totals('task-1').runs, 2);
  assert.equal(ledger.entry('run-3'), null);

  // A zero-cost run exactly at the cap still fits.
  const free = ledger.record({ taskId: 'task-1', runId: 'run-3', tokens: 0, cny: 0 });
  assert.equal(free.totals.runs, 3);
  assert.equal(ledger.spent('task-1'), 10);
});

test('the effective cap is the lower of the ledger default and the task cap', () => {
  const ledger = createLedger({ capCny: 100 });
  assert.equal(ledger.capOf('task-1'), 100);

  assert.equal(ledger.setCap('task-1', 5), 5);
  assert.equal(ledger.capOf('task-1'), 5);
  assert.throws(
    () => ledger.record({ taskId: 'task-1', runId: 'run-1', tokens: 1, cny: 6 }),
    (error) => error.code === COST_CODES.BUDGET_EXCEEDED,
  );

  // A looser per-task cap cannot raise the ledger default.
  assert.equal(ledger.setCap('task-2', 1000), 100);
  assert.equal(ledger.capOf('task-2'), 100);

  // Clearing the per-task cap restores the default.
  assert.equal(ledger.setCap('task-1', null), 100);
  assert.equal(ledger.capOf('task-1'), 100);

  assert.throws(
    () => ledger.setCap('task-1', -1),
    (error) => error.code === COST_CODES.INVALID_INPUT,
  );
});

test('a duplicate run id is refused and cannot double-bill', () => {
  const ledger = createLedger();
  ledger.record({ taskId: 'task-1', runId: 'run-1', tokens: 10, cny: 1 });

  assert.throws(
    () => ledger.record({ taskId: 'task-1', runId: 'run-1', tokens: 10, cny: 1 }),
    (error) => error.code === COST_CODES.DUPLICATE_RUN,
  );
  assert.throws(
    () => ledger.record({ taskId: 'task-2', runId: 'run-1', tokens: 10, cny: 1 }),
    (error) => error.code === COST_CODES.DUPLICATE_RUN,
  );

  assert.equal(ledger.spent('task-1'), 1);
  assert.equal(ledger.spent('task-2'), 0);
  assert.equal(ledger.totals('task-1').runs, 1);
});

test('record does not mutate its input object', () => {
  const ledger = createLedger();
  const input = { taskId: 'task-1', runId: 'run-1', tokens: 10, cny: 1.5 };
  const snapshot = JSON.stringify(input);

  ledger.record(input);

  assert.equal(JSON.stringify(input), snapshot);
});

test('ledgers are independent in-memory instances', () => {
  const first = createLedger();
  const second = createLedger();

  first.record({ taskId: 'task-1', runId: 'run-1', tokens: 10, cny: 1 });

  assert.equal(first.spent('task-1'), 1);
  assert.equal(second.spent('task-1'), 0);
  assert.equal(second.entry('run-1'), null);
});

test('invalid ledger options are rejected', () => {
  for (const options of [null, [], { capCny: -1 }, { capCny: Number.NaN }, { capCny: '10' }]) {
    assert.throws(
      () => createLedger(options),
      (error) => error.code === COST_CODES.INVALID_INPUT,
    );
  }
});
