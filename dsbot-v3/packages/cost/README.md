# `@dsbot/cost`

L32 cost ledger and budget guard: per-run CNY accounting, a min-chain effective
cap and an explicit refusal once the budget is exhausted.

The package is pure and in-memory: it opens no database, writes no file, makes
no network call, reads no ambient clock and has no dependencies. Two ledgers
never share state.

PRD references: `docs/prd/02-api-contract.md` §4.2 (budget check),
`docs/prd/04-reliability-ops.md` §1.6 (layered budget ownership) and §4.3
(budget gate).

## Contract

```js
import { createLedger, guard } from '@dsbot/cost';
```

All amounts are **CNY**. There is no currency parameter: a row that names any
other currency is rejected with `invalid_currency`.

## `createLedger(options?)`

```js
const ledger = createLedger();          // uncapped
const capped = createLedger({ capCny: 10 }); // default per-task cap
```

| Member | Meaning |
|---|---|
| `record({ taskId, runId, tokens, cny })` | append one run's cost; returns the row plus `totals` |
| `spent(taskId)` | total CNY for the task (0 when unknown) |
| `remaining(taskId, cap?)` | `cap - spent`, clamped at 0; `Infinity` when uncapped |
| `totals(taskId)` | `{ taskId, tokens, cny, runs }` |
| `entries(taskId)` | frozen copies of the task's rows |
| `entry(runId)` | frozen copy of one run's row, or `null` |
| `setCap(taskId, capCny)` | set/lower one task's cap (`null` clears it); returns the effective cap |
| `capOf(taskId)` | effective cap for the task |

`record` writes exactly one row per run:

```js
const row = ledger.record({
  taskId: 'task-1',
  runId: 'run-1',
  tokens: 1200,
  cny: 0.42,
});
// { sequence: 1, taskId: 'task-1', runId: 'run-1', tokens: 1200,
//   cny: 0.42, currency: 'CNY',
//   totals: { taskId: 'task-1', tokens: 1200, cny: 0.42, runs: 1 } }
```

Rules:

- repeated runs on one task accumulate; separate tasks are isolated;
- `taskId` and `runId` are non-empty strings and a `runId` may be billed once
  (a duplicate is `duplicate_run`, so a retry cannot double-bill);
- `tokens` is a non-negative safe integer, `cny` a non-negative finite number;
  negative values (refunds) are illegal;
- when a cap is configured, a record that would push the task above the cap is
  refused with `budget_exceeded` and the ledger is left unchanged. A zero-cost
  record exactly at the cap still fits;
- the effective cap is the smaller of `capCny` from `createLedger` and the
  per-task `setCap`; a task cap cannot raise the ledger default.

## `guard({ taskCap, parentRemaining, botCap, spent, requested? })`

```js
guard({ taskCap: 100, parentRemaining: 80, botCap: 90, spent: 60 });
// { allowed: true, effectiveCap: 80, reason: null }

guard({ taskCap: 100, parentRemaining: 80, botCap: 90, spent: 79, requested: 2 });
// { allowed: false, effectiveCap: 80, reason: 'budget_exceeded' }
```

`effectiveCap` is the minimum of the three links. `null`, `undefined` and
`Infinity` mean "no cap on this link"; when every link is absent the cap is
`Infinity` and everything fits. `spent` and the optional `requested` amount are
summed and compared against the cap with a `1e-9` tolerance for decimal
arithmetic. The returned object always has exactly the three contract keys.

## Errors

Malformed input and refused operations throw `CostError` with a stable `code`:

| code | when |
|---|---|
| `invalid_input` | malformed id, token count, amount or cap |
| `invalid_currency` | anything other than `CNY` |
| `duplicate_run` | the run id was already billed |
| `budget_exceeded` | the record would cross the effective cap |

Policy denials are never silently converted into success.

## Tests

```sh
node --test packages/cost/test
```

The suite covers accumulation, task isolation, remaining budget, per-run
records, duplicate runs, negative/refund amounts, CNY-only currency, atomic
over-cap refusal, min-chain caps, decimal tolerance, malformed input and the
purity/no-dependency constraints.
