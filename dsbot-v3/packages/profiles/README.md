# `@dsbot/profiles` — self-media acceptance profile (L8)

Implements the Phase 1 self-media acceptance profile from
`docs/prd/14-business-model.md` §2.1 / `docs/prd/17-minimal-implementation-package.md`
(S4): it evaluates an article pack against pinned, versioned criteria and returns
`pass` / `needs_rework` / `blocked` with one evidence line per acceptance item.

Publishing is **not** part of acceptance. `evaluateArticlePack` never returns a
publishable state, and `evaluatePublish` rejects publishing unless a separate,
explicit `publish_authorization` record covers the same content fingerprint and
target (`docs/prd/14-business-model.md` §3.2, D-V3-23, T-07).

```sh
node --test packages/profiles/test
```

Only local code runs: no network, model or filesystem fixture store.

## `evaluateArticlePack(pack, profile?, {now}?)`

```js
import { evaluateArticlePack, selfMediaProfileV1 } from '@dsbot/profiles';

const { result, items } = evaluateArticlePack(pack, selfMediaProfileV1);
// result: 'pass' | 'needs_rework' | 'blocked'
// items:  [{ id, class, result, detail }, ...]
```

- `items` is always the same ordered set of 11 items; `class` is `auto` or
  `independent` (`docs/prd/03-acceptance-spec.md` §4.3).
- Item results use the same three values as the aggregate. `blocked` dominates
  `needs_rework`, which dominates `pass`; an item can never be hidden behind a
  better aggregate.
- `detail` is the raw evidence/finding line: fact id, source hosts, snapshot
  status, score vs threshold, ratio, risk id, etc.
- `options.now` pins the evaluation clock (epoch ms, ISO string or `Date`).
  Tests always pin it; production callers may omit it.
- The pack is not mutated.

### Item ids

| id | class | checks |
|---|---|---|
| `auto.pack_schema` | auto | pack shape: article body present, facts/quality/layout/citations/compliance types |
| `independent.facts` | independent | every key fact has ≥2 independent hosts and a complete snapshot per source; no contradiction |
| `independent.freshness` | independent | every key fact has source time; the freshest source is not older than the profile limit |
| `independent.quality.reviewer` | independent | rubric comes from an independent review context |
| `independent.quality.structure` | independent | structure score ≥ threshold |
| `independent.quality.readability` | independent | readability score ≥ threshold |
| `independent.quality.style` | independent | style score ≥ threshold |
| `auto.layout.titles` | auto | ≥3 unique title candidates |
| `auto.layout.tags` | auto | ≥3 unique tags |
| `auto.compliance.quote_ratio` | auto | quotation share of body ≤ soft limit (hard limit blocks) |
| `auto.compliance.risk_list` | auto | no unresolved blocker/major compliance risk |

## Article pack contract (v1)

```jsonc
{
  "schema_version": 1,
  "article": {
    "title": "chosen title",
    "body": "full article body (non-empty)",
    "author": { "id": "content-bot", "context_id": "ctx-writer-1" }
  },
  "facts": [
    {
      "id": "F1",
      "key": true,                    // false/absent = background, not gated
      "statement": "the load-bearing claim",
      "time_sensitive": true,         // false skips expiry (time is still required)
      "sources": [
        {
          "url": "https://alpha.example/article",
          "published_at": "2026-10-01T00:00:00Z", // or updated_at / fetched_at
          "fetched_at": "2026-10-02T00:00:00Z",
          "snapshot": {
            "sha256": "<64 hex>",
            "captured_at": "2026-10-02T00:00:00Z",
            "excerpt": "the quoted passage supporting the claim"
          }
        }
      ]
    }
  ],
  "quality": {
    "reviewer": { "id": "reviewer-1", "context_id": "ctx-review-1", "independent": true },
    "rubric": {
      "structure":   { "score": 86, "issues": [] },
      "readability": { "score": 82, "issues": [] },
      "style":       { "score": 84, "issues": [] }
    }
  },
  "layout": {
    "titles": ["candidate 1", "candidate 2", "candidate 3"],
    "tags": ["AI", "认知", "效率"],
    "cover_copy": "cover text",
    "platform": "wechat",
    "account": "翔解"
  },
  "citations": { "total_chars": 2000, "quoted_chars": 120 },
  "compliance": {
    "risks": [
      { "id": "R-1", "severity": "blocker|major|minor", "resolved": false, "detail": "why" }
    ]
  }
}
```

`examples/article-pack.valid.json` is the passing reference;
`examples/article-pack.single-source.json` has one deliberately under-sourced
key fact.

```sh
node packages/profiles/bin/evaluate.js packages/profiles/examples/article-pack.valid.json
# exit 0, result=pass
node packages/profiles/bin/evaluate.js packages/profiles/examples/article-pack.single-source.json
# exit 2, result=needs_rework, independent.facts names F2 and "need >=2 distinct hosts"
```

## What each check accepts and rejects

**Facts** (`independent.facts`)

- Independence is by URL host (`www.` normalised); two URLs on one site are one
  source. Non-key facts are not gated.
- A key fact with fewer than 2 independent hosts → `needs_rework`.
- A key fact with a missing/incomplete snapshot (needs URL + `captured_at` +
  64-hex `sha256` + non-empty `excerpt`) → `blocked`, per the source-failure
  grading in `14-business-model.md` §2.1.
- Key facts explicitly marked contradictory → `blocked`.

**Freshness** (`independent.freshness`)

- Each key fact uses the newest source time (`published_at` → `updated_at` →
  `fetched_at`). A snapshot capture time is not the source's data time and is
  deliberately not used.
- No time at all → `needs_rework` (add a timestamp or replace the source).
- Older than `freshness.maxSourceAgeDays` (default 180) → `blocked`; a profile
  variant may set `expiredResult: 'needs_rework'` to ask for a new source
  instead. `time_sensitive: false` skips expiry but still requires a time.
- A source timestamp in the future → `needs_rework`.

**Quality** (`independent.quality.*`)

- The rubric must come from an independent review context. Missing reviewer
  record or missing `context_id` → `needs_rework`; `independent: false` or the
  author's own `context_id` → `blocked` (`03-acceptance-spec.md` §4.2: author
  self-report is not acceptance evidence).
- Scores are on the profile scale (default 0–100, thresholds 70). Missing/out-of-scale
  score → `needs_rework`; below threshold → `needs_rework` and the finding includes
  the reviewer's `issues`.

**Layout** (`auto.layout.titles` / `auto.layout.tags`)

- At least 3 unique non-empty title candidates and 3 unique non-empty tags;
  duplicates and blanks are ignored and named in the detail.

**Compliance** (`auto.compliance.*`)

- `quoted_chars / total_chars` above 15% → `needs_rework`; above 30% → `blocked`
  (suspected copying). Missing/invalid citation data → `needs_rework`.
- A risk list is required (empty is valid). Unresolved `blocker` → `blocked`,
  unresolved `major` → `needs_rework`; resolved risks do not block.

## Publish authorization is separate

```js
import { assertPublishAllowed, evaluatePublish } from '@dsbot/profiles';

evaluatePublish(pack, authorization, { now });
// { allowed, result: 'authorized'|'rejected', content_fingerprint,
//   acceptance, reasons: [{ code, detail }] }

assertPublishAllowed(pack, authorization, { now }); // throws PublishNotAuthorizedError
```

The authorization follows `publish_authorization` in
`docs/prd/01-data-model.sql`:

```jsonc
{
  "id": "pub_...",
  "action": "publish",                 // deploy/pay/prod_change are not publish
  "target": "wechat:翔解",             // must match layout.platform:layout.account
  "content_fingerprint": "sha256:...", // must equal contentFingerprint(pack)
  "state": "granted",                  // granted only; used/revoked/expired refused
  "granted_by": "human principal id",
  "granted_at": 1763635200000,
  "expires_at": 1763721600000          // required and must be in the future
}
```

The target must be `layout.platform:layout.account`; `options.target` can supply
the expected target when the pack does not declare one. If neither is available,
publishing is rejected (`publish_target_mismatch`).

The content fingerprint covers the chosen title, body, fact statements, tags and
cover copy. Editing any of them after the license was granted changes the
fingerprint and revokes the match (T-07). Acceptance `pass` with no authorization
is rejected with `publish_authorization_required`; a failing acceptance is
rejected with `acceptance_not_passed` even if an authorization exists.

## Profile

`selfMediaProfileV1` is deeply frozen and pinned as
`{ id: 'business.self_media_v1', version: 1, stage: 'business' }`.
Changing thresholds requires a new profile version; `assertProfile` rejects
profiles that are unversioned, have no independent required item, or try to
waive snapshots / independent review / risk list (G06). Every pack is evaluated
against the full v1 item set regardless of `requiredItems`, so a custom profile
cannot silently drop a failing check.

## Limits

- This package is a deterministic evaluator, not a fact-checker or writer. The
  snapshots, rubric scores and risk list are inputs produced by the content
  toolchain's independent review (`17` S3/S4); the evaluator proves they meet the
  PRD gates and reports exactly where they do not. It does not call an LLM.
- Individually verifiable snapshot metadata is required; the evaluator checks
  the recorded URL/time/64-hex hash/excerpt and does not read the snapshot store
  itself. Independence is a host-level deterministic proxy — mirrored copies of
  one publisher are not detected as the same origin.
- Quality scores are policy checks on an independent reviewer's rubric; this
  package does not replace that reviewer, sampling, or the human publish decision.
  The independence flag/context fields and the authorization record are trusted
  metadata from the caller; no external reviewer/authorization registry is
  consulted here.
- The pack schema above is the contract this package consumes; the content
  pipeline (`packages/pipelines/content/**`) is not part of this change.
