# `@dsbot-v3/service` — L2 task / run / acceptance state machine

Pure state-machine and guard layer for the DS Bot V3 task ledger, derived from
`docs/prd/03-acceptance-spec.md` (authoritative semantics) and
`docs/prd/02-api-contract.md` (error-code vocabulary). State is held behind an
injected store interface; the default `createMemoryStore()` keeps everything in
memory. No database, filesystem, network or external dependency is used, so the
whole layer is unit-testable and can be reused by the HTTP service and workers.

```js
import { createTaskService } from './src/index.js';

const service = createTaskService(); // fresh in-memory store

const task = service.createTask({ level: 'execution', title: 'implement slugify' });
const { run } = service.dispatchTask({ taskId: task.id, idempotencyKey: 'dispatch-1' });
service.ackRun({ runId: run.id });

const claimed = service.claimRun({
  runId: run.id,
  claim: {
    commit: 'a'.repeat(40),
    dirty: false,
    manifest: [{ path: 'src/slugify.js', sha256: 'b'.repeat(64) }],
    nonce: 'claim-1',
  },
});

// run = reported, task = accepting, acceptance = open. NOT completed.
service.decideAcceptance({
  acceptanceId: claimed.acceptance.id,
  verdict: 'pass',
  itemStates: { 'auto.checks': 'pass' },
});
// task = completed, run = accepted
```

## State sets

Task (`TASK_STATES`): `planned / queued / running / accepting / reworking /
stopping / completed / blocked / paused / cancelled`.

Run (`RUN_STATES`): `queued / dispatched / dispatch_unknown / running / reported
/ accepted / rejected / invalidated / superseded / failed / cancelled / lost /
timed_out`.

Acceptance (`ACCEPTANCE_STATES`): `open / passed / revise / failed / blocked /
void / superseded`.

Transition tables live in `src/transitions.js` (`checkTaskTransition`,
`checkRunTransition`, `checkAcceptanceTransition`, `next*States`). Illegal
transitions return `ServiceError` with `code: 'invalid_state_transition'`,
`status: 409`, no projection write, and one `transition.rejected` event whose
payload contains `from_state`, `to_state`, `guard_failed`, `request_id` and
`idempotency_key` (PRD §3.8).

## Guards implemented

| Area | Behaviour |
|---|---|
| Role (`G03`) | `executor/exec/adapter/reviewer` may never move a task state. Executor acks/claims are applied by the service (`actor=system`, claimed cause); they do not grant task authority. |
| Completion (`G30`, `G31`) | `completed` requires a **passed acceptance at the task's own level**, with the same subject fingerprint. Child passes never count. `goal` additionally requires a passed, human-signed `human.goal_signoff` item. `completeTask` refuses with `missing_acceptance` (422) otherwise. |
| Claim (`G09`) | Execution claims need a 40-hex commit, `dirty=false`, a non-empty manifest of `{path, sha256}` and a nonce; revision/stage must match. A claim sets run `reported` and task `accepting` only. Same nonce replays; a different nonce on a reported run is `409 run_already_reported`. |
| Idempotency (`G18`) | Same key + same payload returns the first result with `replayed: true` and writes `transition.replayed`; same key + different payload is `duplicate_dispatch` (dispatch) or `idempotency_conflict` (other operations), both 409. |
| Dispatch (`G04`, `G17`) | At most one active run per task; a queued rework run is the run a re-dispatch sends. A second dispatch key while a run is active is rejected. |
| Acceptance decision (`G10`, `G11`, `G12`, `G20`, `G21`, `G29`) | Only `acceptance_service` may decide; an acceptance is decided once; a pass needs every required item `pass`; a subject-fingerprint drift voids the round, returns the task to `running` and invalidates the reported run. |
| Rework (`G14`) | `revise` moves the task to `reworking`, bumps `revision`, clears the subject, rejects the reported run and derives a `queued` run with `kind: 'rework'`. |
| Parent readiness (`G28`, `G35`) | `claimReadiness` gates on all children completed with current passed acceptances and no active child; it opens the parent's own acceptance and never completes the parent. |
| Stop (`G32`) | `requestStop` freezes the subtree into `stopping` (`stop_state=requested`), voids open acceptances, bumps run fencing tokens and records `run.cancel_requested`. It never sets `cancelled`. `verifyStop` only cancels when every active run has process-gone + quiescence window + unchanged namespace hash (child-first); otherwise the task stays `stopping` with `stop_state=stop_unknown` / `stopUnknown=true` and is not cancelled. A missed verification deadline moves it to `blocked(stop_unverified)`. |
| CAS (`G02`) | Optional `expectedStateVersion`; mismatch is `state_conflict` (409) and writes nothing. |

Errors are `ServiceError` instances with `code`, `status`, `details` and
`toJSON()`, e.g. `invalid_state_transition` 409, `missing_acceptance` 422,
`claim_invalid` 422, `forbidden_transition` 403, `state_conflict` 409,
`duplicate_dispatch` 409, `stop_unverified` 409.

## Injected store

`createMemoryStore()` implements the contract documented in
`src/memory-store.js`:

`createTask/getTask/updateTask/listTasks`, `createRun/getRun/updateRun/listRuns/
listActiveRuns`, `createClaim/listClaims`, `createAcceptance/getAcceptance/
updateAcceptance/listAcceptances`, `appendEvent/listEvents/lastEventHash`,
`getIdempotency/putIdempotency`, `appendStopVerification/listStopVerifications`.

Writes are copy-on-write and version-checked; reads return clones. Entities are
plain data (task, run, acceptance, claim, event, stop verification), so a
SQLite/Postgres adapter only has to persist the same fields and enforce the same
uniqueness rules (one active run, one open acceptance, unique idempotency key).

## Deliberate boundaries / notes

- **Run `cancelling`** (PRD 03 §3.4) is not introduced as a separate state: the
  ticket's run-state list is the contract for this layer. A cancel request is
  recorded as `run.cancelRequestedAt`; the run becomes `cancelled` only after
  stop verification, which is the same guarantee `cancelling -> cancelled`
  exists for (D-V3-27). This avoids a second, unverified "cancel" vocabulary.
- **`reworking`** is kept because `02-api-contract.md §2.3` and the ticket name
  it; it is the facade for the PRD's `accepting -> queued` rework and still needs
  a new run and a fresh passed acceptance before completion.
- **Evidence authenticity / reviewer independence / snapshot integrity** are L2
  inputs, not L2 responsibilities: this layer enforces item state and subject
  binding, not how evidence was produced. Those checks belong to the acceptance
  service (ACC), which must pass `itemStates` here.
- **Forced stop**: only an explicit `force=true` plus a non-empty
  `decisionToken` can cancel unverified runs; it records `stop_state=forced`,
  `unsafeStop=true` and `security.stop_unverified` (PRD §5.2.1 step 8). The
  default path never cancels unverified work.
- Events carry a `prevHash`/`hash` SHA-256 chain and are appended for every
  transition, rejection, replay and security event; the store keeps the chain.

## Tests

Acceptance command (repository root):

```bash
node --test packages/service/test
```

`test/index.js` makes the directory itself runnable (Node 25 resolves a directory
through the module loader); it imports all suites. Suites map directly to the
ticket acceptance items:

| File | Covers |
|---|---|
| `states.test.js` | exact task/run/acceptance state sets and transition-table integrity |
| `transitions.test.js` | illegal transition `invalid_state_transition` (409), no partial write, rejection event, hash chain, CAS, role guard |
| `claim.test.js` | claim → run `reported` + task `accepting` (never `completed`), invalid/dirty claims, duplicate nonce |
| `completion.test.js` | completion refused without own-level pass, child cannot complete parent, readiness gate, goal human signoff |
| `acceptance.test.js` | revise/void/block verdicts, subject drift, decision authority |
| `idempotency.test.js` | duplicate dispatch produces one run, payload conflict, decision replay |
| `stop.test.js` | stop does not cancel, unverified → `stop_unknown`, verified → `cancelled`, deadline → `blocked(stop_unverified)`, child-first cascade, forced stop |
