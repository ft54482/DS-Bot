# L41 devloop-e2e — end-to-end loop scenarios with fakes

Re-runnable acceptance for the L34 dev-loop driver (`packages/autoloop`). Every
external system is a deterministic fake: GitHub, the SuperAgent work-order
queue, the independent verifier, git and the clock. No network, process,
filesystem, database, model call or real PR is involved.

The goal decomposition in scenario A uses the shipped L33 goal engine
(`packages/goal-engine`), so three lanes and their task books are real output
of that layer; only the lane execution is fake.

## Run

```sh
node --test tests/devloop-e2e
```

Exit code `0` means all 12 cases passed. The suite is deterministic and
re-runnable; each case builds a fresh store, fake world and loop.

## Scenarios

| Case | What it proves |
|---|---|
| A (normal advance) | A goal decomposes into 3 lanes, the loop runs 3 work rounds (one lane task per round) and then a final done plan; every fake agent opens a PR, every fake verifier says PASS, every PR is merged once, all tasks are merged and the loop reaches its completed terminal state. |
| B (rework) | The first verification FAILs, exactly one rework task is generated with the verifier feedback, the same PR gets a second commit, the second verification PASSes and the loop continues to completion. `reworkCount=1`, lane `reworkRounds=1`. |
| C (stop-loss) | The same lane FAILs three times. Two reworks are allowed; the third rework would be round 3, so the lane's task is stopped and the loop stops with `rework_exceeded`. The stop detail names the lane, no third rework is dispatched, and a stopped loop replays without more work. |
| D (budget) | Two 6 CNY submissions accumulate to 12 CNY on a task whose `budgetCny` (and loop cap) is 10. The loop stops with `budget_exceeded` and `spentCny=12` before a second verification or any merge. |
| E (crash recovery) | A driver is dropped after dispatch and again after a merge. `resume()` reloads the persisted snapshot: in-flight tasks are not dispatched again and an already merged PR is not merged again. |
| Observability | Every executed state is recorded with its iteration (round), returned actions and the post-step state snapshot. The fake store exposes `steps()`, `saves()`, `round(n)` and `rounds()` so a failure can point at one round. |

### State vocabulary

The L34 driver's terminal success state is `done`. The ticket calls the same
outcome `completed`; the fake store's `status()` projects `done` to
`completed` and `stop` to `stopped`. Tests assert both the raw driver state
and the projection so the mapping is visible.

### Stop-loss shape

The L34 driver stops the whole loop when a lane exhausts its rework budget; it
does not leave the other lanes running. The offending lane and task are kept in
`snapshot.stop.detail` (`lane`, `taskId`, `reworkCount`, `laneReworkRounds`,
`maxReworkRounds`), which is what scenario C asserts. This is the shipped
driver's behavior, not a test-only interpretation.

## What is fake, what is real

- Real: `packages/autoloop` (driver, stop-loss, recovery, verdict parsing),
  the shipped `sa`/`git`/`gh` adapters, and `packages/goal-engine` for
  scenario A's lane task books.
- Fake: GitHub pull requests and merges, SuperAgent work orders, verifier
  output, git merge, the clock and the snapshot store.
- "Kill" means dropping the driver instance, exactly as a process restart
  would lose it; the store and the fake external systems survive. No OS process
  is killed and no timing/sleep is used.
