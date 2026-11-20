# `@dsbot/events`

L13b reliable-dispatch primitives from the PRD: the outbox state machine,
inbox dedupe, event watermark and idempotency keys.

Everything in this package is **pure in-memory**. No module writes a file,
opens a socket, starts a timer or reads the clock implicitly. The clock, id
factory and transport are injected; `InMemoryTransport` is provided for tests
and demos.

References: `docs/prd/04-reliability-ops.md` §2.1 (outbox), §2.2 (idempotency),
§2.4 (inbox/watermark), `docs/prd/01-data-model.sql` (`dispatch_outbox`,
`event_inbox`, `event_watermark`).

## Outbox

```text
intent -> sending -> sent -> acked
```

`intent` is the durable row that says "we intend to call something"; the PRD
calls the same state `pending`, and `pending` is accepted as an alias in reads.
The transition history is kept on every record so the chain is observable.

```js
import { InMemoryTransport, Outbox } from '@dsbot/events';

const transport = new InMemoryTransport();
const outbox = new Outbox({ transport, reconcileGraceMs: 0 });

const { record } = outbox.enqueue({
  taskId: 'task-1',
  runId: 'run-1',
  principalRef: 'scheduler',
  intent: 'dispatch_run',
  payload: { runId: 'run-1' },
});

await outbox.dispatchIntent(record.id); // intent -> sending -> sent
outbox.ack(record.id);                  // sent -> acked
```

### Guarantees

- **One external execution per `idempotency_key`.** `enqueue` replays the
  stored record when the key and the canonical payload fingerprint match; a
  different payload is a `409 duplicate_dispatch`. `dispatchIntent`/`scan`
  never call the transport for `sent`, `acked` or `failed` records, and the
  transport answers a repeated key from its receipt cache instead of running
  the handler again.
- **Key format.** `formatIdempotencyKey({taskId, runNo, attempt, intent})`
  produces `{task_id}:{run_no}:{attempt}:{intent}` (PRD 04 §2.2.1).
  `parseIdempotencyKey` is the inverse.
- **Payload fingerprint.** `normalizePayload` canonicalizes JSON (sorted keys,
  no whitespace) and hashes it with SHA-256, mirroring `payload_json` +
  `payload_sha256`.
- **Crash boundary.** `beginSend` durably marks `sending`, `send_started_at`
  and increments `attempts` before the transport call. A record with an
  unexpired `lease_until` is skipped by scanners; an expired one is treated as
  "possibly sent" and reconciled.
- **Reconciliation.** Before any resend, `scan`/`reconcile` probes the
  transport ledger (`lookup(key)`). A receipt means the effect landed: the
  record adopts it and is acked without a second execution. Without a receipt,
  the grace window must pass; then at most one resend is allowed, always with
  the **same** key. Exhausted reconciliation ends `failed` with
  `resolution='manual'` rather than guessing.
- **Acked is terminal.** `scan` filters terminal records out, so an acked
  intent is never sent again. A late ack may resolve an `unknown` record.
- **Failure classes.** `ToolError` with `BAD_REQUEST`, `FORBIDDEN_WORKSPACE` or
  `NOT_FOUND` ends `failed` immediately; `RATE_LIMITED` returns to `intent`
  with `next_retry_at` (the send marker is cleared because the bridge answered
  without a side effect); transport errors and ambiguous tool errors become
  `unknown` and go through reconciliation.
- **Single writer.** `claimLease`/`releaseLease` and `writer_epoch` fencing let
  a stale scanner skip a record written by a newer epoch.

### Transport contract

```js
transport.send({ idempotencyKey, intent, payload, payloadSha256, attempt, outboxId })
  -> receipt | throws TransportError | throws ToolError
transport.lookup(idempotencyKey) -> receipt | null   // optional side-effect probe
```

`InMemoryTransport` exposes `calls`, `executions`, `callsFor(key)`,
`executionsFor(key)`, `duplicates`, `failBeforeDeliveryOnce(key, error)` and
`failAfterDeliveryOnce(key, error)`; the last one models a response lost after
the side effect landed.

## Inbox and watermark

`event_key = source|session|seq|type` (`eventKeyOf`). `Inbox` keeps every
received record visible:

- a duplicate key is reported, not stored twice;
- records above the watermark are buffered under `seq`; contiguous records are
  drained in order;
- the per-session watermark advances only after a contiguous record was
  processed successfully; a failing handler leaves it in place and blocks the
  stream until `retry(eventKey)` succeeds;
- the same `source|session|seq` with a different `type` is stored as a
  `conflict` and does not advance the watermark;
- unknown types (when `knownTypes` is configured) are stored `ignored` and the
  watermark may pass them; event payloads are never interpreted by this layer.

`Watermark` is the underlying primitive (`advance` only accepts
`value + 1`, while higher seqs only move `lastSeen`). `WatermarkTable` provides
per-source watermarks for non-session streams (`event_watermark`).

```js
import { Inbox } from '@dsbot/events';

const inbox = new Inbox({ handler: (event) => apply(event) });
inbox.receive({ source: 'dsh', session: 's-1', seq: 2, type: 'turn.end' });
inbox.receive({ source: 'dsh', session: 's-1', seq: 1, type: 'turn.start' });
// handler saw 1 then 2; watermark is now 2.
```

## Tests

```sh
node --test packages/events/test
```

The suite is 27 cases across `keys`, `watermark`, `outbox`, `transport` and
`inbox`, with no file, network or timer access. Acceptance mapping:

| Ticket criterion | Tests |
|---|---|
| exit 0, ≥12 cases | 27 cases, all pass |
| `intent -> sending -> sent -> acked`; one call per key | `outbox: intent -> ...`, `outbox: the same idempotencyKey ...`, `outbox: same key with a different payload ...`, `outbox: concurrent dispatch ...`, `transport: concurrent sends ...` |
| inbox key/dedupe, seq buffering, contiguous watermark | `inbox: event_key ...`, `inbox: out-of-order ...`, `inbox: the watermark stops at a gap ...`, `watermark: ...` |
| interrupted recovery, no resend after ack | `outbox: a crashed sending intent ...`, `outbox: scan delivers pending intents ...`, `outbox: a lost response ...` |
| pure memory | no `node:fs`/`node:net`/`fetch`/`http` import in `src/` |
