# `@dsbot/notify`

L26 alerting channel for the SuperAgent lab: a stuck task, a failed run and an
over-budget task produce a notification through an injected sender, with a
five-minute dedupe window and a two-step escalation cap.

The package is deliberately pure. It imports no network or file module, keeps no
timer, and uses `Date.now()` only when no clock is injected. The default sender
writes one JSON line with `console.log`; a deployment injects its Feishu/webhook
sender. The sender runs synchronously — a deployment sender should hand off to
an outbox/queue rather than await network I/O in place.

## Contract

```js
import { createNotifier } from '@dsbot/notify';

const notifier = createNotifier({ send: (notification) => channel.push(notification) });

notifier.stuck(task);                 // task is stuck
notifier.failed(run, 'timeout');      // run failed with a reason
notifier.overBudget(task);            // task exceeded its budget
notifier.escalate(task, 1);           // escalation level 1
```

Every method returns:

```json
{ "delivered": true, "reason": null, "notification": { "...": "..." } }
```

or, when the notifier deliberately stays quiet:

```json
{ "delivered": false, "reason": "duplicate", "notification": { "...": "..." } }
```

`reason` is `duplicate` inside the five-minute dedupe window or
`escalation_limit` once a task has used both escalation slots.

## Template

All four events fill the same context fields, so one renderer can display any
notification:

```json
{
  "id": "stuck-1795000000000-1",
  "event": "stuck",
  "kind": "stuck",
  "created_at": "2026-11-20T12:00:00.000Z",
  "task": { "id": "task-1", "level": "business", "state": "running", "owner": "bot:content" },
  "run": null,
  "reason": "accepting_timeout",
  "level": null,
  "title": "Task task-1 is stuck",
  "message": "Task task-1 is stuck: accepting_timeout",
  "dedupe_key": "stuck:task-1"
}
```

| Event | `task` | `run` | `reason` | `level` |
|---|---|---|---|---|
| `stuck` | normalized task | `null` | `task.reason` / `blocked_reason` / `stuck` | `null` |
| `failed` | run's task when available, else `{ id: run.task_id }` or `null` | normalized run | second argument (string/Error/message object), or the run's failure reason | `null` |
| `over_budget` | normalized task | `null` | `task.reason` / `blocked_reason` / `budget_exceeded` | `null` |
| `escalation` | normalized task | `null` | `task.reason` / `blocked_reason` / `escalation` | the supplied level (or auto 1, 2) |

Task summaries accept `id`/`task_id`, `level`/`task_level`, `state`/`status`
and `owner`/`owner_ref`. Run summaries accept `id`/`run_id`, `task_id`,
`state`/`status`, `attempt` and `run_no`.

## Dedupe and escalation

- The same event is delivered once per five minutes. The notifier keys dedupe
  by event subject: task id for `stuck`/`over_budget`, run id for `failed`, and
  task id plus level for `escalation`. At exactly five minutes it delivers
  again; a new notifier instance starts empty.
- `escalate(task, level)` delivers at most two escalations per task. The third
  and later calls return `escalation_limit` and never reach the sender, even
  after the dedupe window expires. When `level` is omitted the notifier derives
  the next level (1, then 2).
- Suppressed calls still return the template that would have been sent, which
  is useful for logging and tests. A sender exception propagates and is not
  recorded as delivered, so the next call can retry.

## Options

| Option | Default | Meaning |
|---|---|---|
| `send` | console JSON line | injected sender; must be a function. The default uses `console.log` only. |
| `now` / `clock` | `Date.now` | clock injection: function, epoch milliseconds, `Date` or ISO-8601 string. |
| `dedupeWindowMs` | `300000` | dedupe window in milliseconds. |
| `maxEscalations` | `2` | delivered escalation slots per task. |

## Run the tests

```sh
node --test packages/notify/test
```

The suite uses a fixed clock and an in-memory sender: template completeness for
all four events, input immutability, the five-minute boundary, per-subject
dedupe, separate instances, the two-step escalation cap and the console-only
default. It has no network, filesystem or timer dependency.
