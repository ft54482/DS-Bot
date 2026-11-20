# PRD hard-rule conformance checks

Rule-by-rule verification that the merged implementation satisfies the PRD's
hard rules. This is not a second unit-test suite: every case goes through the
runtime composition root (`createRuntime`) and, where the rule is a public
contract, the real loopback HTTP API. No state machine, guard or transition
table is reimplemented here.

```sh
node --test tests/conformance
```

Exit code `0` is required. Every test name starts with `[PRD <section>]`, and a
failed check prints a block that locates the section, the rule, the expected
value and the actual value:

```text
[PRD 03 §4.2] the acceptance stays open
  expected: "open"
  actual:   "passed"
```

## Coverage

| Rule | PRD section | Test |
|---|---|---|
| A completed child never completes its parent | 03 §1.3, §3.9 G2; 00 R2 | `hierarchy.test.js` |
| A task cannot complete without its own passed acceptance | 03 §4.2, §0.5 G30; 02 §2.3 | `acceptance.test.js` |
| The delegation hierarchy is adjacent (goal→business→execution) | 03 §1.2 G26, §5.1.4; 02 §2.1 | `hierarchy.test.js` |
| A claim reports work; it never sets completion or item outcomes | 02 §2.2; 03 §4.2 | `acceptance.test.js` |
| An unverified stop is `stop_unknown`, never `cancelled` | 03 §5.2.1 step 7, §5.2.2; 04 §1.6 | `stop.test.js` |
| A child `auth_scope` may only narrow the parent grant | 02 §4.1; 03 §5.1.2 G27 | `authz.test.js` |
| The effective budget is the minimum of the chain | 02 §4.2; 04 §1.6, §4.3.1 | `authz.test.js` |
| Task/run state names follow 03 §10 with no second vocabulary | 03 §10.1, §10.2; 00 C6 | `states.test.js` |
| A parent acceptance opens only after the children pass | 03 §3.9 G28, §4.1 | `hierarchy.test.js` |
| Only a verified quiescence proof cancels the subtree | 03 §5.2.1 steps 5-6, §5.2.2 | `stop.test.js` |

## Baseline and the authorization-gate dependency

Base revision: `e0eae2e29a51338377c3a22c0461af6b0d1a777c` (`origin/main` when the
ticket started). The base has no `packages/authz`: the L12 scope/budget gates
(PRD 02 §4.1/§4.2) are a separate package and are not wired into the task
service yet. The two `authz.test.js` cases therefore load the gate when it is
present and otherwise mark the rule assertion as **TODO** with that reason; the
data path (`auth_scope`/`budget` round-trip through the runtime) is still
asserted. They turn into hard assertions as soon as the gate package lands.

## Design notes

- `support/harness.js` is glue only: a deterministic clock/id factory, a mock
  executor, an in-memory SQLite runtime and helpers to drive the public
  `tasks`/`runs`/`acceptances`/`stop` facades.
- `support/conformance.js` only formats failures; it contains no domain logic.
- The API cases start the real loopback server from the same runtime/store
  (`runtime.api.start()`), so the assertion is about the actual projection.
