# `@dsbot-v3/cli` — operator CLI (L10)

A small command-line surface for the people running the task service: create a
goal, inspect state, dispatch, accept/reject, stop and query cost.

The CLI is **transport only**. It parses argv, projects stable output and calls
the L9 runtime facade. It never owns task state, run state, acceptance decisions,
stop verification or cost aggregation.

## Commands

```bash
node packages/cli/bin/cli.js task create --level goal --title "写一篇关于 AI 的文章" --json
node packages/cli/bin/cli.js task list --json
node packages/cli/bin/cli.js task get <task-id> --json
node packages/cli/bin/cli.js dispatch <task-id> --json
node packages/cli/bin/cli.js accept <run-id> --verdict pass --json
node packages/cli/bin/cli.js accept <run-id> --verdict reject --reason "来源不足" --json
node packages/cli/bin/cli.js stop <task-id> --reason user_stop --json
node packages/cli/bin/cli.js cost <task-id> --json
```

`--json` may appear anywhere. Help and version never load the runtime:

```bash
node packages/cli/bin/cli.js --help
node packages/cli/bin/cli.js task create --help
node packages/cli/bin/cli.js --version
```

`accept` accepts the operator vocabulary `pass|reject`; the adapter forwards the
service vocabulary `pass|fail`. An optional `--items '<json>'` passes item
states through to the acceptance decision (for example
`--items '{"auto.checks":"pass"}'`), because required items belong to the
runtime/acceptance policy, not to the CLI.

## `runCli(argv, deps)`

`packages/cli/src/index.js` exports the pure entry point:

```js
import { runCli } from '../src/index.js';

const result = await runCli(['task', 'list', '--json'], deps);
// { exitCode: 0, stdout: '{"command":"task.list",...}\n', stderr: '' }
```

It does not read `process`, the filesystem, a database or the network. All
effects come from `deps`:

| dep | call | result |
|---|---|---|
| `createTask(input)` | `{level, title, parentTaskId?, actor?}` | task |
| `listTasks(filter)` | `{level?, state?, limit?}` | task array |
| `getTask(taskId)` | task id | task or `{task, runs, acceptances, open_acceptance}` |
| `dispatchTask(taskId, options)` | `{executorKind?, idempotencyKey?}` | `{task, run}` |
| `acceptRun(runId, options)` | `{verdict: 'pass'\|'fail', reason?, itemStates?}` | `{task, acceptance, run?}` |
| `stopTask(taskId, options)` | `{reason?, requestedBy?}` | `{task, tasks, stopState, verified}` |
| `getCost(taskId)` | task id | `{taskId, total, entries?}` |

Tests inject scripted deps or a runtime fixture backed by
`packages/service` + its in-memory store; no real network or database file is
used.

## Runtime wiring

`packages/cli/src/from-runtime.js` adapts the L9 `createRuntime(...)` facade to
the deps above. The expected facade (verified against the L9 runtime branch) is:

```
runtime.tasks        create / get / list / dispatch({taskId, ...})
runtime.runs         get / list
runtime.acceptances  get / list / decide({acceptanceId, verdict, ...})
runtime.stop         stop / request({taskId, ...})
runtime.cost         total(taskId)
```

`task get` composes the task projection with `runs.list({taskId})`,
`acceptances.list({taskId})` and the task's open acceptance. `accept` resolves
the open acceptance for the run and calls `decide` with the service-level
verdict (`pass`/`fail`). `stop` prefers the full `stop.stop` path (cancel live
executors + verify quiescence) and falls back to `request`.

Common aliases (`createTask`, `getTask`, `requestStop`, `summary`, ...) are
accepted. `packages/cli/src/load-runtime.js` imports `packages/runtime` lazily;
if that package is absent (the L9 ticket is still open), the CLI reports
`runtime_unavailable` (503) instead of failing at module load, and `runCli` tests
continue to run.

`main`/`bin` pass these runtime options:

| env | default | meaning |
|---|---|---|
| `SUPERAGENT_DB_PATH` | `control.sqlite` | SQLite path (use `:memory:` for an ephemeral run) |
| `SUPERAGENT_WORKSPACE` | unset | workspace root whose writes must stop for verified stop |

## Output contract

Success (`--json`) is written to stdout:

```json
{"ok":true,"command":"task.create","data":{"task":{...}}}
```

Failure (`--json`) is written to stderr:

```json
{"ok":false,"command":"dispatch","error":{"code":"invalid_state_transition","status":409,"message":"...","details":{...}}}
```

Object keys are sorted recursively, so output is byte-stable and assertable.
Task/run/acceptance/cost projections use a fixed key set (snake_case) instead of
echoing internal runtime objects.

PRD client error statuses are surfaced verbatim in `error.status` and as the
process exit code: `403`, `409`, `422` (also `404`/`402`). Server errors
(`5xx`) collapse to exit code `1`; `--json` always carries the exact status.
POSIX shells only carry 8 bits, so `409`/`422` are exact on Windows and truncated
by a POSIX shell.

Text mode uses one stable line per command and writes errors to stderr as
`error <status> <code>: <message>`.

## Tests

```bash
node --test packages/cli/test
```

The suite covers parsing, every subcommand (JSON and text), the runtime adapter,
PRD error mapping and an end-to-end flow against the real in-memory service.
