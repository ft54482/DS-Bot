# `@dsbot/agents` — Chief / business bot tool surface (L21)

Thin, authorized wrappers over the L9 runtime (`packages/runtime`) for the two
management roles in `docs/prd/02-api-contract.md` §5 and PRD FR-14:

| Role | Tools |
|---|---|
| Chief | `delegate`, `status`, `accept`, `stop`, `cost` |
| Business bot | `plan`, `dispatch`, `accept`, `rework` |

Each factory takes the composed runtime and the role's configured scope:

```js
import { createChiefTools, createBusinessTools } from '@dsbot/agents';

const chief = createChiefTools({ runtime, scope: chiefScope });
const contentBot = createBusinessTools({ runtime, scope: businessScope });
```

## Scope

The scope is the same object `packages/authz` already understands, plus two
agent-facing fields:

```js
{
  projects: ['self-media'],          // task trees this bot may touch
  executors: ['tool_chain'],         // executor kinds it may dispatch (legacy alias: tools)
  spend_cny_cap: 20,                 // bot-level budget ceiling (CNY)
  max_delegate_level: 'business',    // delegation ceiling
  // ...any other authz scope key (paths, git, ...)
}
```

* An absent `projects` means unconstrained; when present, a task without a
  resolvable project is denied (`authorization_exceeded`), not guessed. Project
  attribution comes from `task.subject.project` or the task's delegated
  `authScope` (`projects`/`project`), including its tree.
* An absent `executors`/`tools` allow-list is fail-closed: `dispatch` is denied.
  Dispatch checks the executor that the queued run will actually use, so a
  service-derived rework run cannot bypass the allow-list.
* A task's own `authScope` is intersected with the bot scope before every
  operation, so a delegated narrowing cannot be widened by the tool layer.

## Result contract

Tools never throw for authorization or state-machine outcomes; they return:

```js
{ ok: true, tool: 'status', ... }
{ ok: false, code: 'not_allowed' | 'authorization_exceeded' | 'budget_exceeded' |
  'validation_error' | <service error code>, message, details? }
```

Known but unauthorized tools are installed as non-enumerable denials, so
`chief.dispatch(...)` returns `not_allowed` while `Object.keys(chief)` remains
exactly the five Chief tools. `invoke(name, input)` is the uniform entry point
for a model-driven tool loop.

`dispatch` and `stop` are asynchronous because executor hand-off and
stop verification are async; all other tools are synchronous.

## Boundaries

This package deliberately contains no task, run, acceptance, stop or cost
logic. It calls the runtime facade (`runtime.tasks.*`, `runtime.runs.*`,
`runtime.acceptances.*`, `runtime.stop.*`, `runtime.cost.*`) and delegates scope
containment and the budget min-chain to `packages/authz`. Hierarchy rules that
already exist in the service (goal→business→execution, acceptance service
identity, human goal sign-off) are preserved, never re-implemented.

Specifically:

* the Chief has no dispatch path at all; asking for one returns `not_allowed`;
* a business bot cannot decide a goal acceptance or reopen a goal round;
* neither bot may mark a `human.*` acceptance item as passed;
* budget checks compose the task cap, the parent's remaining budget and
  `scope.spend_cny_cap`, and an exhausted cap blocks before any side effect.

## Test

```sh
node --test packages/agents/test
```
