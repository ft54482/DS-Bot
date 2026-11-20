# `@dsbot/taskpack`

L47 task pack contract (`docs/prd/16-execution-paths.md`, PRD FR-19). One task
definition is built, validated and routed to one of the two DSH executor paths —
`dsh_session` or `superagent` — so the two paths share the same task, budget and
routing vocabulary.

```js
import {
  buildTaskPack,
  validatePack,
  choosePath,
} from '@dsbot/taskpack';

const taskPack = buildTaskPack({
  goal: 'Refactor the retrieval module across three files',
  constraints: ['no new dependencies', 'do not touch packages/api'],
  acceptance: {
    auto: ['node --test packages/retrieval/test exits 0'],
    independent: ['a reviewer reruns the tests on the exact commit'],
  },
  contextRefs: ['docs/prd/16-execution-paths.md'],
  workspace: { path: 'packages/retrieval', baseCommit: '0864d0b' },
  budget: { cny_cap: 30 },
  signals: { estimatedSteps: 9, multi_file: true }, // optional hints
});

const decision = choosePath({
  taskPack,
  capability: {
    dsh_session: { available: true, bridge_version: '0.2.3' },
    superagent: { available: false, reason: 'G-SA-1: no local ticket API' },
  },
});
```

```json
{
  "executor_kind": "dsh_session",
  "routing_reason": {
    "path": "dsh_session",
    "requested_path": "superagent",
    "score": 3,
    "why": ["steps>5", "multi_file", "independent_acceptance", "superagent_unavailable"],
    "degraded": true,
    "reason": "superagent capability unavailable: G-SA-1: no local ticket API"
  }
}
```

## Task pack

`buildTaskPack(input)` returns a validated pack:

```json
{
  "schema_version": "1.0.0",
  "goal": "…",
  "constraints": ["…"],
  "acceptance": { "auto": ["…"], "independent": ["…"] },
  "context_refs": ["…"],
  "workspace": { "path": "…", "base_commit": "…" },
  "budget": { "cny_cap": 5 },
  "signals": {
    "estimated_steps": 9,
    "stages": ["probe", "implement"],
    "multi_file": true,
    "multiple_rounds": true,
    "isolated_worktree": true,
    "long_running": true
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Current version is `1.0.0`; a reader rejects a newer pack. |
| `goal` | yes | Non-empty string. |
| `constraints` | yes | Array of non-empty strings; `[]` is allowed. Duplicates are removed. |
| `acceptance` | yes | One criterion minimum. A string or string array is normalized to `{auto, independent}`; independent checks force `superagent`. |
| `context_refs` | yes | Array of non-empty strings; `[]` is allowed. Duplicates are removed. |
| `workspace` | yes | `path` is mandatory; `base_commit` is optional. `baseCommit` is accepted as input. |
| `budget` | yes | `cny_cap` must be a positive finite number. Default schema ceiling: `1000` CNY. |
| `signals` | no | Optional routing hints; see below. |

Input aliases: `contextRefs`, `baseCommit`, `cnyCap`; signal hints may be passed
as a `signals` object or as top-level camelCase/snake_case keys. The output is
always canonical snake_case.

## Validation

`validatePack(pack, {budgetLimits})` never throws on invalid data. It collects
every problem:

```js
{ ok: true, pack }
{ ok: false, errors: [{ code, path, message }, ...] }
```

| Code | Meaning |
|---|---|
| `invalid_pack` | Required field missing or malformed. `path` names the field (`goal`, `workspace.path`, `context_refs[1]`, `$` for a non-object pack). |
| `unknown_field` | A field outside the schema, at any level (`owner`, `workspace.owner`, `signals.parallelism`). |
| `unsupported_schema_version` | The pack's `schema_version` is not supported. |
| `budget_exceeded` | `budget.cny_cap` is above the schema ceiling. |

`assertValidPack(pack, options)` returns the pack or throws `TaskPackError` with
`code`, `path` and the complete `errors` list. `buildTaskPack` throws the same
error on malformed input, so it never returns a partial pack.

## Routing

`choosePath({taskPack, capability})` returns
`{executor_kind, routing_reason}`; `routing_reason.path` always equals
`executor_kind`.

| Signal | Ordinary session | SuperAgent |
|---|---|---|
| `estimated_steps` | `<= 5` | `> 5` |
| `stages` | at most one | more than one |
| `multi_file` | single file | multiple files |
| `multiple_rounds` | single verification round | multiple rounds |
| `isolated_worktree` | shared workspace | isolated worktree |
| `long_running` | short | long-running / cross-day |
| `acceptance.independent` | empty | non-empty |

A pack with no signals routes to `dsh_session` (`why: ["simple_single_step"]`).
Otherwise every evaluated hint is recorded in `why`, and `score` counts the
complexity indicators.

`capability` accepts booleans or `{available, reason}` per path. A missing or
malformed entry counts as **unavailable**, never as available. If the requested
path is unavailable, the router uses the other path and marks the decision
`degraded: true`, adds `requested_path` and a `reason`, and keeps
`why` including `<path>_unavailable`. The caller must surface that record
(PRD 16: degradation is never silent). When neither path is available,
`choosePath` throws `executor_unavailable` instead of pretending a path exists.

## Purity

All exports are pure: no file, network or clock access, no randomness, no input
mutation, and the same input always yields the same pack and decision. The suite
checks this by scanning the source modules and by freezing inputs.

## Run the tests

```sh
node --test packages/taskpack/test
```

The suite covers the versioned pack shape, aliases and normalization, every
validation code and field path, one-pass error collection, the routing table,
capability degradation in both directions, `executor_unavailable`, determinism,
input immutability and the no-IO guarantee.
