# `@dsbot/scheduler`

L23 dispatch loop: take a queued `run`, respect `maxWorkers`, hand it to an
executor, retry failures with exponential backoff, and record the outbox intent.

The module is pure logic. It calls no timer, opens no database, writes no file
and makes no network request. Time and queue state arrive through injected
collaborators, so every scenario (concurrency, retry timing, idempotence) is
reproducible without sleeping.

## Contract

```js
import { createScheduler } from '@dsbot/scheduler';

const scheduler = createScheduler({
  runtime,                       // runtime port, or the L9 runtime facade
  executor,                      // dispatch(request) function or { dispatch }
  clock: () => now,              // injected clock, epoch milliseconds
  maxWorkers: 4,                 // concurrent dispatch slots
});

const pass = await scheduler.tick();
```

`tick()` performs one pass:

1. read queued runs from `runtime.listQueuedRuns()`;
2. order them by priority (desc), `createdAt` (asc), then id;
3. skip runs whose task is stopping/frozen/terminal or missing;
4. skip a run that is inside its failure backoff window;
5. dispatch while fewer than `maxWorkers` slots are active;
6. for every attempt, mark the run dispatched and append one
   `dispatch_run` outbox record.

Overlapping `tick()` calls share one in-flight pass. A run is dispatched at
most once per scheduler instance, even if a stale queue view still returns it.

### Tick result

```json
{
  "at": 1763683200000,
  "dispatched": [
    {
      "runId": "run-1",
      "taskId": "task-1",
      "attempt": 1,
      "outboxId": "outbox-run-1-a1",
      "result": { "ok": true, "accepted": true }
    }
  ],
  "failed": [
    {
      "runId": "run-2",
      "taskId": "task-2",
      "attempt": 1,
      "error": "bridge down",
      "code": null,
      "nextRetryAt": 1763683201000,
      "outboxId": "outbox-run-2-a1"
    }
  ],
  "waiting": [
    { "runId": "run-5", "taskId": "task-5", "reason": "concurrency_limit" }
  ],
  "skipped": [
    { "runId": "run-6", "taskId": "task-6", "reason": "task_stopping" }
  ],
  "unrecorded": [],
  "active": 4,
  "available": 0
}
```

`waiting[].reason` is `concurrency_limit` or `backoff` (with `nextRetryAt`).
`skipped[].reason` is `run_not_queued`, `run_stopping`, `already_dispatched`,
`task_missing`, `task_unavailable`, or `task_<state>`.

The scheduler also exposes `getRetryState(runId)`, `hasDispatched(runId)` and
`config`.

## Runtime port

`createScheduler` accepts any object implementing these five methods. All of
them may be synchronous or return a promise.

| Method | Purpose |
|---|---|
| `listQueuedRuns()` | Array of runs to consider (normally `state: 'queued'`) |
| `getTask(taskId)` | Task projection used to detect stopping/terminal tasks |
| `activeRunCount()` | Number of runs currently occupying a worker slot |
| `markDispatched(run, info)` | Durable `queued -> dispatched` transition |
| `recordOutbox(entry)` | Append/upsert one dispatch attempt record |

An outbox entry is `{ id, runId, taskId, intent, state, attempt,
idempotencyKey, payload, createdAt, updatedAt, sentAt, nextRetryAt, lastError }`.
A successful attempt uses `state: 'sent'`; a failed one uses `state: 'pending'`
with `nextRetryAt` and `lastError`, matching the L1 `dispatch_outbox` columns.

### L9 runtime facade

When the object looks like the composed runtime (`runtime.runs.list`,
`runtime.tasks.get`, `runtime.service.transitionRun`,
`runtime.store.enqueueOutbox`), the scheduler adapts it automatically:

- queued runs come from `runtime.runs.list({ state: 'queued' })`;
- active runs are `dispatched`/`dispatch_unknown`/`running`;
- dispatch uses the service state machine (`transitionRun`), not a second state
  vocabulary;
- outbox rows are appended through the L1 store.

## Backoff

A failure is either a thrown executor error or a rejection result
(`{ ok: false }` / `{ accepted: false, code, message }`). The run stays queued;
the attempt number increases and the next pass is delayed by:

| Failure | Delay |
|---|---|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4+ | 4s (capped) |

The delay is measured on the injected clock, so `clock.advance(1000)` is what
unlocks the retry. A success clears the retry window.

`maxWorkers` counts runs already dispatched or running plus the runs dispatched
in the current pass. With `maxWorkers: 4` and five queued runs, the first four
are dispatched and the fifth waits for a slot.

## Executor request

The default request matches the L9 dispatch envelope plus attempt metadata:

```js
{
  run, run_id, task_id, attempt, idempotency_key, task,
  taskPack: { goal, constraints: [], acceptance: [...], context_refs: [] },
  workspace: { path },
  budget: { cny_cap },
  tracking: { status: true, follow: true },
}
```

Pass `workspacePath`, `tracking` or a `buildRequest({ run, task, attempt,
idempotencyKey, now })` override to adapt it.

## Run the tests

```sh
node --test packages/scheduler/test
```

22 cases cover the dispatch/outbox path, the L9 facade adapter, the four-of-five
concurrency limit, a freed slot, FIFO/priority ordering, repeated and
overlapping ticks, the 1s/2s/4s/4s backoff sequence, executor rejections, and
stopping/terminal tasks.
