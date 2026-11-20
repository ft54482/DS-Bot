# `@dsbot/chief` — L46 Chief coordination layer

The Chief is the goal-level manager in the PRD's **two management levels, one
execution level** model (`docs/prd/00-PRD.md` §3, §5). It creates goals, hands
business work to registered professional BOTs, aggregates their status, and
produces one result package upward.

It never dispatches execution work: execution belongs to a business BOT, which
owns its DSH/SuperAgent sessions. `chief.dispatchExecution(...)` and the
`dispatch`/`plan`/`rework` aliases return `not_allowed` without touching the
runtime.

## Contract

```js
import * as acceptance from '@dsbot/acceptance';
import * as metrics from '@dsbot/metrics';
import { createChief } from '@dsbot/chief';

const chief = createChief({
  runtime,                    // packages/runtime facade
  agents: {                   // registered professional BOTs
    content: {
      scope: {
        projects: ['self-media'],
        executors: ['dsh_session'],
        spend_cny_cap: 50,
        max_delegate_level: 'business',
      },
    },
  },
  acceptance,                 // { evaluate }
  metrics,                    // { computeMetrics }
  scope: {                    // the Chief's own authorization scope
    projects: ['self-media'],
    spend_cny_cap: 200,
    max_delegate_level: 'goal',
  },
});
```

`agents` is the registry of professional BOTs. Each key is the bot name used by
`delegate`; each value may be a descriptor (`{scope, acceptanceProfile}`), a
plain scope object, or an already-built business tool surface. `createChief`
also accepts `{chief: <prebuilt chief tools>, bots: {...}}`, a `Map`, an array of
bot names/descriptors, or the `@dsbot/agents` module namespace.

`acceptance` and `metrics` are injected, not imported by the caller's tests:
the package composes `evaluate({stage:'business', ...})` and
`computeMetrics({tasks,runs,acceptances,costs})` instead of re-implementing
either.

## Methods

### `openGoal({title, scope, budgetCny, mustConfirm})`

Creates a `goal` task owned by `chief`. `scope` accepts a project string, a
project array, or an auth-scope object. The budget becomes `budget.capCny`; a
budget above the Chief's `spend_cny_cap` returns `budget_exceeded` before any
write. `mustConfirm` defaults to `true` and is recorded on the goal subject; it
only controls whether `deliver` surfaces a pending human-confirmation decision.

Returns `{ok, tool:'openGoal', goalId, goal, task}`.

### `delegate({goalId, bot, brief})`

Creates a `business` task under the goal and hands it to the named bot. `brief`
may be a string (used as the title) or:

```js
{
  title: 'business: draft the article',
  brief: 'Draft one article from the checked sources.',
  scope: { projects: ['self-media'], max_delegate_level: 'business' },
  budgetCny: 30,             // or { capCny: 30 }
  subject: { note: '...' },
  acceptanceProfile: { ... } // optional
}
```

The delegation goes through `@dsbot/agents`' `createChiefTools().delegate`, so
hierarchy, scope containment and the budget min-chain are enforced by the
existing implementation. The Chief adds:

* `unknown_bot` when `bot` is not registered;
* `budget_exceeded` when the delegation exceeds the goal's remaining budget or
  the bot's `spend_cny_cap`;
* `not_allowed` when `goalId` is not a goal (or is terminal).

Returns `{ok, tool:'delegate', goalId, bot, task, businessTask}`.

### `status({goalId})`

Aggregates the goal and its business delegations without execution logs:

```json
{
  "ok": true,
  "goal": { "id": "...", "title": "...", "state": "running", "mustConfirm": true },
  "businesses": [
    {
      "id": "...",
      "state": "completed",
      "acceptance": { "state": "passed", "result": "pass", "accepted": true },
      "cost": { "cny": 2.5, "entries": 3 },
      "blockers": []
    }
  ],
  "counts": { "completed": 1 },
  "acceptance": { "total": 1, "passed": 1, "rework": 0, "blocked": 0, "pending": 0, "missing": 0, "allPassed": true },
  "cost": { "cny": 2.5, "capCny": 100, "remainingCny": 97.5, "entries": 3, "runs": 2 },
  "blockers": [],
  "metrics": { "cost_per_accepted_task": 2.5, "...": "..." }
}
```

For every business round the Chief reads the latest acceptance record and asks
the injected acceptance engine for an independent business-stage result. A
recorded round is never upgraded: a `passed` round with a failed required item
is reported as `rework`, and a round that cannot be judged is `blocked`.
Missing rounds are `missing`, open rounds are `pending`. A business with a
`blocked`/`paused`/`cancelled` task contributes a blocker even if an older
acceptance passed. A metrics failure is reported as `metricsError` and does not
break the status view.

### `deliver({goalId})`

Produces the PRD result package only when **every** business delegation has a
passed acceptance (and no task-level blocker):

```json
{
  "ok": true,
  "outcome": "done",
  "summary": "1 business delegation(s) passed acceptance for goal \"...\".",
  "deliverables": [{ "name": "article", "path": "article.md", "sha256": "..." }],
  "acceptance": { "stage": "business", "result": "passed", "businesses": [] },
  "cost": { "cny": 2.5, "capCny": 100, "remainingCny": 97.5 },
  "risks": [],
  "needs_decision": [],
  "must_confirm": false,
  "needs_confirmation": false
}
```

When something is not accepted yet:

```json
{
  "ok": false,
  "code": "blocked",
  "message": "1 of 2 business delegation(s) have not passed acceptance",
  "blockers": [{ "taskId": "...", "code": "acceptance_rework", "message": "..." }],
  "pending": [{ "taskId": "...", "acceptanceState": "revise", "result": "rework" }]
}
```

The same `blockers` / `pending` arrays are available under `details`. A goal
with no delegations is also `blocked`. The returned object is the package
itself; a non-enumerable `package` property points at the same object for
callers that prefer `result.package`.

## Error codes

| Code | Meaning |
|---|---|
| `not_allowed` | The Chief tried to cross management levels, including any execution dispatch |
| `unknown_bot` | `delegate` named a bot that is not registered |
| `budget_exceeded` | Goal/bot/remaining budget would be crossed |
| `blocked` | `deliver` has unaccepted business delegations |
| `not_found` | The goal id does not exist |
| `validation_error` | Malformed title/scope/budget/brief |
| `authorization_exceeded` | The agent layer rejected the delegation scope |
| `tool_error` | An unexpected runtime failure |

Every method returns a result object instead of throwing for domain failures;
constructor and malformed dependency errors throw `TypeError` immediately.

## Boundaries

This package contains no task, run, acceptance, stop, budget or metric
implementation. It composes:

* `@dsbot/runtime` — `tasks.*`, `runs.list`, `acceptances.list/get`, `cost.*`;
* `@dsbot/agents` — `createChiefTools` for guarded delegation;
* `@dsbot/acceptance` — `evaluate` for the business acceptance view;
* `@dsbot/metrics` — `computeMetrics` for the goal subtree projection.

## Test

```sh
node --test packages/chief/test
```

The suite uses fakes for runtime/agents/acceptance/metrics plus two composition
tests against the real packages (in-memory runtime).
