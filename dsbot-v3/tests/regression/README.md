# L27 one-command regression

`run.mjs` is the single entry point for the full DS Bot V3 regression: every
package test directory, the cross-package suites, and the DDL verifier run in
one command, and a machine-readable `report.json` is written to a fresh
temporary directory.

```sh
node tests/regression/run.mjs
```

Exit code `0` means every executed suite passed. Exit code `1` means at least
one suite failed or crashed, or a required suite path is missing; the runner
prints the failed suite names and the failing test names before exiting.

## What it runs

| Kind | Discovery | Command (cwd) |
|---|---|---|
| package | every `package.json` with a sibling `test/` under `packages/`, including nested package roots such as `packages/pipelines/content` | `node --test --test-reporter=tap test` |
| node-test | `tests/e2e`, `tests/contract`, `tests/conformance` | `node --test --test-reporter=tap` |
| script | `tools/verify/verify.mjs` | `node tools/verify/verify.mjs` |

Suites run sequentially from the repository root, so a slow suite cannot make
another suite's timing noisy and each failure has one owner. Package discovery
is dynamic: a new `packages/<name>/test` directory is picked up without editing
the runner. A required path that disappears is reported as a synthetic failing
suite instead of being skipped silently.

The baseline at `0b415f30561accb2253fd398afd388bdbf05a422` is 22 suites:
18 package suites (16 top-level packages plus the two nested pipeline packages)
and the four fixed suites, 647 tests, about 18.6 s on Node v25.2.0.

## Report

The default report directory is:

```text
<os tmpdir>/dsbot-v3-regression/<run id>/report.json
<os tmpdir>/dsbot-v3-regression/<run id>/logs/<suite>.log
```

The absolute path is printed as the last line (`Report: ...`). `--report-dir`
puts the run in a chosen directory, and `--report <file>` writes the report at
an exact path. The report directory also keeps one TAP/script log per suite, so
a failure can be reproduced without rerunning the whole command.

```json
{
  "suite": "dsbot-v3-regression",
  "run_id": "2026-11-20T16-55-22-037Z-27264",
  "started_at": "2026-11-20T16:55:22.040Z",
  "finished_at": "2026-11-20T16:55:40.635Z",
  "duration_ms": 18594,
  "base_commit": "0b415f30561accb2253fd398afd388bdbf05a422",
  "head_commit": "0b415f30561accb2253fd398afd388bdbf05a422",
  "dirty": false,
  "node": "v25.2.0",
  "platform": "win32",
  "arch": "x64",
  "budget_ms": 120000,
  "within_budget": true,
  "items": [
    {
      "name": "packages/store",
      "kind": "package",
      "path": "packages/store/test",
      "command": "node --test --test-reporter=tap test",
      "exit": 0,
      "pass": 18,
      "fail": 0,
      "duration_ms": 1116,
      "slow": false,
      "timed_out": false,
      "status": "passed",
      "log": "logs/packages-store.log"
    }
  ],
  "totals": {"items": 22, "pass": 647, "fail": 0, "duration_ms": 18594, "slow": 0},
  "failed": [],
  "slow": [],
  "timed_out": [],
  "incomplete": false,
  "ok": true
}
```

Each item always carries `name`, `exit`, `pass`, `fail` and `duration_ms`;
`totals` sums the counts and wall time. A failed item additionally carries
`failed_tests` (TAP `not ok` names or verifier `[FAIL]` names) when available.
The `pass`/`fail` counts come from the TAP summary (`# pass` / `# fail`) or the
verifier's `Summary: N passed, M failed` line. A suite that exits without a
summary (a crash) is counted as one failure rather than being treated as green.

## Slow suites and timeouts

- `--timeout-ms <n>` (default `120000`) is a hard per-suite timeout. A timed-out
  suite is killed, marked `timed_out: true` and `slow: true`, and its partial
  TAP counts are kept. The timeout itself does not set exit code `1`; only real
  test failures, crashes, or missing suites do. A timed-out run is marked
  `incomplete: true` so callers can tell the coverage is partial.
- `--slow-ms <n>` (default `30000`) marks any suite above that wall time as
  `slow` without blocking it.
- `--budget-ms <n>` (default `120000`) is the overall runtime target. Exceeding
  it sets `within_budget: false` and lists the run as slow, but does not change
  the exit code.

These rules implement the ticket's "timeout marks slow, does not block" rule:
the report is honest about slow or incomplete work while a legitimately slow
suite cannot turn an otherwise green regression red.

## Options

```text
--report-dir <dir>   directory for report.json and logs
--report <file>      exact report.json path; overrides --report-dir
--timeout-ms <n>     hard per-suite timeout (default 120000)
--slow-ms <n>        per-suite slow threshold (default 30000)
--budget-ms <n>      overall runtime target for the slow flag (default 120000)
--verbose            print each suite's full captured output
--help, -h           usage
```

`REGRESSION_REPORT_DIR` behaves like `--report-dir` when the flag is absent.

## Scope

This directory only contains the runner and its documentation. It is a thin
orchestrator over the existing suites: it does not reimplement test logic,
change package test scripts, or write outside the report directory. The report
records the base (`origin/main`) and head commits that produced the run, so a
regression result can be tied to the revision under test.
