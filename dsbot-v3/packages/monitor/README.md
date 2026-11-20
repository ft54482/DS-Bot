# `@dsbot/monitor`

L11 status snapshot (`docs/prd/00-PRD.md` FR-16: task tree / state / budget /
stuck / pending decisions). It turns a point-in-time view of the task ledger and
executor observations into one `status.json`-shaped value for the cockpit or the
master control.

The projection is deliberately pure: it opens no database, writes no file,
makes no network call and has no ambient clock dependency when `now` is passed.
A repository/executor adapter collects `runtime` elsewhere and hands it in.

## Contract

```js
import { buildSnapshot } from '@dsbot/monitor';

const status = buildSnapshot({ runtime, now: 1795000000000 });
```

```json
{
  "generated_at": "2026-11-20T15:00:00.000Z",
  "tasks": [
    { "id": "task-biz-1", "level": "business", "state": "accepting", "owner": "bot:content", "cost": 3.21 }
  ],
  "stuck": [
    {
      "id": "task-biz-1",
      "reason": "accepting_timeout",
      "detail": "accepting for 26.0h (threshold 24.0h)",
      "evidence_ref": "task:task-biz-1",
      "evidence": {
        "type": "task",
        "ref": "task:task-biz-1",
        "field": "task.state_entered_at",
        "state": "accepting",
        "since": "2026-11-19T13:00:00.000Z",
        "age_ms": 93600000,
        "threshold_ms": 86400000
      }
    }
  ],
  "pending_decision": [
    {
      "id": "esc-1",
      "escalation_id": "esc-1",
      "kind": "budget",
      "task_id": "task-biz-1",
      "summary": "Budget is exhausted.",
      "evidence": { "type": "escalation", "ref": "escalation:esc-1", "state": "open" }
    }
  ],
  "budget": { "spent": 3.21, "cap": 200 }
}
```

`generated_at`, `tasks`, `stuck`, `pending_decision` and `budget` are the
contract keys. `tasks` entries carry exactly `id`, `level`, `state`, `owner` and
`cost`; `cost` and `budget` amounts are rounded to 4 decimals.

`now` accepts epoch milliseconds, an ISO-8601 string, a `Date`, or a function
returning one. Pass it explicitly for deterministic output; when omitted the
snapshot uses `runtime.now` and finally `Date.now()`.

Invalid input throws `TypeError` instead of silently emitting a misleading
snapshot: a missing `runtime`, an invalid `now`, a task without `id`, or a
duplicate task id.

## Runtime input

`runtime` is a read-only aggregate. Arrays, `Map`s and id-keyed objects are
accepted for entity lists; common snake_case and camelCase aliases are both
supported.

| Field | Used for |
|---|---|
| `tasks[]` | `id`, `level`, `state`, `owner`/`owner_ref`, `cost`/`cost_cny`, `accepting_since`, `state_entered_at`/`updated_at`/`created_at`, `rework_rounds`/`rework_history`, `blocked_reason`, `escalated`/`escalation_id`, `executor_id` |
| `runs[]` | `task_id`, `run_no`, `attempt`, `state` — derives consecutive rework rounds from `rejected` runs |
| `escalations[]` | `task_id`, `kind`, `detail`, `state`, `created_at`, `answered_at` — pending decisions and the blocked-escalation check |
| `interventions[]` / `user_interventions[]` | `task_id`, `question`, `answer`, `asked_at`, `answered_at` — pending human questions |
| `cost_ledger[]` | `task_id`, `cost_cny` — per-task and total spend |
| `costs` | `{ "task-1": 1.5 }` shorthand for the ledger |
| `budget` | `{ spent, cap }` or a numeric cap; aliases such as `budget_cny_cap` are accepted |
| `executors[]` | `id`, `kind`, `state`, `last_seen_at` — attached to stuck evidence when the task names an executor |
| `policy` / `thresholds` | `accepting_timeout_ms`, `rework_rounds_threshold` overrides |

## Stuck rules

Each entry carries a machine `reason`, a human `detail`, an `evidence_ref`, and
a structured `evidence` object. `evidence.executor` is added when the task's
`executor_id` resolves in `runtime.executors`.

| `reason` | Rule | Evidence |
|---|---|---|
| `accepting_timeout` | `state === 'accepting'` and `now - since >= accepting_timeout_ms`. `since` is `accepting_since`, then `state_entered_at`/`updated_at`, then `created_at`. Default timeout: 24h. A task without any timestamp is not flagged (the timeout cannot be proven). | task id, state, `since`, `age_ms`, `threshold_ms` |
| `rework_rounds` | `state === 'reworking'` and at least 2 consecutive rework rounds. Rounds come from `rework_rounds`/`rework_history` or, when absent, from the leading `rejected` runs (latest `run_no` backwards; the first non-rejected run stops the count; one `run_no` counts once across attempts). The configured threshold cannot go below 2. | round count, threshold, rejected `run_ids`, sources |
| `blocked_not_escalated` | `state === 'blocked'` with no open `escalation`, no open human intervention, and no task-level `escalated`/`escalation_id`. Closed/answered escalations do not satisfy the rule. | blocked reason, `open_escalations: 0`, checked rule |

## Pending decisions and budget

`pending_decision` contains every open `escalation` and every unanswered
`intervention`, oldest first. A closed/answered/resolved/cancelled entry is not
pending.

`budget.spent` is, in order: an explicit `budget.spent`, the sum of
`cost_ledger` rows (or `costs` when no ledger is supplied; the ledger wins to
avoid double counting), then the sum of per-task costs. `budget.cap` is
only an explicit scope cap (`budget.cap`, `budget_cny_cap`, ...); it is `null`
when the runtime does not provide one. Per-task caps are not summed: the PRD's
effective budget is the minimum along the task chain, so inventing an aggregate
from hierarchical caps would misreport it.

## Run the tests

```sh
node --test packages/monitor/test
```

The suite uses only fixed clocks and in-memory fixtures: shape, clock
injection, input immutability/determinism, all three stuck rules, pending
decisions and budget aggregation.
