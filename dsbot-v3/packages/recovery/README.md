# `@dsbot/recovery` — L24 restart reconciliation

Crash recovery for the task runtime: on restart, turn the persisted run/outbox/
worktree snapshot into a **plan** of safe actions. The plan is computed without
the network and without touching a database; applying it is the caller's
transaction.

```text
restart
  ├─ unfinished runs ── stale heartbeat ── probe executor ──┬─ alive  → kept
  │                                                        ├─ idle   → redispatch
  │                                                        └─ no proof → markLost
  ├─ outbox rows ────── never sent → redispatch
  │                     sending / sent / unknown → markLost (never re-send)
  └─ worktrees ─────── no ticket → orphans (report only, never delete)
```

## Usage

```js
import { reconcile, collectEvents } from '@dsbot/recovery';

const plan = reconcile({
  runtime: {
    runs: restoredRuns,        // [{ id, task_id, state, heartbeat_at, ... }]
    outbox: restoredOutbox,    // [{ id, run_id, intent, state, send_started_at }]
    worktrees: restoredTrees,  // [{ path, ticket_id?, run_id?, state? }]
    tickets: restoredTickets,  // [{ id }] or ['task-id'] (known tickets/tasks)
    now: Date.now(),           // optional; also accepted as the `now` argument
    policy: { heartbeat_stall_ms: 600_000 },
  },
  // Synchronous observation of the executor. A throw / unreachable answer means
  // "cannot prove", which always becomes markLost rather than a blind resend.
  executorProbe: (run) => ({ queryable: true, running: false }),
});

// plan.redispatch[]  safe to send again (outbox never sent, or executor idle)
// plan.markLost[]    heartbeat/dispatch cannot be proven: mark lost only
// plan.orphans[]     worktree without a ticket: report only, deleted === false
// plan.kept[]        terminal / queued / live / tracked, untouched

for (const event of collectEvents(plan)) {
  // append to the event ledger inside the same transaction that applies the plan
}
```

### Executor probe contract

`executorProbe(run)` must be **synchronous** because `reconcile` is a pure
planning call; collect executor observations before calling it. Return one of:

| Answer | Meaning | Decision |
|---|---|---|
| `{ queryable: true, running: true }` | the attempt is still alive | `kept` |
| `{ queryable: true, running: false }` | no live attempt holds the run | `redispatch` |
| `{ queryable: true, state: 'not_found' }` (`idle`, `done`, `failed`, ...) | executor says the attempt is gone | `redispatch` |
| `{ queryable: false }`, throw, `null` | cannot prove anything | `markLost` |
| `{ queryable: true }` with no state | queryable but inconclusive | `markLost` |

Aliases accepted: `reachable`, `connected`, `ok`, `active`, `busy`, `status`,
`executor_state`, `found`, `exists`, `error`. Being alive after the heartbeat
stall is allowed (long render/test jobs), and an active `lease_until` also keeps
a run alive.

### Decision table

| Runtime observation | Bucket | Reason |
|---|---|---|
| `queued` / `planned` / `created` | `kept` | `not_dispatched` |
| `reported`, `accepted`, `completed`, `failed`, ... | `kept` | `terminal_state` |
| `cancelling` | `kept` | `stop_in_progress` (stop verification owns it) |
| heartbeat/lease fresh | `kept` | `heartbeat_fresh` / `within_stall_window` / `lease_active` |
| stale + executor reports alive | `kept` | `executor_alive` |
| stale + outbox `pending` with no `send_started_at` | `redispatch` | `outbox_never_sent` |
| stale + outbox `sending` / `sent` / `unknown` | `markLost` | `dispatch_ambiguous` |
| stale + outbox `failed` | `markLost` | `dispatch_failed` |
| stale + probe says idle | `redispatch` | `heartbeat_stale_queryable_idle` |
| stale + probe unavailable / threw / inconclusive | `markLost` | `executor_unqueryable` / `executor_no_answer` / `executor_state_unknown` |
| worktree with a ticket present | `kept` | `worktree_tracked` |
| worktree without a ticket, or a referenced ticket is absent | `orphans` | `worktree_without_ticket` / `worktree_ticket_missing` |

## Guarantees

- **No I/O**: the package imports only its own modules. No `node:net`,
  `node:fs`, SQLite driver or HTTP client, and the tests enforce that.
- **No deletion**: orphan entries carry `action: 'report_only'` and
  `deleted: false`; there is no cleanup call anywhere in the package.
- **No mutation**: input objects are only read; a frozen snapshot works.
- **Idempotent**: runs are ordered by id and worktrees by path, and every action
  carries a deterministic `idempotency_key`. Re-running over the same snapshot
  returns a deeply equal plan. After the caller applies `lost` (or the
  re-dispatch), the next restart no longer reports that action.
- **Events included**: `collectEvents(plan)` returns one descriptor per action
  (`run.lost`, `run.redispatched`, `worktree.orphan`) with a stable event key for
  deduplication.

## Tests

```bash
node --test packages/recovery/test
```
