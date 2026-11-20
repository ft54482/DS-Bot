# `@ds-bot/pipelines-selfmedia`

End-to-end self-media pilot for Phase 1 (`docs/prd/09-wbs.md` §1.1,
`docs/prd/14-business-model.md` §2.1, `docs/prd/17-minimal-implementation-package.md` S3+S4).

It runs the existing content chain, evaluates the result with the pinned
self-media acceptance profile, allows at most two rework rounds, and returns a
**ready-for-review publish package**. It never publishes: the package records
`license_status: "unauthorized"` and a rejected `evaluatePublish` decision with
no authorization record. A person must supply the separate publish authorization
(`docs/prd/14-business-model.md` §3.2, D-V3-23).

Implementation is reused, not copied:

- `packages/pipelines/content` — retrieve → snapshot → fact_check → write →
  review → typeset, including source-degradation rules and offline defaults.
- `packages/profiles` — `evaluateArticlePack` (facts/snapshot/freshness/quality/
  layout/compliance), `evaluatePublish` (the separate publish gate) and
  `selfMediaProfileV1`.

```sh
node --test packages/pipelines/selfmedia/test
```

No network, model or filesystem fixture store is used by the suite; search,
fetch, clock, writer and reviewer are deterministic doubles.

## API

```js
import { runSelfMediaPilot } from '@ds-bot/pipelines-selfmedia';

const result = await runSelfMediaPilot({
  topic: 'Why long AI chats make work messier',
  deps: {
    search: async ({ topic }) => [
      {
        url: 'https://alpha.example/study',
        title: 'Study',
        claims: [{ text: 'Long AI chats increase context switching.', key: true }],
      },
      {
        url: 'https://beta.example/report',
        title: 'Report',
        claims: [{ text: 'Long AI chats increase context switching.', key: true }],
      },
    ],
    fetch: async (url) => ({ ok: true, text: `body of ${url}`, fetched_at: '2026-11-20T10:00:00Z' }),
    model: {
      write: async ({ topic, facts }) => ({
        title_candidates: [topic, `${topic}: the evidence`, `A guide to ${topic}`],
        body: `# ${topic}\n\n${facts.map((fact) => fact.claim).join('\n\n')}\n`,
      }),
      review: async () => ({
        score: 88,
        issues: [],
        rubric: {
          structure: { score: 86, issues: [] },
          readability: { score: 82, issues: [] },
          style: { score: 84, issues: [] },
        },
        reviewer: { id: 'reviewer-1', context_id: 'ctx-review-1', independent: true },
        citations: { total_chars: 2000, quoted_chars: 120 },
        risks: [],
      }),
    },
  },
});
```

### Return shape

```jsonc
{
  "topic": "…",
  "draft": {
    "title_candidates": ["…"],
    "body": "…",
    "tags": ["…"],
    "layout": { "platform": "wechat", "format": "markdown" },
    "sources": [{ "url": "…", "fetched_at": "…", "sha256": "…", "excerpt": "…" }],
    "facts": [{ "claim": "…", "source_refs": ["…"], "key": true }]
  },
  "review": {
    "result": "pass" | "needs_rework" | "blocked",
    "needs_rework": false,
    "score": 88,
    "issues": [],
    "warnings": [],
    "acceptance_result": "pass",
    "rework_rounds": 0,
    "max_rework_rounds": 2,
    "rubric_source": "reviewer_rubric",
    "acceptance": { "result": "pass", "items": [] }
  },
  "publish_package": {
    "status": "ready_for_review",
    "title_candidates": ["…"],
    "chosen_title": "…",
    "body": "…",
    "tags": ["…"],
    "sources": [{ "url": "…", "fetched_at": "…", "sha256": "…", "excerpt": "…" }],
    "license_status": "unauthorized",
    "license": { "status": "unauthorized", "allowed": false, "authorization": null, "decision": {} },
    "publish": { "executed": false, "authorization": null }
  },
  "attempts": []
}
```

When the chain is blocked before a draft exists (for example no search results or
no usable snapshot), `draft` and `publish_package` are `null`, `review.stage` is
`"content"`, and `blocked_reason` is set. When acceptance blocks, the draft is
returned for review, `review.stage` is absent, `publish_package` is `null`, and
`blocked_reason` starts with `acceptance_blocked:`. When the rework budget is
exhausted, `review.result` becomes `"blocked"`, `review.exhausted` is `true`, and
`blocked_reason` starts with `rework_exhausted:`.

## Dependency injection

| `deps` field | Purpose |
|---|---|
| `search(query)` | Returns search results/claims; may throw (the content chain records `search_failed`). |
| `fetch(url, context)` | Returns `{ ok: true, text, fetched_at }` or `{ ok: false, error }`; may throw. |
| `model.write(context)` | Returns `{ title_candidates, body }`; the same writer is reused for every rework round. |
| `model.review(context)` | Returns `{ score, issues, rubric?, reviewer?, citations?, risks?, cover_copy? }`. |
| `snapshotStore` | Map/function/object used by the content chain when `fetch` fails; a usable cached snapshot lets the run continue. |
| `now` | Clock returning epoch milliseconds (fixed in tests). |
| `tags` | Preferred tags; fallbacks fill the profile minimum of three unique tags. |
| `platform` / `account` | Publish target metadata; default `wechat`, account may be omitted. |
| `author` / `reviewer` | Override the default writer/reviewer identities passed to the acceptance profile. |
| `profile` | Override `selfMediaProfileV1` (must still satisfy `assertProfile`). |
| `maxReworkRounds` | Non-negative integer; default `2`. |

`search`, `fetch` and `model` are forwarded to `runContentPipeline`; the content
chain's own defaults keep the pilot offline when they are omitted.

### Review evidence

The content chain normalizes a review down to `score` / `issues` /
`needs_rework`. The pilot wraps the injected `model.review` so it can also read
the raw `rubric`, `reviewer`, `citations`, `risks` and `cover_copy` needed by the
acceptance profile.

- `rubric` with per-dimension scores → `rubric_source: "reviewer_rubric"`.
- Only an aggregate `score` → that score is projected onto structure,
  readability and style, and `rubric_source: "aggregate_score_projection"` is
  recorded.
- Neither → the quality dimensions are missing, acceptance returns
  `needs_rework`, and the bounded rework loop ends `blocked`. The deterministic
  fallback reviewer's score is never treated as independent quality evidence.

## Rework semantics

`maxReworkRounds = 2` means one initial attempt plus at most two rework attempts
(three content-chain runs). A round continues when either the content review
(`review.needs_rework`) or the acceptance profile (`needs_rework`) asks for
changes. Each later writer/reviewer call receives a `rework_feedback` array with
the content issue lines and the failing acceptance item ids/details, and the
content input `constraints` also carries them. If the last allowed round still
needs rework, the pilot returns `blocked` with `rework_exhausted:` and the
remaining reasons. A `blocked` acceptance result stops immediately; rework cannot
turn a blocked finding (missing snapshot, contradiction, stale evidence, absent
independence) into a pass.

## Source degradation

The content chain owns this behavior, and the pilot inherits it unchanged
(`docs/prd/14-business-model.md` §2.1, D-V3-28):

| Situation | Outcome |
|---|---|
| Fetch succeeds | Source is snapshotted with `url`, `fetched_at`, `sha256`, `excerpt`. |
| Fetch fails, usable cached snapshot exists | Continue from the snapshot; a `source_unreachable_using_cached_snapshot` warning is returned. |
| Fetch fails, no usable snapshot, key fact affected | `blocked`, with `no_usable_sources` / `key_fact_unverified`. |
| Fetch fails for a non-key source only | Continue with a warning; non-key facts are not gated. |
| No search results | `blocked` with `no_sources`. |

Because the acceptance profile requires two independent hosts and a complete
snapshot per key fact, at least one claim must be marked `key: true` and be
supported by two distinct hosts. Sources are counted by URL host, so two URLs on
one site are one source.

## Publish package and license

The `publish_package` is produced only when the content chain is ready for review
**and** `evaluateArticlePack` returns `pass`. It contains the title candidates,
chosen title, body, tags, source list (URL + fetch time + SHA-256 + excerpt),
mapped facts, the acceptance record and warnings.

Publishing remains a separate authorization. The pilot calls
`evaluatePublish(profilePack, null, { now })`; with no authorization record the
decision is always rejected with `publish_authorization_required`, and the
package states:

```json
{
  "license_status": "unauthorized",
  "license": { "status": "unauthorized", "allowed": false, "authorization": null },
  "publish": { "executed": false, "authorization": null }
}
```

No publish function exists in this package and no outbound call is made.

## Layout

```text
packages/pipelines/selfmedia/
  src/pilot.js    orchestration + content/profile bridge + publish package
  src/index.js    public exports
  test/           deterministic end-to-end pilot suite
```

## Limitations

- Search, fetch and model are interfaces, not provider integrations. This package
  stays offline.
- The profile's reviewer independence is trusted metadata. The pilot runs review
  in its own model call/context and defaults to an independent reviewer record,
  but it cannot detect a caller that injects the same model or context for
  writing and review. Callers can pass `deps.reviewer` and `deps.author` to make
  the real separation explicit.
- Tag fallback (explicit tags → content/layout tags → topic words → platform →
  `self-media` → `待发布`) guarantees the profile minimum but is not editorial
  tag selection.
- The facts mapping uses the content chain's `source_refs`; a source that was not
  snapshotted cannot appear as acceptance evidence.
- The pilot is sequential and synchronous between stages; it has no cancel,
  budget or persistence layer. Those belong to the task service/runtime.
