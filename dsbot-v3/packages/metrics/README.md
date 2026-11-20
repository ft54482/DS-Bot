# `@dsbot/metrics`

L16 north-star metrics (`docs/prd/04-reliability-ops.md` §8): the cost, lead
time, rework rounds and human interventions attributable to each accepted task.

`computeMetrics` is a pure projection. It opens no database, writes no file,
makes no network call and mutates none of its inputs. Pass `clock`/`now` to make
`totals.generated_at` deterministic; the default is `Date.now()`.

## Contract

```js
import { computeMetrics } from '@dsbot/metrics';

const metrics = computeMetrics({ tasks, runs, acceptances, costs, clock: () => now });
```

```json
{
  "cost_per_accepted_task": 5,
  "lead_time": { "median_hours": 3, "p90_hours": 4, "samples": 2, "missing": 0 },
  "rework_rounds": 0.5,
  "interventions": 0.5,
  "totals": {
    "tasks": 3,
    "accepted_tasks": 2,
    "runs": 3,
    "accepted_runs": 3,
    "rework_runs": 1,
    "accepted_rework_runs": 1,
    "interventions": 1,
    "cost_cny": 10,
    "known_cost_cny": 10,
    "lead_time_samples": 2,
    "missing": { "cost": 0, "lead_time": 0, "rework": 0, "interventions": 0 },
    "data_complete": true,
    "generated_at": "2026-11-21T00:00:00.000Z"
  }
}
```

The five keys `cost_per_accepted_task`, `lead_time`, `rework_rounds`,
`interventions` and `totals` are the contract. `cost_per_accepted_task`,
`rework_rounds` and `interventions` are ratios over accepted tasks. `lead_time`
reports the median and nearest-rank P90 in hours, plus how many accepted tasks
contributed and how many lacked usable timestamps.

## Accepted tasks

A task is in the accepted queue when any of the following holds:

- `state`/`status` is `completed`, `done`, `accepted` or `passed`;
- `accepted_at`/`acceptedAt`/`completed_at`/`completedAt` is present;
- it has a passed acceptance (`state: passed`, `verdict: pass`, ...) whose
  `stage` matches the task's `level` (or the acceptance omits a stage).

The queue is not filtered by wall-clock window: slice the input arrays for the
reporting window. A parent's metric includes its descendants' runs and costs
(see below).

## Inputs

Arrays, `Map`s and id-keyed objects are accepted for every entity list. Common
snake_case and camelCase aliases are supported.

| Input | Used fields |
|---|---|
| `tasks[]` | `id`, `level`, `state`/`status`, `parent_task_id`, `created_at`, `accepted_at`/`completed_at`, `cost_cny`, `intervention_count`, `interventions` |
| `runs[]` | `id`, `task_id`, `run_no`, `attempt`, `kind`/`role`/`type`, `rework`/`is_rework`, `parent_run_id`, `rework_reason`, `cost_cny` |
| `acceptances[]` | `id`, `target_task_id`/`task_id`, `stage`, `state`/`verdict`/`result`, `passed`, `mode`, `decided_at` |
| `costs[]` | `id`, `run_id`, `task_id`, `cost_cny`/`amount`; a `{runId: amount}` or `{taskId: amount}` shorthand also works |
| `interventions[]` | `id`, `task_id`; optional fifth input for an explicit `user_intervention` ledger |

`clock` accepts epoch milliseconds, an ISO-8601 string, a `Date`, or a function
returning one. `now` is accepted as an alias. Invalid input (duplicate task/run
ids, a task without an id, a run without `task_id`, an invalid clock) throws
`TypeError` instead of emitting a misleading metric.

## Formulas

With `A = accepted_tasks`:

| Metric | Formula |
|---|---|
| `cost_per_accepted_task` | sum of every accepted task's lifetime cost ÷ `A` |
| `lead_time.median_hours` / `p90_hours` | `accepted_at - created_at` over tasks with both timestamps; median and nearest-rank P90 |
| `rework_rounds` | count of rework runs belonging to accepted tasks ÷ `A` |
| `interventions` | count of human interventions belonging to accepted tasks ÷ `A` |

### Cost

Cost is aggregated per run. For each run, ledger rows in `costs` win; otherwise
the run's own `cost_cny` is used. Task-level ledger rows without a run id are
added once. A task-level `cost_cny` is only a fallback when that task has no runs
and no ledger rows, so the same spend is never counted twice.

Accepted parents include the runs and direct costs of their whole descendant
subtree. Every run state is included: failed runs and rework runs are part of
the cost.

### Rework

A run is rework when it is explicitly marked (`kind/role/type` in
`rework/revision/revise`, `rework: true`, `parent_run_id`, `rework_reason`) or,
following the L1 model, when `run_no > 1` and `attempt <= 1`. A retry of the same
run number (`attempt > 1`) and an explicit `retry`/`recovery` kind are not
rework.

### Interventions

When an explicit `interventions` list is supplied it is authoritative and
deduplicated by id. Otherwise interventions come from:

- `mode: human` (or `manual`) acceptance decisions with a decision time;
- task-level `intervention_count` or an `interventions` list.

## Missing data

Missing data is never coerced to zero:

- no accepted tasks → every ratio is `null`;
- an accepted task with no cost source, or a run with no reported cost → the
  cost ratio is `null` (the known subtotal is still in
  `totals.known_cost_cny`);
- accepted tasks without usable timestamps are excluded from the distribution
  and counted in `lead_time.missing`;
- no run for any accepted task → `rework_rounds` is `null`;
- no intervention evidence at all → `interventions` is `null`.

`totals.missing` counts the affected accepted tasks and
`totals.data_complete` is `false` when any metric rests on incomplete input.
An explicit zero (cost `0`, an empty intervention list, an `auto` acceptance)
is a known zero, not missing data.

## Run the tests

```sh
node --test packages/metrics/test
```
