# `@dsbot/authz`

L12 authorization gates for the task service: scope subset, budget min-chain and
hard-rule blocking. The module is pure — it opens no database, writes no file,
makes no network call and reads no ambient clock. It has no dependencies.

PRD references: `docs/prd/02-api-contract.md` §4.1/§4.2,
`docs/prd/04-reliability-ops.md` §1.5/§1.6 (AR-1..AR-6) and
`docs/prd/03-acceptance-spec.md` §4.1.

## Contract

```js
import { effectiveScope, effectiveBudget, gateRules } from '@dsbot/authz';
```

Every gate returns a discriminated result: `{ ok: true, ... }` on success, or
`{ ok: false, code, ... }` with one of the stable PRD codes:

| code | meaning |
|---|---|
| `authorization_exceeded` | the child/action stepped outside the parent grant |
| `budget_exceeded` | the commitment does not fit under the effective cap |
| `rule_blocked` | a matching hard rule forbids the action |

Malformed input throws `TypeError`; a policy denial is never silently turned
into a pass.

## `effectiveScope(parent, child)`

```js
const result = effectiveScope(parentScope, childScope);
// { ok: true, scope: { ... } }
// { ok: false, code: 'authorization_exceeded', violations: [...] }
```

The effective scope is the intersection of the two scopes, so a child may only
narrow what the parent granted. When a dimension is absent from the parent it
is unconstrained, and the child may add a restriction. `null`/`undefined`
scopes are treated as `{}`.

| Dimension | Subset rule | Effective value |
|---|---|---|
| `projects` | every child project is in the parent list | child list |
| `paths` | exact path, or below a parent directory prefix ending in `/` | child list |
| `tools` | every child tool is in the parent list | child list |
| `spend_cny_cap` | child `<=` parent | smaller value |
| `max_parallel_runs` | child `<=` parent | smaller value |
| `max_delegate_level` | rank `execution < business < goal`; child rank `<=` parent | child level |
| `git.branch_prefix` | child prefix must start with the parent prefix | child prefix |
| `git.can_merge` | always `false` (AR-6); `true` from a child is denied | `false` |
| `git.can_push` | child may only be `true` when the parent is `true` | parent AND child |
| extra keys | the key must already exist in the parent; the child value must be contained (arrays/objects/numbers/booleans) | child value |

A violation has `{ dimension, reason, parent?, child? }`; list violations also
carry the `offending` items. All violations are reported, not just the first.

Git capabilities fail closed: `can_merge` is always false, and `can_push`
defaults to false unless the parent explicitly grants it.

## `effectiveBudget({ taskCap, parentRemaining, botCap, ... })`

```js
const result = effectiveBudget({
  taskCap: 100,
  parentRemaining: 80,
  botCap: 90,
  requested: 20,
});
// { ok: true, cap: 80, remaining: 60 }
```

`cap` is the minimum of the three links. `null`, `undefined` and `Infinity`
mean "no cap on this link"; a missing cap on every link yields
`cap: Infinity`.

To check a spend, also pass `requested` (the amount to spend/reserve now) and
optionally `spent` / `reserved`. The gate sums
`spent + reserved + requested` and returns `budget_exceeded` when the sum is
above `cap` (with a `1e-9` tolerance for decimal arithmetic):

```js
effectiveBudget({ taskCap: 100, parentRemaining: 80, botCap: 90, requested: 81 });
// {
//   ok: false,
//   code: 'budget_exceeded',
//   cap: 80,
//   committed: 81,
//   reason: 'cap_exceeded',
//   ...
// }
```

The cap is not silently rounded up and the input object is not mutated.

## `gateRules(rules, action)`

```js
const result = gateRules(rules, { type: 'publish', project: 'ai-video' });
// { ok: true, applied: [...] }
// { ok: false, code: 'rule_blocked', rule, blocked_by, applied }
```

Rules are versioned. For every rule identity (`key`, `rule_key`, `ruleKey` or
`id`) only the highest `version` is evaluated; an inactive or out-of-window
newest version does **not** fall back to an older one. The newest version is
then filtered by `active`, the effective window and applicability before its
`kind` decides the outcome:

- `kind: 'hard'` + match → `rule_blocked`;
- `kind: 'soft'` + match → reported in `applied`, never blocks.

Applicability:

| Rule field | Matches when |
|---|---|
| `action` / `actions` / `applies_to` / `appliesTo` | action type is in the list, or the list contains `*`; absence means any type |
| `project` or `scope: 'project'` | `action.project` equals it |
| `task_id` / `taskId` or `scope: 'task'` | `action.task_id` (or `taskId`) equals it |
| `match` | every key equals/contains the corresponding `action` field |
| no matcher | the rule is global and applies to every action |

`active` accepts `true`/`1` (default) and `false`/`0`/`'0'`/`'false'`.
`effective_from`/`effective_to` are inclusive and accept epoch milliseconds,
ISO-8601 strings or `Date`. Pass `action.at` to evaluate the window; without
it the window is not consulted, which keeps the function deterministic.

`action` may be a string (`'publish'`, shorthand for `{ type: 'publish' }`) or
an object such as `{ type, project, task_id, tool, at, ... }`.

The returned rules are copies; mutating them cannot change the input.

## Tests

```sh
node --test packages/authz/test
```

The suite covers scope narrowing and every denial path, budget minima and
over-commitment, versioned hard/soft rules, applicability, time windows and
input validation.
