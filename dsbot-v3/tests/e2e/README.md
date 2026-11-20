# L5 e2e — 10-step minimal closed loop (mock executor)

Re-runnable acceptance for the PRD's Phase 1 closed loop, built on the merged
layers:

- `packages/service` — task/run/acceptance state machine and guards (reused, not copied);
- `packages/adapters/mock` — executor contract with scripted completion, artifacts, evidence and usage (reused);
- `packages/store` — L1 SQLite `cost_ledger` for the cost-query step;
- `packages/service/src/memory-store.js` — reused by the journaled persistence fixture.

## Run

```sh
node --test tests/e2e
```

Exit code `0` means all steps passed. The suite is deterministic: no sleeps, no
network, no model calls, no real executor. `node:sqlite` prints its usual
`ExperimentalWarning`; it does not affect the exit code.

Each of the 10 steps below is its own top-level `node:test` case named
`stepNN …`, with a fresh journal/clock/id factory, so a failure identifies the
step directly. Rerun one step with:

```sh
node --test --test-name-pattern='step07' tests/e2e
```

## Step map

| # | PRD step | Asserted evidence |
|---|---|---|
| 1 | Create goal | `goal.state=planned`, no run/acceptance, `task.created` |
| 2 | Delegate business | child task with `parentTaskId=goal`, `delegation.created`, level skip rejected |
| 3 | Dispatch through the mock adapter | service run `dispatched`, adapter `accepted` with the same `run_id`, tracker modes, ack -> `running` |
| 4 | Duplicate dispatch creates no second run | same key replays the first run; a different key is 409; the adapter refuses `duplicate_dispatch` and adds no events |
| 5 | Restart recovery | a new service built from the persisted journal restores task/run states, event seq/hash chain and idempotency; retry still replays |
| 6 | Submission -> accepting | claim sets run `reported`, task `accepting`, opens round 1; task is not completed |
| 7 | Acceptance rejected -> reworking + new run | verdict `revise`, run `rejected`, task `reworking`, revision +1, queued `rework` run attempt 2 |
| 8 | New run passes acceptance | rework run dispatched, claimed and passed; task `completed`, run `accepted`; parents stay `running` (child pass never completes a parent) |
| 9 | Cost records queryable | executor `usage` per run plus L1 `cost_ledger` rows (2 runs, rework included) aggregate to the same tokens/cost |
| 10 | One-click stop + verified quiescence | `requestStop(goal)` freezes the subtree; missing proof cannot cancel; executor cancel + unchanged workspace hash -> `stop_verified`, child-first cancellation, no new dispatch |

The service uses `revise` for the acceptance round (`acceptance.revise`); the
old run is the `rejected` record required by the ticket wording.

## What is a fixture, not product code

- `support/journal-store.js` wraps the shipped memory store and journals writes
  to JSON so step 5 can rebuild the projection from disk. It exists because the
  L6 service -> SQLite bridge is a separate ticket; it reimplements no transition
  or guard logic.
- `support/cost-ledger.js` projects the service task/run ids into the L1 store
  and records the executor usage there, again standing in for the not-yet-merged
  L6 bridge. `cost_ledger` itself is the shipped L1 implementation.

## Limits

- Mock executor only; a real DSH/SuperAgent run is not exercised here (PRD 17 §7
  keeps that as a separate, later acceptance).
- "Restart" means a fresh service instance over the persisted journal, not an OS
  process kill; the executor object stays alive across it, as a separate process
  would.
