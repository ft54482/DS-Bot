# `@dsbot/autoloop`

L34 dev-loop driver: one deterministic state machine that drives a round of
development work through dispatch, collection, independent verification, merge
and rework, with budget and stop-loss guards and crash recovery.

The package is pure orchestration. It starts no timer, opens no database,
spawns no process and makes no network call. `git`, `gh`, `sa`, the verifier,
the scheduler, the goal engine, the store and the clock are all injected
interfaces; the tests use fakes only.

## Contract

```js
import { createLoop, createMemoryStore } from '@dsbot/autoloop';

const loop = createLoop({
  goalEngine,   // { plan(context) -> { goal?, tasks?, done? } }
  scheduler,    // { freeSlots, dispatch, collect, rework }
  verifier,     // { verify(context) -> JSON {verdict: 'PASS'|'FAIL'} }
  merger,       // { merge(context) -> { merged: true, commit, pr? } }
  store,        // { load(), save(snapshot) } crash-recovery snapshot
  clock,        // () => epoch milliseconds
});

const result = await loop.step();
// { state: 'plan', actions: [...], next: 'dispatch' }
```

`step()` executes exactly one state and returns:
`state` is the state that just ran, `actions` is the ordered list of decisions
it made, and `next` is the state the following `step()` will run. `stop` and
`done` are terminal. Concurrent `step()` calls share one in-flight pass.

### Ports

| Port | Contract |
|---|---|
| `goalEngine.plan({ round, goal, tasks, completed, failed, spentCny, now })` | Return `{ goal?, tasks?, done? }`. A task is `{ id, lane, title?, goal?, budgetCny? }`. `done: true` ends the loop successfully. |
| `scheduler.freeSlots()` | Non-negative integer. The driver dispatches only while a slot is free. |
| `scheduler.dispatch(request)` | Return `{ workOrderId }` or the id string. `request.idempotencyKey` is stable per task/attempt. |
| `scheduler.collect()` | Return submissions `{ taskId, workOrderId?, commit?, costCny?, output?, tests? }`. Returning `{ submissions }` is also accepted. |
| `scheduler.rework(request)` | Return the new `{ workOrderId }`. `request.feedback` is the verifier's FAIL feedback. |
| `verifier.verify({ task, submission, lane, round })` | Return JSON with `verdict: "PASS"` or `"FAIL"`. Anything else (plain text, missing field, malformed JSON, a thrown error) fails closed as `FAIL`. |
| `merger.merge({ task, submission, verdict, lane, round })` | Return `{ merged: true, commit?, pr? }`. A PASS is the only path that reaches this port. |
| `store.load()/save(snapshot)` | Persist the last snapshot. `save` is awaited before `step()` returns. |
| `clock()` | Epoch milliseconds. Used for all snapshot timestamps. |

`createLoop` also accepts `sa`, `git` and `gh` instead of a prebuilt
`scheduler`/`merger`; `createSaScheduler` and `createGitGhMerger` compose them.
`createMemoryStore()` is the in-memory store used by tests and demos.

## State machine

```
plan ──▶ dispatch ──▶ collect ──▶ verify ──▶ merge ──▶ next
  ▲          │            │                        │        │
  │          └─ no slot ──┘                        │        │
  └──────────────────── plan (new round) ◀─────────┴────────┘
```

- **plan** – starts a round and asks the goal engine for tasks. `done: true`
  goes to `done`.
- **dispatch** – dispatches only planned tasks and only while
  `scheduler.freeSlots() > 0`. A full pool produces `slots_full` and leaves the
  task `planned`; no slot is ever oversubscribed from this driver's view.
- **collect** – takes submitted work orders. With nothing submitted it returns
  `next: 'collect'` (`wait`), so the caller can poll; when a slot frees up and a
  task is still planned it routes back to `dispatch`.
- **verify** – asks the verifier for a JSON verdict. `PASS` marks the task
  `passed`; `FAIL` (or any malformed output) marks it `failed` with feedback.
- **merge** – merges every `passed` task; every `failed` task is sent back
  through `scheduler.rework`. A merge API that does not return `merged: true`
  is a `merge_failed` action, never a silent success.
- **next** – routes back to `collect`/`verify`/`merge` if work is still active,
  ends on `done`, or starts the next `plan` round. It is also where the
  no-progress guard is evaluated.

### Stop-loss

| Guard | Default | Trigger | `stop.reason` |
|---|---|---|---|
| Rework rounds per lane | 2 | a third rework would be needed | `rework_exceeded` |
| Cost per task | 30 CNY | reported cost is **above** 30 (exactly 30 is allowed) | `budget_exceeded` |
| Consecutive no-progress rounds | 2 | two completed rounds without a merge | `no_progress` |

On a stop the snapshot gets a `stop: { reason, detail, at }`, the state becomes
`stop`, and the next `step()` replays the stop without doing more work. Limits
can be overridden per loop with `maxReworkRounds`, `maxTaskCostCny` and
`maxNoProgressRounds`.

### Crash recovery

`step()` persists the snapshot after every state. `resume()` reloads the last
snapshot and returns `{ state, actions, next }` without advancing:

```js
const resumed = await loop.resume();
// { state: 'collect', actions: [{ type: 'resume', inFlight: [...] }], next: 'collect' }
```

Tasks already in `dispatched` state stay in flight: `resume()` never sends them
again. The dispatch `idempotencyKey` (`autoloop:<loopId>:<taskId>:a<attempt>`)
protects the one unavoidable at-least-once window between an external dispatch
and the snapshot write.

## Actions

Every action has a `type`; common ones are `plan`, `goal_done`, `dispatch`,
`dispatch_skipped`, `slots_full`, `submission`, `wait`, `verify`, `merge`,
`merge_failed`, `rework`, `rework_failed`, `next` and `stop`. Actions are
descriptive; they never change external state themselves.

## Verification

```sh
node --test packages/autoloop/test
```

The suite covers every state, the empty-slot rule, PASS/FAIL parsing,
rework limits, per-task budget, two-round no-progress, crash recovery, the
adapters and input validation.
