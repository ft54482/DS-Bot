# `@dsbot/loop`

L25 loop config: turn `loop.yaml` into a validated, normalized object and decide
when a loop must stop for rounds, budget or lack of progress.

The package is pure logic and dependency-free. It reads no file, starts no
timer, opens no network connection and imports only its own relative modules.
A tiny YAML subset is parsed in `src/yaml.js`; no third-party parser is used.

## Contract

```js
import { loadLoop, stopLoss } from '@dsbot/loop';

const loaded = loadLoop(await readFile('loop.yaml', 'utf8'));

if (!loaded.ok) {
  console.error(loaded.code, loaded.path, loaded.message);
  // invalid_config maxWorkers maxWorkers must be an integer between 1 and 4
} else {
  const verdict = stopLoss({
    lane: loaded.config.lane,
    rounds: 3,
    budgetSpent: 12.5,
    lastProgressAt: Date.now() - 31 * 60_000,
    now: Date.now(),
    limits: loaded.config.stopLoss,
  });
  // { stop: true, reason: 'no_progress' }
}
```

## `loadLoop(yamlText)`

Returns either

```js
{ ok: true, config: { lane, base, maxWorkers, verifier, stopLoss } }
```

or

```js
{
  ok: false,
  code: 'invalid_config',
  path: 'verifier.command', // '$' means the whole document
  message: 'verifier.command must be a non-empty string',
}
```

It never throws for bad input: malformed YAML, a non-mapping root and schema
violations all come back as `invalid_config`. The first error is reported; the
path names the exact field.

### Schema

| Field | Required | Rule | Default |
| --- | --- | --- | --- |
| `verifier` | yes | non-empty command string, or a mapping with `command` and optional boolean `independent` | — |
| `base` | yes | exactly `origin/main` | — |
| `maxWorkers` | yes | integer between 1 and 4 (inclusive) | — |
| `lane` | no | non-empty string | `main` |
| `stopLoss.maxRounds` | no | integer `>= 1` | `2` |
| `stopLoss.maxBudget` | no | number `> 0` (CNY) | `30` |
| `stopLoss.noProgressMinutes` | no | number `> 0` | `30` |

`verifier` is normalized to `{ command, independent }`, with `independent`
defaulting to `true`. Unknown top-level keys are ignored so a later loop
revision can add fields without breaking older loaders. Duplicate YAML keys,
tabs used for indentation and ambiguous indentation are rejected.

### Example

```yaml
lane: content
base: origin/main
maxWorkers: 4
verifier:
  command: node --test packages/loop/test
  independent: true
stopLoss:
  maxRounds: 2
  maxBudget: 30
  noProgressMinutes: 30
```

### Supported YAML subset

- block mappings and nested mappings by indentation;
- block sequences of scalars (`- value`) and of mappings (`- key: value`);
- single- and double-quoted scalars, including `''` and JSON-style escapes;
- unquoted strings, integers, floats, `true`/`false` and `null`/`~`;
- comments introduced by `#` after a space, outside quotes;
- blank lines and a leading UTF-8 BOM.

Anchors/aliases, tags, block scalars (`|`, `>`), flow collections (`[]`, `{}`),
multi-document streams and tab indentation are rejected with a `YamlError`
instead of being guessed at. A config that is ambiguous is an invalid config.

## `stopLoss({ lane, rounds, budgetSpent, lastProgressAt, now, limits? })`

Returns exactly `{ stop, reason }`, where `reason` is `rounds_exceeded`,
`budget_exceeded`, `no_progress` or `null`.

Guards are strict and evaluated in this order; the first hit wins:

| Guard | Condition | Reason |
| --- | --- | --- |
| rounds | `rounds > maxRounds` (default 2) | `rounds_exceeded` |
| budget | `budgetSpent > maxBudget` (default 30 CNY) | `budget_exceeded` |
| progress | `now - lastProgressAt > noProgressMinutes` (default 30 min) | `no_progress` |

Exactly 2 rounds, exactly 30 CNY or exactly 30 minutes without progress do not
stop the loop. Timestamps may be epoch milliseconds, `Date` objects or ISO-8601
strings; a clock that moved backwards does not count as no progress.

`limits` optionally overrides `{ maxRounds, maxBudget, noProgressMinutes }`, for
example `limits: loaded.config.stopLoss`. Malformed counters, timestamps or
limits throw a `TypeError` (programmer error), not `invalid_config`.

## Tests

```text
node --test packages/loop/test
```

The suites cover the YAML subset and its rejections, every required invalid
config path, defaults and overrides, the strict stop-loss boundaries, guard
precedence and the no-dependency/no-I/O boundary.
