# @dsbot/acceptance — L31 three-stage acceptance engine

Pure, dependency-free evaluator for the three acceptance stages of
`docs/prd/03-acceptance-spec.md` §4: `execution`, `business`, `goal`.

```js
import { evaluate, sha256Hex } from '@dsbot/acceptance';

const evaluation = evaluate({
  stage: 'execution',
  task: { id: 'tsk_1', level: 'execution' },
  evidence: [
    { id: 'evd-commit', kind: 'commit', content: 'a'.repeat(40) },
    {
      id: 'evd-tests',
      kind: 'test_output',
      content: 'ok 1 - example\n# pass 3\n# fail 0',
      exitCode: 0,
      sha256: sha256Hex('ok 1 - example\n# pass 3\n# fail 0'),
    },
  ],
  rubric: null,
});

evaluation.result; // 'pass' | 'rework' | 'blocked'
evaluation.items;  // [{ id, required, ok, detail }]
```

## Contract

`evaluate({ stage, task, evidence, rubric })` returns exactly:

```js
{
  result: 'pass' | 'rework' | 'blocked',
  items: [{ id: string, required: boolean, ok: boolean, detail: string }],
}
```

- `pass` — every required item of this stage is satisfied.
- `rework` — the stage was judged and a required item failed in a fixable way
  (a failing test run, a failing domain rubric entry).
- `blocked` — the stage cannot be judged: evidence is missing, malformed or
  invalid, the domain rubric is absent, the rubric belongs to another stage, or
  a child stage tried to decide its parent.
- The aggregate is never better than its worst item. `ok` is exactly
  `result === 'pass'` for that item.
- Invalid input *shape* (unknown stage, non-object task, non-array evidence)
  throws `TypeError`. Missing or contradictory acceptance data is a `blocked`
  result, not an exception.

## Stage rules

| stage | required items | decision |
|---|---|---|
| `execution` | `execution.commit`, `execution.tests` | commit evidence (40-hex SHA) **and** non-empty test output are mandatory; either one missing, malformed or hash-invalid → `blocked`. A test record with `exitCode`/`exit_code !== 0` (or `ok:false` / verdict `fail`) → `rework`. |
| `business` | `business.rubric` + every required domain rubric entry | at least one domain rubric entry is mandatory; a required entry that fails → `rework`; a pending/blocked/missing entry → `blocked`. |
| `goal` | `goal.evaluator`, `goal.rubric` + every required goal rubric entry | the rubric must declare `stage:'goal'` **and** a goal-level `evaluator` (`'goal'` or `{stage:'goal'}`); child test/acceptance evidence is never read, so a child `pass` can never make the goal pass. |

Every stage also emits `stage.alignment` (stage must equal `task.level` when
that field is present) and `evidence.integrity`.

Optional rubric entries (`required: false`) are reported but do not gate the
aggregate. Rubric entries are classified from `verdict`/`result`/`state`/
`status` (`pass`, `fail`/`revise`/`rework`, `blocked`/`pending`/...) or an
explicit boolean `ok`.

## Evidence and hash verification

Evidence is caller-supplied data only. Author self-reports (`claim`,
`task.commit`, `task.tests`, chat text) are deliberately ignored; they are not
evidence.

```js
{
  id: 'evd-1',              // optional; defaults to evidence[index]
  kind: 'commit',           // 'commit' | 'test_output' | ...
  content: '<UTF-8 text>',  // the exact text the hash covers
  sha256: '<64 hex>',       // optional; verified against content when present
  exitCode: 0,              // test evidence only; exit_code is accepted too
  ok: true,                 // optional boolean outcome
  verdict: 'pass',          // optional outcome spelling
}
```

`kind`/`type`, `sha256`/`hash` and `exitCode`/`exit_code` aliases are accepted.
When a record declares `sha256`, it must be the SHA-256 of its own `content`;
a mismatch, a malformed hash or missing content makes the record **invalid**.
Invalid evidence is reported in `evidence.integrity` and the stage-specific
item, and it always yields `blocked` — never `pass` and never a silent ignore.
The same rule applies at every stage.

## Rubric shape

```js
{
  id: 'business.product_v1',
  stage: 'business',          // optional here, mandatory for goal
  evaluator: 'business-bot',  // optional; goal requires stage/level 'goal'
  items: [
    { id: 'independent.visual', required: true, verdict: 'pass', detail: '...' },
    { id: 'independent.flow', required: true, verdict: 'fail' },
    { id: 'note', required: false, verdict: 'fail' }, // reported, not gated
  ],
}
```

A bare array of entries is also accepted as a rubric. `detail` is copied when
supplied; otherwise the engine writes a deterministic explanation.

## Guarantees

- **No child-to-parent promotion**: `evaluate` returns one stage's result only.
  Goal-stage input is judged solely by the goal-level evaluator rubric; child
  acceptance results, child task states and child evidence are not consulted.
- **Pure**: no filesystem, network, process, clock or randomness access; no
  input mutation; the same input returns a structurally equal result.
- **No dependencies**: only the Node built-in `node:crypto` for SHA-256.

## Test

```bash
node --test packages/acceptance/test
```

The suite covers execution evidence gates, business rubric gating, goal
isolation from child passes, hash mismatch → invalid, aggregate monotonicity,
input immutability/determinism and the absence of I/O imports.
