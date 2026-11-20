# `@ds-bot/pipelines-content`

Self-media Phase 1 content chain (`docs/prd/17-minimal-implementation-package.md` §S3):

```
retrieve -> snapshot -> fact_check -> write -> review -> typeset
```

It produces the reviewable article pack defined by the self-media acceptance profile:

```json
{
  "title_candidates": ["..."],
  "body": "...",
  "sources": [{ "url": "...", "fetched_at": "...", "sha256": "...", "excerpt": "..." }],
  "facts": [{ "claim": "...", "source_refs": ["..."] }],
  "review": { "score": 100, "issues": [] },
  "layout": { "platform": "wechat", "format": "markdown" }
}
```

`status`, `needs_rework`, `warnings` and `generated_at` are additive fields on the
pack. **No real network call is made:** search, fetch and model are injected, and
the defaults (`defaultSearch`, `defaultFetch`) deliberately return no data /
`network_disabled`.

## Run the tests

```sh
node --test packages/pipelines/content/test
```

The suite uses only deterministic doubles (fixed clock, in-process search/fetch
maps, stub writer/reviewer).

## Pipeline API

```js
import { createContentPipeline } from '@ds-bot/pipelines-content';

const pipeline = createContentPipeline({
  now: () => Date.now(),
  search: async ({ topic }) => [
    {
      url: 'https://example.test/report',
      title: 'Report',
      claims: [{ text: 'A checkable claim.', key: true }],
    },
  ],
  fetch: async (url) => ({ ok: true, text: 'source body', fetched_at: '2026-11-20T10:00:00Z' }),
  snapshotStore: new Map([
    ['https://example.test/cached', { text: 'cached body', fetched_at: '2026-11-19T10:00:00Z' }],
  ]),
  model: {
    write: async ({ topic, facts }) => ({ title_candidates: ['...', '...', '...'], body: '...' }),
    review: async ({ article, facts }) => ({ score: 88, issues: [{ code: 'pacing', message: '...' }] }),
  },
});

const result = await pipeline.run({ topic: 'Why long AI chats make work messier', platform: 'wechat' });
// result.status: 'ready_for_review' | 'needs_rework' | 'blocked'
// result.article_pack: the pack above
// result.blockers / warnings / steps / usage: execution evidence
```

Both `model.write` and `model.review` are optional. Without a reviewer, a
deterministic check flags an empty body or fewer than three title candidates, which
sets `review.needs_rework` and `article_pack.needs_rework` to `true` while still
returning the draft. A failing reviewer becomes a listed `review_failed` issue; a
failing **writer** fails the run (it cannot produce a draft).

`hooks.onStep` is an internal extension used by the adapter to stream stage events;
callers normally use the returned result.

## Source-degradation rules (D-V3-28 / 14 §2.1)

| Situation | Outcome |
|---|---|
| Fetch succeeds | Use the fresh body: `sources[] = {url, fetched_at, sha256, excerpt}`. |
| Fetch fails, cached snapshot exists and its `sha256` matches | Continue from the snapshot; emit `source_unreachable_using_cached_snapshot`. |
| Fetch fails, cached snapshot is corrupt or absent, and the source supports a key fact | `status: 'blocked'`; the blocker is `key_fact_unverified`. |
| Fetch fails for a non-key fact only | Continue; warn with `source_unreachable` + `fact_not_fully_verified`. |
| No source can be snapshotted | `status: 'blocked'` with `no_usable_sources`. |
| A key fact's sources contradict each other (`conflict: true` on the claim) | `status: 'blocked'` with `key_fact_conflict`. |

A key fact needs snapshot-backed evidence from `min(2, referenced_sources)`
independent sources by default (PRD 14: key facts need at least two independent
sources). One-source facts therefore only need that source's snapshot. The
threshold is configurable with `min_independent_sources_for_key_fact` on the run
input and `minIndependentSourcesForKeyFact` on the pipeline dependencies.

Claims come from search results (`claims: [{text, key?, conflict?}]`) or from
`input.facts` (`[{claim, key?, source_refs?, conflict?}]`). Facts are records with
`claim`, `source_refs` (only snapshot-backed URLs), plus `status`, `key`,
`independent_sources` and `missing_source_refs` for auditability.

## `tool_chain` adapter

`createContentToolChainAdapter` implements the shared executor contract from
`packages/adapters/src/contract.js`: `dispatch / status / cancel / follow /
collectArtifacts / collectEvidence / usage`. Its kind is `tool_chain`, it exports
`article-pack.json` as the artifact, and it keeps the adapter's hard rules:

- dispatch without `tracking.status` or `tracking.follow` is rejected;
- a cancel is `cancelled` only after the running stage returns, with
  `verified_stopped_at` set; otherwise the run stays `cancelling`;
- a blocked factual outcome is still a completed execution: `status.state` is
  `completed`, `progress.health` is `no_progress`, and `progress.outcome` /
  `detail.outcome` are `blocked`. The pack itself has `status: "blocked"`.

```js
import { createContentToolChainAdapter } from '@ds-bot/pipelines-content';

const adapter = createContentToolChainAdapter({ search, fetch, model });
const dispatched = await adapter.dispatch({
  run: { id: 'run-1' },
  taskPack: { goal: 'topic', inputs: { topic: 'topic', platform: 'wechat' } },
  tracking: { status: true },
});
const page = await adapter.follow('run-1', 0);
const artifacts = await adapter.collectArtifacts('run-1'); // article-pack.json
```

The adapter imports the shared contract builders from `packages/adapters` (read
only) so its envelopes cannot drift from the other executors.

## Layout

```
packages/pipelines/content/
  src/article-pack.js  required pack shape + validator + hashing/excerpts
  src/pipeline.js      six stages, degradation rules, deterministic defaults
  src/tool-chain.js    tool_chain adapter (all seven contract methods)
  src/index.js         public exports
  test/                pipeline, degradation, review and adapter suites
```

## Known limitations

- Search and model are interfaces, not provider integrations: Phase 1 injects
  real adapters outside this package. This package stays offline.
- Contradiction detection is explicit input (`conflict: true`); it is not inferred
  from prose.
- The chain runs stages sequentially and synchronously; a cancel takes effect
  after the current stage returns.
