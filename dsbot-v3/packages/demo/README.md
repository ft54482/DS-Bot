# `@ds-bot/demo` — L29 one-command end-to-end self-media demo

One command shows the Phase 1 self-media loop across the shipped packages,
with every external dependency stubbed:

```sh
node packages/demo/run.mjs --out /tmp/dsbot-demo
```

The command exits `0`, prints a short summary and writes three files to `--out`:

| File | Meaning |
|---|---|
| `article.md` | The article the mocked pilot produced (executor artifact). |
| `publish-package.json` | The ready-for-review package; `license_status: "unauthorized"`, `publish.executed: false`. |
| `demo-report.json` | Per-step timings, task ids, flow states, stub call counts, cost and the `verify` result. |

No file outside `--out` is written: the runtime uses `:memory:` SQLite and the
only executor is the scripted `mock` adapter.

## Flow

```text
goal task (human owner, queued)
  └─ Chief delegates a business task (packages/agents, queued)
       └─ business bot plans an execution task (packages/agents)
            └─ dispatch to the mock executor (packages/adapters)
                 └─ self-media pilot (packages/pipelines/selfmedia)
                      search/fetch/model stubs only (src/fixtures.js)
                      -> content chain -> acceptance profile -> publish package
                 └─ executor claim + business acceptance pass
                      (acceptance items are the pilot's 11 profile items)
                 └─ publish-package.json written with license unauthorized
```

The demo intentionally stops before goal sign-off: a human goal acceptance is
outside an offline demo, and publishing always needs a separate
`publish_authorization` record (the package records the rejected decision with
`publish_authorization_required`).

## `demo-report.json`

Key fields:

```jsonc
{
  "steps": [
    { "id": "create-goal", "status": "passed", "duration_ms": 9.4,
      "started_at": "2026-11-20T12:00:00.000Z", "task_id": "task-1" }
    // delegate-business, plan-execution, dispatch-mock, selfmedia-pilot,
    // acceptance, publish-package, verify
  ],
  "ids": {
    "goal": "task-1", "business": "task-4", "execution": "task-8",
    "run": "run-11", "acceptance": "acc-19", "claim": "claim-18"
  },
  "flow": {
    "goal": { "level": "goal", "state": "queued" },
    "business": { "level": "business", "state": "queued", "parent_task_id": "task-1" },
    "execution": { "level": "execution", "state": "completed", "parent_task_id": "task-4" },
    "run": { "executor_kind": "mock", "state": "accepted", "mock_state": "completed" },
    "acceptance": { "state": "passed", "items": [/* 11 passing items */] }
  },
  "pilot": {
    "review_result": "pass", "acceptance_result": "pass",
    "rework_rounds": 0, "sources": ["https://alpha.example/…", "https://beta.example/…"]
  },
  "external_calls": {
    "mode": "stubbed", "search": 1, "fetch": 2,
    "model_write": 1, "model_review": 1, "unexpected_urls": []
  },
  "publish_package": {
    "status": "ready_for_review", "license_status": "unauthorized",
    "license": { "allowed": false, "authorization": null,
                 "decision": { "result": "rejected",
                               "reasons": [{ "code": "publish_authorization_required" }] } },
    "publish": { "executed": false, "authorization": null }
  },
  "verify": { "ok": true, "summary": "10/10 checks passed", "checks": [/* named checks */] }
}
```

`verify` is the demo's own gate. It fails the run (exit `1`) if the task tree,
mock completion, stub-only external calls, pilot acceptance, runtime acceptance
or unauthorized license no longer hold.

## Tests

```sh
node --test packages/demo/test
```

11 cases cover the end-to-end run, report/artifact shape, the task tree,
acceptance, stub-only pilot behavior, the unauthorized license, run isolation,
CLI parsing and the spawned `run.mjs` command. They use OS temp directories and
never touch the network or write inside the repository.

## Limitations

- The mock executor proves the dispatch/claim plumbing; the pilot itself is
  invoked in-process by the demo after the mock run completes, not inside the
  adapter process.
- The goal and business tasks stay `queued`: the demo has no scheduler and no
  aggregate/human sign-off, so it does not complete the parent levels.
- Search, fetch and model are deterministic stubs, not provider integrations.
  The report records their call counts so the offline claim is observable.
