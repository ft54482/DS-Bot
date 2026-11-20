# L15 cross-package contracts

Contract tests for the PRD semantics that only exist when the merged layers run
together. They are not a second copy of the package unit suites: every scenario
is assembled through the L9 runtime composition root
(`packages/runtime/src/runtime.js` → store + service + api + adapters), the
execution acceptance fixtures are the merged L5 e2e vocabulary, and the
operator CLI is invoked as a real child process against the same database.

## Run

```sh
node --test tests/contract
```

Exit code 0 means all contracts hold. Each test gets its own
`mkdtemp`-created directory with a real `contract.sqlite` file; cleanup closes
the runtime and removes the directory. No `:memory:` shortcuts, no wall-clock
sleeps, and no timers.

## Contracts

| id | promise |
|---|---|
| `CONTRACT-01` | `/v1` task/run/acceptance state names are exactly the names declared by `packages/service` at every step (`planned → queued → running → accepting → reworking`), including the `reworking` facade name. |
| `CONTRACT-02` | An author claim opens `accepting`, never `completed`; after a passed acceptance completes the task, a late claim is rejected and the task stays `completed`. |
| `CONTRACT-03` | A passing verdict without passed required items returns HTTP 422; the raw completion guard maps to the PRD's `missing_acceptance` 422. |
| `CONTRACT-04` | A repeated `Idempotency-Key` returns the first body (`replayed: true`, one row) on task creation and dispatch; the same key with a different payload is a 409 `duplicate_dispatch`. |
| `CONTRACT-05` | An unverified executor cancel yields `stop_unknown` through both `runtime.stop.stop()` and `POST /v1/tasks/{id}/stop`; the task stays `stopping`, the run stays active, and no `task.cancelled` event is written. |
| `CONTRACT-06` | CLI `cost --json` totals equal `runtime.cost.total()` (the API/runtime measure) and the sum of `cost_ledger` rows, with no double billing after a rework run. |

The merged `/v1` API has no cost route; the operator CLI reads
`runtime.cost.total()` through the same composition root, so that facade is the
API-side measure compared here.

## Failure output

Every assertion is wrapped with its contract id and prints the expectation next
to the actual value, for example:

```
[CONTRACT-01] after revise: API task.state
  expected: 'completed'
  actual:   'reworking'
```

The test name also carries the contract id, so the failing line in
`node --test` output is enough to locate the broken cross-package promise.
