# `@ds-bot/adapters` — L3 executor contract and four adapters

Implements the executor adapter layer from `docs/prd/02-api-contract.md` §2.4 and
`docs/prd/16-execution-paths.md`: one contract, four implementations
(`mock`, `tool_chain`, `dsh_session`, `superagent`). The service talks only to the
contract; no adapter reaches the network on its own.

## Run the tests

```sh
node --test packages/adapters/test
```

The suite uses only local code and an in-process fake HTTP server bound to
`127.0.0.1:0` (never 3082/3084/3086). No real bridge, orchestrator, GitHub, model
or web request is made.

## Contract

Every adapter exports the same seven methods and the same result envelope
(`ok`, `kind`, `method`, `run_id`, `contract_version`):

| Method | Request | Result |
|---|---|---|
| `dispatch` | `{run, taskPack, workspace, budget, tracking}` (or positional `dispatch(run, taskPack, workspace, budget)`) | `{accepted, session_id\|ticket_id, run_id, state, tracking}` |
| `status` | `handle` (`{run_id}` or id string) | `{state, progress:{health}, usage}` |
| `cancel` | `handle` | `{requested, verified_stopped_at\|null, state, remote_may_still_run, reasons}` |
| `follow` | `handle, sinceSeq` | `{events:[{seq,type,at,data}], next_seq}` |
| `collectArtifacts` | `handle` | `[{path, sha256, bytes}]` |
| `collectEvidence` | `handle` | `[{kind, ref, sha256, command, output_excerpt}]` |
| `usage` | `handle` | `{tokens_in, tokens_out, tokens_cached, cost_cny, source}` |

`validateContract(adapter)` checks the shape; `validateResult(adapter, method, result)`
checks every response. Adapters build responses through the shared builders in
`src/contract.js`, so the shape cannot drift per adapter.

### Hard rules (verified by tests)

1. **No tracker, no dispatch.** `dispatch` rejects with `tracker_missing` unless
   `tracking.status` or `tracking.follow` is true; a mode the adapter cannot
   provide is `tracking_unsupported`. Rejections return `fallback: 'none'` and the
   adapter performs no external call.
2. **Cancel ≠ stopped.** A run is `cancelled` only when `verified_stopped_at` is a
   timestamp. Otherwise `cancel` reports `stop_unknown` with
   `remote_may_still_run: true` and the failed conditions in `reasons`
   (`cancel_not_accepted`, `remote_not_stopped`, `process_children_remaining`,
   `workspace_writes_unstable`, …).
3. **No silent executor swap.** An unavailable `superagent` returns
   `state: 'blocked'`, `code: 'executor_unavailable'`, `degraded: true`,
   `fallback: 'none'`. `createExecutorRouter` has no fallback branch, so path B
   work is never handed to `dsh_session` (T-PATH-04/T-PATH-07).
4. **Unknown is not completion.** Tracker health is always one of
   `progress` / `no_progress` / `unknown`; bridge or orchestrator failures surface
   as `health: 'unknown'`, never as a synthetic completion.

## Adapters

| Kind | Behavior | Cancellation confirmation |
|---|---|---|
| `mock` | Scripted `progress` / `complete` / `fail` / `timeout` against an injected clock. Deterministic tests without timers. `cancelVerification: 'unverified'` exercises `stop_unknown`. | Local and synchronous; verified unless configured otherwise. |
| `tool_chain` | Placeholder content chain `retrieve → snapshot → fact_check → write → review → typeset`, synchronous by default; custom async steps may be cancelled from `ctx.cancel()` or from outside. | Verified once the last running step returns; the chain never starts another step. |
| `dsh_session` | Injected-`fetch` HTTP client for all 12 DSH bridge tools. `dispatch` = `dsh_create_session` (unless reusing a session) + `dsh_prompt`; `status` = `dsh_get_status` + `dsh_get_projections`; `follow` = `dsh_follow` (clamped to ≤30 s / ≤200 events, advances `sinceSeq`); `cancel` = `dsh_cancel` + stop verification. | Bridge accepted + session not running + no child processes (`verifyStop().children`) + workspace writes stable ≥ `minStableMs`. |
| `superagent` | Creates the GitHub Issue that produces a SuperAgent ticket (`@teammate` on the final line, created by the main account) and polls the orchestrator management API (`x-orchestrator-request: 1`, no `Origin`) for `state` / `tickets` / `tickets/:id` / `tickets/:id/stop`. `follow` synthesises `ticket.state` events from polling. | Stop request accepted + ticket state stopped + no workspace writes after stop (`workspace_writes_after_stop` or injected verifier). |

Bridge tool wrappers are exposed as `adapter.tools.<camelCaseName>` (for example
`adapter.tools.listSessions` → `POST /tools/dsh_list_sessions`), matching
`docs/prd/recon.md` §3.2.

### Ticket identity

GitHub Issue creation happens before the orchestrator assigns a ticket id.
`dispatch` therefore returns `ticket_id: null` with `ticket_id_pending: true` and
the created `issue`; the first `status` resolves the ticket by source URL and
caches its id. This is recorded rather than guessed.

### Usage honesty

Every `usage` result carries `source`. When the bridge projections or ticket card
have no usage data, zeroes are returned with `source: 'unavailable'` and, for
remote failures, `ok: false` — never an invented cost.

## Layout

```
packages/adapters/
  src/contract.js    enums, request parsing, tracker check, result builders/validators
  src/mock.js
  src/tool_chain.js
  src/dsh_session.js bridge client + adapter
  src/superagent.js  GitHub issue + orchestrator client + adapter
  src/router.js      kind-based dispatch, no fallback
  src/index.js       package exports
  test/              contract + one suite per adapter
```

## Known limitations

- `superagent` tracking is poll-based; the orchestrator exposes no push stream,
  so `follow` is a status-diff event source.
- `dsh_session` is a client stub for the documented 12 bridge tools; it has not
  been run against a live bridge (the prompt forbids real network calls).
- `tool_chain` steps are placeholders: they exercise the chain, cancellation and
  evidence plumbing, not content generation. It performs no model calls.
