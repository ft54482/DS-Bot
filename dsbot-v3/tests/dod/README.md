# L30 — executable goal DoD checks

One command runs the goal's ten Definition-of-Done checks. Each check executes a
real `node --test` subprocess and derives its verdict from that subprocess's exit
code and printed summary; no assertion from the suites is copied here.

```sh
node tests/dod/run.mjs
```

Exit code `0` means all ten checks passed. Exit code `1` means at least one
check failed, timed out, or could not run.

## Usage

```sh
node tests/dod/run.mjs
node tests/dod/run.mjs --out .agent/tmp/dod-report.json
node tests/dod/run.mjs --timeout 600000
```

| Option | Meaning |
|---|---|
| `--out <path>` | Report path. Default: `<os.tmpdir()>/dod-report.json`. |
| `--timeout <ms>` | Per-check timeout. Default: `600000` (10 minutes). |
| `-h`, `--help` | Print usage. |

The default report is written to the system temporary directory. The checker
does not write into the repository unless `--out` explicitly names a repository
path. It performs no network access of its own.

## The ten items

| # | id | What it runs |
|---|---|---|
| 1 | `full-regression` | Every `packages/**/test` directory plus every `tests/*` directory that looks like a `node:test` suite (an `index.js` entry or at least one `*.test.js`), excluding `tests/dod`. Discovered at run time. |
| 2 | `e2e-10-steps` | `tests/e2e` — the PRD's ten-step minimal closed loop. Also requires exactly ten `stepNN` cases, all passing. |
| 3 | `contract` | `tests/contract` — cross-package contract suite. |
| 4 | `conformance` | `tests/conformance` — PRD hard-rule conformance suite. |
| 5 | `metrics` | `packages/metrics/test` — north-star metrics. |
| 6 | `scheduler` | `packages/scheduler/test` — dispatch scheduler. |
| 7 | `recovery` | `packages/recovery/test` — restart reconciliation. |
| 8 | `authz` | `packages/authz/test` — scope, budget and hard-rule gates. |
| 9 | `events` | `packages/events/test` — outbox, inbox dedupe and watermark. |
| 10 | `selfmedia` | `packages/pipelines/selfmedia/test` — self-media pilot. |

Every check is the command:

```sh
node --test --test-reporter=spec <paths...>
```

The checker spawns `process.execPath` (the Node running the checker) but records
`node` in the report's `cmd` field so the command is directly reproducible.

## Verdict rules

A check passes only when all of the following hold:

1. The subprocess exit code is `0`.
2. The output contains a `node:test` summary with `tests > 0` and `fail == 0`.
3. No test was skipped.
4. For `e2e-10-steps`, the summary reports exactly 10 tests and the output names
   exactly the ten `step01`..`step10` cases.

A suite that silently runs zero tests, skips cases, or renames/drops an e2e step
therefore fails even if `node --test` exits `0`.

On failure the check prints an indented raw-output excerpt (up to 40 lines,
starting at the first failure marker) and records a short failure line in the
report. The report item shape is exactly:

```json
{
  "id": "metrics",
  "name": "北极星指标",
  "cmd": "node --test --test-reporter=spec packages/metrics/test",
  "exit": 0,
  "pass": true,
  "evidence": "tests=31 pass=31 fail=0 skipped=0 duration_ms=211.26"
}
```

The report as a whole is:

```json
{
  "schema": "dod-report/v1",
  "generatedAt": "...",
  "node": "v25.2.0",
  "platform": "win32",
  "root": "<repo>",
  "summary": { "total": 10, "passed": 10, "failed": 0 },
  "items": [ /* ten items, in goal order */ ]
}
```

## Requirements and limitations

- Node.js with `node:test` directory arguments. This repository's packages
  require Node `>=22.13.0`; the checker itself uses no npm dependencies.
- The checker runs the suites as they are. It deliberately does not retry or
  mask failures; a failing suite is a failing DoD item.
- `packages/store/test/dao.test.js` contains a pre-existing timing-sensitive
  assertion (event ordering when two `Date.now()` values land in the same
  millisecond). Under heavy machine load it can fail independently of this
  checker; the current repository baseline hits this intermittently. Treat that
  as a product/test finding, not as a checker retry case.
