import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex, validateArticlePack } from '../src/article-pack.js';
import {
  STAGES,
  defaultFetch,
  defaultSearch,
  runContentPipeline,
} from '../src/pipeline.js';
import {
  BODIES,
  KEY_CLAIM,
  SOURCE_A,
  SOURCE_B,
  TOPIC,
  createClock,
  createFetch,
  createSearch,
  createWriterModel,
} from './helpers/fixtures.js';

test('content pipeline: produces a complete, validated article pack', async () => {
  const clock = createClock();
  const search = createSearch();
  const fetcher = createFetch();
  const model = createWriterModel();

  const result = await runContentPipeline(
    { topic: TOPIC, platform: 'wechat', audience: 'knowledge workers', tags: ['ai', 'work'] },
    { now: clock.now, search: search.search, fetch: fetcher.fetch, model },
  );

  assert.equal(result.status, 'ready_for_review');
  const pack = result.article_pack;
  assert.deepEqual(validateArticlePack(pack).issues, []);

  assert.equal(pack.status, 'ready_for_review');
  assert.equal(pack.needs_rework, false);
  assert.equal(pack.title_candidates.length, 3);
  assert.ok(pack.title_candidates.every((title) => title.trim().length > 0));
  assert.ok(pack.body.includes(KEY_CLAIM));
  assert.ok(pack.body.startsWith(`# ${TOPIC}`));

  assert.equal(pack.sources.length, 2);
  const fetchedAt = new Date(clock.now()).toISOString();
  for (const source of pack.sources) {
    assert.ok([SOURCE_A, SOURCE_B].includes(source.url));
    assert.equal(source.fetched_at, fetchedAt);
    assert.equal(source.sha256, sha256Hex(BODIES[source.url]));
    assert.equal(source.excerpt.length <= 281, true);
    assert.ok(source.excerpt.length > 0);
  }

  assert.equal(pack.facts.length, 2);
  const keyFact = pack.facts.find((fact) => fact.claim === KEY_CLAIM);
  assert.ok(keyFact);
  assert.equal(keyFact.key, true);
  assert.equal(keyFact.status, 'verified');
  assert.equal(keyFact.independent_sources, 2);
  assert.deepEqual([...keyFact.source_refs].sort(), [SOURCE_A, SOURCE_B].sort());

  assert.equal(pack.review.score, 100);
  assert.deepEqual(pack.review.issues, []);
  assert.equal(pack.review.needs_rework, false);

  assert.equal(pack.layout.platform, 'wechat');
  assert.equal(pack.layout.format, 'markdown');
  assert.equal(pack.layout.title, TOPIC);
  assert.ok(pack.layout.word_count > 0);
  assert.deepEqual(pack.layout.headings, [TOPIC, 'Sources']);
  assert.deepEqual(pack.layout.tags, ['ai', 'work', 'wechat']);

  assert.deepEqual(result.steps.map((step) => step.name), [...STAGES]);
  assert.equal(result.usage.source, 'model_call');
  assert.equal(result.usage.tokens_in, 120);
  assert.equal(result.usage.tokens_out, 80);
  assert.equal(result.generated_at, fetchedAt);
  assert.equal(search.calls[0].topic, TOPIC);
  assert.deepEqual(fetcher.calls.sort(), [SOURCE_A, SOURCE_B].sort());
});

test('content pipeline: the default capabilities never reach the network', async () => {
  assert.deepEqual(await defaultSearch(), []);
  const refused = await defaultFetch(SOURCE_A);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /network_disabled/);

  const result = await runContentPipeline({ topic: TOPIC }, { now: createClock().now });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockers[0].code, 'no_sources');
  assert.equal(result.article_pack.status, 'blocked');
  assert.deepEqual(validateArticlePack(result.article_pack).issues, []);
  assert.deepEqual(result.steps.map((step) => step.name), ['retrieve', 'snapshot', 'fact_check']);
});

test('article pack validation: rejects malformed shapes and accepts the contract shape', () => {
  const minimal = {
    title_candidates: [],
    body: '',
    sources: [],
    facts: [],
    review: { score: 0, issues: [] },
    layout: {},
  };
  assert.deepEqual(validateArticlePack(minimal), { ok: true, issues: [] });

  const malformed = {
    title_candidates: [42],
    body: null,
    sources: [{ url: '', fetched_at: null, sha256: 'not-a-hash', excerpt: null }],
    facts: [{ claim: '', source_refs: 'nope' }],
    review: { score: 120, issues: 'nope' },
    layout: [],
  };
  const validation = validateArticlePack(malformed);
  assert.equal(validation.ok, false);
  for (const issue of [
    'title_candidates[]',
    'body',
    'sources[0].url',
    'sources[0].fetched_at',
    'sources[0].sha256',
    'sources[0].excerpt',
    'facts[0].claim',
    'facts[0].source_refs',
    'review.score_range',
    'review.issues',
    'layout',
  ]) {
    assert.ok(validation.issues.includes(issue), `missing issue ${issue}`);
  }
});
