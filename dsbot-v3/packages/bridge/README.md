# `@ds-bot/bridge` — L20 DS Bot integration adapter

Implements the inbound seam between a DS Bot issue and the task runtime:
environment mapping, dispatch request/receipt, result receipts and error-code
conversion. Everything here is local-testable; no code in this package opens a
socket by itself because `fetch` and `baseUrl` are injected.

References: `docs/prd/02-api-contract.md` §1 (error table),
`docs/prd/03-acceptance-spec.md` §4.4.1 (`env_allowlist`/`env_digest`),
`docs/prd/04-reliability-ops.md` §0.3 (bridge codes) and §2.3 (failure handling).

## Run the tests

```sh
node --test packages/bridge/test
```

The suite uses an in-process fake HTTP server bound to `127.0.0.1:0`. It never
connects to `17300`, `3086` or a real DS Bot, and it makes no model or web call.

## Public API

```js
import { createBridge } from '@ds-bot/bridge';

const bridge = createBridge({
  baseUrl: 'http://127.0.0.1:3111',
  fetch,                       // required, injected
  env: process.env,            // optional; defaults to process.env, filtered by allowlist
  envAllowlist: ['PATH', 'TZ'],// optional; defaults below
  timeoutMs: 20_000,           // optional; clamped to 1..120000
  token: '...',                // optional; sent as Bearer
  dispatchPath: '/v1/dispatch',// optional
  idempotencyPrefix: 'ds-bot', // optional
  now: () => Date.now(),       // optional, tests use it for receipts
});

const receipt = await bridge.dispatchTask({
  id: 45,
  number: 45,
  title: 'L20 bridge',
  goal: 'Implement the adapter',
  workspace: { path: 'C:\\work', base_commit: 'abc123' },
  budget_cny_cap: 5,
  env: { PATH: '/bin', TZ: 'UTC', SECRET_TOKEN: 'must not pass' },
  idempotency_key: 'issue-45-v1', // defaults to `ds-bot:45`
});

bridge.onResult((result) => {
  // called once per applied receipt
});

bridge.onResult({ event_id: 'evt-1', task_id: 'task-1', state: 'completed', output: { ok: true } });

const mapped = bridge.mapError('FORBIDDEN_WORKSPACE');
// { prd: 'scope_denied', prd_status: 403, retryable: false, ... }
```

### `dispatchTask(issue)`

Sends exactly one `POST` and returns a receipt-shaped outcome. On success it
returns `{ok: true, accepted: true, task_id, request_id, state, env_keys,
env_digest, receipt}`. On failure it returns `{ok: false, accepted: false}` plus
the converted PRD fields (`prd`, `prd_status`, `http_status`, `category`,
`retryable`, `requires_idempotency_key`, `side_effects_possible`).

Wire contract:

```http
POST {baseUrl}{dispatchPath}
Idempotency-Key: <issue.idempotency_key | ds-bot:<issue.id>>
Content-Type: application/json

{
  "source": "ds-bot",
  "issue": {"id": "45", "number": 45, "title": "...", "url": "..."},
  "goal": "...",
  "workspace": {"path": "...", "base_commit": "..."},   // or null
  "budget_cny_cap": 5,                                  // omitted when absent
  "env": {"PATH": "/bin", "TZ": "UTC"},
  "env_allowlist": ["PATH", "TZ"],
  "env_digest": "sha256:..."
}
```

A 2xx body is accepted only when it proves acceptance: `accepted: true`, or
`accepted` is absent but `task_id`/`request_id` is present. A 2xx body with
`ok: false`/`accepted: false` is converted through `mapError` and is a failure.

Repeated dispatch with the same issue and the same payload is replayed locally
(`replayed: true`, `duplicate: true`) without a second request. Reusing the
idempotency key with different content returns
`duplicate_dispatch` (409) and is not retried.

### Environment mapping

`issue.env` wins over the bridge-level `env`; when neither is given the bridge
reads `process.env`. Only keys in `envAllowlist` are forwarded either way, so
host variables such as `DSH_SUPERAGENT_*` or cloud credentials never cross the
boundary. Pass `env: {}` to forward no environment at all. The default allowlist
is:

```text
PATH PYTHONPATH TZ LANG LC_ALL LC_CTYPE HOME TEMP TMP SYSTEMROOT COMSPEC PATHEXT
```

It deliberately excludes credentials and code-injection keys such as
`NODE_OPTIONS`/`PYTHONSTARTUP`. Matching is case-insensitive so Windows `Path`
maps to the canonical `PATH`, but the emitted object contains only allowlisted
keys. `env_digest` is `sha256:` over a sorted-key JSON object of the picked
values, so a receipt can be re-checked later.

### `onResult(evt | handler)`

`onResult(handler)` subscribes and returns an unsubscribe function.
`onResult(evt)` applies one result and is idempotent by receipt identity:

- identity: `event_id`/`eventId`/`receipt_id`/`receiptId`, else `id` when it
  differs from `task_id`, else `(task_id, seq)`;
- same identity + same content: `{ok: true, duplicate: true, applied: false}`,
  and subscribers are **not** called again;
- same identity + different content: `duplicate_dispatch` (409),
  `applied: false`, no subscriber call;
- a throwing subscriber is contained in `handler_errors`, so ingestion still
  succeeds for the other subscribers.

### `mapError(code | status | {code,status,message})`

Converts bridge-native/HTTP errors into the PRD vocabulary. Both sides stay
visible: `code` is what the peer sent and `prd` is the canonical PRD name.
Unknown codes are not guessed (`prd: null`, `category: 'unknown'`,
`side_effects_possible: true`); a known HTTP status still classifies them.

| Input | PRD name | PRD status |
|---|---|---|
| `BAD_REQUEST` | `invalid_state_transition` | 409 (observed 400) |
| `NOT_FOUND` | `invalid_state_transition` | 409 (observed 404) |
| `FORBIDDEN_WORKSPACE` | `scope_denied` | 403 |
| `RATE_LIMITED` / 429 | `rate_limited` (04 §9 extension) | 429 |
| `HOST_ERROR` / `TIMEOUT` / `NETWORK_ERROR` / 5xx | `executor_unavailable` | 503 |
| 400 / 404 / 409 | `invalid_state_transition` | 409 |
| 401 | `authorization_exceeded` | 403 |
| 402 | `budget_exceeded` | 402 |
| 403 | `scope_denied` | 403 |
| 422 | `missing_acceptance` | 422 |
| other 4xx | `null` (no PRD equivalent) | — |

Classification follows 04 §2.3: clean 4xx rejections are non-retryable and do
not `side_effects_possible`; 5xx/timeouts/transport errors are retryable **only
with the same idempotency key** and are flagged as possibly having side effects,
so callers reconcile instead of blindly redispatching.

## Verification

`node --test packages/bridge/test` runs 32 cases covering:

- env allowlist (only allowed keys, default `process.env` source, Windows
  casing, digest stability, secrets and injection keys excluded);
- every PRD error name and bridge alias, 4xx/5xx classification, unknown codes;
- dispatch success shape/header/body, allowlisted env, local replay,
  conflicting idempotency key, 403/500/200-with-error conversion, timeout,
  transport failure, malformed 2xx, invalid input;
- result receipt idempotency, conflicting receipt content, `seq` identity,
  subscriber isolation and invalid receipts.

## Limits

- In-memory dedupe only: this module does not persist dispatches/receipts; the
  task runtime remains the source of truth across restarts.
- No real DS Bot, bridge (`17300`) or GUI (`3086`) is contacted; production
  wiring must pass a real `fetch` and base URL explicitly.
- `issue.env` is a full replacement for the bridge-level env (still filtered by
  the allowlist), not a per-key merge. With no `env` option the bridge reads
  `process.env`, but only the allowlisted keys leave the process.
