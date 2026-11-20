# `@dsbot/context`

L14 level-aware context pack assembly (`docs/prd/00-PRD.md` §7, G9 and
`docs/prd/04-reliability-ops.md` §1.7). It turns one task plus the layer's
recent dialogue and open questions into the same five-part shape for every
prompt:

```js
import { buildContextPack } from '@dsbot/context';

const pack = buildContextPack({
  level: 'business', // goal | business | execution
  task,
  recent,
  open_questions: task.open_questions,
  budgets: { business: 80_000 },
  countTokens, // optional; defaults to a deterministic byte estimate
});
```

```json
{
  "identity": {
    "role": "business_bot",
    "level": "business",
    "principal": "bot:content",
    "scope": { "projects": ["ai-video"], "bot_scope": "bot:content" },
    "rules_version": "v1",
    "visible": ["own_task_pack", "business_conclusions", "open_questions"],
    "hidden": ["other_bot_tasks", "chief_dialogue", "execution_logs"]
  },
  "task_pack": {
    "task_id": "task-biz-1",
    "level": "business",
    "goal": "Ship L14",
    "scope": { "allowed_paths": ["packages/context/**"] },
    "acceptance": { "stage": "business", "criteria": ["node --test exits 0"] },
    "conclusions": ["Assembly implemented."],
    "latest_run": { "run_id": "run-1", "state": "accepted", "summary": "tests pass" }
  },
  "recent": [{ "role": "user", "text": "Please do L14" }],
  "open_questions": [
    { "id": "esc-1", "question": "Which budget?", "options": ["60k", "80k"] }
  ],
  "pointers": [
    {
      "kind": "task",
      "id": "task-biz-1",
      "ref": "task:task-biz-1",
      "uri": "/v1/tasks/task-biz-1"
    }
  ]
}
```

The output has exactly these five keys. `buildContextPack` is pure: no
database, file, network, clock or randomness. It does not mutate its input.

## Budgets

| Level | Effective budget | Source |
|---|---|---|
| `goal` | `min(configured, 60_000)` | PRD G9 hard cap |
| `business` | `min(configured, 80_000)` | PRD G9 hard cap |
| `execution` | `budgets.execution` | no PRD-wide cap; the caller must configure it |

`budgets` may be a positive number (applies to the requested level) or an
object keyed by level. `budgets.executor` is accepted as an execution alias.
Configuring a goal/business budget above its PRD cap is clamped; the cap is not
raised. A missing execution budget throws `TypeError`.

## Trim order

If `measurePack(pack, countTokens)` exceeds the effective budget:

1. drop `recent` from the oldest turn forward;
2. drop `open_questions` from the lowest-priority (last) entry backward;
3. drop optional `task_pack` fields in `TASK_PACK_TRIM_ORDER`:
   `latest_run`, `latest_acceptance`, `latest_report`, `title`, `state`,
   `owner`, `budget`, `due_at`.

The task id, level, goal, scope, acceptance criteria, delivery contract,
baseline SHA, stop conditions, idempotency key, outcome, conclusions and risks
are never removed. If those alone cannot fit, the function throws `RangeError`
rather than returning an empty or oversized pack. `pointers` and `identity` are
fixed and are never trimmed.

`measurePack(pack, countTokens)` uses `JSON.stringify` once and the same
counter, so a caller can reproduce the exact number used for every trim.
`countTokens(text)` must return a non-negative finite number; the default
`estimateTokens` counts one token per four UTF-8 bytes, rounded up.

## Inputs

| Field | Meaning |
|---|---|
| `level` | `goal`, `business` or `execution` |
| `task` | Task ledger row / rendered task. Only whitelisted fields enter the pack. |
| `recent` | Array of turns (or `{messages,turns,items}`). Only `role`, `text`, `at` and `id` survive. |
| `open_questions` | Open escalations/decisions. Falls back to `task.open_questions`, `task.openQuestions`, `task.escalations`, then `task.needs_decision`. Answered/closed entries are dropped. |
| `budgets` | Number or per-level object described above. |
| `countTokens` | Optional injectable `(text) => number`. |

Task-pack fields are whitelisted: `task_id`, `level`, `goal`, `title`, `state`,
`owner`, `scope` (`allowed_paths`, `forbidden_paths`, `projects`,
`bot_scope`), `base_sha`, `acceptance`, `delivery`, `budget`, `due_at`,
`stop_conditions`, `idempotency_key`, `outcome`, `conclusions`, `risks`, plus
the latest run/acceptance/report reduced to a summary and evidence reference.
Transcripts, tool calls, stdout/stderr and other raw log fields are never
copied.

## Pointers and drill-down

Each pointer is `{kind, id, ref, uri?, label?, sha256?}`. `ref` is the canonical
opaque reference; `uri` exists only where the API contract has a read endpoint
(`/v1/tasks/{id}`, `/v1/evidence/{id}`). A task pointer is always present when
the task has an id; explicit pointers, evidence refs, latest run/acceptance,
report pointers and artifact pointers are added without duplicates.

```js
import { drilldownRef } from '@dsbot/context';

drilldownRef(taskPointer, { fields: ['state', 'cost'] });
// "/v1/tasks/task-biz-1?fields=state,cost"
drilldownRef(runPointer); // "run:run-1"
```

## Run the tests

```sh
node --test packages/context/test
```

The suite covers the five-key shape, all three levels, hard-cap clamping,
the exact trim order, the non-empty task-pack rule, raw-log exclusion,
pointer/drill-down composition, input immutability, deterministic output and
injected token counters.
