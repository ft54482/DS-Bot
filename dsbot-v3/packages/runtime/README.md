# `@dsbot/runtime` — L9 composition root

Assembles the merged layers into one runnable object for a CLI or a monitor:

| Layer | Package | Role inside the runtime |
|---|---|---|
| L1 store | `packages/store` | SQLite schema/migrations, task/run/acceptance DAO, `cost_ledger`, event ledger |
| L2 service | `packages/service` | task/run/acceptance state machine, guards, idempotency, stop verification |
| L6 api | `packages/api` | `/v1` HTTP handler and the service↔store adapter |
| L3 adapters | `packages/adapters` | executor contract, kind router, `mock`/`tool_chain`/`dsh_session`/`superagent` |

The runtime adds wiring, configuration, cost projection and stop orchestration.
It does **not** reimplement state transitions; every state change still goes
through `packages/service`.

## Usage

```js
import { createRuntime } from './packages/runtime/src/index.js';
import { createMockAdapter } from './packages/adapters/src/index.js';

const runtime = createRuntime({
  dbPath: 'control.sqlite', // ':memory:' in tests
  adapters: {
    mock: createMockAdapter({ usage: { tokens_in: 10, tokens_out: 5, cost_cny: 0.01 } }),
  },
  workspacePath: '/path/to/worktree', // used by stop verification
});

const goal = runtime.tasks.create({ level: 'goal', title: '…' });
const business = runtime.tasks.delegate({ parentTaskId: goal.id, title: '…' });
const execution = runtime.tasks.delegate({ parentTaskId: business.id, title: '…' });

const { run } = runtime.tasks.dispatch({ taskId: execution.id, executorKind: 'mock' });
await runtime.runs.dispatchToExecutor({ runId: run.id });
runtime.runs.ack({ runId: run.id });

const claimed = await runtime.runs.claim({ runId: run.id, claim, acceptanceItems });
// claimed.cost.recorded === true when the adapter reported usage

runtime.acceptances.decide({
  acceptanceId: claimed.acceptance.id,
  verdict: 'pass',
  itemStates: { 'auto.contract': 'pass' },
});

await runtime.stop.stop({ taskId: goal.id }); // verified quiescence or stop_unknown
await runtime.api.start({ port: 0 });         // /v1 HTTP on the same service/store
await runtime.close();
```

## Facade

| Member | Purpose |
|---|---|
| `tasks` | `create`, `delegate` (next level only), `get`, `list`, `queue`, `dispatch` |
| `runs` | `get`, `list`, `ack`, `claim`, `dispatchToExecutor`, `usage` |
| `acceptances` | `get`, `list`, `decide` |
| `cost` | `record`, `list`, `total`, `forRun`, `captureRunUsage` |
| `stop` | `request`, `verify`, `stop` |

Also exposed for tools: `api` (`start`/`close`/`url`/`server`), `service`,
`serviceStore`, `store`, `router`, `adapters`, `config`, `close`.

### Dispatch idempotency and outbox

`tasks.dispatch` derives an idempotency key from the task revision/cycle when the
caller does not supply one, so retrying the same dispatch replays the original
result and creates no second run. A dispatch on a `completed`/`cancelled` task is
refused even when an old idempotency record exists.

The run row, its idempotency record and a `dispatch_outbox` intent
(`intent='dispatch_run'`, `state='pending'`, id `outbox-<runId>`) are committed in
one transaction, so a crash can never leave a run without its intent.

### Cost accounting

`runs.claim` projects the adapter's `usage` into the L1 `cost_ledger` with the
deterministic row id `cost-<runId>`, so a retried claim or a restart never
double-bills a run. `cost.captureRunUsage` can be called explicitly for a
non-claim path. If an adapter has no usage data the ledger is left untouched
(`usage_unavailable`); the runtime never invents a cost.

### Stop = verified stop

`stop.stop` requests the stop, asks each live adapter to `cancel`, hashes the
workspace before and after cancellation, and passes that evidence to
`service.verifyStop`. A cancel that cannot prove the process is gone or that the
workspace stopped changing stays `stopping`/`stop_unknown`; it is never reported
as `cancelled`. Callers with their own evidence can call `stop.verify` directly.

## Tests

```sh
node --test packages/runtime/test
```

The suite uses only local code, `node:sqlite` and an in-process loopback HTTP
listener (`127.0.0.1:0`). No npm dependencies and no external network calls.

The suite is split into independent behavior cases, so a failure names the step
that broke. Covered:

- composition of store, service, api and adapters
- goal → business → execution delegation and the one-level guard
- dispatch writing a run plus a pending outbox intent, duplicate dispatch
  (same key and restart replay) and the one-active-run refusal
- claim opening acceptance without completing the task, and the duplicate-claim
  refusal
- completion refused without a passed acceptance, an incomplete passing verdict,
  completion after a pass, and no dispatch from a completed task
- revise deriving a rework run on the same task, and dispatching that run
- cost projection from executor usage, aggregation with explicit costs, no
  double-billing and no invented cost when usage is unavailable
- the `/v1` API reading the same service/store
- verified stop and the fail-closed `stop_unknown` path
