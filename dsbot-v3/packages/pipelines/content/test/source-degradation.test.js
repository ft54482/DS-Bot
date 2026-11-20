import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex, validateArticlePack } from '../src/article-pack.js';
import { runContentPipeline } from '../src/pipeline.js';
import {
  BODIES,
  KEY_CLAIM,
  MINOR_CLAIM,
  SOURCE_A,
  SOURCE_B,
  SOURCE_C,
  TOPIC,
  createClock,
  createFetch,
  createSearch,
  createSnapshotStore,
  createWriterModel,
} from './helpers/fixtures.js';

test('source degradation: an unreachable source with a verifiable snapshot continues', async () => {
  const clock = createClock();
  const search = createSearch();
  const fetcher = createFetch({ failing: { [SOURCE_A]: 'ECONNREFUSED' } });
  const snapshotStore = createSnapshotStore({
    [SOURCE_A]: {
      text: BODIES[SOURCE_A],
      fetched_at: '2026-11-19T10:00:00.000Z',
      sha256: sha256Hex(BODIES[SOURCE_A]),
    },
  });
  const model = createWriterModel();

  const result = await runContentPipeline(
    { topic: TOPIC },
    {
      now: clock.now,
      search: search.search,
      fetch: fetcher.fetch,
      snapshotStore,
      model,
    },
  );

  assert.equal(result.status, 'ready_for_review');
  const pack = result.article_pack;
  assert.deepEqual(validateArticlePack(pack).issues, []);
  assert.equal(pack.sources.length, 2);

  const sourceA = pack.sources.find((source) => source.url === SOURCE_A);
  assert.ok(sourceA);
  assert.equal(sourceA.fetched_at, '2026-11-19T10:00:00.000Z');
  assert.equal(sourceA.sha256, sha256Hex(BODIES[SOURCE_A]));

  const keyFact = pack.facts.find((fact) => fact.claim === KEY_CLAIM);
  assert.equal(keyFact.status, 'verified');
  assert.deepEqual([...keyFact.source_refs].sort(), [SOURCE_A, SOURCE_B].sort());

  const warning = result.warnings.find((item) => item.code === 'source_unreachable_using_cached_snapshot');
  assert.ok(warning);
  assert.equal(warning.url, SOURCE_A);
});

test('source degradation: a key fact that cannot be verified blocks the chain before writing', async () => {
  const clock = createClock();
  const fetcher = createFetch({ failing: { [SOURCE_A]: 'ECONNREFUSED' } });
  const model = createWriterModel();

  const result = await runContentPipeline(
    { topic: TOPIC },
    { now: clock.now, search: createSearch().search, fetch: fetcher.fetch, model },
  );

  assert.equal(result.status, 'blocked');
  assert.equal(result.article_pack.status, 'blocked');
  assert.equal(result.article_pack.body, '');
  assert.deepEqual(result.article_pack.title_candidates, []);
  assert.equal(result.article_pack.review.score, 0);
  assert.ok(result.article_pack.review.issues.length > 0);

  const blocker = result.blockers.find((item) => item.code === 'key_fact_unverified');
  assert.ok(blocker);
  assert.equal(blocker.claim, KEY_CLAIM);
  assert.ok(blocker.missing_source_refs.includes(SOURCE_A));
  assert.ok(!blocker.source_refs.includes(SOURCE_A));

  assert.deepEqual(result.steps.map((step) => step.name), ['retrieve', 'snapshot', 'fact_check']);
  assert.equal(model.calls.length, 0, 'the writer must not run for a blocked chain');
  assert.deepEqual(validateArticlePack(result.article_pack).issues, []);
});

test('source degradation: a corrupt cached snapshot is not accepted as evidence', async () => {
  const clock = createClock();
  const fetcher = createFetch({ failing: { [SOURCE_A]: 'ECONNREFUSED' } });
  const snapshotStore = createSnapshotStore({
    [SOURCE_A]: {
      text: BODIES[SOURCE_A],
      fetched_at: '2026-11-19T10:00:00.000Z',
      sha256: '0'.repeat(64),
    },
  });

  const result = await runContentPipeline(
    { topic: TOPIC },
    { now: clock.now, search: createSearch().search, fetch: fetcher.fetch, snapshotStore },
  );

  assert.equal(result.status, 'blocked');
  assert.ok(result.warnings.some((item) => item.code === 'source_unreachable' && item.url === SOURCE_A));
  assert.ok(!result.warnings.some((item) => item.code === 'source_unreachable_using_cached_snapshot'));
  assert.ok(result.blockers.some((item) => item.code === 'key_fact_unverified'));
});

test('source degradation: an unreachable non-key source is warned about but does not block', async () => {
  const clock = createClock();
  const results = [
    { url: SOURCE_A, title: 'A', claims: [{ text: KEY_CLAIM, key: true }] },
    { url: SOURCE_B, title: 'B', claims: [{ text: KEY_CLAIM, key: true }] },
    { url: SOURCE_C, title: 'C', claims: [{ text: MINOR_CLAIM }] },
  ];
  const fetcher = createFetch({ failing: { [SOURCE_C]: 'ENOTFOUND' } });
  const model = createWriterModel();

  const result = await runContentPipeline(
    { topic: TOPIC },
    { now: clock.now, search: createSearch(results).search, fetch: fetcher.fetch, model },
  );

  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.article_pack.sources.length, 2);
  assert.ok(result.warnings.some((item) => item.code === 'source_unreachable' && item.url === SOURCE_C));
  assert.equal(model.calls.length, 1);

  const minorFact = result.article_pack.facts.find((fact) => fact.claim === MINOR_CLAIM);
  assert.equal(minorFact.key, false);
  assert.equal(minorFact.status, 'unverified');
  assert.deepEqual(minorFact.source_refs, []);
  assert.ok(result.warnings.some((item) => item.code === 'fact_not_fully_verified' && item.claim === MINOR_CLAIM));
});

test('source degradation: every source unreachable without snapshots is blocked', async () => {
  const clock = createClock();
  const fetcher = createFetch({ failing: { [SOURCE_A]: 'ECONNREFUSED', [SOURCE_B]: 'ECONNREFUSED' } });

  const result = await runContentPipeline(
    { topic: TOPIC },
    { now: clock.now, search: createSearch().search, fetch: fetcher.fetch },
  );

  assert.equal(result.status, 'blocked');
  assert.equal(result.article_pack.sources.length, 0);
  assert.ok(result.blockers.some((item) => item.code === 'no_usable_sources'));
  assert.ok(result.blockers.some((item) => item.code === 'key_fact_unverified'));
});

test('source degradation: the key-fact source threshold is configurable', async () => {
  const clock = createClock();
  const fetcher = createFetch({ failing: { [SOURCE_A]: 'ECONNREFUSED' } });

  const result = await runContentPipeline(
    { topic: TOPIC, min_independent_sources_for_key_fact: 1 },
    { now: clock.now, search: createSearch().search, fetch: fetcher.fetch, model: createWriterModel() },
  );

  assert.equal(result.status, 'ready_for_review');
  const keyFact = result.article_pack.facts.find((fact) => fact.claim === KEY_CLAIM);
  assert.equal(keyFact.status, 'verified');
  assert.deepEqual(keyFact.source_refs, [SOURCE_B]);
});
