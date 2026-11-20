# M5 10-step drill

Executable acceptance drill for `docs/prd/09-wbs.md` §1.3 / S6. It runs the ten
steps on a **simulated link** and produces a machine-readable report plus an
evidence pack.

```sh
node tests/m5-drill/run.mjs --out C:\tmp\m5-drill
node --test tests/m5-drill/test
```

`--out` is created if missing. Without it the artifacts go to a fresh OS temp
directory. The drill makes no network call and never writes inside the
repository. Exit code is `0` only when all ten steps, the report contract and
the evidence hashes pass.

## What is real

The drill imports the shipped production components; it does not reimplement
the state machine:

| Concern | Component |
|---|---|
| task/run/acceptance transitions, guards, idempotency, stop verification | `packages/service` |
| composition root, dispatch outbox, cost projection, stop orchestration | `packages/runtime` |
| durable task/run/acceptance/outbox/event/cost rows | `packages/store` (SQLite, temp path) |
| executor | `packages/adapters/src/mock.js` (scripted content and usage) |

The only drill-side glue is deterministic clock/id injection, fixture sources,
the result-package assembly and the report/evidence writer. The mock is a
simulated executor by design: the drill proves the task-service loop, not an
external content tool chain.

### Known limitation carried by the drill

The L2 service derives a rework run from `task.executorKind`, but the task
projection does not persist that field, so a derived run defaults to
`dsh_session`. Step 8 therefore pins `executorKind=mock` on the already-created
run through the store before routing it. This changes routing metadata only,
not a state transition; fixing the package would need a change outside
`tests/m5-drill/**`.

## Steps

| # | Action | Main assertion |
|---|---|---|
| 1 | create goal | `planned`, budget `cnyCap=2`, allow/deny scope, `mustConfirm` |
| 2 | delegate business | `delegation.created`, goal/business `queued` |
| 3 | dispatch execution | durable `dispatch_run` outbox intent, executor accepted, run `running` |
| 4 | duplicate dispatch | same key replays; a different key is `409`; one run and one outbox row |
| 5 | restart the task service | reopen the same SQLite file; tasks/run/outbox/event hashes intact; replay creates no new run |
| 6 | submit | run `reported`, task `accepting`, acceptance round 1, usage billed once |
| 7 | inject a factual error | acceptance `revise`; task `reworking`; revision 1; exactly one rework run |
| 8 | rework passes | corrected claim → acceptance `passed` → task `completed`; result package with manuscript, sources and a pending publish decision |
| 9 | cost query | task/run/acceptance levels, business/goal roll-up, retry cost, reconciliation |
| 10 | one-click stop | a live follow-up run is cancelled, quiescence hash is stable, stop is `verified`, re-dispatch is refused |

Step 10 runs with a live follow-up execution so the executor cancel and the
workspace-hash proof are exercised for real; the already-completed child stays
`completed`. A separate scenario (run in the same drill) covers the required
`stop_unknown` case: an unverified cancel stays `stopping`, the run stays
`running`, and the report never claims "stopped".

## Cost fixture

The mock executor reports `0.12 CNY` for the first attempt and `0.18 CNY` for
the rework attempt; each acceptance round records a `0.01 CNY` review row
through the runtime cost ledger. The report exposes:

- `cost.levels` — the three ledger attribution levels: `task`, `run`,
  `acceptance` (PRD 04 §4.1.1);
- `cost.hierarchy` — execution/business/goal roll-up (PRD 00 G8);
- `cost.retry` — the rework run's cost and the whole rejected+rework cycle cost;
- `cost.reconciliation` — task total equals run + acceptance rows, every run is
  billed once.

## Artifacts

```text
<out>/drill-report.json
<out>/evidence/
  manifest.json                 # sha256 of every evidence file
  step-01-...json ... step-10-...json
  tasks.json runs.json acceptances.json events.json outbox.json
  costs.json result-pack.json restart.json stop.json stop-unknown.json
  rework.json
```

Every step record has exactly `{step, action, expect, actual, ok,
evidenceRef}`; `actual` is read back from the runtime, never copied from
`expect`. `report.result.ok` is the gate.

## Tests

`node --test tests/m5-drill/test` runs 14 cases:

- the CLI contract, report shape and step ordering;
- cost levels/roll-up/retry/reconciliation;
- restart recovery without duplicate run or outbox row;
- verified stop, stable workspace and refused re-dispatch;
- evidence references and manifest hashes;
- no writes inside the repository;
- failure paths: malformed claim, dispatch on a completed task, `stop_unknown`,
  missing stop evidence, duplicate cost capture.
