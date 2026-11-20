# `@ds-bot/pipelines-sources` (L43)

Self-media **topic pack** retrieval for M2, without fetching article bodies
(D-04), plus a two-source consistency check.

A topic pack is exactly:

```js
{
  id,           // source item id
  title,
  summary,      // raw summary text from the source
  sourceName,
  sourceUrl,
  publishedAt,  // ISO instant
  contentHash   // sha256(summary), computed locally
}
```

The body is never requested, parsed, stored or returned. The client imports only
`node:crypto`; it never imports a filesystem or HTTP module, and it never calls
global `fetch`. There is no cache and no file output, so the same id fetched
twice yields the same `contentHash`.

## Usage

```js
import { createSourceClient, crossCheck } from '@ds-bot/pipelines-sources';

const client = createSourceClient({
  // required: an injected transport, never global fetch
  http: async (url, { signal, timeoutMs }) => ({ status: 200, body: await getJson(url, { signal }) }),
  // optional: only sleep(ms) is used, for retry backoff
  clock: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  // optional overrides
  endpoints: {
    hot: 'https://feed.example/hot?limit={limit}',
    item: 'https://feed.example/items/{id}',
  },
  retries: 2,        // retries after the first attempt; default 2
  timeoutMs: 5000,   // per attempt; default 5000
  backoffMs: 100,    // attempt N waits backoffMs * N; default 100
});

const hot = await client.listHot({ limit: 10 }); // Item[], source order
const item = await client.fetchItem({ id: 'hot-1' });

const check = crossCheck({ item, second: itemFromSecondSource });
// { agree: boolean, conflicts: [{ field: 'title' | 'publishedAt' | 'subject', a, b }] }
```

### `http(url, { signal, timeoutMs })`

Return one of:

- `{ status, body }` where `body` is a JSON value or a JSON string;
- a response-like object with `status` and `json()` / `text()`;
- `{ ok: false }` for a transport-level failure without a status.

`status` outside `200..299` raises `http_error`. A thrown transport error raises
`network_error`. Both are retried up to `retries`; the per-attempt timeout
aborts through `signal` and raises `timeout` (also retried). `invalid_response`
and `invalid_item` are structural and are **not** retried. Every failure is a
`SourceError` with a stable `code`, and an exhausted error records `attempts`
(plus `status` for HTTP failures).

### Accepted envelopes

- hot list: `[...]`, `{ items }`, `{ results }`, `{ data: [...] }` or
  `{ data: { items | results } }`;
- single item: the item object, `{ item }`, `{ data }` or `{ result }`.

Item keys may be camelCase or snake_case (`source_name`, `source_url`,
`published_at`). `publishedAt` accepts an ISO string or an epoch-millisecond
number and is normalized to an ISO instant. Missing, empty, non-string or
malformed required fields raise `invalid_item` with `missing` / `invalid`
detail; a returned id that differs from the requested id is `invalid_item` too.

`listHot` defaults to `limit: 10` and clamps to `MAX_LIMIT` (50); a non-positive
or non-integer limit is a `TypeError`. `fetchItem` rejects an empty id with a
`TypeError`.

### Endpoint defaults

The defaults use the reserved `.invalid` TLD
(`https://selfmedia.invalid/hot`, `https://selfmedia.invalid/items/{id}`), so a
caller that injects a real transport but forgets to configure endpoints fails
during resolution instead of quietly contacting a real host.

## Cross-check semantics

`crossCheck({ item, second })` compares:

| field         | comparison                                                        |
| ------------- | ----------------------------------------------------------------- |
| `title`       | whitespace-collapsed text, case-sensitive                         |
| `publishedAt` | instants, so `10:00Z` equals `18:00+08:00`                        |
| `subject`     | whitespace-collapsed summary; equal `contentHash` also matches    |

Any difference is a conflict, including a field present on only one side. There
is no similarity threshold: callers that want fuzzy titles must normalize
before calling. `a` and `b` in a conflict are the original values.

## Tests

```sh
node --test packages/pipelines/sources/test
```

The suite injects fake HTTP transports and a fake clock, covers 4xx/5xx and
transport retries, per-attempt timeouts, malformed bodies and fields, repeated
id hashing, envelope/key variants, cross-check conflicts, and statically checks
that the shipped modules stay free of filesystem/HTTP/global-fetch use.
