# `@dsbot/dsbot-adapter` — L49 DS Bot command adapter

The code seam between a DS Bot chat surface and the existing Chief/runtime
layers. It turns one user command into one injected tool call and returns an
auditable receipt:

```
command -> action -> receipt
```

It contains no goal, task, acceptance, budget or stop implementation. The
adapter only parses the command, calls the injected surface, and formats the
reply, so DS Bot can `import` (or, on Node versions with `require(esm)`,
`require`) this package directly.

## Contract

```js
import { createDsBotAdapter } from '@dsbot/dsbot-adapter';

const adapter = createDsBotAdapter({
  chief,                       // @dsbot/chief: openGoal/status/delegate/deliver
  runtime,                     // runtime facade; /stop uses runtime.stop.request
  clock: () => Date.now(),     // injectable, used for the audit timestamp
  allowlist: ['user-1'],       // authorized DS Bot user ids (optional)
  scope: { projects: ['self-media'], max_delegate_level: 'goal' },
});

const result = adapter.handle({
  userId: 'user-1',
  text: '/goal new 写一篇文章 --budget 30',
  channel: 'dsbot:dm',
});

// {
//   ok: true,
//   reply: '✅ 已创建目标 goal-1：写一篇文章（预算 30 CNY）\n\n行动：openGoal（已执行）· 参数：{"budgetCny":30,"title":"写一篇文章"}',
//   action: {
//     name: 'openGoal', command: 'goal.new',
//     args: { budgetCny: 30, title: '写一篇文章' },
//     executed: true, userId: 'user-1', channel: 'dsbot:dm', at: 1700000000000,
//   },
//   data: { ok: true, tool: 'openGoal', goalId: 'goal-1', ... },
// }
```

`handle` is synchronous because every composed Chief/runtime facade method it
uses is synchronous. Domain failures are returned as receipts; `handle` does not
throw. Constructor misuse (a missing `chief`, a missing required Chief method,
or a non-function `clock`) throws `TypeError` immediately.

## Command map

| Command | Parsed arguments | Action (injected call) |
|---|---|---|
| `/goal new <标题> [--budget 30]` | `{title, budgetCny?}` | `chief.openGoal(...)` |
| `/goal status <id>` | `{goalId}` | `chief.status(...)` |
| `/delegate <goalId> <bot> <简要>` | `{goalId, bot, brief}` | `chief.delegate(...)` |
| `/deliver <goalId>` | `{goalId}` | `chief.deliver(...)` |
| `/stop <id>` | `{taskId}` | `runtime.stop.request(...)` |
| `/help` | — | no tool call |

Parsing details:

* `/goal new` accepts `--budget 30` and `--budget=30` anywhere after `new`. The
  remaining text is the title. A missing value, a non-numeric value or a
  negative value is rejected before any tool call.
* `/delegate` takes the first token as `goalId`, the second as `bot`, and the
  rest of the line (including spaces) as the brief.
* `/deliver` and `/stop` take one id token.

`scope` (alias `defaultScope`) is the optional goal auth scope forwarded to
`chief.openGoal`. A deployment that enforces project scope on business BOTs must
set it: a goal created with no project cannot prove that a later delegation sits
inside the bot's project scope.

## Receipt and audit

Every recognized command attempt returns:

```js
{
  ok,                 // true when the action completed
  code,               // present when ok is false
  reply,              // DS Bot-ready text, includes the audit line
  action: {
    name,             // openGoal | status | delegate | deliver | stop.request | exec | ...
    command,          // goal.new | goal.status | delegate | deliver | stop | ...
    args,             // bounded, key-sorted parameter summary
    executed,         // false for a rejected or incomplete attempt
    userId, channel, at,
  },
  data,               // the injected tool's result (or failure details)
}
```

The `reply` audit line has the action name, whether it executed, and the
parameter summary:

```
行动：openGoal（已执行）· 参数：{"budgetCny":30,"title":"写一篇文章"}
```

The summary is a bounded projection (200-character strings, 20 array items, 40
keys, depth 4). Keys matching `secret|token|password|passwd|api_key|credential|
authorization|cookie` and common credential shapes (`Bearer ...`, `sk-...`,
`ghp_...`, `token=...`) are redacted. `data` is the injected tool's result, not
the receipt; callers that log receipts should log `reply`/`action`.

## Guards

| Situation | `code` | Behaviour |
|---|---|---|
| Unknown command | `unknown_command` | Friendly `/help` reply, no exception, no tool call |
| Missing argument | `missing_argument` | `data.argument` names the missing field; no tool call |
| Malformed argument | `invalid_argument` | Names the field and reason; no tool call |
| User outside allowlist (or no `userId`) | `not_allowed` | No parsing, no tool call |
| `/exec`, `/dispatch`, `/run`, `/shell`, `/plan`, `/rework` | `not_allowed` | Explicit no-leapfrog denial; `action.denied = true`; no tool call |
| Runtime has no `stop.request` | `runtime_unavailable` | `/stop` only; no exception |
| Chief/runtime throws | the error's `code`, otherwise `tool_error` | Receipt with the message; no exception |

### Allowlist

`allowlist` accepts a user-id string, an array, a `Set`, or an object map of
`{userId: true}`. `allowedUsers` and `allowedUserIds` are aliases. A custom
`authorize(userId, context) => boolean` predicate can replace the list; a
predicate that throws denies access.

When no allowlist is configured the adapter has no user gating and accepts every
identity. A production DS Bot should pass an explicit `allowlist` (an empty list
denies everyone).

### `/stop` semantics

`/stop` calls `runtime.stop.request({taskId, requestedBy: userId,
reason: 'user_stop'})`. It reports the stop as *requested*, not verified: the
runtime's stop verification/quiescence logic remains the source of truth for a
final `cancelled` state.

## Boundaries

This package composes:

* `@dsbot/chief` — `openGoal`, `status`, `delegate`, `deliver`;
* `@dsbot/runtime` — `stop.request`.

It deliberately does not duplicate any of their logic. Tests use a fake Chief
and fake runtime, so the suite proves the command mapping, guards and receipts
rather than re-testing the composed packages.

## Test

```sh
node --test packages/dsbot-adapter/test
```

The suite has 38 cases covering all six commands, argument parsing (including
the budget flag), the optional goal scope, missing/invalid arguments, allowlist
enforcement, leapfrog denials, audit redaction and bounded summaries, Chief
failure passthrough, thrown dependency errors, `/stop` with and without a
runtime stop surface, and clock/channel injection.
