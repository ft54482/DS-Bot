# @dsbot/api · L6 task-service HTTP layer

HTTP/JSON facade over the L2 state machine (`packages/service`) and the L1
SQLite store (`packages/store`). No npm dependencies; the server is
`node:http` and the store is `node:sqlite` through `packages/store`.

## Run

```powershell
node --test packages/api/test
```

Programmatic use:

```js
import { startApiServer } from './packages/api/src/index.js';

const api = await startApiServer({ databasePath: ':memory:' }); // binds 127.0.0.1
// api.url === 'http://127.0.0.1:<ephemeral-port>'
await api.close();
```

Pass `databasePath: 'C:/path/tasks.sqlite'` to persist across restart. The
default is an isolated in-memory SQLite database.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/tasks` | create `goal`/`business`/`execution` task |
| `GET` | `/v1/tasks/:id` | task package (task + runs + acceptances + claims) |
| `POST` | `/v1/tasks/:id/dispatch` | create/advance a run to `dispatched` |
| `POST` | `/v1/tasks/:id/stop` | freeze subtree; `202` until stop verification |
| `POST` | `/v1/runs/:id/ack` | executor ack: `dispatched -> running` |
| `POST` | `/v1/runs/:id/claim` | author claim: `running -> reported`; opens acceptance |
| `POST` | `/v1/acceptances` | open an acceptance round (PRD 02 §2.3 payload) |
| `POST` | `/v1/acceptances/:id/verdict` | only `acceptance_service`; `pass/revise/fail/block/void` |

Every write accepts an `Idempotency-Key` header. A replay of the same key with
the same body returns the first result and `"replayed": true`; the same key
with a different body is `409 idempotency_conflict` (`duplicate_dispatch` for
dispatch). Error bodies carry the PRD code, HTTP status, message and details.

`POST /v1/runs/:id/claim` can only move a task to `accepting`; it never writes
`completed`. Completion is only reachable through a passing acceptance verdict
on the task's own level. A passing verdict with pending required items is
`422 acceptance_incomplete`; completion without a passed acceptance is
`422 missing_acceptance` at the service guard.

## Store adapter

`src/store-adapter.js` implements the L2 service's injected store contract on
top of an opened `packages/store` `Store`. Columns with schema guards
(`task.state`, `parent_task_id`, `acceptance.state/stage`) are written normally,
so the L1 hierarchy and completion triggers still run. Fields the L1 schema does
not model yet (`state_version`, `revision`, `cycle_no`, run lease/dispatch,
acceptance items) are kept as a JSON sidecar in existing free-form JSON columns.
`packages/store` itself is untouched; this package only imports it.

## Tests

`test/api.test.js` covers all endpoints and the ticket assertions:
idempotent replay, `409 invalid_state_transition`, claim cannot complete,
`422` completion guards, stop pending/verified, and error envelopes.
`test/persistence.test.js` proves tasks and idempotency records survive a
SQLite-backed restart.
